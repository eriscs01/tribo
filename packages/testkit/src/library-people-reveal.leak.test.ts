// @module-tag drop-b
// library.people.reveal against the oracle: of every person in the world, each with a sealed
// emergency contact, an account reveals exactly its own and those of people it shares a live
// trip with as owner or organizer; everyone else (a plain member or viewer of a shared trip, a
// placeholder's creator, a stranger) is told the person does not exist, at the cost of an
// unknown person, and no refusal leaves an event. Every reveal leaves one event naming the
// field, never the value.
import { createPersonRevealService, sharedTripRoles, type SharedTripRoles } from '@tribo/core';
import type { Keyring } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { testKeys } from './keys.js';
import { leakRunOptions, worldProperty, type BuiltWorld } from './leak.js';
import { sealEmergencyContact } from './offline-bundle-world.js';
import { counted } from './overlays-world.js';

/* eslint-disable no-await-in-loop -- one transaction, so one statement at a time */
const options = leakRunOptions();
const keys: Keyring = testKeys();
const body = { fields: ['emergencyContact'] };
const UNKNOWN = '0192f000-0000-7000-8000-00000000000d';
const marker = (personId: string) => `reveal-sos:${personId}`;

/** Who may reveal a person's emergency contact, written independently of the SQL. */
function mayReveal(world: BuiltWorld, userId: string, personId: string): boolean {
  const person = world.persons.find((p) => p.id === personId);
  if (!person || person.deleted) return false;
  if (person.userId === userId) return true;
  const me = world.persons.find((p) => p.userId === userId);
  if (!me) return false;
  return world.trips.some(
    (t) =>
      !t.deleted &&
      t.members.some((m) => m.personId === personId && !m.deleted) &&
      t.members.some(
        (m) => m.personId === me.id && !m.deleted && (m.role === 'owner' || m.role === 'organizer'),
      ),
  );
}

async function sealContacts(trx: Kysely<DB>, world: BuiltWorld): Promise<void> {
  for (const person of world.persons) {
    await sealEmergencyContact(trx, keys, person.id, {
      name: marker(person.id),
      phone: '+63 917 555 0100',
    });
  }
}

/** The reveal events in the database, as rows. */
const revealEvents = (trx: Kysely<DB>) =>
  trx
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('action', '=', 'reveal')
    .where('entity_type', '=', 'person')
    .execute();

const revealsExactly = (db: Kysely<DB>, port: SharedTripRoles) =>
  worldProperty(db, async (trx, world) => {
    await sealContacts(trx, world);
    const service = createPersonRevealService(trx, keys, port);
    const problems: string[] = [];
    let n = 0;
    for (const userId of world.userIds) {
      for (const person of world.persons) {
        n += 1;
        const ctx = { requestId: `reveal-leak-${String(n)}`, surface: 'web' as const, userId };
        const before = (await revealEvents(trx)).length;
        const got = await service.reveal(ctx, person.id, body).then(
          (shown) => ({ shown }),
          (error: unknown) => {
            if (error instanceof ApiError) return { refused: error.code };
            throw error;
          },
        );
        const events = (await revealEvents(trx)).length - before;
        const at = `${userId} on ${person.id}`;
        if (mayReveal(world, userId, person.id)) {
          if (!('shown' in got) || got.shown.emergencyContact?.name !== marker(person.id)) {
            problems.push(`${at}: wanted the contact, got ${JSON.stringify(got)}`);
          }
          if (events !== 1) problems.push(`${at}: ${String(events)} events for one reveal`);
        } else {
          if (!('refused' in got) || got.refused !== 'not_found') {
            problems.push(`${at}: wanted not_found, got ${JSON.stringify(got)}`);
          }
          if (events !== 0) problems.push(`${at}: a refusal wrote ${String(events)} events`);
        }
      }
    }
    const all = await revealEvents(trx);
    if (all.some((e) => e.reason !== '/emergencyContact' || e.chain_key !== 'platform')) {
      problems.push('a reveal event names something but the field, or another chain');
    }
    if (JSON.stringify(all).includes('reveal-sos:')) problems.push('an event holds the value');
    return problems;
  });

describe('library.people.reveal against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`reveals exactly to the person and the owners and organizers of a live shared trip (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(revealsExactly(tdb.db, sharedTripRoles), options);
  });

  it('costs every refusal the queries of an unknown person', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await sealContacts(trx, world);
        const problems: string[] = [];
        const cost = async (userId: string, personId: string) => {
          const { handle, state } = counted(trx);
          const ctx = { requestId: 'reveal-cost', surface: 'web' as const, userId };
          await sql`SAVEPOINT reveal_cost`.execute(trx);
          try {
            await createPersonRevealService(handle, keys, sharedTripRoles).reveal(
              ctx,
              personId,
              body,
            );
            return null;
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            return state.queries;
          } finally {
            await sql`ROLLBACK TO SAVEPOINT reveal_cost`.execute(trx);
          }
        };
        for (const userId of world.userIds) {
          const unknown = await cost(userId, UNKNOWN);
          for (const person of world.persons.filter((p) => !mayReveal(world, userId, p.id))) {
            const refused = await cost(userId, person.id);
            if (refused !== unknown) {
              problems.push(
                `${userId} on ${person.id}: ${String(refused)} queries, unknown ${String(unknown)}`,
              );
            }
          }
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a reveal that lets any role of a shared trip in', async () => {
    const anyone: SharedTripRoles = async (db, userId, personId) =>
      (await sharedTripRoles(db, userId, personId)).map(() => 'owner' as const);
    expect((await fc.check(revealsExactly(tdb.db, anyone), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a reveal that refuses organizers', async () => {
    const nobody: SharedTripRoles = () => Promise.resolve([]);
    expect((await fc.check(revealsExactly(tdb.db, nobody), options)).failed).toBe(true);
  });

  it('is not vacuous: some world reveals another person’s contact to an organizer', async () => {
    let granted = 0;
    await fc.assert(
      worldProperty(tdb.db, (_trx, world) => {
        for (const userId of world.userIds) {
          granted += world.persons.filter(
            (p) => p.userId !== userId && mayReveal(world, userId, p.id),
          ).length;
        }
        return Promise.resolve([]);
      }),
      { ...options, numRuns: 20 },
    );
    expect(granted).toBeGreaterThan(0);
  });
});
