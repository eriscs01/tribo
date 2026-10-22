import { createHash, randomBytes } from 'node:crypto';

/**
 * A 256-bit random opaque token for the client (sessions, reset links, invite links), and
 * the SHA-256 the database keeps: a stolen table holds nothing that opens a door.
 */
export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
