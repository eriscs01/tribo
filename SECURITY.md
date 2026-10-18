# Security policy

Tribo stores people's travel documents and trip plans, so we treat security reports as a priority.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (<https://github.com/eriscs01/tribo/security/advisories/new>).

Please do not open a public issue, pull request or discussion for a vulnerability.

Include what you can of:

- the affected component (server, web app, deploy files, CI) and version or commit;
- steps to reproduce, or a proof of concept;
- the impact you expect.

Never include real personal data or real trip documents in a report; invented ones are enough.

## What to expect

- An acknowledgement within 7 days.
- An assessment and, if confirmed, a planned fix within 30 days.
- A published GitHub security advisory once a fix is released, crediting you unless you ask otherwise.

## Supported versions

Tribo has no stable release yet. Fixes land on `main` and in the latest `v*` release only;
older releases are not patched. Self-hosters should run the latest release.

## Scope

In scope: the code and configuration in this repository, including the published container images.

Out of scope: a self-hosted instance's own infrastructure (its server, DNS or TLS setup)
beyond what the deploy files in this repository configure, and findings that need an
already-compromised server or administrator account.
