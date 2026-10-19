# 0005. Drop A is API only

- Date: 18 Oct 2026
- Status: accepted
- Source: user decision

## Context

Drop A (due Sun 1 Nov 2026) is 46 operations. Building the web screens alongside the
operations would slow the API packages and mix two kinds of review.

## Decision

Drop A delivers the REST API: services, handlers, OpenAPI and tests. The web screens that
use it are separate work packages.

## Consequences

- The generated web client carries operations no screen calls yet.
- Acceptance of a story in Drop A is by integration and leak tests, not by a browser.
