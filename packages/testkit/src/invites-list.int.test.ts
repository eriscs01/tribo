// @module-tag drop-a
// invites.list (Drop A): Invite links with role, expiry, uses; Token never returned after create
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import type { InvitesService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contexts, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createInvite } from './factories.js';
import { invitesService, inviteWorld, tomorrow } from './invite-world.js';

let tdb: TestDatabase;
let invites: InvitesService;
const as = contexts('req-invite-list');

beforeAll(async () => {
  tdb = await createTestDatabase();
  invites = invitesService(tdb);
});
afterAll(() => tdb.destroy());

describe('invites.list', () => {
  it("lists the trip's invites in creation order with role, expiry, uses and status, never a token", async () => {
    const w = await inviteWorld(tdb);
    const open = await invites.create(as(w.owner), w.tripId, {
      role: 'member',
      expiresAt: tomorrow(),
      maxUses: 4,
    });
    const claim = await invites.create(as(w.owner), w.tripId, {
      personId: encodeTypeId(ID_PREFIX.person, w.guest.personId),
      expiresAt: tomorrow(),
    });
    const revoked = await createInvite(tdb.db, {
      tripId: w.tripId,
      createdBy: w.owner.userId,
      revoked: true,
    });
    const expired = await createInvite(tdb.db, {
      tripId: w.tripId,
      createdBy: w.owner.userId,
      expired: true,
    });
    const page = await invites.list(w.owner.userId, w.tripId, { limit: 50 });
    expect(page.items.map((i) => [i.id, i.status])).toEqual([
      [open.id, 'active'],
      [claim.id, 'active'],
      [revoked, 'revoked'],
      [expired, 'expired'],
    ]);
    expect(page.items[0]).toEqual({
      id: open.id,
      tripId: w.tripId,
      role: 'member',
      personId: null,
      expiresAt: open.expiresAt,
      maxUses: 4,
      uses: 0,
      status: 'active',
      revokedAt: null,
      createdAt: open.createdAt,
    });
    expect(page.items[1]).toMatchObject({ personId: w.guest.personId, maxUses: 1 });
    expect(JSON.stringify(page)).not.toContain(open.token);
  });

  it('pages by id with a cursor', async () => {
    const w = await inviteWorld(tdb);
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- in creation order
      ids.push(await createInvite(tdb.db, { tripId: w.tripId, createdBy: w.owner.userId }));
    }
    const first = await invites.list(w.owner.userId, w.tripId, { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    const next = await invites.list(w.owner.userId, w.tripId, {
      limit: 2,
      cursor: first.nextCursor ?? '',
    });
    expect(next).toMatchObject({ nextCursor: null });
    expect(next.items.map((i) => i.id)).toEqual(ids.slice(2));
  });

  it('refuses organizer, member, viewer with forbidden; lets owner', async () => {
    const w = await inviteWorld(tdb);
    for (const who of [w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      expect(await refusal(invites.list(who.userId, w.tripId, { limit: 10 }))).toBe('forbidden');
    }
    await expect(invites.list(w.owner.userId, w.tripId, { limit: 10 })).resolves.toMatchObject({
      items: [],
    });
  });

  it('answers not_found to an account outside the trip', async () => {
    const w = await inviteWorld(tdb);
    expect(await refusal(invites.list(w.outsider.userId, w.tripId, { limit: 10 }))).toBe(
      'not_found',
    );
  });
});
