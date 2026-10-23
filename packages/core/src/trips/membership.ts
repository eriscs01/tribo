// What the trips module's services share about memberships: who the caller is inside a trip,
// the role check every trips-module operation makes, and how a membership is recorded and
// shown. Private to the module; service.ts, members.ts and invites.ts build on it.
import { forModule, type DB, type TripRole } from '@tribo/db';
import {
  ApiError,
  type Change,
  type RequestContext,
  type Tx,
  type WriteRecord,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordEvent } from '../audit/service.js';
import {
  accountPersonId,
  memberPersons,
  personAccountId,
  type PersonRecord,
} from '../library/service.js';
import {
  activeMembershipIds,
  countActiveMemberships,
  findActiveMembership,
  findMembershipPersons,
  lockMembershipOf,
  type MembershipRow,
} from './repo.js';

/** The caller inside a trip: their membership, its role, and whether costs show to them. */
export interface CallerMembership {
  id: string;
  role: TripRole;
  /** Every role but a viewer reads costs; a viewer only with can_view_costs. */
  canViewCosts: boolean;
}

/** Inside a trip a person is their membership: the caller's active one, or null. */
export async function callerMembership(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
): Promise<CallerMembership | null> {
  const personId = await accountPersonId(db, userId);
  if (personId === null) return null;
  const row = await findActiveMembership(forModule(db, 'trips'), tripId, personId);
  if (!row) return null;
  const role = row.trip_role as TripRole;
  return { id: row.id, role, canViewCosts: role !== 'viewer' || row.can_view_costs };
}

/** True when every one of these is an active membership of the trip. */
export async function allActiveMemberships(
  db: Kysely<DB>,
  tripId: string,
  membershipIds: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(membershipIds)];
  return (await countActiveMemberships(forModule(db, 'trips'), tripId, unique)) === unique.length;
}

/** Which of these are active memberships of the trip: removed and foreign ones are left out. */
export async function activeMembershipSet(
  db: Kysely<DB>,
  tripId: string,
  membershipIds: readonly string[],
): Promise<Set<string>> {
  return new Set(
    await activeMembershipIds(forModule(db, 'trips'), tripId, [...new Set(membershipIds)]),
  );
}

/**
 * Which of these memberships of the trip are people holding a driving licence: the board's
 * no_licensed_driver check asks it of the drivers it seats.
 */
export async function licensedMemberships(
  db: Kysely<DB>,
  tripId: string,
  membershipIds: readonly string[],
): Promise<Set<string>> {
  if (membershipIds.length === 0) return new Set();
  const rows = await findMembershipPersons(forModule(db, 'trips'), tripId, membershipIds);
  const persons = await memberPersons(
    db,
    rows.map((r) => r.person_id),
  );
  return new Set(rows.filter((r) => persons.get(r.person_id)?.drivingLicence).map((r) => r.id));
}

/**
 * The caller's membership must allow the operation. A trip the caller is not in does not
 * exist for them.
 */
export async function requireRole(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
  allowed: (role: TripRole) => boolean,
): Promise<void> {
  const membership = await callerMembership(db, userId, tripId);
  if (membership === null) throw new ApiError('not_found');
  if (!allowed(membership.role)) throw new ApiError('forbidden');
}

/**
 * R28: the person's membership of the trip while it is active and the person still a
 * placeholder (no account), locked FOR UPDATE until commit, with the person; null
 * otherwise. What a placeholder invite needs, at create and again at accept.
 */
export async function activePlaceholder(
  tx: Tx,
  tripId: string,
  personId: string,
): Promise<{ membership: MembershipRow; person: PersonRecord } | null> {
  const membership = await lockMembershipOf(forModule(tx, 'trips'), tripId, personId);
  if (membership?.deleted_at !== null) return null;
  const person = (await memberPersons(tx, [personId])).get(personId);
  if (!person || (await personAccountId(tx, personId)) !== null) return null;
  return { membership, person };
}

/** A membership with the person behind it, as members.list shows it. */
export interface MemberRecord {
  id: string;
  tripId: string;
  role: TripRole;
  /** Every role but a viewer reads costs; a viewer only with can_view_costs. */
  canViewCosts: boolean;
  person: PersonRecord;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export function memberRecord(row: MembershipRow, persons: Map<string, PersonRecord>): MemberRecord {
  const person = persons.get(row.person_id);
  if (!person) throw new Error(`membership ${row.id} has no person ${row.person_id}`);
  const role = row.trip_role as TripRole;
  return {
    id: row.id,
    tripId: row.trip_id,
    role,
    canViewCosts: role !== 'viewer' || row.can_view_costs,
    person,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The membership's stored fields, as entity_versions keeps them. */
export function membershipSnapshot(row: MembershipRow) {
  return { personId: row.person_id, role: row.trip_role, canViewCosts: row.can_view_costs };
}

/** The write's change for a membership just written, with the person behind it. */
type MembershipAction = 'create' | 'restore' | 'role_change' | 'delete' | 'claim';

export function membershipChange(
  action: MembershipAction,
  row: MembershipRow,
  person: PersonRecord,
): Change<MemberRecord> {
  return {
    ...membershipWrite(action, row),
    result: memberRecord(row, new Map([[person.id, person]])),
  };
}

/** A membership write as its snapshot and event record it. */
export function membershipWrite(action: MembershipAction, row: MembershipRow) {
  return {
    action,
    aggregate: 'membership',
    entityId: row.id,
    tripId: row.trip_id,
    version: row.version,
    snapshot: membershipSnapshot(row),
  };
}

/** A membership leaving or rejoining its trip, and the account acting on it. */
export interface MemberMove {
  tripId: string;
  membershipId: string;
  userId: string;
}

/**
 * The items module's side of a membership's removal and rejoin (R32), passed in by the
 * composition because the items service already reaches this one. Each runs in the
 * membership write's transaction and returns the records that write stores with its own.
 */
export interface MemberItems {
  /** Takes the member off every board and soft-deletes the private items they own. */
  leave(tx: Tx, move: MemberMove): Promise<WriteRecord[]>;
  /** Brings back the private items the member's latest removal soft-deleted. */
  rejoin(tx: Tx, move: MemberMove): Promise<WriteRecord[]>;
}

/** The revoke event of an invite a claim or a removal closed. */
export function recordInviteRevoked(tx: Tx, ctx: RequestContext, inviteId: string, tripId: string) {
  return recordEvent(tx, ctx, {
    action: 'revoke',
    entityType: 'invite',
    entityId: inviteId,
    tripId,
  });
}
