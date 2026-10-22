import { describe, expect, it } from 'vitest';
import { newToken, tokenHash } from './token.js';

describe('opaque tokens', () => {
  it('are 32 random bytes, kept only as their SHA-256', () => {
    const { token, hash } = newToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toHaveLength(32);
    expect(tokenHash(token).equals(hash)).toBe(true);
    expect(newToken().token).not.toBe(token);
  });
});
