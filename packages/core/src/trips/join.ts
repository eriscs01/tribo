// invites.accept: joining a trip from an invite link, as a new account or signed in, and
// the per-trip placeholder claim (R28). Private to the trips module; invites.ts mounts it.
import { InviteAcceptInput } from '@tribo/contract';
import { tokenHash } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  ApiError,
  validate,
  type RequestContext,
  type Tx,
  type WriteRecord,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordEvent, recordWrite } from '../audit/service.js';
import {
  accountPersonId,
  memberPersons,
  mergeClaimedPlaceholder,
  personAccountId,
} from '../library/service.js';
import {
  memberRecord,
  membershipWrite,
  type MemberItems,
  type MemberRecord,
} from './membership.js';
import { takesCostGrant } from './policy.js';
import {
  claimMembership,
  countMembershipRows,
  findLiveInvite,
  insertMembership,
  lockMembershipOf,
  revokePlaceholderInvites,
  undeleteMembership,
  useInvite,
  type InviteRole,
  type MembershipRow,
} from './repo.js';
import { guardTrip } from './trip-guard.js';

/** Where a join came from; identity stores it on the session, never in audit. */
export interface JoinClient {
  ip: string | null;
  userAgent: string | null;
}

/**
 * What a join asks of identity (invitedAccounts in identity/service.ts), passed in because
 * identity's service reaches the write path, which reaches this module. `S` is the session
 * a new account is signed in with.
 */
export interface InviteAccounts<S> {
  hashPassword(password: string): Promise<string>;
  create(
    tx: Tx,
    ctx: RequestContext,
    account: { username: string; passwordHash: string; displayName: string },
  ): Promise<{ userId: string; personId: string }>;
  signIn(
    tx: Tx,
    ctx: RequestContext,
    account: { userId: string; username: string },
    client: JoinClient,
  ): Promise<S>;
}

/** invites.accept's answer: the joiner's membership, and a new account's session. */
export interface AcceptedInvite<S> {
  member: MemberRecord;
  /** null for a signed-in joiner: they keep the session they joined with. */
  session: S | null;
}

/** The account a join acts as: made by it, or the signed-in caller. */
interface Joiner {
  userId: string;
  personId: string;
  /** Set for a new account, which the join signs in. */
  username: string | null;
}

/** A placeholder invite's placeholder member, locked until commit. */
interface Placeholder {
  personId: string;
  membership: MembershipRow;
  displayName: string;
}

/**
 * invites.accept, in one transaction: the live invite (locked, so two joins never both take
 * its last use), the trip guard, the joiner's account, the claim or the join, one use of the
 * invite, and a new account's session. Each write records its own event and snapshot as the
 * joiner. The write path is not used: the actor is only known once the account exists, and
 * invites are credentials with no counter of their own.
 */
