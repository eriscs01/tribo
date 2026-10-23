import { VALUE_SETS, type TripRole } from '@tribo/db';
import { describe, expect, it } from 'vitest';
import {
  anyMember,
  contributors,
  itemManager,
  itemOwnerOrOrganizer,
  organizers,
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

  it('itemOwnerOrOrganizer: the item owner whatever their role now, or organizers', () => {
    for (const role of ROLES) {
      expect(itemOwnerOrOrganizer({ role, owns: true })).toBe(true);
      expect(itemOwnerOrOrganizer({ role, owns: false })).toBe(organizers(role));
    }
  });
});
