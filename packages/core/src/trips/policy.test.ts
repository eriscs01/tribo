import { describe, expect, it } from 'vitest';
import { VALUE_SETS } from '@tribo/db';
import {
  canAddMember,
  canListMembers,
  canSetMemberRole,
  roleChangeRefusal,
  takesCostGrant,
  LIFECYCLE,
  statusMoveRefusal,
  tripCreateRefusal,
  tripWriteRefusal,
} from './policy.js';

const open = { archived: false, deleted: false };
const archived = { archived: true, deleted: false };
const deleted = { archived: false, deleted: true };

describe('tripWriteRefusal', () => {
  it('lets every write through on an open trip', () => {
    expect(tripWriteRefusal(open, 'items.update')).toBeNull();
  });

  it('R29: an archived trip takes only delete and restore', () => {
    expect(tripWriteRefusal(archived, 'items.create')).toBe('trip_archived');
    expect(tripWriteRefusal(archived, 'trips.update')).toBe('trip_archived');
    expect(tripWriteRefusal(archived, 'trips.delete')).toBeNull();
    expect(tripWriteRefusal(archived, 'trips.restore')).toBeNull();
  });

  it('a deleted trip takes only its restore', () => {
    expect(tripWriteRefusal(deleted, 'items.create')).toBe('not_found');
    expect(tripWriteRefusal(deleted, 'trips.delete')).toBe('not_found');
    expect(tripWriteRefusal(deleted, 'trips.restore')).toBeNull();
  });
});

describe('tripCreateRefusal', () => {
  it('needs a session that passed a second factor', () => {
    expect(tripCreateRefusal({ mfaVerified: true })).toBeNull();
    expect(tripCreateRefusal({ mfaVerified: false })).toBe('mfa_required');
  });
});

describe('statusMoveRefusal', () => {
  it('orders every status the database allows, and only those', () => {
    expect([...LIFECYCLE].sort()).toEqual([...VALUE_SETS['tribo.trips.status']].sort());
  });

  it('moves forward, one step or several, and stays put', () => {
    expect(statusMoveRefusal('draft', 'planning')).toBeNull();
    expect(statusMoveRefusal('draft', 'completed')).toBeNull();
    expect(statusMoveRefusal('active', 'active')).toBeNull();
  });

  it('never moves back', () => {
    expect(statusMoveRefusal('active', 'planning')).toBe('invalid_transition');
    expect(statusMoveRefusal('completed', 'draft')).toBe('invalid_transition');
  });

  it('leaves archiving to trips.archive', () => {
    expect(statusMoveRefusal('completed', 'archived')).toBe('invalid_transition');
  });
});

describe('canListMembers', () => {
  it('lets every role read who is in the trip', () => {
    for (const role of VALUE_SETS['tribo.memberships.trip_role']) {
      expect(canListMembers(role)).toBe(true);
    }
  });
});

describe('canAddMember', () => {
  it('lets only the owner add travellers', () => {
    expect(canAddMember('owner')).toBe(true);
    for (const role of ['organizer', 'member', 'viewer'] as const) {
      expect(canAddMember(role)).toBe(false);
    }
  });
});

describe('canSetMemberRole', () => {
  it('lets only the owner set roles', () => {
    expect(canSetMemberRole('owner')).toBe(true);
    for (const role of ['organizer', 'member', 'viewer'] as const) {
      expect(canSetMemberRole(role)).toBe(false);
    }
  });
});

describe('takesCostGrant', () => {
  it('is a viewer-only grant: every other role reads costs anyway', () => {
    expect(takesCostGrant('viewer')).toBe(true);
    for (const role of ['owner', 'organizer', 'member'] as const) {
      expect(takesCostGrant(role)).toBe(false);
    }
  });
});

describe('roleChangeRefusal', () => {
  const other = { ownMembership: false, newOwnerHasMfa: false };

  it('changes any other role freely', () => {
    for (const to of ['organizer', 'member', 'viewer'] as const) {
      expect(roleChangeRefusal({ ...other, to })).toBeNull();
    }
  });

  it('G14: hands the trip only to an account with MFA', () => {
    expect(roleChangeRefusal({ ...other, to: 'owner' })).toBe('mfa_required');
    expect(roleChangeRefusal({ ...other, to: 'owner', newOwnerHasMfa: true })).toBeNull();
  });

  it('keeps the owner owner until they hand the trip over', () => {
    const own = { ownMembership: true, newOwnerHasMfa: false };
    expect(roleChangeRefusal({ ...own, to: 'organizer' })).toBe('owner_transfer_required');
    expect(roleChangeRefusal({ ...own, to: 'owner' })).toBeNull();
  });
});
