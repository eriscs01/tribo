# 0031. A body of the wrong content type answers 400 validation_failed

- Date: 24 Oct 2026
- Status: accepted
- Source: Q3 tidy-up (R1 review, A6)

## Context

Fastify answers 415 when a request body has a content type no parser reads (anything but JSON,
plain text and multipart here). The adapter turned every Fastify 4xx into `validation_failed`
with Fastify's message as `detail`. The status line was already 400, taken from the problem
table, so header and body agreed; what was open was whether the contract should instead answer
415, and the detail echoed the type the client sent. The problem table's 415 is
`file_type_not_allowed`, which decision 0021 defines as an upload whose bytes are off the
allowlist, a different fact. The 413 case was settled earlier (`file_too_large`, decision 0019).

## Decision

A body of a content type the endpoint cannot read answers `400 validation_failed` with the fixed
detail "The request body must be application/json". No new code, no 415 outside
`file_type_not_allowed`. Other Fastify 4xx errors keep their behaviour.

## Consequences

- A client sees one status for "your request is malformed" and a separate one for "that file
  type is not kept".
- The detail no longer repeats what the client sent.
