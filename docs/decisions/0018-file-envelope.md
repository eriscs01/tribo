# 0018. The file envelope: chunks of 64 KiB, AAD bound to file, index and end

- Date: 23 Oct 2026
- Status: accepted
- Source: B0 Drop B prerequisites

## Context

The design encrypts uploads with AES-256-GCM "streamed in chunks, with the app key", and
`tribo.files` stores `blob_key` and `enc_key_version`. It does not fix the chunk size, the
nonce scheme, or how a blob is bound to its row. One GCM pass over a whole file would either
hold the file in memory or release plaintext before its tag is checked; a naive chunking
lets an attacker with access to the upload volume drop the last chunks, reorder chunks or
swap two files' blobs undetected.

## Decision

- A blob is `key_version (1 byte) ‖ nonce prefix (8 random bytes) ‖ chunks`, matching the
  field envelope's leading key version. Each chunk is the AES-256-GCM ciphertext of up to
  64 KiB of plaintext followed by its 16-byte tag, under nonce = prefix ‖ chunk index
  (uint32 big-endian), so no nonce repeats under a key within or across files.
- Each chunk's AAD is `files.blob:<file uuid>:<index>:<final 0|1>`, as the field envelope's
  is `<table>.<column>:<row id>`. A blob copied to another file id, a chunk moved, dropped or
  repeated, bytes appended after the final chunk, and a blob cut at a chunk boundary all fail.
  An empty file is one empty final chunk.
- `sealFile(keys, fileId)` and `openFile(keys, fileId)` in `@tribo/crypto` are Node
  Transform streams. Each holds back at most one chunk (it must know whether the chunk is the
  last), and every chunk is authenticated before its plaintext is passed on.

## Consequences

- A 25 MB file costs about 400 chunks and 6.4 KB of tags (0.03%).
- Memory per stream is bounded by the chunk size, whatever the file size.
- A failed open can already have streamed earlier, authenticated chunks to the client: a
  download that fails mid-way ends the response with an error rather than a clean end, so
  the client never mistakes a cut file for a whole one.
- Key rotation re-encrypts blobs offline in steps, reading the version from the header.
