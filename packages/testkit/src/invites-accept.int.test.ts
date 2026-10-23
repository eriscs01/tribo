// @module-tag drop-a
// invites.accept (Drop A): Join: new account (username+password) or signed-in; claims placeholder; username_taken, already_member, invite_invalid; Claim is per trip (R28): new account → its own person is created first; then only this trip's placeholder membership moves to the caller's person (tickets, allocations, shares follow the membership id); the placeholder never gains an account and stays in its other trips; when it has no membership rows left it is scrubbed, soft-deleted and mergedInto the caller; claim_conflict if the caller's person already has a row in this trip. Rejoin undeletes the caller's earlier membership in the trip. Anonymous Idempotency-Key caller = invite:<inviteId>; Set-Cookie never replayed
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import { createIdentityService, type MembersService, writePath } from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addAllocation,
  addMember,
  createItem,
  createPlaceholder,
  createTrip,
  createUser,
  softDelete,
  type UserFixture,
} from './factories.js';
import {
  invitesService,
  inviteWorld,
  membersService,
  storedInvite,
  tomorrow,
} from './invite-world.js';
import { testKeys } from './keys.js';

const PASSWORD = 'correct horse battery';
const CLIENT = { ip: '2001:db8::7', userAgent: 'vitest' };

let tdb: TestDatabase;
let invites: ReturnType<typeof invitesService>;
let members: MembersService;
let n = 0;
const ctxOf = (userId: string | null): RequestContext => {
  n += 1;
  return { requestId: `req-invite-accept-${String(n)}`, surface: 'web', userId };
};
const as = (user: UserFixture) => ctxOf(user.userId);
const anonymous = () => ctxOf(null);
const newAccount = (extra: object = {}) => {
  n += 1;
  return { username: `joiner_${String(n)}`, password: PASSWORD, ...extra };
};

beforeAll(async () => {
  tdb = await createTestDatabase();
  invites = invitesService(tdb);
  members = membersService(tdb.db);
});
afterAll(() => tdb.destroy());

type World = Awaited<ReturnType<typeof inviteWorld>>;
const openInvite = (w: World, extra: object = {}) =>
  invites.create(as(w.owner), w.tripId, { role: 'member', expiresAt: tomorrow(), ...extra });
const claimInvite = (w: World, personId: string, tripId = w.tripId) =>
  invites.create(as(w.owner), tripId, {
    personId: encodeTypeId(ID_PREFIX.person, personId),
    expiresAt: tomorrow(),
  });

const userNamed = (username: string) =>
  tdb.db
    .selectFrom('tribo.users')
    .select(['id', 'status', 'platform_role'])
    .where('username', '=', username)
    .executeTakeFirst();
