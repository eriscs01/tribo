import { describe, expect, it } from 'vitest';
import { actingUser, type RequestContext } from './context.js';

describe('actingUser', () => {
  const ctx: RequestContext = { requestId: 'r', surface: 'web', userId: 'u1' };

  it('is the account behind the request', () => {
    expect(actingUser(ctx)).toBe('u1');
  });

  it('refuses work with no account behind it as unauthenticated', () => {
    expect(() => actingUser({ ...ctx, userId: null })).toThrow(
      expect.objectContaining({ code: 'unauthenticated' }),
    );
  });
});
