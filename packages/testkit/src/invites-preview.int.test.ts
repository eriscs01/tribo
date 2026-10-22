// @module-tag drop-a
// invites.preview (Drop A): Trip name, role, placeholder name for a token; Token in body; invite_invalid; Read only; no key (R2)
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import type { InvitesService } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, contexts, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { softDelete } from './factories.js';
import {
  invitesService,
  inviteWorld,
  membersService,
  storedInvite,
  tomorrow,
} from './invite-world.js';

let tdb: TestDatabase;
let invites: InvitesService;
const as = contexts('req-invite-preview');

beforeAll(async () => {
  tdb = await createTestDatabase();
  invites = invitesService(tdb);
});
afterAll(() => tdb.destroy());

/** One invite of each kind that opens nothing, and the token each one carries. */
async function deadLinks() {
  const w = await inviteWorld(tdb);
  const open = (extra: object = {}) =>
    invites.create(as(w.owner), w.tripId, { role: 'member', expiresAt: tomorrow(), ...extra });
  const expired = await open();
  await tdb.db
    .updateTable('tribo.invites')
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where('id', '=', expired.id)
    .execute();
  const revoked = await open();
  await invites.revoke(as(w.owner), w.tripId, revoked.id, undefined);
  const usedUp = await open({ maxUses: 1 });
  await tdb.db.updateTable('tribo.invites').set({ uses: 1 }).where('id', '=', usedUp.id).execute();
  const unclaimable = await invites.create(as(w.owner), w.tripId, {
    personId: encodeTypeId(ID_PREFIX.person, w.guest.personId),
    expiresAt: tomorrow(),
  });
  await membersService(tdb.db).remove(as(w.owner), w.tripId, w.guest.membershipId, undefined, 1);

  const archived = await inviteWorld(tdb);
  const onArchived = await invites.create(as(archived.owner), archived.tripId, {
    role: 'member',
    expiresAt: tomorrow(),
  });
  await archive(tdb, archived.tripId);
  const deleted = await inviteWorld(tdb);
  const onDeleted = await invites.create(as(deleted.owner), deleted.tripId, {
    role: 'member',
    expiresAt: tomorrow(),
  });
  await softDelete(tdb.db, 'tribo.trips', deleted.tripId);

  return {
    unknown: 'a'.repeat(43),
    expired: expired.token,
    revoked: revoked.token,
    usedUp: usedUp.token,
    unclaimable: unclaimable.token,
    archived: onArchived.token,
    deleted: onDeleted.token,
  };
}

/** The error a call failed with, whole: code, detail and extra must not tell cases apart. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      const error = e as ApiError;
      return { code: error.code, message: error.message, extra: error.extra };
    },
  );

describe('invites.preview', () => {
  it('enforces the roles column: anyone with link sees the trip name and the role it gives', async () => {
    const w = await inviteWorld(tdb);
    const { token } = await invites.create(as(w.owner), w.tripId, {
      role: 'organizer',
      expiresAt: tomorrow(),
    });
    await expect(invites.preview({ token })).resolves.toEqual({
      tripName: 'Sagada long weekend',
      role: 'organizer',
      placeholderName: null,
    });
  });

  it('names the placeholder a placeholder invite lets the joiner claim, and nothing else of theirs', async () => {
    const w = await inviteWorld(tdb);
    const { token } = await invites.create(as(w.owner), w.tripId, {
      personId: encodeTypeId(ID_PREFIX.person, w.guest.personId),
      expiresAt: tomorrow(),
    });
    await expect(invites.preview({ token })).resolves.toEqual({
      tripName: 'Sagada long weekend',
      role: 'viewer',
      placeholderName: 'Lola Pacing',
    });
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    for (const body of [{}, { token: '' }, { token: 7 }, { token: 'x', extra: 1 }]) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      expect(await refusal(invites.preview(body))).toBe('validation_failed');
    }
  });

  it('is read only: no use counted, no audit event, no snapshot', async () => {
    const w = await inviteWorld(tdb);
    const created = await invites.create(as(w.owner), w.tripId, {
      role: 'member',
      expiresAt: tomorrow(),
      maxUses: 1,
    });
    await invites.preview({ token: created.token });
    await invites.preview({ token: created.token });
    expect((await storedInvite(tdb, created.id)).uses).toBe(0);
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .select('action')
      .where('entity_id', '=', created.id)
      .execute();
    expect(events.map((e) => e.action)).toEqual(['create']);
  });

  it('answers invite_invalid where operations.csv says so: one answer for every link that opens nothing', async () => {
    const links = await deadLinks();
    const answers = await Promise.all(
      Object.values(links).map((token) => failure(invites.preview({ token }))),
    );
    expect(answers[0]).toEqual({ code: 'invite_invalid', message: 'invite_invalid', extra: {} });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('asks the database the same one question for every dead link, so timing tells none apart', async () => {
    const links = await deadLinks();
    let queries = 0;
    const counting: KyselyPlugin = {
      transformQuery: (args) => {
        queries += 1;
        return args.node;
      },
      transformResult: (args) => Promise.resolve(args.result),
    };
    const counted = invitesService({ db: tdb.db.withPlugin(counting) });
    const perCase: Record<string, number> = {};
    for (const [name, token] of Object.entries(links)) {
      queries = 0;
      // eslint-disable-next-line no-await-in-loop -- one count at a time
      await failure(counted.preview({ token }));
      perCase[name] = queries;
    }
    expect(new Set(Object.values(perCase))).toEqual(new Set([1]));
  });
});
