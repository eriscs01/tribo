import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AppKey } from './app-key.js';

const ALGORITHM = 'aes-256-gcm';
const VERSION_BYTES = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The row and column a sensitive value belongs to: the value only decrypts there. */
export interface FieldRef {
  /** Table name without schema, e.g. `users`. */
  table: string;
  /** The `*_enc` column, e.g. `mfa_secret_enc`. */
  column: string;
  /** The row's uuid as stored in the database (not the TypeID). */
  rowId: string;
}

export class EnvelopeError extends Error {
  override name = 'EnvelopeError';
}

/** Keys by version; `current` encrypts, any listed version decrypts. */
export interface Keyring {
  current: AppKey;
  get(version: number): AppKey | undefined;
}

export function keyring(current: AppKey, ...older: AppKey[]): Keyring {
  const byVersion = new Map([...older, current].map((k) => [k.version, k]));
  if (byVersion.size !== older.length + 1) throw new EnvelopeError('two app keys share a version');
  return { current, get: (version) => byVersion.get(version) };
}

/** AAD = `<table>.<column>:<row id>`, as the 0001_init.sql header defines it. */
export function fieldAad({ table, column, rowId }: FieldRef): Buffer {
  if (!IDENTIFIER.test(table)) throw new EnvelopeError(`bad table name ${table}`);
  if (!IDENTIFIER.test(column) || !column.endsWith('_enc')) {
    throw new EnvelopeError(`bad column ${column}: sensitive columns end in _enc`);
  }
  return Buffer.from(`${table}.${column}:${rowUuid(rowId)}`, 'utf8');
}

/** A row id as AAD binds it: a lowercase uuid, never a TypeID. */
export function rowUuid(rowId: string): string {
  const id = rowId.toLowerCase();
  if (!UUID.test(id)) throw new EnvelopeError('row id must be a uuid');
  return id;
}

/** Encrypts a value for one row's column: key_version (1 byte) ‖ nonce (12) ‖ ciphertext ‖ tag (16). */
export function seal(keys: Keyring, field: FieldRef, plaintext: Buffer | string): Buffer {
  const key = keys.current;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes(), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(fieldAad(field));
  const body = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.of(key.version), nonce, body, cipher.getAuthTag()]);
}

/**
 * Decrypts an envelope for the row and column it was sealed for. A value copied to another
 * row, column or table, a tampered byte or an unknown key all fail the same way, naming the
 * field but nothing about the value.
 */
export function open(keys: Keyring, field: FieldRef, envelope: Buffer): Buffer {
  const where = `${field.table}.${field.column}`;
  if (envelope.length < VERSION_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new EnvelopeError(`${where}: envelope too short`);
  }
  const version = envelope.readUInt8(0);
  const key = keys.get(version);
  if (!key) throw new EnvelopeError(`${where}: no app key with version ${String(version)}`);
  const nonce = envelope.subarray(VERSION_BYTES, VERSION_BYTES + NONCE_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const body = envelope.subarray(VERSION_BYTES + NONCE_BYTES, envelope.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key.bytes(), nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(fieldAad(field));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new EnvelopeError(`${where}: value does not decrypt for this row`);
  }
}

/** Structured values are JSON-encoded before encryption (0001 header). */
export function sealJson(keys: Keyring, field: FieldRef, value: unknown): Buffer {
  return seal(keys, field, JSON.stringify(value));
}

export function openJson(keys: Keyring, field: FieldRef, envelope: Buffer): unknown {
  return JSON.parse(open(keys, field, envelope).toString('utf8')) as unknown;
}
