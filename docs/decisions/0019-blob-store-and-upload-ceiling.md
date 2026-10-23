# 0019. The blob store and the upload ceiling

- Date: 23 Oct 2026
- Status: accepted
- Source: B0 Drop B prerequisites

## Context

The design keeps uploads "on a local volume", encrypted with the app key, with a 25 MB
default limit (`tribo.files.size_bytes` allows up to 26 214 400 bytes, 25 MiB) and nightly
`rsync` of the volume. It does not say who writes the blobs, how a blob is named, how a
half-written file is avoided, or how the limit is enforced at the edge and in the app.

## Decision

- **The documents module owns the blob store** (`packages/core/src/documents/blobs.ts`),
  as it owns `tribo.files`. `write(fileId, plaintext)` encrypts with the file envelope
  (decision 0018), writes to `.tmp/` on the volume, fsyncs, renames into place and fsyncs
  the directory, and returns `blobKey`, the plaintext's SHA-256 and size, and the key
  version: the four columns the files row stores. `read` streams the plaintext; `delete`
  is for the purge and ignores a blob already gone.
- **A blob key is 128 random bits in hex** under a directory named by its first two
  characters (`ab/ab…`), not the file id, so a rotation or a re-upload can write a new blob
  before the old one goes. The store accepts only keys of that shape, so a key can never
  name a path outside the volume.
- **The ceiling is 25 MiB** (`UPLOAD_MAX_BYTES` in `@tribo/contract`). The blob store stops
  reading at it and throws `file_too_large`, leaving nothing behind. Caddy refuses bodies
  over 26 MiB (the file plus multipart framing) with the same problem body. A JSON body over
  Fastify's 1 MiB limit is also `413 file_too_large`: it is the contract's one 413 code.
- **The volume** is `uploads` in `deploy/compose.yml`, mounted at `/var/lib/tribo/uploads`
  (`TRIBO_UPLOADS_DIR`), the read-only app container's one writable path. The image creates
  the mount point owned by `node`, so a new volume takes that owner. The app checks at start
  that it can write there and stops, naming the directory, if it cannot.
- **The restore check** compares the SHA-256 of every restored file with the snapshot's.

## Consequences

- B4 generates the files row's id before writing the blob, since the envelope binds the
  blob to it, and deletes the blob of an upload whose write path does not commit.
- Files in `.tmp/` are left only by a crash mid-write; they are never referenced and are
  not restored.
