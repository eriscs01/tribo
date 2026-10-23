import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { EnvelopeError, rowUuid, type Keyring } from './envelope.js';

/**
 * Uploaded files, encrypted in chunks under the app key (Technical design, "Encryption";
 * decision 0018). The blob is
 *
 *   key_version (1 byte) ‖ nonce prefix (8) ‖ chunk₀ ‖ chunk₁ ‖ … ‖ chunkₙ
 *
 * and each chunk is the AES-256-GCM ciphertext of up to FILE_CHUNK_BYTES of plaintext ‖ its
 * 16-byte tag, under nonce = prefix ‖ chunk index (uint32 BE). Every chunk's AAD is
 * `files.blob:<file id>:<index>:<final>`, so a blob copied to another file, a chunk moved,
 * dropped or repeated, and a file cut short at a chunk boundary all fail to open. Only the
 * last chunk is final; an empty file is one empty final chunk.
 */
export const FILE_CHUNK_BYTES = 64 * 1024;

const ALGORITHM = 'aes-256-gcm';
const VERSION_BYTES = 1;
const PREFIX_BYTES = 8;
const HEADER_BYTES = VERSION_BYTES + PREFIX_BYTES;
const TAG_BYTES = 16;
const RECORD_BYTES = FILE_CHUNK_BYTES + TAG_BYTES;
/** The index is 4 bytes of the nonce. */
const MAX_CHUNKS = 2 ** 32;

function nonceOf(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(PREFIX_BYTES + 4);
  prefix.copy(nonce);
  nonce.writeUInt32BE(index, PREFIX_BYTES);
  return nonce;
}

function chunkAad(fileId: string, index: number, final: boolean): Buffer {
  return Buffer.from(`files.blob:${fileId}:${String(index)}:${final ? '1' : '0'}`, 'utf8');
}

/** Splits what arrives into whole records, holding the last one back until it is known to be final. */
class Chunker {
  #pending: Buffer[] = [];

  #length = 0;

  constructor(readonly size: number) {}

  push(data: Buffer): void {
    this.#pending.push(data);
    this.#length += data.length;
  }

  /** Whole records that are certainly not the last: more bytes follow each of them. */
  *nonFinal(): Generator<Buffer> {
    while (this.#length > this.size) {
      const all = Buffer.concat(this.#pending);
      yield all.subarray(0, this.size);
      this.#pending = [all.subarray(this.size)];
      this.#length = all.length - this.size;
    }
  }

  rest(): Buffer {
    return Buffer.concat(this.#pending);
  }
}

/**
 * Encrypts a file's plaintext stream for one file id with the current app key. The key
 * version it used is `keys.current.version`, which the files row stores beside the blob.
 */
export function sealFile(keys: Keyring, fileId: string): Transform {
  const id = rowUuid(fileId);
  const key = keys.current;
  const prefix = randomBytes(PREFIX_BYTES);
  const chunks = new Chunker(FILE_CHUNK_BYTES);
  let index = 0;

  const sealChunk = (plaintext: Buffer, final: boolean): Buffer => {
    if (index >= MAX_CHUNKS) throw new EnvelopeError(`file ${id}: too many chunks`);
    const cipher = createCipheriv(ALGORITHM, key.bytes(), nonceOf(prefix, index), {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(chunkAad(id, index, final));
    index += 1;
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  };

  return new Transform({
    construct(done) {
      this.push(Buffer.concat([Buffer.of(key.version), prefix]));
      done();
    },
    transform(data: Buffer, _encoding, done: TransformCallback) {
      try {
        chunks.push(data);
        for (const plaintext of chunks.nonFinal()) this.push(sealChunk(plaintext, false));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        done(null, sealChunk(chunks.rest(), true));
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

/**
 * Decrypts a blob sealed for this file id. Each chunk is authenticated before any of its
 * plaintext is passed on; a stream that ends without a final chunk, or goes on after one,
 * fails. Errors name the file id, never anything about its contents.
 */
export function openFile(keys: Keyring, fileId: string): Transform {
  const id = rowUuid(fileId);
  const fail = (why: string) => new EnvelopeError(`file ${id}: ${why}`);
  let header: Buffer | null = null;
  let headerBytes: Buffer[] = [];
  const records = new Chunker(RECORD_BYTES);
  let index = 0;

  const openChunk = (record: Buffer, final: boolean): Buffer => {
    if (header === null) throw fail('blob too short');
    if (record.length < TAG_BYTES) throw fail('blob truncated');
    const version = header.readUInt8(0);
    const key = keys.get(version);
    if (!key) throw fail(`no app key with version ${String(version)}`);
    const decipher = createDecipheriv(
      ALGORITHM,
      key.bytes(),
      nonceOf(header.subarray(VERSION_BYTES), index),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(chunkAad(id, index, final));
    decipher.setAuthTag(record.subarray(record.length - TAG_BYTES));
    index += 1;
    try {
      return Buffer.concat([
        decipher.update(record.subarray(0, record.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw fail('blob does not decrypt for this file');
    }
  };

  return new Transform({
    transform(data: Buffer, _encoding, done: TransformCallback) {
      try {
        let rest = data;
        if (header === null) {
          headerBytes.push(data);
          const all = Buffer.concat(headerBytes);
          if (all.length < HEADER_BYTES) {
            done();
            return;
          }
          header = all.subarray(0, HEADER_BYTES);
          rest = all.subarray(HEADER_BYTES);
          headerBytes = [];
        }
        records.push(rest);
        for (const record of records.nonFinal()) this.push(openChunk(record, false));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        done(null, openChunk(records.rest(), true));
      } catch (error) {
        done(error as Error);
      }
    },
  });
}