export function acceptInvite<S>(
  db: Kysely<DB>,
  ports: { accounts: InviteAccounts<S>; memberItems: MemberItems },
) {
  const { accounts, memberItems } = ports;
  return async (
    ctx: RequestContext,
    body: unknown,
    client: JoinClient,
  ): Promise<AcceptedInvite<S>> => {
    const input = validate(InviteAcceptInput, body);
    if (input.account && ctx.userId !== null) {
      throw new ApiError('validation_failed', {
        errors: [{ path: '/account', message: 'already signed in' }],
      });
    }
    if (!input.account && ctx.userId === null) throw new ApiError('unauthenticated');
    // Argon2id is slow: hashed before the transaction, for every token alike.
    const passwordHash = input.account ? await accounts.hashPassword(input.account.password) : null;

    return db.transaction().execute(async (tx) => {
      const trips = forModule(tx, 'trips');
      const invite = await findLiveInvite(trips, tokenHash(input.token), { lock: true });
      if (!invite) throw new ApiError('invite_invalid');
      await guardTrip(tx, invite.trip_id, 'invites.accept');
      const placeholder =
        invite.person_id === null
          ? null
          : await lockedPlaceholder(tx, invite.trip_id, invite.person_id);

      let joiner: Joiner;
      if (input.account && passwordHash !== null) {
        const { username, displayName } = input.account;
        const made = await accounts.create(tx, ctx, {
          username,
          passwordHash,
          displayName: displayName ?? placeholder?.displayName ?? username,
        });
        joiner = { ...made, username };
      } else {
        joiner = await signedInJoiner(tx, ctx);
      }
      const as = { ...ctx, userId: joiner.userId };
      const role = invite.role as InviteRole;
      const move = { tripId: invite.trip_id, userId: joiner.userId };

      const records: WriteRecord[] = [];
      let row: MembershipRow;
      if (placeholder) {
        if (await lockMembershipOf(trips, invite.trip_id, joiner.personId)) {
          throw new ApiError('claim_conflict');
        }
        const others = await revokePlaceholderInvites(trips, {
          tripId: invite.trip_id,
          personId: placeholder.personId,
          exceptInviteId: invite.id,
        });
        row = await claimMembership(trips, placeholder.membership.id, {
          personId: joiner.personId,
          role,
          canViewCosts: takesCostGrant(role) && placeholder.membership.can_view_costs,
          updatedBy: joiner.userId,
        });
        records.push({
          ...membershipWrite('claim', row),
          versionBefore: placeholder.membership.version,
        });
        if ((await countMembershipRows(trips, placeholder.personId)) === 0) {
          records.push(
            await mergeClaimedPlaceholder(tx, {
              personId: placeholder.personId,
              into: joiner.personId,
              by: joiner.userId,
            }),
          );
        }
        // eslint-disable-next-line no-await-in-loop -- audit events chain, so they append in order
        for (const id of others) await revoked(tx, as, id, invite.trip_id);
      } else {
        const existing = await lockMembershipOf(trips, invite.trip_id, joiner.personId);
        if (existing?.deleted_at === null) throw new ApiError('already_member');
        if (existing) {
          // A rejoin: the earlier membership comes back, with what its removal took (R32).
          row = await undeleteMembership(trips, existing.id, { role, updatedBy: joiner.userId });
          records.push({ ...membershipWrite('restore', row), versionBefore: existing.version });
          records.push(...(await memberItems.rejoin(tx, { ...move, membershipId: row.id })));
        } else {
          row = await insertMembership(trips, {
            tripId: invite.trip_id,
            personId: joiner.personId,
            role,
            createdBy: joiner.userId,
          });
          records.push({ ...membershipWrite('create', row), versionBefore: null });
        }
      }
      // eslint-disable-next-line no-await-in-loop -- audit events chain, so they append in order
      for (const record of records) await recordWrite(tx, as, record);

      await useInvite(trips, invite.id);
      await recordEvent(tx, as, {
        action: 'update',
        entityType: 'invite',
        entityId: invite.id,
        tripId: invite.trip_id,
      });
      const session =
        joiner.username === null
          ? null
          : await accounts.signIn(
              tx,
              as,
              { userId: joiner.userId, username: joiner.username },
              client,
            );
      const persons = await memberPersons(tx, [row.person_id]);
      return { member: memberRecord(row, persons), session };
    });
  };
}

/**
 * R28: a placeholder invite's placeholder must still be an active member of the trip and
 * still a placeholder, else the link opens nothing (invite_invalid, as for any dead link).
 */
async function lockedPlaceholder(tx: Tx, tripId: string, personId: string): Promise<Placeholder> {
  const membership = await lockMembershipOf(forModule(tx, 'trips'), tripId, personId);
  const person = (await memberPersons(tx, [personId])).get(personId);
  if (
    membership?.deleted_at !== null ||
    !person ||
    (await personAccountId(tx, personId)) !== null
  ) {
    throw new ApiError('invite_invalid');
  }
  return { personId, membership, displayName: person.displayName };
}

/** The signed-in caller as a joiner; every account has its own person. */
async function signedInJoiner(tx: Tx, ctx: RequestContext): Promise<Joiner> {
  if (ctx.userId === null) throw new ApiError('unauthenticated');
  const personId = await accountPersonId(tx, ctx.userId);
  if (personId === null) throw new ApiError('forbidden');
  return { userId: ctx.userId, personId, username: null };
}

/** The revoke event of an invite a claim closed. */
function revoked(tx: Tx, ctx: RequestContext, inviteId: string, tripId: string) {
  return recordEvent(tx, ctx, {
    action: 'revoke',
    entityType: 'invite',
    entityId: inviteId,
    tripId,
  });
}
