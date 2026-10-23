import { VALUE_SETS, type TripRole } from '@tribo/db';
import { describe, expect, it } from 'vitest';
import {
  anyMember,
  contributors,
  itemManager,
  ownerOrOrganizer,
  organizers,
  organizersOrOwningMember,
  ownerOnly,
} from './roles.js';

const ROLES = VALUE_SETS['tribo.memberships.trip_role'];
const allowed = (rule: (role: TripRole) => boolean) => ROLES.filter(rule);

describe('shared trip-role rules', () => {
  it('anyMember lets every role in, viewers included', () => {
    expect(allowed(anyMember)).toEqual(['owner', 'organizer', 'member', 'viewer']);
  });

  it('contributors are everyone but a viewer', () => {
    expect(allowed(contributors)).toEqual(['owner', 'organizer', 'member']);
  });

  it('organizers are the owner and organizers', () => {
    expect(allowed(organizers)).toEqual(['owner', 'organizer']);
  });

  it('ownerOnly is the owner alone', () => {
    expect(allowed(ownerOnly)).toEqual(['owner']);
  });

  it('itemManager: organizers, or a member who owns the item; never an assignee or a viewer', () => {
    for (const role of ROLES) {
      expect(itemManager({ role, owns: false, assigned: true })).toBe(organizers(role));
      expect(itemManager({ role, owns: true, assigned: false })).toBe(role !== 'viewer');
    }
  });

  it('ownerOrOrganizer: the item owner whatever their role now, or organizers', () => {
    for (const role of ROLES) {
      expect(ownerOrOrganizer({ role, owns: true })).toBe(true);
      expect(ownerOrOrganizer({ role, owns: false })).toBe(organizers(role));
    }
  });

  it('organizersOrOwningMember: organizers, or a member on what they own; never a viewer, even an owning one', () => {
    for (const role of ROLES) {
      expect(organizersOrOwningMember({ role, owns: false })).toBe(organizers(role));
      expect(organizersOrOwningMember({ role, owns: true })).toBe(role !== 'viewer');
    }
  });
});
