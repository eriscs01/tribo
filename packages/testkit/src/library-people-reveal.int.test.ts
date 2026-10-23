// @module-tag drop-b
// library.people.reveal (Drop B): Plaintext emergency contact; ID/passport in 1b; Audited reveal; write scope (G15); MCP approval (1b); No Idempotency-Key: each call is its own audited reveal (R2); MCP: tool returns approvalId, after approval the client calls again with approvalId within 10 min, single use (R15); Moved to Drop B so organizers can reach emergency contacts during the trip
// Through the library's reveal and the real trips, crypto and audit modules: the emergency
// contact leaves the database only here, for the person themself and the owners and organizers
// of a live trip they share, each call writing its own reveal event that names the field and
// never the value. Anyone else is told the person does not exist, at the same cost.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createPlaceholder, createTrip, createUser, softDelete } from './factories.js';
import { sealEmergencyContact } from './offline-bundle-world.js';
import { counted } from './overlays-world.js';
import {
  contactOf,
  peopleRevealWorld,
  personRevealService,
  type PeopleRevealWorld,
} from './people-world.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const as = contexts('people-reveal');
const body = { fields: ['emergencyContact'] };
const UNKNOWN = '0192f000-0000-7000-8000-00000000000b';

const reveals = (personId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('entity_id', '=', personId)
    .where('action', '=', 'reveal')
    .orderBy('seq')
    .execute();

describe('library.people.reveal', () => {
  let w: PeopleRevealWorld;
  beforeAll(async () => {
    w = await peopleRevealWorld(tdb);
  });

  it('lets the person themself, and the owner and an organizer of a trip they share', async () => {
    for (const user of [w.member, w.owner, w.organizer]) {
      // eslint-disable-next-line no-await-in-loop -- each caller is checked on its own
      expect(await w.reveal.reveal(as(user), w.member.personId, body)).toEqual({
        emergencyContact: w.contactOf(w.member.personId),
      });
    }
  });

  it('lets an organizer reveal a placeholder traveller of the trip', async () => {
    expect(await w.reveal.reveal(as(w.organizer), w.placeholder, body)).toEqual({
      emergencyContact: w.contactOf(w.placeholder),
    });
  });

  it('answers a plain member, a viewer, a stranger and the placeholder’s creator as for an unknown person, writing nothing', async () => {
    const d = await peopleRevealWorld(tdb);
    for (const user of [d.other, d.viewer, d.outsider, d.creator]) {
      // eslint-disable-next-line no-await-in-loop -- each caller is checked on its own
      expect(await refusal(d.reveal.reveal(as(user), d.member.personId, body))).toBe('not_found');
      // eslint-disable-next-line no-await-in-loop -- each caller is checked on its own
      expect(await refusal(d.reveal.reveal(as(user), d.placeholder, body))).toBe('not_found');
    }
    expect(await refusal(d.reveal.reveal(as(d.owner), UNKNOWN, body))).toBe('not_found');
    expect(await reveals(d.member.personId)).toEqual([]);
    expect(await reveals(d.placeholder)).toEqual([]);
  });

  it('costs the same queries to refuse a member, a stranger and an unknown person', async () => {
    const queries: number[] = [];
    for (const [user, personId] of [
      [w.other, w.member.personId],
      [w.outsider, w.member.personId],
      [w.owner, UNKNOWN],
    ] as const) {
      const { handle, state } = counted(tdb.db);
      const refused = refusal(personRevealService(handle, w.keys).reveal(as(user), personId, body));
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time, each counted alone
      expect(await refused).toBe('not_found');
      queries.push(state.queries);
    }
    expect(new Set(queries).size).toBe(1);
  });

  it('stops granting once the person or the organizer leaves the trip, or the trip is deleted', async () => {
    const left = await peopleRevealWorld(tdb);
    await softDelete(tdb.db, 'tribo.memberships', left.member.membershipId);
    expect(await refusal(left.reveal.reveal(as(left.owner), left.member.personId, body))).toBe(
      'not_found',
    );
    // The person still reveals their own.
    expect(await left.reveal.reveal(as(left.member), left.member.personId, body)).toMatchObject({
      emergencyContact: { phone: '+63 917 555 0100' },
    });

    const gone = await peopleRevealWorld(tdb);
    await softDelete(tdb.db, 'tribo.memberships', gone.organizer.membershipId);
    expect(await refusal(gone.reveal.reveal(as(gone.organizer), gone.member.personId, body))).toBe(
      'not_found',
    );

    const deleted = await peopleRevealWorld(tdb);
    await softDelete(tdb.db, 'tribo.trips', deleted.tripId);
    expect(
      await refusal(deleted.reveal.reveal(as(deleted.owner), deleted.member.personId, body)),
    ).toBe('not_found');
  });

  it('grants through an archived trip, but not through one whose audit chain has retired', async () => {
    const d = await peopleRevealWorld(tdb);
    await archive(tdb, d.tripId);
    expect(await d.reveal.reveal(as(d.organizer), d.member.personId, body)).toMatchObject({
      emergencyContact: contactOf(d.member.personId),
    });
    await tdb.db
      .updateTable('tribo.trips')
      .set({ audit_retired_at: new Date() })
      .where('id', '=', d.tripId)
      .execute();
    expect(await refusal(d.reveal.reveal(as(d.organizer), d.member.personId, body))).toBe(
      'not_found',
    );
  });

  it('grants through any one live trip the two share', async () => {
    const d = await peopleRevealWorld(tdb);
    // A second trip where the member's organizer is only a member: the first trip still grants.
    const second = await createTrip(tdb.db, { owner: d.member });
    await addMember(tdb.db, {
      tripId: second.tripId,
      personId: d.organizer.personId,
      role: 'member',
    });
    expect(await d.reveal.reveal(as(d.organizer), d.member.personId, body)).toMatchObject({
      emergencyContact: { phone: '+63 917 555 0100' },
    });
  });

  it('answers null when no emergency contact is stored, and still records the reveal', async () => {
    const d = await peopleRevealWorld(tdb);
    expect(await d.reveal.reveal(as(d.other), d.other.personId, body)).toEqual({
      emergencyContact: null,
    });
    expect(await reveals(d.other.personId)).toHaveLength(1);
  });

  it('records one reveal event per call on the platform chain, naming the field and never the value', async () => {
    const d = await peopleRevealWorld(tdb);
    const ctx = as(d.organizer);
    await d.reveal.reveal(ctx, d.member.personId, body);
    await d.reveal.reveal(as(d.organizer), d.member.personId, body);
    const events = await reveals(d.member.personId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      chain_key: 'platform',
      action: 'reveal',
      entity_type: 'person',
      trip_id: null,
      actor_user_id: d.organizer.userId,
      reason: '/emergencyContact',
      request_id: ctx.requestId,
    });
    const contact = d.contactOf(d.member.personId);
    expect(JSON.stringify(events)).not.toContain(contact.name);
    expect(JSON.stringify(events)).not.toContain(contact.phone);
    // A reveal changes nothing, so it leaves no snapshot.
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select('version')
      .where('entity_id', '=', d.member.personId)
      .execute();
    expect(snapshots).toEqual([]);
  });

  it('refuses an invalid body with validation_failed, writing nothing, but only once the caller may reveal', async () => {
    const d = await peopleRevealWorld(tdb);
    for (const bad of [
      {},
      { fields: [] },
      { fields: ['passport'] },
      { fields: ['emergencyContact'], why: 1 },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each body is checked on its own
      expect(await refusal(d.reveal.reveal(as(d.owner), d.member.personId, bad))).toBe(
        'validation_failed',
      );
    }
    expect(await refusal(d.reveal.reveal(as(d.outsider), d.member.personId, {}))).toBe('not_found');
    expect(await reveals(d.member.personId)).toEqual([]);
  });

  it('rolls its event back when the stored contact does not open for its person', async () => {
    const d = await peopleRevealWorld(tdb);
    // A sealed value copied from another person's row is bound to that row (AAD).
    const { emergency_contact_enc: copied } = await tdb.db
      .selectFrom('tribo.persons')
      .select('emergency_contact_enc')
      .where('id', '=', d.owner.personId)
      .executeTakeFirstOrThrow();
    await tdb.db
      .updateTable('tribo.persons')
      .set({ emergency_contact_enc: copied })
      .where('id', '=', d.member.personId)
      .execute();
    await expect(d.reveal.reveal(as(d.owner), d.member.personId, body)).rejects.toThrow();
    expect(await reveals(d.member.personId)).toEqual([]);
  });

  it('reveals the survivor’s contact through a merged placeholder’s id', async () => {
    const d = await peopleRevealWorld(tdb);
    const merged = await createPlaceholder(tdb.db, { createdBy: d.owner.userId });
    await tdb.db
      .updateTable('tribo.persons')
      .set({ merged_into: d.member.personId, deleted_at: new Date() })
      .where('id', '=', merged)
      .execute();
    await sealEmergencyContact(tdb.db, d.keys, d.member.personId, {
      name: 'Survivor contact',
      phone: '+63 917 555 0199',
    });
    expect(await d.reveal.reveal(as(d.owner), merged, body)).toEqual({
      emergencyContact: { name: 'Survivor contact', phone: '+63 917 555 0199' },
    });
    expect(await reveals(d.member.personId)).toHaveLength(1);
  });

  it('lets an account with no shared trip reveal only its own', async () => {
    const loner = await createUser(tdb.db);
    expect(await w.reveal.reveal(as(loner), loner.personId, body)).toEqual({
      emergencyContact: null,
    });
    expect(await refusal(w.reveal.reveal(as(loner), w.member.personId, body))).toBe('not_found');
  });
});
