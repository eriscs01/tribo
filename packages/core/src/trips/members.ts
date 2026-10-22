// The members service: a trip's memberships as members.list, .add and .setRole read and
// write them. Memberships are the trips module's table; service.ts exposes this file.
import {
  decodeTypeId,
  ID_PREFIX,
  MemberAddInput,
  MemberPatch,
  type PageQuery,
} from '@tribo/contract';
import type { Keyring } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  ApiError,
  encodeCursor,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import {
  createPlaceholder,
  memberPersons,
  personAccountId,
  visiblePerson,
} from '../library/service.js';
import { writeOperation } from '../write-operation.js';
import {
  actingUser,
  callerMembership,
  idCursor,
  memberRecord,
  membershipChange,
  membershipWrite,
  requireRole,
  type MemberRecord,
} from './membership.js';
import {
  canAddMember,
  canListMembers,
  canSetMemberRole,
  roleChangeRefusal,
  takesCostGrant,
} from './policy.js';
import {
  insertMembership,
  listMemberships,
  lockMembership,
  lockMembershipOf,
  undeleteMembership,
  updateMembershipRole,
  type MembershipRow,
  type TripRole,
} from './repo.js';

export interface MembersService {
  /** members.list: the trip's active memberships, oldest first, to any member of it. */
  list(
    userId: string,
    tripId: string,
    page: PageQuery,
  ): Promise<{ items: MemberRecord[]; nextCursor: string | null }>;
  /**
   * members.add: the owner adds a placeholder traveller, new or from their library. A person
   * with an account joins by invite instead (R4); a removed placeholder is brought back.
   */
  add(ctx: RequestContext, tripId: string, body: unknown): Promise<MemberRecord>;
  /**
   * members.setRole: the owner changes a member's role or a viewer's cost grant, under
   * If-Match on the membership's version. Making another member owner hands the trip over
   * (G14).
   */
  setRole(
    ctx: RequestContext,
    tripId: string,
    membershipId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<MemberRecord>;
}

const membersAdd = writeOperation('members.add', MemberAddInput);
const membersSetRole = writeOperation('members.setRole', MemberPatch);

/** What members.add locks: the library person's earlier row in the trip, if it has one. */
interface MemberAddLoaded {
  tripId: string;
  /** The library person asked for; null for a new placeholder. */
  personId: string | null;
  existing?: MembershipRow & { deleted_at: Date | null };
  counter?: number;
}

/** Identity's answer to whether an account has MFA on (accountHasMfa in identity/service.ts). */
export type MfaCheck = (db: Kysely<DB>, userId: string) => Promise<boolean>;

/**
 * `write` is core's write path and `hasMfa` identity's MFA check, both passed in to keep
 * imports acyclic (identity's service reaches the write path, which reaches this one).
 */
export function createMembersService(
  db: Kysely<DB>,
  write: WritePath,
  keys: Keyring,
  hasMfa: MfaCheck,
): MembersService {
  return {
    async list(userId, tripId, page) {
      await requireRole(db, userId, tripId, canListMembers);
      const after = page.cursor === undefined ? null : idCursor(page.cursor);
      // One extra row says whether another page follows.
      const rows = await listMemberships(forModule(db, 'trips'), tripId, {
        limit: page.limit + 1,
        after,
      });
      const shown = rows.slice(0, page.limit);
      const persons = await memberPersons(
        db,
        shown.map((r) => r.person_id),
      );
      const items = shown.map((r) => memberRecord(r, persons));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > page.limit && last ? encodeCursor([last.id]) : null,
      };
    },

    add: (ctx, tripId, body) =>
      write(ctx, {
        operation: membersAdd,
        target: { tripId },
        body,
        ifMatch: undefined,
        authorize: (tx, c, target) => requireRole(tx, actingUser(c), target.tripId, canAddMember),
        load: async (tx, target, input): Promise<MemberAddLoaded> => {
          if (!('personId' in input)) return { tripId: target.tripId, personId: null };
          const personId = decodeTypeId(ID_PREFIX.person, input.personId);
          const existing = await lockMembershipOf(forModule(tx, 'trips'), target.tripId, personId);
          return existing
            ? { tripId: target.tripId, personId, existing, counter: existing.version }
            : { tripId: target.tripId, personId };
        },
        mutate: async (tx, c, loaded, input) => {
          const userId = actingUser(c);
          const trips = forModule(tx, 'trips');
          const join = (personId: string) =>
            insertMembership(trips, {
              tripId: loaded.tripId,
              personId,
              role: input.role ?? 'member',
              createdBy: userId,
            });
          if ('person' in input) {
            const { result: person, ...created } = await createPlaceholder(tx, keys, {
              createdBy: userId,
              person: input.person,
            });
            return {
              ...membershipChange('create', await join(person.id), person),
              related: [{ ...created, versionBefore: null }],
            };
          }
          const person =
            loaded.personId === null ? null : await visiblePerson(tx, userId, loaded.personId);
          if (person === null) {
            throw new ApiError('validation_failed', {
              errors: [{ path: '/personId', message: 'no such person' }],
            });
          }
          if (person.hasAccount) throw new ApiError('person_has_account');
          const { existing } = loaded;
          if (!existing) return membershipChange('create', await join(person.id), person);
          if (existing.deleted_at === null) throw new ApiError('already_member');
          const role = input.role ?? 'member';
          const row = await undeleteMembership(trips, existing.id, { role, updatedBy: userId });
          return membershipChange('restore', row, person);
        },
      }),

    setRole: (ctx, tripId, membershipId, body, ifMatch) =>
      write(ctx, {
        operation: membersSetRole,
        target: { tripId, membershipId },
        body,
        ifMatch,
        authorize: (tx, c, target) =>
          requireRole(tx, actingUser(c), target.tripId, canSetMemberRole),
        load: async (tx, target) => {
          const row = await lockMembership(forModule(tx, 'trips'), target);
          if (!row) throw new ApiError('not_found');
          return { tripId: row.trip_id, counter: row.version, row };
        },
        mutate: async (tx, c, { row }, patch) => {
          const userId = actingUser(c);
          const trips = forModule(tx, 'trips');
          const role = patch.role ?? (row.trip_role as TripRole);
          const caller = await callerMembership(tx, userId, row.trip_id);
          if (caller === null) throw new Error('members.setRole lost its authorized caller');
          if (patch.canViewCosts !== undefined && !takesCostGrant(role)) {
            throw new ApiError('validation_failed', {
              errors: [{ path: '/canViewCosts', message: 'only a viewer takes a cost grant' }],
            });
          }
          const ownMembership = row.id === caller.id;
          const handover = role === 'owner' && !ownMembership;
          const refusal = roleChangeRefusal({
            to: role,
            ownMembership,
            newOwnerHasMfa: handover && (await accountWithMfa(tx, row.person_id, hasMfa)),
          });
          if (refusal) throw new ApiError(refusal);
          // One owner per trip (memberships_one_owner): the old owner steps down first.
          const demoted = handover
            ? await updateMembershipRole(trips, caller.id, {
                role: 'organizer',
                canViewCosts: false,
                updatedBy: userId,
              })
            : undefined;
          const updated = await updateMembershipRole(trips, row.id, {
            role,
            canViewCosts: takesCostGrant(role) && (patch.canViewCosts ?? row.can_view_costs),
            updatedBy: userId,
          });
          const persons = await memberPersons(tx, [updated.person_id]);
          const person = persons.get(updated.person_id);
          if (!person) throw new Error(`membership ${updated.id} has no person`);
          const change = membershipChange('role_change', updated, person);
          if (!demoted) return change;
          const stepDown = membershipWrite('role_change', demoted);
          return { ...change, related: [{ ...stepDown, versionBefore: demoted.version - 1 }] };
        },
      }),
  };
}

/** Whether the person is an account with MFA on; a placeholder has neither. */
async function accountWithMfa(tx: Tx, personId: string, hasMfa: MfaCheck): Promise<boolean> {
  const userId = await personAccountId(tx, personId);
  return userId !== null && (await hasMfa(tx, userId));
}
