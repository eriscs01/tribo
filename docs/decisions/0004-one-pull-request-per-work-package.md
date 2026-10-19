# 0004. One pull request per work package in slice 1a

- Date: 18 Oct 2026
- Status: accepted
- Source: user decision

## Context

Sprint 0 ran one task per branch and pull request. Slice 1a is 68 operations; one pull
request per operation (story) is more review overhead than the stories justify, since the
operations of a module share a service, a repo and tests.

## Decision

Slice 1a is built as work packages, each one branch and one pull request holding several
stories, one commit per story. Sprint 0's one-task-per-PR rule is unchanged.

## Consequences

- Fewer, larger reviews; each story's definition of done is still proven per story in the
  pull request body.
- A package's pull request is the unit that merges, so a story cannot land alone.
