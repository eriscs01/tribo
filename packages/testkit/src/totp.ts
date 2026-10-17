import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * What an authenticator app shows: RFC 6238 (SHA-1, 30 s, 6 digits) for a base32 key.
 * Written independently of the identity module, so tests check it against an outside oracle.
 */
export function totpFor(base32Key: string, at = Date.now()): string {
  let bits = '';
  for (const char of base32Key.replace(/=+$/, '')) {
    bits += BASE32.indexOf(char.toUpperCase()).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
