import type { ErrorCode } from '@tribo/contract';
import type { ValueOf } from '@tribo/db';

type TripRole = ValueOf<'tribo.memberships.trip_role'>;

/** R29: an archived trip is read-only, except that it can still be deleted and restored. */
const WRITES_ON_ARCHIVED = new Set(['trips.delete', 'trips.restore']);
/** A deleted trip takes no writes but its own restore. */
const WRITES_ON_DELETED = new Set(['trips.restore']);

/** Why a write under this trip is refused, or null when the trip takes it. */
export function tripWriteRefusal(
  trip: { archived: boolean; deleted: boolean },
  operationId: string,
): ErrorCode | null {
  if (trip.deleted && !WRITES_ON_DELETED.has(operationId)) return 'not_found';
  if (trip.archived && !WRITES_ON_ARCHIVED.has(operationId)) return 'trip_archived';
  return null;
}

/** trips.create: the owner of a trip must have signed in with a second factor. */
export function tripCreateRefusal(caller: { mfaVerified: boolean }): ErrorCode | null {
  return caller.mfaVerified ? null : 'mfa_required';
}

/** trips.get: every member reads the trip, viewers included. */
const TRIP_READERS: ReadonlySet<TripRole> = new Set(['owner', 'organizer', 'member', 'viewer']);

export function canGetTrip(role: TripRole): boolean {
  return TRIP_READERS.has(role);
}

/** trips.update: the owner and organizers edit the trip. */
const TRIP_EDITORS: ReadonlySet<TripRole> = new Set(['owner', 'organizer']);

export function canUpdateTrip(role: TripRole): boolean {
  return TRIP_EDITORS.has(role);
}

/** trips.delete: the owner alone deletes the trip. */
export function canDeleteTrip(role: TripRole): boolean {
  return role === 'owner';
}

/**
 * The stored statuses in lifecycle order; `archived` is derived from archived_at (R40).
 * policy.test.ts checks this holds exactly the statuses the database allows.
 */
export const LIFECYCLE = [
  'draft',
  'planning',
  'active',
  'completed',
] as const satisfies readonly ValueOf<'tribo.trips.status'>[];

/**
 * trips.update moves a trip's status forward only, skipping steps if it likes; staying put
 * is no move. `archived` is set by trips.archive alone, so asking for it here is refused.
 */
export function statusMoveRefusal(from: string, to: string): ErrorCode | null {
  const at = (s: string) => LIFECYCLE.findIndex((step) => step === s);
  const target = at(to);
  return target !== -1 && target >= at(from) ? null : 'invalid_transition';
}

/** members.list: every member reads who else is in the trip, viewers included. */
export function canListMembers(role: TripRole): boolean {
  return TRIP_READERS.has(role);
}

/** members.add: the owner alone adds travellers (and invites, sets roles and removes). */
export function canAddMember(role: TripRole): boolean {
  return role === 'owner';
}

/** members.setRole: the owner alone sets roles and cost grants. */
export function canSetMemberRole(role: TripRole): boolean {
  return role === 'owner';
}

/** Every role but a viewer reads costs anyway; only a viewer's are a grant (can_view_costs). */
export function takesCostGrant(role: TripRole): boolean {
  return role === 'viewer';
}

/**
 * members.setRole, asked by the owner: why this membership may not take this role, or null.
 * The owner steps down only by handing the trip to another member (G14), who needs an
 * account with MFA, as every owner does.
 */
export function roleChangeRefusal(change: {
  to: TripRole;
  /** The membership is the owner's own. */
  ownMembership: boolean;
  /** For a handover: the new owner is an account with MFA on. */
  newOwnerHasMfa: boolean;
}): ErrorCode | null {
  if (change.ownMembership) return change.to === 'owner' ? null : 'owner_transfer_required';
  if (change.to === 'owner' && !change.newOwnerHasMfa) return 'mfa_required';
  return null;
}

/** invites.create, .list and .revoke: the owner alone manages the trip's invite links. */
export function canManageInvites(role: TripRole): boolean {
  return role === 'owner';
}

/** An invite's standing, derived on every read from its row and the clock (R40). */
export function inviteStatus(
  invite: { revokedAt: Date | null; expiresAt: Date; uses: number; maxUses: number | null },
  now: Date,
): 'active' | 'revoked' | 'expired' | 'used_up' {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.expiresAt <= now) return 'expired';
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return 'used_up';
  return 'active';
}

/**
 * members.remove: why the caller may not remove this membership, or null. The owner removes
 * anyone but themself: they leave only by handing the trip over first (G14), as they step
 * down. Any other member may remove only themself, which is leaving the trip.
 */
export function removalRefusal(removal: {
  callerRole: TripRole;
  /** The membership is the caller's own. */
  own: boolean;
}): ErrorCode | null {
  if (removal.own) return removal.callerRole === 'owner' ? 'owner_transfer_required' : null;
  return removal.callerRole === 'owner' ? null : 'forbidden';
}
