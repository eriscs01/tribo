import { describe, expect, it } from 'vitest';
import { tripCreateRefusal, tripWriteRefusal } from './policy.js';

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
