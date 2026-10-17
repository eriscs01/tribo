import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id at the OWASP minimums (19 MiB, 2 passes, 1 lane); the library's default
 * algorithm is Argon2id, which the PHC string records. Tune upwards on the host, never down.
 */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Stored in password_hash when an account has no password (erased); never verifies. */
export const NO_PASSWORD = '!';

export function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON2);
}

/** A malformed or '!' hash simply fails; a hash is never an exception path. */
export async function verifySecret(phc: string, secret: string): Promise<boolean> {
  if (phc === NO_PASSWORD) return false;
  try {
    return await verify(phc, secret);
  } catch {
    return false;
  }
}

/** Hashed for unknown usernames so a miss costs the same time as a wrong password. */
let decoy: Promise<string> | undefined;
export async function burnPasswordCheck(secret: string): Promise<void> {
  decoy ??= hashSecret(randomBytes(16).toString('hex'));
  await verifySecret(await decoy, secret);
}

/** Length rules only (NIST SP 800-63B): at least 12 characters, at most 128. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// --- Opaque tokens (sessions; later reset links and PATs) -----------------------------

/** A 256-bit random token for the client, and the SHA-256 the database keeps. */
export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// --- TOTP (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) ---------------------------------

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept one step either side, for clock drift between the phone and the host. */
const DRIFT_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

/** The URI authenticator apps read from a QR code or a pasted link. */
export function totpUri(secret: Buffer, issuer: string, username: string): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret: base32(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function totpAt(secret: Buffer, unixSeconds: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / STEP_SECONDS)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

export function totpValid(secret: Buffer, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const given = Buffer.from(code);
  let ok = false;
  for (let step = -DRIFT_STEPS; step <= DRIFT_STEPS; step++) {
    const expected = Buffer.from(totpAt(secret, now / 1000 + step * STEP_SECONDS));
    // No early exit: every candidate is compared, in constant time.
    ok = timingSafeEqual(given, expected) || ok;
  }
  return ok;
}

// --- Recovery codes -------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** `xxxxx-xxxxx`: 10 characters from 31 (about 50 bits), easy to read and type. */
export function newRecoveryCode(): string {
  const chars = Array.from({ length: 10 }, () =>
    RECOVERY_ALPHABET.charAt(randomInt(RECOVERY_ALPHABET.length)),
  );
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** Case and the dash are forgiven when a code is typed back. */
export function normalizeRecoveryCode(code: string): string {
  const bare = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return bare.length === 10 ? `${bare.slice(0, 5)}-${bare.slice(5)}` : bare;
}
