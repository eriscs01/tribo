// @module-tag drop-b
// trips.offlineBundle against the oracle: every account reads the bundle of exactly the trips
// it is in (not_found otherwise, as for an unknown trip), and each collection in it holds
// exactly what the oracle lets that account see: items, units and boards of visible items,
// the trip's active members, the live ledger with hidden item links nulled, the files the
// one file predicate allows, and only the caller's own tickets and overlays. No sealed
// value (booking ref, ticket number, emergency contact) shows in any form, no other member's
// overlay or ticket shows by value, and the bundle reads the same, at the same cost, with
// every item hidden from the caller gone.
import { createOfflineBundleService, type OfflineBundleRecord } from '@tribo/core';
import type { Keyring } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import { testKeys } from './keys.js';
import {
  leakRunOptions,
  oracle,
  withoutHiddenItems,
  worldProperty,
  type BuiltWorld,
} from './leak.js';
import { SEALED_MARKERS, sealBookingRef, sealEmergencyContact } from './offline-bundle-world.js';
import { activeMembership, counted, seedOverlays } from './overlays-world.js';
import { seedTickets, type SeededTicket } from './tickets-world.js';

/* eslint-disable no-await-in-loop -- one transaction, so one statement at a time */
const options = leakRunOptions();
const keys: Keyring = testKeys();

type BundleRead = (db: Kysely<DB>, userId: string, tripId: string) => Promise<OfflineBundleRecord>;

const fair: BundleRead = (db, userId, tripId) => createOfflineBundleService(db).get(userId, tripId);

/** Gives every item a sealed booking ref and every person a sealed emergency contact, each with its marker. */
async function sealEverything(trx: Kysely<DB>, world: BuiltWorld): Promise<void> {
  for (const item of world.trips.flatMap((t) => t.items)) {
    await sealBookingRef(trx, keys, item.id, `bundle-ref:${item.id}`);
  }
  for (const person of world.persons) {
    await sealEmergencyContact(trx, keys, person.id, {
      name: `bundle-sos:${person.id}`,
      phone: '+63 917 555 0100',
    });
  }
}

/** The seeded world: tickets for everyone on every transport item, overlays everywhere, everything sealed. */
async function seeded(trx: Kysely<DB>, world: BuiltWorld): Promise<SeededTicket[]> {
  const tickets = await seedTickets(trx, keys, world);
  await seedOverlays(trx, world);
  await sealEverything(trx, world);
  return tickets;
}

type Answer = { bundle: OfflineBundleRecord; text: string } | { refused: string };

async function answer(read: BundleRead, db: Kysely<DB>, userId: string, tripId: string) {
  try {
    const bundle = await read(db, userId, tripId);
    return { bundle, text: JSON.stringify(bundle) } satisfies Answer;
  } catch (error) {
    if (error instanceof ApiError) return { refused: error.code } satisfies Answer;
    throw error;
  }
}

const sortedIds = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();
const same = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** What the oracle forbids or misses in one account's bundle of one trip. */
function problemsOf(
  world: BuiltWorld,
  tickets: SeededTicket[],
  userId: string,
  tripId: string,
  got: Answer,
): string[] {
  const at = `${userId} on ${tripId}`;
  if (!oracle.tripVisible(world, userId, tripId)) {
    return 'refused' in got && got.refused === 'not_found' ? [] : [`${at}: wanted not_found`];
  }
  if ('refused' in got) return [`${at}: refused ${got.refused}`];
  const { bundle, text } = got;
  const trip = world.trips.find((t) => t.id === tripId);
  const mine = activeMembership(world, userId, tripId);
  if (!trip || !mine) return [`${at}: no trip in the world`];
  const problems: string[] = [];
  const check = (what: string, listed: readonly string[], wanted: readonly string[]) => {
    if (!same(listed, wanted)) {
      problems.push(`${at}: ${what} ${JSON.stringify(listed)}, wanted ${JSON.stringify(wanted)}`);
    }
  };
  const seen = (itemId: string) => oracle.itemVisible(world, userId, itemId);

  check(
    'items',
    sortedIds(bundle.items),
    trip.items.filter((i) => seen(i.id)).map((i) => i.id),
  );
  check(
    'boards',
    bundle.boards.map((b) => b.itemId),
    trip.items.filter((i) => seen(i.id)).map((i) => i.id),
  );
  check(
    'units',
    sortedIds(bundle.units),
    trip.items
      .flatMap((i) => i.units.filter((u) => oracle.unitVisible(world, userId, u.id)))
      .map((u) => u.id),
  );
  check(
    'members',
    sortedIds(bundle.members),
    trip.members.filter((m) => oracle.memberVisible(world, userId, m.id)).map((m) => m.id),
  );
  check(
    'expenses',
    sortedIds(bundle.expenses),
    trip.expenses.filter((e) => oracle.expenseVisible(world, userId, e.id)).map((e) => e.id),
  );
  for (const e of bundle.expenses) {
    if (e.itemId !== oracle.expenseItem(world, userId, e.id)) {
      problems.push(`${at}: expense ${e.id} names item ${String(e.itemId)}`);
    }
    if (!('masked' in e.amount) && !oracle.costsReadable(world, userId, tripId)) {
      problems.push(`${at}: expense ${e.id} shows its amount`);
    }
  }
  for (const i of bundle.items) {
    if (i.cost !== null && i.cost !== 'masked' && !oracle.moneyReadable(world, userId, i.id)) {
      problems.push(`${at}: item ${i.id} shows its cost`);
    }
  }
  check(
    'files',
    sortedIds(bundle.files),
    trip.files.filter((f) => oracle.fileVisible(world, userId, f.id)).map((f) => f.id),
  );
  check(
    'tickets',
    sortedIds(bundle.tickets),
    tickets
      .filter((t) => !t.deleted && t.membershipId === mine.id && seen(t.itemId))
      .map((t) => t.id),
  );
  check(
    'overlays',
    bundle.overlays.map((o) => o.itemId),
    mine.role === 'viewer' ? [] : trip.items.filter((i) => seen(i.id)).map((i) => i.id),
  );

  // By value: nothing sealed, and nothing private of anyone else.
  for (const marker of [...SEALED_MARKERS, 'tkt-no:']) {
    if (text.includes(marker)) problems.push(`${at}: a sealed value shows (${marker})`);
  }
  for (const m of world.trips.flatMap((t) => t.members).filter((x) => x.id !== mine.id)) {
    if (text.includes(`ovl-note:${m.id}`) || text.includes(`ovl-check:${m.id}`)) {
      problems.push(`${at}: ${m.id}'s overlay shows`);
    }
    if (text.includes(`tkt-seat:${m.id}`)) problems.push(`${at}: ${m.id}'s ticket shows`);
  }
  return problems;
}

