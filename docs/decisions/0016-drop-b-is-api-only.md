# 0016. Drop B is API only

- Date: 23 Oct 2026
- Status: accepted
- Source: user decision, 23 Oct 2026

## Context

Drop B (due Sun 8 Nov 2026) is 22 operations: files, expenses, overlays and my tasks,
tickets, the offline bundle and people reveal. Drop A shipped as REST only
([decision 0005](0005-drop-a-is-api-only.md)), and the same trade-off holds: building screens
alongside the operations would slow the API packages and mix two kinds of review.

## Decision

Drop B delivers the REST API, as Drop A did: services, handlers, OpenAPI and tests. The web
screens that use it, the offline bundle's service-worker side included, are later work
packages.

## Consequences

- The generated web client carries Drop B operations no screen calls yet.
- Acceptance of a Drop B story is by integration and leak tests, not by a browser.
- The Siquijor acceptance items that need a screen (the offline read on a phone, uploading a
  ticket from the web) wait for those packages.
