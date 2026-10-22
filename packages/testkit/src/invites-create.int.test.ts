// @module-tag drop-a
// invites.create (Drop A): Create link: role, expiry, maxUses, optional placeholder; Token shown once; placeholder invite single use; Secret omitted on idempotent replay (redacted = true): revoke and recreate (R2); Link format /join#<token> (fragment, never in proxy logs); Pre-linked person must be an active placeholder member of this trip (FK + check), else invite_invalid (R28); trip_archived on archived trips (R29)
import { createHash } from 'node:crypto';
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import type { InvitesService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, history, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addMember, createPlaceholder, createUser, softDelete } from './factories.js';
import { invitesService, inviteWorld, storedInvite, tomorrow } from './invite-world.js';

let tdb: TestDatabase;
let invites: InvitesService;
const as = contexts('req-invite-create');

beforeAll(async () => {
  tdb = await createTestDatabase();
  invites = invitesService(tdb);
});
afterAll(() => tdb.destroy());

const personTid = (id: string) => encodeTypeId(ID_PREFIX.person, id);

describe('invites.create', () => {
  it('shows a 256-bit token once in a /join# link and stores only its SHA-256', async () => {
    const w = await inviteWorld(tdb);
    const expiresAt = tomorrow();
    const created = await invites.create(as(w.owner), w.tripId, {
      role: 'member',
      expiresAt,
      maxUses: 5,
    });
    expect(created).toMatchObject({
      tripId: w.tripId,
      role: 'member',
      personId: null,
      maxUses: 5,
      uses: 0,
      status: 'active',
      revokedAt: null,
    });
    expect(created.expiresAt.toISOString()).toBe(expiresAt);
    // 32 random bytes as base64url, carried in the fragment of the configured public URL.
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.link).toBe(`https://tribo.test/join#${created.token}`);
    const row = await storedInvite(tdb, created.id);
    expect(row.token_hash).toEqual(createHash('sha256').update(created.token).digest());
    expect(JSON.stringify(row)).not.toContain(created.token);
  });

  it('refuses organizer, member, viewer with forbidden; lets owner', async () => {
    const w = await inviteWorld(tdb);
    const body = { role: 'member', expiresAt: tomorrow() };
    for (const who of [w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      expect(await refusal(invites.create(as(who), w.tripId, body))).toBe('forbidden');
    }
    await expect(invites.create(as(w.owner), w.tripId, body)).resolves.toMatchObject({
      role: 'member',
    });
  });

  it('answers not_found to an account outside the trip', async () => {
    const w = await inviteWorld(tdb);
    const body = { role: 'member', expiresAt: tomorrow() };
    expect(await refusal(invites.create(as(w.outsider), w.tripId, body))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await inviteWorld(tdb);
    const bad = [
      { role: 'owner', expiresAt: tomorrow() },
      { role: 'member', expiresAt: tomorrow(), maxUses: 0 },
      { role: 'member' },
      { personId: personTid(w.guest.personId), expiresAt: tomorrow(), maxUses: 2 },
    ];
    for (const body of bad) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      expect(await refusal(invites.create(as(w.owner), w.tripId, body))).toBe('validation_failed');
    }
    const past = await invites
      .create(as(w.owner), w.tripId, { role: 'member', expiresAt: '2020-01-01T00:00:00Z' })
      .catch((e: unknown) => e);
    expect(past).toMatchObject({
      code: 'validation_failed',
      extra: { errors: [{ path: '/expiresAt', message: 'must be in the future' }] },
    });
    const stored = await tdb.db
      .selectFrom('tribo.invites')
      .select('id')
      .where('trip_id', '=', w.tripId)
      .execute();
    expect(stored).toEqual([]);
  });

  it('records its audit event in the one transaction, naming the invite and never its token', async () => {
    const w = await inviteWorld(tdb);
    const ctx = as(w.owner);
    const created = await invites.create(ctx, w.tripId, { role: 'viewer', expiresAt: tomorrow() });
    const { events, snapshots } = await history(tdb, created.id);
    expect(events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'create',
        entity_type: 'invite',
        version_before: null,
        version_after: null,
        request_id: ctx.requestId,
      },
    ]);
    // Invites are credentials: never versioned, never snapshotted (0001_init.sql, rule 1).
    expect(snapshots).toEqual([]);
    const rows = await tdb.db
      .selectFrom('audit.audit_events')
      .selectAll()
      .where('request_id', '=', ctx.requestId)
      .execute();
    expect(JSON.stringify(rows)).not.toContain(created.token);
  });

  it('pre-links a placeholder member: single use, its own role by default', async () => {
    const w = await inviteWorld(tdb);
    const created = await invites.create(as(w.owner), w.tripId, {
      personId: personTid(w.guest.personId),
      expiresAt: tomorrow(),
    });
    expect(created).toMatchObject({ personId: w.guest.personId, role: 'viewer', maxUses: 1 });
    const chosen = await invites.create(as(w.owner), w.tripId, {
      personId: personTid(w.guest.personId),
      role: 'member',
      expiresAt: tomorrow(),
    });
    expect(chosen).toMatchObject({ role: 'member', maxUses: 1 });
  });

  it('answers invite_invalid where operations.csv says so: the person is no active placeholder member here', async () => {
    const w = await inviteWorld(tdb);
    const elsewhere = await createPlaceholder(tdb.db, { createdBy: w.owner.userId });
    const removed = await createPlaceholder(tdb.db, { createdBy: w.owner.userId });
    const removedMembership = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: removed,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', removedMembership);
    const stranger = await createUser(tdb.db);
    const cases = [
      elsewhere, // a placeholder, but not in this trip
      removed, // removed from this trip
      w.member.personId, // a member, but an account
      stranger.personId, // nobody here
      '0190f2c4-0000-7000-8000-000000000000', // nobody at all
    ];
    for (const personId of cases) {
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      const code = await refusal(
        invites.create(as(w.owner), w.tripId, {
          personId: personTid(personId),
          expiresAt: tomorrow(),
        }),
      );
      expect(code).toBe('invite_invalid');
    }
  });

  it('answers trip_archived where operations.csv says so', async () => {
    const w = await inviteWorld(tdb);
    await archive(tdb, w.tripId);
    const code = await refusal(
      invites.create(as(w.owner), w.tripId, { role: 'member', expiresAt: tomorrow() }),
    );
    expect(code).toBe('trip_archived');
  });

  it('Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.', async () => {
    const w = await inviteWorld(tdb);
    const body = { role: 'member', expiresAt: tomorrow() };
    const ctx = as(w.owner);
    const first = await invites.create(ctx, w.tripId, body);
    const second = await invites.create(ctx, w.tripId, body);
    // Each create is its own invite with its own token: nothing is replayed.
    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(second.redacted).toBe(false);
  });
});
