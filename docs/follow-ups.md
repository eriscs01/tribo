# Follow-ups

Follow-ups that pull requests raised and that were not done in them. Each one names the pull
request it came from and why it waits or was dropped. A deferred item moves into the story or
chore that does it; a dropped one stays here so it is not raised again without a new reason.

## Deferred to slice 1b

| Follow-up                                                                                                               | From                                             | Why it waits                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.password.reset` must also revoke the account's OAuth refresh tokens.                                              | [#42](https://github.com/eriscs01/tribo/pull/42) | `oauth_store` holds no refresh tokens until MCP and OAuth land in 1b; today a reset revokes the account's sessions and reset links.             |
| Check trip destinations live through the library service instead of the `trip_destinations` foreign key alone.          | [#45](https://github.com/eriscs01/tribo/pull/45) | Places can only become unusable once admin merge can soft-delete them (1b); until then the foreign key is the whole rule.                       |
| Decide whether an erased account keeps trip access: `library.findAccountPerson` no longer filters soft-deleted persons. | [#46](https://github.com/eriscs01/tribo/pull/46) | Only merged placeholders are soft-deleted today. The answer belongs to erasure (1b), which is the first thing to soft-delete an account person. |
| Split `packages/core/src/library/service.ts` into a people part and a shared-library part.                              | [#43](https://github.com/eriscs01/tribo/pull/43) | Split along the second reason to change when it arrives: the after-trip places and vendors stories.                                             |

## Dropped

| Follow-up                                    | From                                             | Why it was dropped                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| An audit action for "MFA enrolment started". | [#42](https://github.com/eriscs01/tribo/pull/42) | `auth.mfa.confirm` audits the enrolment that matters; a start event would need a migration to the closed action set for nothing an operator acts on. |
| ETags on `items.get` and `items.list`.       | [#46](https://github.com/eriscs01/tribo/pull/46) | They are not polled reads. Representation ETags are for the polled ones (dashboard, offline bundle), declared in the registry when they land.        |
| The CLI printing its request id on success.  | [#48](https://github.com/eriscs01/tribo/pull/48) | A successful command's events are found by the entity it changed; a failing command already prints its request id with the error.                    |
| A generic request-id helper for jobs.        | [#48](https://github.com/eriscs01/tribo/pull/48) | There are no daily jobs yet; per the debuggability skill the first job mints its prefixed id and brings the helper with it.                          |
