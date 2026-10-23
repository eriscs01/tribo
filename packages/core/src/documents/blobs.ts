import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline as pipe, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UPLOAD_MAX_BYTES } from '@tribo/contract';
import { openFile, sealFile, type Keyring } from '@tribo/crypto';
import { ApiError } from '@tribo/platform';

/** What a stored upload is: the row's blob_key, sha256 (of the plaintext), size_bytes and enc_key_version. */
export interface StoredBlob {
  blobKey: string;
  sha256: string;
  sizeBytes: number;
  keyVersion: number;
}

/**
 * Uploads on the local volume (Technical design, "Uploads and downloads"; decision 0019),
 * encrypted with the file envelope for the file id they belong to. The documents module
 * owns it, as it owns tribo.files.
 */
export interface BlobStore {
  /**
   * Encrypts and stores a plaintext stream for one file id: a temporary file, fsynced, then
   * renamed into place, so a blob key always names a whole blob. Over UPLOAD_MAX_BYTES it
   * stops reading and throws file_too_large; on any failure nothing is left behind.
   */
  write(fileId: string, plaintext: Readable): Promise<StoredBlob>;
  /** The plaintext of a stored blob; the stream fails if the blob is missing or not this file's. */
  read(fileId: string, blobKey: string): Readable;
  /** Removes a blob (the purge); a blob already gone is not an error. */
  delete(blobKey: string): Promise<void>;
  /** At start: throws, naming the directory, when uploads cannot be written there. */
  check(): Promise<void>;
}

/** `ab/ab…` : 128 random bits in hex, under a directory named by the first two characters. */
const BLOB_KEY = /^([0-9a-f]{2})\/\1[0-9a-f]{30}$/;
const TMP = '.tmp';

/** Counts and hashes the plaintext as it passes, and stops it past the ceiling. */
function meter(maxBytes: number) {
  const hash = createHash('sha256');
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(new ApiError('file_too_large'));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { transform, result: () => ({ sha256: hash.digest('hex'), sizeBytes: size }) };
}

async function fsync(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createBlobStore(options: {
  root: string;
  keys: Keyring;
  maxBytes?: number;
}): BlobStore {
  const { root, keys, maxBytes = UPLOAD_MAX_BYTES } = options;
  const pathOf = (blobKey: string): string => {
    if (!BLOB_KEY.test(blobKey)) throw new Error('not a blob key');
    return join(root, blobKey);
  };

  return {
    async write(fileId, plaintext) {
      const tmpDir = join(root, TMP);
      await mkdir(tmpDir, { recursive: true });
      const hex = randomBytes(16).toString('hex');
      const blobKey = `${hex.slice(0, 2)}/${hex}`;
      const tmp = join(tmpDir, `${hex}.partial`);
      const metered = meter(maxBytes);
      try {
        await pipeline(
          plaintext,
          metered.transform,
          sealFile(keys, fileId),
          createWriteStream(tmp, { flags: 'wx' }),
        );
        await fsync(tmp);
        const dir = join(root, hex.slice(0, 2));
        await mkdir(dir, { recursive: true });
        await rename(tmp, join(root, blobKey));
        await fsync(dir);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
      return { blobKey, ...metered.result(), keyVersion: keys.current.version };
    },

    read(fileId, blobKey) {
      return pipe(createReadStream(pathOf(blobKey)), openFile(keys, fileId), () => {
        // Errors reach whoever reads the returned stream; nothing to do here.
      });
    },

    async delete(blobKey) {
      await unlink(pathOf(blobKey)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    },

    async check() {
      const probe = join(root, TMP, `check-${randomBytes(8).toString('hex')}`);
      try {
        await mkdir(join(root, TMP), { recursive: true });
        await (await open(probe, 'wx')).close();
        await unlink(probe);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
        throw new Error(`upload directory ${root} is not writable (${code})`, { cause: error });
      }
    },
  };
}