const person = (id: string) =>
  tdb.db.selectFrom('tribo.persons').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const membershipRow = (id: string) =>
  tdb.db
    .selectFrom('tribo.memberships')
    .select(['trip_id', 'person_id', 'trip_role', 'version', 'deleted_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
const eventsOf = (requestId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('request_id', '=', requestId)
    .orderBy('id')
    .execute();

describe('invites.accept', () => {
  it('enforces the roles column: anyone with link joins, as a new account or signed in', async () => {
    const w = await inviteWorld(tdb);
    const invite = await openInvite(w, { role: 'viewer', maxUses: 5 });
    const account = newAccount({ displayName: 'Ate Joy' });
    const joined = await invites.accept(anonymous(), { token: invite.token, account }, CLIENT);
    const created = await userNamed(account.username);
    expect(created).toMatchObject({ status: 'active', platform_role: 'user' });
    expect(joined.member).toMatchObject({
      tripId: w.tripId,
      role: 'viewer',
      canViewCosts: false,
      version: 1,
      person: { displayName: 'Ate Joy', hasAccount: true },
    });
    // The new account is signed in, and the password it chose is the one it signs in with.
    expect(joined.session?.session).toMatchObject({ userId: created?.id, mfaVerified: false });
    const identity = createIdentityService(
      tdb.db,
      writePath(tdb.db),
      testKeys(),
      'Tribo (tribo.test)',
    );
    await expect(identity.authenticate(joined.session?.token ?? '')).resolves.toMatchObject({
      userId: created?.id,
    });
    await expect(
      identity.login(
        anonymous(),
        { username: account.username, password: PASSWORD },
        { ip: null, userAgent: null },
      ),
    ).resolves.toMatchObject({ session: { userId: created?.id } });

    // A signed-in outsider sends the token alone and joins as themself.
    const signedIn = await invites.accept(as(w.outsider), { token: invite.token }, CLIENT);
    expect(signedIn.session).toBeNull();
    expect(signedIn.member).toMatchObject({
      role: 'viewer',
      person: { id: w.outsider.personId },
    });
    expect((await storedInvite(tdb, invite.id)).uses).toBe(2);
    const listed = await members.list(w.owner.userId, w.tripId, { limit: 50 });
    expect(listed.items.map((m) => m.id)).toEqual(
      expect.arrayContaining([joined.member.id, signedIn.member.id]),
    );
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await inviteWorld(tdb);
    const invite = await openInvite(w);
    const bad = [
      {},
      { token: '' },
      { token: invite.token, account: { username: 'x', password: PASSWORD } },
      { token: invite.token, account: { username: 'joiner_short', password: 'short' } },
      { token: invite.token, extra: true },
    ];
    for (const body of bad) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      expect(await refusal(invites.accept(anonymous(), body, CLIENT))).toBe('validation_failed');
    }
    // Signed in and asking for a new account at once is ambiguous: refused too.
    const both = await invites
      .accept(as(w.outsider), { token: invite.token, account: newAccount() }, CLIENT)
      .catch((e: unknown) => e);
    expect(both).toMatchObject({
      code: 'validation_failed',
      extra: { errors: [{ path: '/account', message: 'already signed in' }] },
    });
    // No account and no session: nobody to join as.
    expect(await refusal(invites.accept(anonymous(), { token: invite.token }, CLIENT))).toBe(
      'unauthenticated',
    );
    expect((await storedInvite(tdb, invite.id)).uses).toBe(0);
  });

  it('records its audit events and entity_versions snapshots in the one transaction, as the joiner, never the token', async () => {
    const w = await inviteWorld(tdb);
    const invite = await openInvite(w);
    const ctx = anonymous();
    const account = newAccount();
    const joined = await invites.accept(ctx, { token: invite.token, account }, CLIENT);
    const userId = joined.session?.session.userId;
    const events = await eventsOf(ctx.requestId);
    expect(events.map((e) => [e.entity_type, e.action, e.entity_id])).toEqual([
      ['user', 'create', userId],
      ['person', 'create', joined.member.person.id],
      ['membership', 'create', joined.member.id],
      ['invite', 'update', invite.id],
      ['user', 'login', userId],
    ]);
    expect(new Set(events.map((e) => e.actor_user_id))).toEqual(new Set([userId]));
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'version'])
      .where('entity_id', 'in', [userId ?? '', joined.member.person.id, joined.member.id])
      .orderBy('entity_type')
      .execute();
    expect(snapshots).toEqual([
      { entity_type: 'membership', version: 1 },
      { entity_type: 'person', version: 1 },
      { entity_type: 'user', version: 1 },
    ]);
    const stored = JSON.stringify([events, snapshots]);
    expect(stored).not.toContain(invite.token);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(joined.session?.token);
  });

  it('answers username_taken where operations.csv says so, writing nothing', async () => {
    const w = await inviteWorld(tdb);
    const invite = await openInvite(w);
    const taken = newAccount();
    await createUser(tdb.db, { username: taken.username });
    expect(
      await refusal(invites.accept(anonymous(), { token: invite.token, account: taken }, CLIENT)),
    ).toBe('username_taken');
    expect((await storedInvite(tdb, invite.id)).uses).toBe(0);
  });

  it('answers invite_invalid where operations.csv says so: the same answer for every dead link, creating no account', async () => {
    const w = await inviteWorld(tdb);
    const expired = await openInvite(w);
    await tdb.db
      .updateTable('tribo.invites')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', expired.id)
      .execute();
    const revoked = await openInvite(w);
    await invites.revoke(as(w.owner), w.tripId, revoked.id, undefined);
    const usedUp = await openInvite(w, { maxUses: 1 });
    await invites.accept(as(w.outsider), { token: usedUp.token }, CLIENT);
    const placeholderGone = await claimInvite(w, w.guest.personId);
    await softDelete(tdb.db, 'tribo.memberships', w.guest.membershipId);
    const archivedWorld = await inviteWorld(tdb);
    const onArchived = await openInvite(archivedWorld);
    await archive(tdb, archivedWorld.tripId);

    const tokens = ['c'.repeat(43), expired, revoked, usedUp, placeholderGone, onArchived].map(
      (t) => (typeof t === 'string' ? t : t.token),
    );
    const answers = [];
    for (const token of tokens) {
      const account = newAccount();
      // eslint-disable-next-line no-await-in-loop -- one link at a time
      const error = await invites.accept(anonymous(), { token, account }, CLIENT).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      answers.push({ code: (error as ApiError).code, extra: (error as ApiError).extra });
      // eslint-disable-next-line no-await-in-loop -- as above
      expect(await userNamed(account.username)).toBeUndefined();
    }
    expect(answers[0]).toEqual({ code: 'invite_invalid', extra: {} });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('answers already_member where operations.csv says so', async () => {
    const w = await inviteWorld(tdb);
    const invite = await openInvite(w);
    expect(await refusal(invites.accept(as(w.member), { token: invite.token }, CLIENT))).toBe(
      'already_member',
    );
    expect((await storedInvite(tdb, invite.id)).uses).toBe(0);
  });

  it("answers claim_conflict where operations.csv says so: the caller's person already has a row here", async () => {
    const w = await inviteWorld(tdb);
    const invite = await claimInvite(w, w.guest.personId);
    expect(await refusal(invites.accept(as(w.member), { token: invite.token }, CLIENT))).toBe(
      'claim_conflict',
    );
    // A removed member's row is still their row: they rejoin with an open invite instead.
    await members.remove(as(w.viewer), w.tripId, w.viewer.membershipId, undefined, 1);
    expect(await refusal(invites.accept(as(w.viewer), { token: invite.token }, CLIENT))).toBe(
      'claim_conflict',
    );
    expect(await membershipRow(w.guest.membershipId)).toMatchObject({
      person_id: w.guest.personId,
      deleted_at: null,
    });
  });

  it("R28: a claim moves only this trip's placeholder membership; its rows follow the id, its other trips stay", async () => {
    const w = await inviteWorld(tdb);
    // The placeholder is also in a second trip of the same owner.
    const other = await createTrip(tdb.db, { owner: w.owner, name: 'Baguio food crawl' });
    const elsewhere = await addMember(tdb.db, {
      tripId: other.tripId,
      personId: w.guest.personId,
      role: 'member',
    });
    const hike = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
    });
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: hike,
      membershipId: w.guest.membershipId,
      role: 'attendee',
      rsvp: 'yes',
    });
    const invite = await claimInvite(w, w.guest.personId);
    const ctx = anonymous();
    const joined = await invites.accept(
      ctx,
      { token: invite.token, account: newAccount() },
      CLIENT,
    );
    // The same membership, now the joiner's own person, with the invite's role.
    expect(joined.member).toMatchObject({ id: w.guest.membershipId, role: 'viewer', version: 2 });
    expect(joined.member.person).toMatchObject({ displayName: 'Lola Pacing', hasAccount: true });
    expect(joined.member.person.id).not.toBe(w.guest.personId);
    const board = await tdb.db
      .selectFrom('tribo.allocations')
      .select('membership_id')
      .where('item_id', '=', hike)
      .execute();
    expect(board).toEqual([{ membership_id: w.guest.membershipId }]);
    // The placeholder never gains an account and keeps its other trip.
    expect(await person(w.guest.personId)).toMatchObject({
      user_id: null,
      deleted_at: null,
      merged_into: null,
    });
    expect(await membershipRow(elsewhere)).toMatchObject({
      trip_id: other.tripId,
      person_id: w.guest.personId,
      version: 1,
      deleted_at: null,
    });
    // The invite's pre-link follows the membership to who claimed it (ON UPDATE CASCADE).
    expect(await storedInvite(tdb, invite.id)).toMatchObject({
      person_id: joined.member.person.id,
      uses: 1,
    });
    const events = await eventsOf(ctx.requestId);
    expect(events.map((e) => [e.entity_type, e.action])).toEqual([
      ['user', 'create'],
      ['person', 'create'],
      ['membership', 'claim'],
      ['invite', 'update'],
      ['user', 'login'],
    ]);
    // Single use: the same link opens nothing now.
    expect(await refusal(invites.accept(as(w.outsider), { token: invite.token }, CLIENT))).toBe(
      'invite_invalid',
    );
  });

  it('R28: the placeholder is scrubbed, soft-deleted and merged into the caller only once no membership rows are left', async () => {
    const w = await inviteWorld(tdb);
    const { owner } = w;
    const guestId = await createPlaceholder(tdb.db, { createdBy: owner.userId });
    await tdb.db
      .updateTable('tribo.persons')
      .set({ dietary: 'No pork', contacts: JSON.stringify({ phone: '+63 917 000 0000' }) })
      .where('id', '=', guestId)
      .execute();
    const here = await addMember(tdb.db, { tripId: w.tripId, personId: guestId, role: 'member' });
    const second = await createTrip(tdb.db, { owner });
    const there = await addMember(tdb.db, {
      tripId: second.tripId,
      personId: guestId,
      role: 'member',
    });
    // A removed row in a third trip is still a row: it keeps the placeholder alive.
    const third = await createTrip(tdb.db, { owner });
    const removedThere = await addMember(tdb.db, {
      tripId: third.tripId,
      personId: guestId,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', removedThere);

    const joiner = await createUser(tdb.db);
    await invites.accept(as(joiner), { token: (await claimInvite(w, guestId)).token }, CLIENT);
    await invites.accept(
      as(joiner),
      { token: (await claimInvite(w, guestId, second.tripId)).token },
      CLIENT,
    );
    expect(await person(guestId)).toMatchObject({ deleted_at: null, merged_into: null });
    expect(await membershipRow(here)).toMatchObject({ person_id: joiner.personId });
    expect(await membershipRow(there)).toMatchObject({ person_id: joiner.personId });

    // The last row: the owner of the third trip brings the placeholder back and invites it.
    await members.add(as(owner), third.tripId, {
      personId: encodeTypeId(ID_PREFIX.person, guestId),
    });
    const ctx = as(joiner);
    await invites.accept(
      ctx,
      { token: (await claimInvite(w, guestId, third.tripId)).token },
      CLIENT,
    );
    expect(await person(guestId)).toMatchObject({
      user_id: null,
      merged_into: joiner.personId,
      deleted_at: expect.any(Date) as Date,
      deleted_by: joiner.userId,
      dietary: null,
      contacts: {},
      emergency_contact_enc: null,
    });
    const merge = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['action', 'request_id'])
      .where('entity_id', '=', guestId)
      .where('action', '=', 'merge')
      .execute();
    expect(merge).toEqual([{ action: 'merge', request_id: ctx.requestId }]);
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select('snapshot')
      .where('entity_id', '=', guestId)
      .orderBy('version', 'desc')
      .executeTakeFirstOrThrow();
    expect(snapshot.snapshot).toMatchObject({ mergedInto: joiner.personId, dietary: null });
  });

  it("R28: a claim closes the trip's other links to the same placeholder, which nobody can claim now", async () => {
    const w = await inviteWorld(tdb);
    const used = await claimInvite(w, w.guest.personId);
    const sibling = await claimInvite(w, w.guest.personId);
    const ctx = as(w.outsider);
    await invites.accept(ctx, { token: used.token }, CLIENT);
    expect(await storedInvite(tdb, sibling.id)).toMatchObject({
      revoked_at: expect.any(Date) as Date,
    });
    expect(await refusal(invites.preview({ token: sibling.token }))).toBe('invite_invalid');
    const events = await eventsOf(ctx.requestId);
    expect(events.filter((e) => e.entity_id === sibling.id).map((e) => e.action)).toEqual([
      'revoke',
    ]);
  });

  it("R28: the claimed membership keeps a viewer's cost grant only while it stays a viewer's", async () => {
    const grant = (membershipId: string) =>
      tdb.db
        .updateTable('tribo.memberships')
        .set({ can_view_costs: true })
        .where('id', '=', membershipId)
        .execute();
    const w = await inviteWorld(tdb);
    await grant(w.guest.membershipId);
    const asViewer = await claimInvite(w, w.guest.personId);
    const kept = await invites.accept(as(w.outsider), { token: asViewer.token }, CLIENT);
    expect(kept.member).toMatchObject({ role: 'viewer', canViewCosts: true });

    const other = await inviteWorld(tdb);
    await grant(other.guest.membershipId);
    const asMember = await invites.create(as(other.owner), other.tripId, {
      personId: encodeTypeId(ID_PREFIX.person, other.guest.personId),
      role: 'member',
      expiresAt: tomorrow(),
    });
    await invites.accept(as(other.outsider), { token: asMember.token }, CLIENT);
    const stored = await tdb.db
      .selectFrom('tribo.memberships')
      .select(['trip_role', 'can_view_costs'])
      .where('id', '=', other.guest.membershipId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ trip_role: 'member', can_view_costs: false });
  });

  it("rejoin: an open invite undeletes the caller's earlier membership and the private items its removal took", async () => {
    const w = await inviteWorld(tdb);
    const notes = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      visibility: 'private',
    });
    await members.remove(as(w.member), w.tripId, w.member.membershipId, undefined, 1);
    const invite = await openInvite(w, { role: 'organizer' });
    const ctx = as(w.member);
    const back = await invites.accept(ctx, { token: invite.token }, CLIENT);
    expect(back.member).toMatchObject({ id: w.member.membershipId, role: 'organizer', version: 3 });
    expect(
      await tdb.db
        .selectFrom('tribo.items')
        .select(['deleted_at', 'version'])
        .where('id', '=', notes)
        .executeTakeFirstOrThrow(),
    ).toEqual({ deleted_at: null, version: 3 });
    const events = await eventsOf(ctx.requestId);
    expect(events.map((e) => [e.entity_type, e.action])).toEqual([
      ['membership', 'restore'],
      ['item', 'restore'],
      ['invite', 'update'],
    ]);
  });

  it('takes an open invite up to maxUses, even when joins race for the last use', async () => {
    const w = await inviteWorld(tdb);
    const invite = await openInvite(w, { maxUses: 1 });
    const results = await Promise.allSettled(
      [newAccount(), newAccount()].map((account) =>
        invites.accept(anonymous(), { token: invite.token, account }, CLIENT),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.filter((r) => r.status === 'rejected').map((r) => r.reason as unknown);
    expect(lost).toEqual([expect.objectContaining({ code: 'invite_invalid' })]);
    expect((await storedInvite(tdb, invite.id)).uses).toBe(1);
  });

  it('Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.', async () => {
    const w = await inviteWorld(tdb);
    const invite = await openInvite(w);
    const ctx = as(w.outsider);
    await invites.accept(ctx, { token: invite.token }, CLIENT);
    // The same request again is a second join, refused as one: nothing is replayed.
    expect(await refusal(invites.accept(ctx, { token: invite.token }, CLIENT))).toBe(
      'already_member',
    );
  });
});