const readsExactly = (db: Kysely<DB>, read: BundleRead) =>
  worldProperty(db, async (trx, world) => {
    const tickets = await seeded(trx, world);
    const problems: string[] = [];
    for (const userId of world.userIds) {
      for (const trip of world.trips) {
        const got = await answer(read, trx, userId, trip.id);
        problems.push(...problemsOf(world, tickets, userId, trip.id, got));
      }
    }
    return problems;
  });

describe('trips.offlineBundle against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`carries exactly what each role may see, nothing sealed (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(readsExactly(tdb.db, fair), options);
  });

  it('answers, and costs, the same with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seeded(trx, world);
        const problems: string[] = [];
        for (const userId of world.userIds) {
          const { before, after } = await withoutHiddenItems(trx, world, userId, async () => {
            const { handle, state } = counted(trx);
            const answers: unknown[] = [];
            for (const trip of world.trips) {
              const got = await answer(fair, handle, userId, trip.id);
              answers.push('refused' in got ? got : got.text);
            }
            return JSON.stringify({ answers, queries: state.queries });
          });
          if (before !== after) problems.push(`${userId}'s bundles change with hidden items`);
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a bundle that carries another member’s overlays', async () => {
    const leaky: BundleRead = async (db, userId, tripId) => {
      const bundle = await fair(db, userId, tripId);
      const all = await db
        .selectFrom('tribo.overlays')
        .select(['item_id', 'note'])
        .where('trip_id', '=', tripId)
        .execute();
      return {
        ...bundle,
        overlays: [
          ...bundle.overlays,
          ...all.map((o) => ({ ...bundle.overlays[0], itemId: o.item_id, note: o.note }) as never),
        ],
      };
    };
    expect((await fc.check(readsExactly(tdb.db, leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a bundle that carries other passengers’ tickets', async () => {
    const leaky: BundleRead = async (db, userId, tripId) => {
      const bundle = await fair(db, userId, tripId);
      const all = await db
        .selectFrom('tribo.tickets')
        .select(['id', 'seat'])
        .where('trip_id', '=', tripId)
        .where('deleted_at', 'is', null)
        .execute();
      return {
        ...bundle,
        tickets: all.map((t) => ({ ...bundle.tickets[0], id: t.id, seat: t.seat }) as never),
      };
    };
    expect((await fc.check(readsExactly(tdb.db, leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a bundle that carries a revealed value', async () => {
    const leaky: BundleRead = async (db, userId, tripId) => {
      const bundle = await fair(db, userId, tripId);
      return { ...bundle, items: bundle.items.map((i) => ({ ...i, title: `bundle-ref:${i.id}` })) };
    };
    expect((await fc.check(readsExactly(tdb.db, leaky), options)).failed).toBe(true);
  });

  it('is not vacuous: some world carries a ticket, an overlay and a file to someone', async () => {
    const carried = { tickets: 0, overlays: 0, files: 0, refused: 0 };
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seeded(trx, world);
        for (const userId of world.userIds) {
          for (const trip of world.trips) {
            const got = await answer(fair, trx, userId, trip.id);
            if ('refused' in got) carried.refused += 1;
            else {
              carried.tickets += got.bundle.tickets.length;
              carried.overlays += got.bundle.overlays.length;
              carried.files += got.bundle.files.length;
            }
          }
        }
        return [];
      }),
      { ...options, numRuns: 20 },
    );
    expect(Object.values(carried).every((n) => n > 0)).toBe(true);
  });
});

describe('mutation check: the harness catches a bundle that shows private items to everyone', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    // Break item_visible in this database only: a private item counts as shared.
    const owner = connectAs(tdb.name, 'tribo_owner');
    await owner.connect();
    try {
      const { rows } = await owner.query<{ def: string }>(
        `SELECT pg_get_functiondef('tribo.item_visible(uuid, uuid)'::regprocedure) AS def`,
      );
      const def = rows[0]?.def ?? '';
      const broken = def.replace(/i\.visibility = 'shared'/, `i.visibility <> 'selected'`);
      expect(broken).not.toBe(def);
      await owner.query(broken);
    } finally {
      await owner.end();
    }
  });
  afterAll(() => tdb.destroy());

  it('fails the property', async () => {
    expect((await fc.check(readsExactly(tdb.db, fair), options)).failed).toBe(true);
  });
});
