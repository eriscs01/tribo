import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';

export const APP_KEY_BYTES = 32;
export const DEFAULT_APP_KEY_FILE = '/run/secrets/app_key';

export class AppKeyError extends Error {
  override name = 'AppKeyError';
}

/**
 * The 32-byte AES-256 app key. The bytes live in a private field and every way of printing
 * the object (String, JSON, util.inspect, so also pino and console) shows only its version
 * and fingerprint, never the key.
 */
export class AppKey {
  readonly #bytes: Buffer;
  /** First 8 hex characters of the key's SHA-256: safe to log, enough to tell keys apart. */
  readonly fingerprint: string;

  constructor(
    bytes: Buffer,
    /** Stored as the envelope's first byte, so rotation can re-encrypt in steps. */
    readonly version = 1,
  ) {
    if (bytes.length !== APP_KEY_BYTES) {
      throw new AppKeyError(
        `app key must be ${String(APP_KEY_BYTES)} bytes, got ${String(bytes.length)}`,
      );
    }
    if (!Number.isInteger(version) || version < 1 || version > 255) {
      throw new AppKeyError('app key version must be 1–255');
    }
    this.#bytes = Buffer.from(bytes);
    this.fingerprint = createHash('sha256').update(this.#bytes).digest('hex').slice(0, 8);
  }

  /** The raw key, for the cipher only. */
  bytes(): Buffer {
    return this.#bytes;
  }

  toString(): string {
    return `AppKey(v${String(this.version)}, ${this.fingerprint})`;
  }

  toJSON(): { version: number; fingerprint: string } {
    return { version: this.version, fingerprint: this.fingerprint };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * Parses an app key file: 32 raw bytes (`openssl rand -out app_key 32`) or their base64
 * (`openssl rand -base64 32`). Errors name the size, never the content.
 */
export function parseAppKey(file: Buffer, version = 1): AppKey {
  if (file.length === APP_KEY_BYTES) return new AppKey(file, version);
  const text = file.toString('latin1').trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return new AppKey(Buffer.from(text, 'base64'), version);
  throw new AppKeyError(
    `app key file must hold ${String(APP_KEY_BYTES)} raw bytes or their base64; it holds ${String(file.length)} bytes`,
  );
}

/** Reads the app key from its Docker secret file. */
export async function loadAppKey(path = DEFAULT_APP_KEY_FILE, version = 1): Promise<AppKey> {
  let file: Buffer;
  try {
    file = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new AppKeyError(`cannot read app key file ${path} (${code})`);
  }
  try {
    return parseAppKey(file, version);
  } finally {
    file.fill(0);
  }
}
