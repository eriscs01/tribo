# 0022. File downloads: the headers, the name, failures and the audit of sensitive files

- Date: 23 Oct 2026
- Status: accepted
- Source: B4 files

## Context

The design says `GET /v1/files/{id}/content` "re-checks permission on every request and
streams the decrypted bytes with `Cache-Control: private, no-store`", and that reveals of
sensitive fields write a `reveal` event naming the field paths, never the values. It does
not say how the file's name reaches the browser, what a damaged blob answers, or whether
reading a sensitive file (an ID scan, a ticket, a voucher) is audited like a reveal.

## Decision

- **Every download looks the file up afresh** through the one file predicate (the file's
  own visibility AND `tribo.item_visible` on its item), with nothing cached between
  requests. A file the caller cannot see is `not_found`, exactly as one that does not exist;
  a purged file they can see is `file_purged` (410).
- **Headers:** `Content-Type` is the type sniffed at upload; `X-Content-Type-Options:
nosniff`; `Cache-Control: private, no-store`; `Content-Security-Policy: default-src
'none'; sandbox`, so a file opened in place runs nothing; `Content-Length` is the stored
  size; and `Content-Disposition: attachment` with the stored name twice: `filename=` in
  printable ASCII (anything else, `"` and `\` become `_`) and `filename*=UTF-8''` with
  RFC 8187 percent-encoding (RFC 6266). The stored name has no path and no control
  characters already (decision 0021).
- **A damaged blob never streams garbage.** The envelope authenticates each 64 KiB chunk
  before its plaintext goes on (decision 0018). The response is sent only once the first
  chunk has been authenticated, so a blob that is missing, moved, swapped or tampered with
  at its start answers `500 internal_error` with a `file content unreadable` line naming the
  file id. A failure further in cuts the response short (its Content-Length is not reached)
  and logs `file download failed` with the file id; the client never sees a clean end.
- **Downloading a sensitive file is audited as a reveal.** A file of kind `id`, `ticket` or
  `voucher` writes a `reveal` event on `file` (`reason` `content`, the file id, the trip's
  chain) before a byte is sent, in the same way as reading a sensitive field; other files
  write nothing, as other reads do. The event holds no name or content. Viewers may still
  download what they can see, as the operation's roles say; the event records that they did.

## Consequences

- A history of who read an ID scan exists from the first download on, at one audit row per
  download of a sensitive file.
- A download of a sensitive file on a trip whose audit chain has retired is refused
  (`trip_retired`), as any audited read is.
- Browsers save the file under its name; none renders it inline from the API's origin.
