// The documents module's blob store (Technical design, "Uploads and downloads",
// "Encryption"; decision 0019): uploads are written encrypted to the upload volume through a
// temporary file that is fsynced and renamed, read back as a stream, and deleted by the purge.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { UPLOAD_MAX_BYTES } from '@tribo/contract';
import { createBlobStore, type BlobStore } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testKeys } from './keys.js';

const fileA = '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4d';
const fileB = '019a0f3c-5b2e-7c41-9d3a-6e8f1a2b3c4e';

let root: string;
const keys = testKeys();
let blobs: BlobStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tribo-blobs-'));
  blobs = createBlobStore({ root, keys });
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** Every file under the root, as paths relative to it. */
async function filesUnder(dir = root): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(root.length + 1));
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('blob store', () => {
  it('writes a file encrypted and reads it back, with the plaintext size and SHA-256', async () => {
    const plaintext = randomBytes(200_000);
    const written = await blobs.write(fileA, Readable.from([plaintext]));

    expect(written).toEqual({
      blobKey: expect.stringMatching(/^[0-9a-f]{2}\/[0-9a-f]{32}$/) as unknown,
      sha256: sha256(plaintext),
      sizeBytes: plaintext.length,
      keyVersion: keys.current.version,
    });
    const onDisk = await readFile(join(root, written.blobKey));
    expect(onDisk.includes(plaintext.subarray(0, 64))).toBe(false);
    expect((await readAll(blobs.read(fileA, written.blobKey))).equals(plaintext)).toBe(true);
  });

  it('gives every write its own blob key', async () => {
    const one = await blobs.write(fileA, Readable.from([Buffer.from('same')]));
    const two = await blobs.write(fileA, Readable.from([Buffer.from('same')]));
    expect(one.blobKey).not.toBe(two.blobKey);
  });

  it('refuses to read a blob as another file', async () => {
    const written = await blobs.write(fileA, Readable.from([randomBytes(1000)]));
    await expect(readAll(blobs.read(fileB, written.blobKey))).rejects.toThrow(/does not decrypt/);
  });

  it('refuses a file over the 25 MB ceiling with file_too_large and leaves nothing behind', async () => {
    const before = await filesUnder();
    const piece = randomBytes(1024 * 1024);
    let sent = 0;
    const tooBig = new Readable({
      read() {
        if (sent > UPLOAD_MAX_BYTES) {
          this.push(null);
          return;
        }
        sent += piece.length;
        this.push(piece);
      },
    });

    const error = await blobs.write(fileA, tooBig).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('file_too_large');
    expect(await filesUnder()).toEqual(before);
  });

  it('accepts a file of exactly 25 MB', async () => {
    const written = await blobs.write(fileA, Readable.from([Buffer.alloc(UPLOAD_MAX_BYTES, 7)]));
    expect(written.sizeBytes).toBe(UPLOAD_MAX_BYTES);
    await blobs.delete(written.blobKey);
  });

  it('leaves nothing behind when the upload stream fails', async () => {
    const before = await filesUnder();
    const broken = new Readable({
      read() {
        this.destroy(new Error('client went away'));
      },
    });
    await expect(blobs.write(fileA, broken)).rejects.toThrow('client went away');
    expect(await filesUnder()).toEqual(before);
  });

  it('deletes a blob, and deleting it again is not an error', async () => {
    const written = await blobs.write(fileA, Readable.from([randomBytes(10)]));
    await blobs.delete(written.blobKey);
    await blobs.delete(written.blobKey);
    expect(await filesUnder()).not.toContain(written.blobKey);
    await expect(readAll(blobs.read(fileA, written.blobKey))).rejects.toThrow(/ENOENT/);
  });

  it('refuses a blob key that is not one it made', async () => {
    await expect(blobs.delete('../secrets/app_key')).rejects.toThrow(/not a blob key/);
    expect(() => blobs.read(fileA, '../../etc/passwd')).toThrow(/not a blob key/);
  });

  it('checks at start that its root can be written, naming the directory', async () => {
    await expect(blobs.check()).resolves.toBeUndefined();
    const locked = await mkdtemp(join(tmpdir(), 'tribo-locked-'));
    await chmod(locked, 0o500);
    try {
      await expect(createBlobStore({ root: locked, keys }).check()).rejects.toThrow(
        `upload directory ${locked} is not writable (EACCES)`,
      );
    } finally {
      await chmod(locked, 0o700);
      await rm(locked, { recursive: true });
    }
  });

  it('reads a blob a previous process wrote', async () => {
    const plaintext = randomBytes(5000);
    const written = await blobs.write(fileA, Readable.from([plaintext]));
    const restarted = createBlobStore({ root, keys });
    expect((await readAll(restarted.read(fileA, written.blobKey))).equals(plaintext)).toBe(true);
  });
});
