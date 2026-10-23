import { describe, expect, it } from 'vitest';
import { ApiError, onConstraint } from './errors.js';

/** What pg throws for a violated constraint: an Error carrying the constraint's name. */
function violation(constraint: string): Error {
  return Object.assign(new Error('duplicate key value'), { constraint });
}

describe('onConstraint', () => {
  const map = { users_username_key: () => new ApiError('username_taken') };

  it("turns a named constraint's violation into its contract error", () => {
    expect(() => onConstraint(violation('users_username_key'), map)).toThrow(
      expect.objectContaining({ code: 'username_taken' }),
    );
  });

  it('rethrows any other constraint as it is, never swallowed', () => {
    const other = violation('items_time_order');
    expect(() => onConstraint(other, map)).toThrow(other);
  });

  it('rethrows an error that names no constraint', () => {
    const plain = new Error('connection reset');
    expect(() => onConstraint(plain, map)).toThrow(plain);
  });

  it("does not take an inherited property's name for a mapped constraint", () => {
    const inherited = violation('toString');
    expect(() => onConstraint(inherited, map)).toThrow(inherited);
  });
});
