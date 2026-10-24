// @module-tag drop-a
// invites.revoke (Drop A): Revoke an invite link; Invites carry no version; trip_archived on archived trips (R29)
import type { InvitesService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createInvite, createTrip, createUser } from './factories.js';
import { invitesService, inviteWorld, storedInvite } from './invite-world.js';

let tdb: TestDatabase;
let invites: InvitesService;
const as = contexts('req-invite-revoke');

beforeAll(async () => {
  tdb = await createTestDatabase();
  invites = invitesService(tdb);
});
afterAll(() => tdb.destroy());

describe('invites.revoke', () => {
  it('stamps revoked_at and answers the revoked invite; a second revoke changes nothing', async () => {
    const w = await inviteWorld(tdb);
    const id = await createInvite(tdb.db, { tripId: w.tripId, createdBy: w.owner.userId });
    const revoked = await invites.revoke(as(w.owner), w.tripId, id, undefined);
    expect(revoked).toMatchObject({ id, status: 'revoked' });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    const again = await invites.revoke(as(w.owner), w.tripId, id, undefined);
    expect(again.revokedAt).toEqual(revoked.revokedAt);
    expect((await history(tdb, id)).events.map((e) => e.action)).toEqual(['revoke']);
  });

  it('refuses organizer, member, viewer with forbidden; lets owner', async () => {
    const w = await inviteWorld(tdb);
    const id = await createInvite(tdb.db, { tripId: w.tripId, createdBy: w.owner.userId });
    for (const who of [w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      expect(await refusal(invites.revoke(as(who), w.tripId, id, undefined))).toBe('forbidden');
    }
    expect((await storedInvite(tdb, id)).revoked_at).toBeNull();
    await expect(invites.revoke(as(w.owner), w.tripId, id, undefined)).resolves.toMatchObject({
      status: 'revoked',
    });
  });

  it("answers not_found to an account outside the trip, and for another trip's invite", async () => {
    const w = await inviteWorld(tdb);
    const id = await createInvite(tdb.db, { tripId: w.tripId, createdBy: w.owner.userId });
    expect(await refusal(invites.revoke(as(w.outsider), w.tripId, id, undefined))).toBe(
      'not_found',
    );
    // The owner of another trip names this invite under their own trip: it is not there.
    const other = await createUser(tdb.db);
    const theirs = await createTrip(tdb.db, { owner: other });
    expect(await refusal(invites.revoke(as(other), theirs.tripId, id, undefined))).toBe(
      'not_found',
    );
    expect((await storedInvite(tdb, id)).revoked_at).toBeNull();
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await inviteWorld(tdb);
    const id = await createInvite(tdb.db, { tripId: w.tripId, createdBy: w.owner.userId });
    expect(await refusal(invites.revoke(as(w.owner), w.tripId, id, { reason: 'x' }))).toBe(
      'validation_failed',
    );
    expect((await storedInvite(tdb, id)).revoked_at).toBeNull();
  });

  it('records its audit event in the one transaction; invites carry no version or snapshot', async () => {
    const w = await inviteWorld(tdb);
    const id = await createInvite(tdb.db, { tripId: w.tripId, createdBy: w.owner.userId });
    const ctx = as(w.owner);
    await invites.revoke(ctx, w.tripId, id, undefined);
    expect(await history(tdb, id)).toEqual({
      events: [
        {
          chain_key: `trip:${w.tripId}`,
          action: 'revoke',
          entity_type: 'invite',
          version_before: null,
          version_after: null,
          request_id: ctx.requestId,
        },
      ],
      snapshots: [],
    });
  });

  it('answers trip_archived where the registry notes say so', async () => {
    const w = await inviteWorld(tdb);
    const id = await createInvite(tdb.db, { tripId: w.tripId, createdBy: w.owner.userId });
    await archive(tdb, w.tripId);
    expect(await refusal(invites.revoke(as(w.owner), w.tripId, id, undefined))).toBe(
      'trip_archived',
    );
  });
});
