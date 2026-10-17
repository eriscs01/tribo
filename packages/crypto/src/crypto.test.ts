import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AppKey, AppKeyError, loadAppKey, parseAppKey } from './app-key.js';
import { EnvelopeError, fieldAad, keyring, open, openJson, seal, sealJson } from './envelope.js';

const rowA = '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d';
const rowB = '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4e';
const booking = { table: 'items', column: 'booking_ref_enc', rowId: rowA };

const keyBytes = randomBytes(32);
const keys = keyring(new AppKey(keyBytes));

describe('envelope', () => {
  it('round-trips text and JSON', () => {
    expect(open(keys, booking, seal(keys, booking, 'PR-ABC123')).toString()).toBe('PR-ABC123');
    const contact = { name: 'Ana', relation: 'sister', phone: '+63 900 000 0000' };
    const field = { table: 'persons', column: 'emergency_contact_enc', rowId: rowA };
    expect(openJson(keys, field, sealJson(keys, field, contact))).toEqual(contact);
  });

  it('lays out key_version ‖ 12-byte nonce ‖ ciphertext ‖ 16-byte tag', () => {
    const plaintext = Buffer.from('0123456789');
    const env = seal(keys, booking, plaintext);
    expect(env.readUInt8(0)).toBe(1);
    expect(env.length).toBe(1 + 12 + plaintext.length + 16);
    expect(env.includes(plaintext)).toBe(false);
  });

  it('uses a fresh nonce for every value', () => {
    expect(seal(keys, booking, 'same').equals(seal(keys, booking, 'same'))).toBe(false);
  });

  it('binds AAD to table.column:row id', () => {
    expect(fieldAad(booking).toString()).toBe(`items.booking_ref_enc:${rowA}`);
    expect(fieldAad({ ...booking, rowId: rowA.toUpperCase() }).toString()).toBe(
      `items.booking_ref_enc:${rowA}`,
    );
  });

  it('refuses a ciphertext copied to another row, column or table', () => {
    const env = seal(keys, booking, 'PR-ABC123');
    expect(() => open(keys, { ...booking, rowId: rowB }, env)).toThrow(EnvelopeError);
    expect(() => open(keys, { ...booking, column: 'card_last4_enc' }, env)).toThrow(EnvelopeError);
    expect(() => open(keys, { ...booking, table: 'tickets' }, env)).toThrow(EnvelopeError);
  });

  it('refuses any tampered byte: version, nonce, ciphertext or tag', () => {
    const env = seal(keys, booking, 'PR-ABC123');
    for (const at of [1, 13, env.length - 1]) {
      const bad = Buffer.from(env);
      bad[at] = (bad[at] ?? 0) ^ 0x01;
      expect(() => open(keys, booking, bad), `byte ${String(at)}`).toThrow(EnvelopeError);
    }
    const otherVersion = Buffer.from(env);
    otherVersion[0] = 2;
    expect(() => open(keys, booking, otherVersion)).toThrow(/no app key with version 2/);
    expect(() => open(keys, booking, env.subarray(0, 28))).toThrow(/too short/);
  });

  it('refuses a value sealed with another key', () => {
    const other = keyring(new AppKey(randomBytes(32)));
    expect(() => open(other, booking, seal(keys, booking, 'x'))).toThrow(EnvelopeError);
  });

  it('decrypts older versions while sealing with the current key', () => {
    const v1 = new AppKey(randomBytes(32), 1);
    const v2 = new AppKey(randomBytes(32), 2);
    const old = seal(keyring(v1), booking, 'old');
    const rotated = keyring(v2, v1);
    expect(open(rotated, booking, old).toString()).toBe('old');
    expect(seal(rotated, booking, 'new').readUInt8(0)).toBe(2);
  });

  it('rejects malformed field refs', () => {
    expect(() => fieldAad({ ...booking, column: 'booking_ref' })).toThrow(/end in _enc/);
    expect(() => fieldAad({ ...booking, table: 'tribo.items' })).toThrow(/bad table/);
    expect(() => fieldAad({ ...booking, rowId: 'itm_01h455vb4pex5vsknk084sn02q' })).toThrow(/uuid/);
  });
});

describe('app key', () => {
  it('never prints the key bytes', () => {
    const key = new AppKey(keyBytes);
    const hex = keyBytes.toString('hex');
    const b64 = keyBytes.toString('base64');
    for (const shown of [String(key), JSON.stringify(key), inspect(key), inspect({ key })]) {
      expect(shown).not.toContain(hex);
      expect(shown).not.toContain(b64);
      expect(shown).toContain(key.fingerprint);
    }
  });

  it('fingerprints as the first 8 hex characters of SHA-256', () => {
    const expected = createHash('sha256').update(keyBytes).digest('hex').slice(0, 8);
    expect(new AppKey(keyBytes).fingerprint).toBe(expected);
  });

  it('reads 32 raw bytes or their base64 from the secret file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tribo-key-'));
    await writeFile(join(dir, 'raw'), keyBytes);
    await writeFile(join(dir, 'b64'), `${keyBytes.toString('base64')}\n`);
    const fp = new AppKey(keyBytes).fingerprint;
    expect((await loadAppKey(join(dir, 'raw'))).fingerprint).toBe(fp);
    expect((await loadAppKey(join(dir, 'b64'))).fingerprint).toBe(fp);
  });

  it('fails on a wrong size or a missing file without echoing content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tribo-key-'));
    await writeFile(join(dir, 'short'), 'hunter2-not-a-key');
    await expect(loadAppKey(join(dir, 'short'))).rejects.toThrow(AppKeyError);
    await expect(loadAppKey(join(dir, 'short'))).rejects.not.toThrow(/hunter2/);
    await expect(loadAppKey(join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
    expect(() => parseAppKey(Buffer.alloc(31))).toThrow(/31 bytes/);
  });
});
