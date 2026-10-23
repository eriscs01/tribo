/* eslint-disable no-bitwise -- flips a single bit to tamper with a blob */
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AppKey } from './app-key.js';
import { EnvelopeError, keyring } from './envelope.js';
import { FILE_CHUNK_BYTES, openFile, sealFile } from './file-envelope.js';

const fileA = '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d';
const fileB = '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4e';
const keys = keyring(new AppKey(randomBytes(32)));

const HEADER = 1 + 8;
const RECORD = FILE_CHUNK_BYTES + 16;

async function collect(source: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** Feeds `input` in pieces of `piece` bytes, so chunk boundaries never line up with writes. */
const sealed = (input: Buffer, fileId = fileA, piece = 10_000) =>
  collect(Readable.from(pieces(input, piece)).pipe(sealFile(keys, fileId)));
const opened = (envelope: Buffer, fileId = fileA, ring = keys) =>
  collect(Readable.from(pieces(envelope, 7_777)).pipe(openFile(ring, fileId)));

function* pieces(buffer: Buffer, size: number) {
  for (let at = 0; at < buffer.length; at += size) yield buffer.subarray(at, at + size);
}

describe('file envelope', () => {
  it('round-trips a file of several chunks, fed in uneven pieces', async () => {
    const plaintext = randomBytes(FILE_CHUNK_BYTES * 3 + 123);
    expect((await opened(await sealed(plaintext))).equals(plaintext)).toBe(true);
  });

  it('round-trips a file exactly a whole number of chunks long', async () => {
    const plaintext = randomBytes(FILE_CHUNK_BYTES * 2);
    const envelope = await sealed(plaintext);
    expect(envelope.length).toBe(HEADER + 2 * RECORD);
    expect((await opened(envelope)).equals(plaintext)).toBe(true);
  });

  it('round-trips an empty file as one empty final chunk', async () => {
    const envelope = await sealed(Buffer.alloc(0));
    expect(envelope.length).toBe(HEADER + 16);
    expect((await opened(envelope)).length).toBe(0);
  });

  it('lays out key version ‖ 8-byte nonce prefix, then chunks of ciphertext ‖ 16-byte tag', async () => {
    const plaintext = randomBytes(FILE_CHUNK_BYTES + 10);
    const envelope = await sealed(plaintext);
    expect(envelope.readUInt8(0)).toBe(1);
    expect(envelope.length).toBe(HEADER + RECORD + 10 + 16);
    expect(envelope.includes(plaintext.subarray(0, 64))).toBe(false);
  });

  it('uses a fresh nonce prefix for every file', async () => {
    const plaintext = randomBytes(100);
    const [one, two] = await Promise.all([sealed(plaintext), sealed(plaintext)]);
    expect(one.subarray(1, HEADER).equals(two.subarray(1, HEADER))).toBe(false);
  });

  describe('refuses', () => {
    const plaintext = randomBytes(FILE_CHUNK_BYTES * 3 + 500);
    const envelope = sealed(plaintext);
    const record = (env: Buffer, i: number) =>
      env.subarray(HEADER + i * RECORD, HEADER + (i + 1) * RECORD);

    it('a file truncated at a chunk boundary (the final chunk dropped)', async () => {
      const env = await envelope;
      await expect(opened(env.subarray(0, HEADER + 3 * RECORD))).rejects.toThrow(EnvelopeError);
    });

    it('a file truncated inside a chunk', async () => {
      const env = await envelope;
      await expect(opened(env.subarray(0, env.length - 5))).rejects.toThrow(EnvelopeError);
    });

    it('a file cut down to its header', async () => {
      const env = await envelope;
      await expect(opened(env.subarray(0, HEADER))).rejects.toThrow(EnvelopeError);
      await expect(opened(env.subarray(0, 3))).rejects.toThrow(EnvelopeError);
    });

    it('a dropped middle chunk', async () => {
      const env = await envelope;
      const dropped = Buffer.concat([
        env.subarray(0, HEADER),
        record(env, 0),
        record(env, 2),
        env.subarray(HEADER + 3 * RECORD),
      ]);
      await expect(opened(dropped)).rejects.toThrow(EnvelopeError);
    });

    it('two chunks swapped', async () => {
      const env = await envelope;
      const swapped = Buffer.concat([
        env.subarray(0, HEADER),
        record(env, 1),
        record(env, 0),
        env.subarray(HEADER + 2 * RECORD),
      ]);
      await expect(opened(swapped)).rejects.toThrow(EnvelopeError);
    });

    it('bytes appended after the final chunk', async () => {
      const env = await envelope;
      await expect(opened(Buffer.concat([env, record(env, 0)]))).rejects.toThrow(EnvelopeError);
    });

    it('a flipped bit', async () => {
      const env = Buffer.from(await envelope);
      env[HEADER + RECORD + 40] = (env[HEADER + RECORD + 40] ?? 0) ^ 1;
      await expect(opened(env)).rejects.toThrow(EnvelopeError);
    });

    it('a blob moved to another file id', async () => {
      await expect(opened(await envelope, fileB)).rejects.toThrow(EnvelopeError);
    });

    it('a file sealed under a key version the keyring does not hold', async () => {
      const rotated = keyring(new AppKey(randomBytes(32), 2));
      await expect(opened(await envelope, fileA, rotated)).rejects.toThrow(
        /no app key with version 1/,
      );
    });

    it('a file opened with another key of the same version', async () => {
      const older = new AppKey(randomBytes(32), 1);
      const ring = keyring(new AppKey(randomBytes(32), 2), older);
      await expect(opened(await envelope, fileA, ring)).rejects.toThrow(EnvelopeError);
    });

    it('naming the file id but nothing about its contents', async () => {
      const error = await opened(await envelope, fileB).catch((e: unknown) => e);
      expect(String(error)).toContain(fileB);
      expect(String(error)).not.toMatch(/[0-9a-f]{32}/);
    });

    it('a file id that is not a uuid', () => {
      expect(() => sealFile(keys, 'fil_123')).toThrow(EnvelopeError);
    });
  });

  it('decrypts under an older key version the keyring still holds', async () => {
    const older = new AppKey(randomBytes(32), 1);
    const plaintext = randomBytes(5000);
    const env = await collect(Readable.from([plaintext]).pipe(sealFile(keyring(older), fileA)));
    const ring = keyring(new AppKey(randomBytes(32), 2), older);
    expect((await opened(env, fileA, ring)).equals(plaintext)).toBe(true);
  });

  it('streams a 25 MB file in and out with bounded memory', async () => {
    // A sweep that frees buffers right away, so a sample after gc() counts only live ones.
    setFlagsFromString('--expose-gc');
    setFlagsFromString('--no-concurrent-array-buffer-sweeping');
    const gc = runInNewContext('gc') as () => void;
    const size = 25 * 1024 * 1024;
    const piece = 256 * 1024;
    const block = randomBytes(piece);
    gc();
    const base = process.memoryUsage().arrayBuffers;
    let peak = 0;
    let produced = 0;
    const source = new Readable({
      read() {
        if (produced >= size) {
          this.push(null);
          return;
        }
        produced += piece;
        if (produced % (2 * 1024 * 1024) === 0) {
          gc();
          peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
        }
        this.push(Buffer.from(block));
      },
    });
    const inHash = createHash('sha256');
    const outHash = createHash('sha256');
    let outBytes = 0;
    for (let i = 0; i < size / piece; i += 1) inHash.update(block);
    await pipeline(
      source,
      sealFile(keys, fileA),
      openFile(keys, fileA),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          outBytes += chunk.length;
          outHash.update(chunk);
          done();
        },
      }),
    );
    expect(outBytes).toBe(size);
    expect(outHash.digest('hex')).toBe(inHash.digest('hex'));
    expect(peak).toBeLessThan(2 * 1024 * 1024);
  }, 30_000);
});
