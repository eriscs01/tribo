# 0021. File uploads: the form, the type allowlist, names and no orphan blobs

- Date: 23 Oct 2026
- Status: accepted
- Source: B4 files

## Context

The design says `POST /v1/trips/{id}/files` "streams multipart uploads (default limit
25 MB), sniffs the type against an allowlist (PDF, JPEG, PNG, HEIC, WebP) and records size
and SHA-256". It does not say how the contract describes a multipart body, how each type is
recognised, what is done with the client's Content-Type and file name, or how a blob
written before its row commits is kept from being orphaned. Decision 0019 fixed that the
file id is taken before the blob is written.

## Decision

- **The contract declares a form.** An operation's `form` is the text fields of a
  multipart/form-data body, followed by one part named `file`; the OpenAPI document shows
  that form. Its `input` stays what the write path validates and an Idempotency-Key hashes:
  the fields plus what the server learnt of the file (name, sniffed type, size, SHA-256),
  so two different files under one key are told apart. Fields must come before the file;
  parts after it are ignored.
- **The type comes from the first 64 bytes only**, against signatures:
  `%PDF-` at 0; `FF D8 FF`; the PNG signature; `RIFF`…`WEBP`; and an ISO `ftyp` box whose
  major brand is a HEVC brand (`heic heix heim heis hevc hevx`), or `mif1`/`msf1` with one
  of those among its compatible brands. AVIF, SVG, GIF, HTML and everything else are
  `file_type_not_allowed`, as is an empty file. Until the type is known the bytes are held
  back, so a refused file never reaches the blob store.
- **The client's claims are checked, never used.** A declared part Content-Type other than
  none or `application/octet-stream` (`image/jpg` reads as JPEG) and a file-name extension
  (1–8 letters or digits after the last dot) must agree with the sniffed type, or the upload
  is `file_type_not_allowed`. A rename (files.update) keeps an extension of the file's type.
  The stored `mime_type` is always the sniffed one.
- **The name is a label.** Only the last path segment of the client's name is kept,
  composed to NFC, without C0/C1 controls, DEL or bidirectional overrides and isolates, and
  without leading dots, cut to 255 characters with its extension kept; an empty name becomes
  `upload.<extension>`. Blob keys are random (decision 0019), so no name ever becomes part of
  a path.
- **Everything that can be refused without the bytes is refused before reading them:** the
  form, the caller's membership and role, an archived trip, and the item (one the caller
  sees in the same trip; a hidden, foreign, deleted or unknown item answers alike,
  `validation_failed` at `/itemId`). The write path checks the caller and the item again
  once the bytes are in.
- **No orphan blobs.** The blob is written, then the write path runs; if it does not commit
  for any reason (a refusal, a replayed or reused Idempotency-Key, a database failure) the
  blob is deleted before the error goes on. If that delete fails, the request fails with an
  error naming the file id and blob key, which the runbook says how to remove. A crash
  between the blob's rename and the commit can still leave one, as a crash mid-write leaves
  one in `.tmp/` (decision 0019).
- **busboy's own file limit sits one byte past the ceiling,** so the blob store's meter
  answers `file_too_large`; busboy truncates silently otherwise, and a part it does cut is
  refused all the same.

## Consequences

- A client must send the fields before the file; most form encoders do.
- A legitimate file named with a dotted suffix that is not its type (`J.Cruz`) is refused;
  the client can rename it.
- An upload that is refused for its content type has still been read up to its first
  64 bytes; one refused for its size has been read to the ceiling.
