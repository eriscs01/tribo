// invites.accept: joining a trip from an invite link, as a new account or signed in, and
// the per-trip placeholder claim (R28). Private to the trips module; invites.ts mounts it.
import { InviteAcceptInput } from '@tribo/contract';
import { tokenHash } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  actingUser,
  ApiError,
  validate,
  type RequestContext,
  type Tx,
  type WriteRecord,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordEvent, recordWrite } from '../audit/service.js';
import { invitedAccounts, type ClientInfo, type SignedIn } from '../identity/service.js';
import { accountPersonId, memberPersons, mergeClaimedPlaceholder } from '../library/service.js';
import {
  activePlaceholder,
  memberRecord,
  membershipWrite,
  type MemberItems,
  recordInviteRevoked,
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

/** invites.accept's answer: the joiner's membership, and a new account's session. */
export interface AcceptedInvite {
  member: MemberRecord;
  /** null for a signed-in joiner: they keep the session they joined with. */
  session: { token: string; session: SignedIn } | null;
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
export function acceptInvite(db: Kysely<DB>, memberItems: MemberItems) {
  return async (
    ctx: RequestContext,
    body: unknown,
    // Where a join came from; identity stores it on the session, never in audit.
    client: ClientInfo,
  ): Promise<AcceptedInvite> => {
    const input = validate(InviteAcceptInput, body);
    if (input.account && ctx.userId !== null) {
      throw new ApiError('validation_failed', {
        errors: [{ path: '/account', message: 'already signed in' }],
      });
    }
    if (!input.account && ctx.userId === null) throw new ApiError('unauthenticated');
    // Argon2id is slow: hashed before the transaction, for every token alike.
    const passwordHash = input.account
      ? await invitedAccounts.hashPassword(input.account.password)
      : null;

    return db.transaction().execute(async (tx) => {
      const invite = await findLiveInvite(forModule(tx, 'trips'), tokenHash(input.token), {
        lock: true,
      });
      if (!invite) throw new ApiError('invite_invalid');
      await guardTrip(tx, invite.trip_id, 'invites.accept');
      const placeholder =
        invite.person_id === null
          ? null
          : await lockedPlaceholder(tx, invite.trip_id, invite.person_id);

      let joiner: Joiner;
      if (input.account && passwordHash !== null) {
        const { username, displayName } = input.account;
        const made = await invitedAccounts.create(tx, ctx, {
          username,
          passwordHash,
          displayName: displayName ?? placeholder?.displayName ?? username,
        });
        joiner = { ...made, username };
      } else {
        joiner = await signedInJoiner(tx, ctx);
      }
      const as = { ...ctx, userId: joiner.userId };
      const { row, records, closed } = placeholder
        ? await claim(tx, { invite, placeholder, joiner })
        : await join(tx, memberItems, { invite, joiner });
      // eslint-disable-next-line no-await-in-loop -- audit events chain, so they append in order
      for (const record of records) await recordWrite(tx, as, record);
      // eslint-disable-next-line no-await-in-loop -- as above
      for (const id of closed) await recordInviteRevoked(tx, as, id, invite.trip_id);

      await useInvite(forModule(tx, 'trips'), invite.id);
      await recordEvent(tx, as, {
        action: 'update',
        entityType: 'invite',
        entityId: invite.id,
        tripId: invite.trip_id,
      });
      const session =
        joiner.username === null
          ? null
          : await invitedAccounts.signIn(
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
  const found = await activePlaceholder(tx, tripId, personId);
  if (!found) throw new ApiError('invite_invalid');
  return { personId, membership: found.membership, displayName: found.person.displayName };
}

/** The live invite a join takes one use of, as findLiveInvite reads it. */
type LiveInvite = NonNullable<Awaited<ReturnType<typeof findLiveInvite>>>;

/** What a claim or an open join wrote: the membership, its records, the links it closed. */
interface Joined {
  row: MembershipRow;
  records: WriteRecord[];
  closed: string[];
}

/**
 * R28, the claim: only this trip's placeholder membership moves to the joiner's person,
 * with the invite's role; the trip's other links to the placeholder close; and a
 * placeholder left with no membership row anywhere is merged into the joiner.
 */
async function claim(
  tx: Tx,
  { invite, placeholder, joiner }: { invite: LiveInvite; placeholder: Placeholder; joiner: Joiner },
): Promise<Joined> {
  const trips = forModule(tx, 'trips');
  if (await lockMembershipOf(trips, invite.trip_id, joiner.personId)) {
    throw new ApiError('claim_conflict');
  }
  const closed = await revokePlaceholderInvites(trips, {
    tripId: invite.trip_id,
    personId: placeholder.personId,
    exceptInviteId: invite.id,
  });
  const role = invite.role as InviteRole;
  const row = await claimMembership(trips, placeholder.membership.id, {
    personId: joiner.personId,
    role,
    canViewCosts: takesCostGrant(role) && placeholder.membership.can_view_costs,
    updatedBy: joiner.userId,
  });
  const records: WriteRecord[] = [
    { ...membershipWrite('claim', row), versionBefore: placeholder.membership.version },
  ];
  if ((await countMembershipRows(trips, placeholder.personId)) === 0) {
    records.push(
      await mergeClaimedPlaceholder(tx, {
        personId: placeholder.personId,
        into: joiner.personId,
        by: joiner.userId,
      }),
    );
  }
  return { row, records, closed };
}

/**
 * An open invite: the joiner's new membership with the invite's role, or, for a rejoin,
 * their earlier membership back with what its removal took (R32).
 */
async function join(
  tx: Tx,
  memberItems: MemberItems,
  { invite, joiner }: { invite: LiveInvite; joiner: Joiner },
): Promise<Joined> {
  const trips = forModule(tx, 'trips');
  const role = invite.role as InviteRole;
  const existing = await lockMembershipOf(trips, invite.trip_id, joiner.personId);
  if (existing?.deleted_at === null) throw new ApiError('already_member');
  if (!existing) {
    const row = await insertMembership(trips, {
      tripId: invite.trip_id,
      personId: joiner.personId,
      role,
      createdBy: joiner.userId,
    });
    return {
      row,
      records: [{ ...membershipWrite('create', row), versionBefore: null }],
      closed: [],
    };
  }
  const row = await undeleteMembership(trips, existing.id, { role, updatedBy: joiner.userId });
  const items = await memberItems.rejoin(tx, {
    tripId: invite.trip_id,
    membershipId: row.id,
    userId: joiner.userId,
  });
  return {
    row,
    records: [{ ...membershipWrite('restore', row), versionBefore: existing.version }, ...items],
    closed: [],
  };
}

/** The signed-in caller as a joiner; every account has its own person. */
async function signedInJoiner(tx: Tx, ctx: RequestContext): Promise<Joiner> {
  const userId = actingUser(ctx);
  const personId = await accountPersonId(tx, userId);
  if (personId === null) throw new ApiError('forbidden');
  return { userId, personId, username: null };
}
