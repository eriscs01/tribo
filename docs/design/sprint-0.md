# Tribo — Sprint 0

Oct 17, 2026 · @Eris Sales · Source: Tribo — Technical Design, Operation inventory

## Goal and exit criteria

Sprint 0 ends when a walking skeleton runs on the reference host and CI guards it, so slice 1a stories (68 operations in Drop A, due Sun 1 Nov, and Drop B, due Sun 8 Nov) can start on a stable base. It adds no 1a feature beyond the skeleton's own operations.

**Exit criteria**, all checked on the reference host over HTTPS:

1. `tribo admin create` makes the first admin, who enrols TOTP and signs in with it.
2. The admin creates a trip, adds one item and reads it back; the item's `create` event is in the trip's audit chain and `tribo audit verify` reports the chain intact.
3. CI is green on `main`: lint, typecheck, unit, integration on PostgreSQL 18, generated OpenAPI diffed, registry coverage, leak-test harness.
4. Every one of the 130 operations in the registry exists as an entry; the skeleton's handlers are real and the rest return `501 not_implemented`.
5. One nightly backup has run and been restored into a scratch Compose project.
6. The Drop A and Drop B backlog (68 stories) is seeded from the registry with the story kit, and the 1a definition of done is in CONTRIBUTING.md (task 19).

**Out of scope:** MCP and OAuth (1b), the offline bundle (a 1a story), history and restore UI (1b), and any screen beyond sign-in, trip list, create trip and add item.

**Sizes:** S = half a focused dev day, M = one, L = two. The dev tasks total about 14 dev days; with Claude sessions writing most of the code during work hours, that is about 4–5 days of the owner's review and operator time. Target exit: Thu 22 Oct. Each dev task is written so a session can finish it unattended, with CI as the gate; evenings go to review, merge and deploy.

## Task list

The critical path is 1 → 4 → 7 → 9 → 10 → 12 → 18, about 7 dev days; operator tasks 15–17 run alongside from day one.

Day-by-day order and session prompts: Execution order

| # | Task | Acceptance criteria | Size | Depends on | Owner type |
| --- | --- | --- | --- | --- | --- |
| 1 | Repo and toolchain | pnpm workspaces, TypeScript strict with project references, ESLint + Prettier, Node 26 pinned (Active LTS from 28 Oct); `pnpm install && pnpm build` passes on a clean clone | S | — | dev |
| 2 | Module boundaries | Each core module's repository gets a Kysely handle typed to its own tables only, so reading another module's table fails typecheck; dependency-cruiser forbids imports past a module's `service.ts` | S | 1 | dev |
| 3 | Contract package | `defineOperation` and the registry; base Zod types (TypeID, money, wall-clock time + zone, problem details); OpenAPI 3.1 generated to `openapi.json`; all 130 operations registered as stubs that return `501 not_implemented` (a dev-only code, gone before 1a ships) | M | 1 | dev |
| 4 | Database package | `0000_bootstrap.sql` and `0001_init.sql` from the project; a runner that applies migrations at start as `tribo_owner` under an advisory lock; Kysely types generated from a migrated database | M | 1 | dev |
| 5 | Local dev stack | `compose.dev.yml` with PostgreSQL 18 (bootstrap on init), the app in watch mode and Caddy with its internal CA; one command brings it up and seeds a demo trip | S | 4 | dev |
| 6 | Server skeleton | Fastify with pino and a request id on every line, RFC 9457 errors from the closed code enum, `__Host-` session cookie and CSRF header check, client IP from trusted proxies only, public `GET /healthz` | M | 3 | dev |
| 7 | Write path | One wrapper runs authorize → validate → load `FOR UPDATE` + `If-Match` → mutate → `entity_versions` snapshot → audit insert in one transaction; `Idempotency-Key` is not part of it (a Drop B story for expenses.create and files.upload). If-Match names the aggregate's counter (version, board\_version or budget\_version), every write under an archived trip fails with trip\_archived, and an integration test shows a failed audit insert rolls the change back | L | 4, 6 | dev |
| 8 | App key and envelope | Key read from a Docker secret file, never logged; envelope key version ‖ nonce ‖ ciphertext ‖ tag with AAD `table.column:id`; a test shows a ciphertext copied to another row fails | S | 1 | dev |
| 9 | Identity skeleton | Argon2id hashing; `tribo admin create` (disabled → TOTP → active); login, TOTP check and session rows; lockout after 5 failures | M | 7, 8 | dev |
| 10 | Skeleton operations | `trips.create` (owner needs MFA; owner membership in the same write), `items.create`, `items.get` through `item_visible`; `tribo audit verify` CLI wraps `audit.verify_chain` | M | 7, 9 | dev |
| 11 | Test harness | Testcontainers PostgreSQL 18 with both roles and migrations; factories for users, trips, members and items; fast-check leak harness over `item_visible` and `person_visible` with a fixed seed in CI | M | 4 | dev |
| 12 | Web shell | Vite + React with TanStack Router and Query; a typed client generated from `openapi.json`; sign-in with TOTP, trip list, create trip, add item; Workbox app-shell precache only | M | 10 | dev |
| 13 | CI pipeline | The jobs in "CI pipeline" run on every push; `main` is protected on them | M | 3, 4, 11 | dev |
| 14 | Production packaging | App image (non-root, read-only root filesystem); Caddy image built with the Cloudflare DNS module; `compose.yml` with a `tunnel` profile; Caddyfile chosen by `TRIBO_TLS_MODE`; secrets via Docker secrets | M | 6 | dev |
| 15 | Provision reference VPS | Runbook steps 1–5 done: hardened host, firewall, Docker, DNS record (Cloudflare, DNS only) | M | — | operator |
| 16 | First deploy | Runbook steps 6–9: secrets created, app key copied off the box, certificate issued, admin created, `/healthz` reachable from a phone on mobile data | S | 14, 15 | operator |
| 17 | Backups and restore | Runbook steps 10–11: nightly dump and upload sync to a disk the operator owns, 7 kept; one restore into a scratch project passes chain verification | S | 16 | operator |
| 18 | Walking skeleton end to end | A Playwright test runs exit criteria 1–2 against the local stack in CI, and the same steps pass by hand on the reference host | S | 12, 13, 16 | dev |
| 19 | 1a story kit and backlog seed | pnpm new:op \<id> scaffolds a registry entry's Input, Patch and Output schemas, policy rows, handler, tagged integration test and leak registration. CONTRIBUTING.md holds the 1a definition of done: status implemented, OpenAPI diff reviewed, policy, leak and audit-event tests, enum codes only, If-Match as the registry's ifMatch. Drop B limits are written into the stories: Idempotency-Key only on expenses.create and files.upload, fx\_rate = 1, equal and itemised splits only. The backlog holds the 68 Drop A and B operations, grouped by module and tagged by drop | S | 3, 7, 11 | dev |

## Repo layout

One repository, pnpm workspaces; modules own their tables and talk only through service interfaces.

```plain
tribo/
├─ apps/
│  ├─ server/        Fastify bootstrap, REST adapter, CLI (tribo admin|audit …), daily jobs; MCP + OAuth adapters in 1b
│  └─ web/           React SPA, service worker, generated API client
├─ packages/
│  ├─ contract/      Zod schemas, defineOperation, registry, error codes, OpenAPI generator
│  ├─ platform/      request context, write-path wrapper, idempotency, logging, rate limits
│  ├─ crypto/        app key loader, field and file envelopes
│  ├─ db/            migrations/*.sql, runner, generated Kysely types
│  ├─ core/
│  │  ├─ identity/   service.ts · repo.ts · policy.ts   (same three files in every module)
│  │  ├─ trips/      trips, memberships, invites
│  │  ├─ items/      items, units, allocations, tickets, overlays
│  │  ├─ itinerary/  read-only engine over items
│  │  ├─ expenses/   expenses, shares, budget
│  │  ├─ documents/  files and blobs
│  │  ├─ library/    people, places, vendors, templates
│  │  └─ audit/      audit events, entity_versions
│  └─ testkit/       Testcontainers setup, factories, leak-test generators
├─ deploy/
│  ├─ compose.yml  compose.dev.yml  .env.example
│  ├─ caddy/       Dockerfile (Cloudflare DNS module), Caddyfile per TLS mode
│  └─ backup/      dump, sync and restore scripts
├─ docs/runbook.md
└─ .github/workflows/ci.yml
```

**Boundary rule:** a module's `repo.ts` receives a Kysely handle typed to its own tables, so a cross-module query does not compile; other modules call its `service.ts`. dependency-cruiser fails CI on imports past a module's service file.

## CI pipeline

GitHub Actions (`.github/workflows/ci.yml`) on every push and pull request; jobs 1–6 and 9 run in parallel, job 7 after job 6, and `main` requires jobs 1–7 and 9 by name. Each job starts with the shared install step (`.github/actions/setup`): a frozen `pnpm install` that fails when the lockfile is out of date, with the pnpm store cached on the lockfile.

| # | Job | Fails when |
| --- | --- | --- |
| 1 | Lint and format | ESLint, Prettier or dependency-cruiser boundary rules fail |
| 2 | Typecheck | `tsc -b` fails, including cross-module table access, or the SPA fails to build |
| 3 | Unit | Vitest fails (policy matrix, envelope, money rounding as they land), including the contract checks: generated `openapi.json` differs from the committed one without an approved update; a route or tool lacks an operation id; the registry and `operations.csv` disagree |
| 4 | Integration | Vitest with Testcontainers PostgreSQL 18 and both roles fails: migrations, write-path rollback, append-only audit, chain verification |
| 5 | Leak properties | fast-check finds a private row reaching another user (fixed seed; random seeds run nightly, below) |
| 6 | Build and scan | App or Caddy image fails to build; osv-scanner or Trivy reports a high or critical finding without a recorded exception |
| 7 | End to end | Playwright walking-skeleton test fails against the Compose stack, on every pull request and push (after job 6) |
| 8 | Publish | On a release tag only, after jobs 1–7 and 9 pass: push both images to GHCR with the tag and digest |
| 9 | Coverage | Unit, integration and leak tests run against the TypeScript source with V8 coverage computed on the runner, and statements, branches, functions or lines fall below the floors in `vitest.config.ts`; the summary goes to the run page and the HTML report is kept 14 days as an artifact. No coverage service or token is involved |

A nightly workflow (`.github/workflows/nightly.yml`) runs the leak properties with a random seed, prints the seed in its log and run summary, and opens an issue when it fails; `TRIBO_LEAK_SEED=<seed> pnpm test:leak` reproduces a failure. It is not a required check, so a new seed's finding never blocks an unrelated pull request.

Deploys stay manual: the operator pulls a tagged release on the host.

## Deployment-mode configuration

One image set serves every mode; the operator picks the mode in `deploy/.env` and adds only that mode's secrets.

| Variable | Meaning | Default |
| --- | --- | --- |
| `TRIBO_PUBLIC_URL` | The one public origin; OAuth issuer, MCP resource, invite and reset links derive from it | none (required) |
| `TRIBO_TLS_MODE` | `acme-http`, `acme-dns-cloudflare`, `origin-cert` or `internal` | `acme-http` |
| `TRIBO_ACME_EMAIL` | Let's Encrypt account contact | none (required for `acme-*`) |
| `TRIBO_TRUSTED_PROXIES` | `none`, `cloudflare` (Cloudflare's published ranges) or a CIDR list | `none` |
| `TRIBO_UPLOAD_MAX_MB` | Upload ceiling, capped at 25 | `25` |
| `TRIBO_MCP_ENABLED` | MCP endpoint on or off (1b; refused in Private mode) | `false` |
| `COMPOSE_PROFILES` | `tunnel` adds the `cloudflared` service | empty |

Secrets are files under `deploy/secrets/` (mode 600, mounted as Docker secrets): `app_key` (32 random bytes), `db_owner_password`, `db_app_password`, plus `cloudflare_api_token` for `acme-dns-cloudflare` and `tunnel_token` for the tunnel profile.

| Mode | `TRIBO_TLS_MODE` | `TRIBO_TRUSTED_PROXIES` | Profile | Inbound ports |
| --- | --- | --- | --- | --- |
| Public host | `acme-http` | `none` | — | 80, 443 |
| Cloudflare, DNS only (reference) | `acme-http` (or `acme-dns-cloudflare`) | `none` | — | 80, 443 |
| Cloudflare, proxied | `origin-cert` or `acme-dns-cloudflare` | `cloudflare` | — | 443 from Cloudflare ranges only |
| Cloudflare Tunnel | `origin-cert` or `internal` | `cloudflare` | `tunnel` | none |
| Private | `internal` | `none` or the LAN range | — | 443 on the LAN or VPN |

The proxied and tunnel modes also need a Cloudflare WAF skip rule for `/mcp`, `/.well-known/*` and the OAuth paths once MCP is enabled in 1b.

## Reference VPS runbook

Written for the reference deployment (VPS, domain on Cloudflare, DNS only); steps marked *mode* change per the table above.

1. **Host.** A VPS with at least 1 vCPU, 2 GB RAM and 25 GB disk on a current Ubuntu LTS or Debian stable, in a region near the Philippines (Singapore is the usual choice).
2. **Access.** Create a sudo user with SSH key login; disable password and root login; enable unattended security upgrades.
3. **Firewall** (*mode*). Allow 22 (from your own IP where possible), 80 and 443 in both the host firewall and the provider's firewall; deny everything else.
4. **Docker.** Install Docker Engine and the Compose plugin from Docker's own repository; add the sudo user to the `docker` group.
5. **DNS** (*mode*). In Cloudflare, add an A record (and AAAA if the VPS has IPv6) for the Tribo host name pointing at the VPS, proxy status DNS only.
6. **Release.** Put `deploy/` from the release tag in `/opt/tribo`; copy `.env.example` to `.env` and set the public URL, TLS mode and ACME email.
7. **Secrets.** Create the secret files: `openssl rand -out app_key 32` and two long random database passwords; `chmod 600`. Copy `app_key` off the box to a password manager or offline storage now — without it, backups of sensitive fields are unreadable.
8. **Start.** `docker compose pull && docker compose up -d`; watch the proxy logs until the certificate is issued, then open `/healthz` from a phone on mobile data.
9. **First admin.** `docker compose exec app tribo admin create`; scan the TOTP code and store the recovery codes.
10. **Backups.** Install the nightly timer (02:00 Asia/Manila): `pg_dump -Fc` from the database container plus an rsync of the upload volume to a disk you own, keeping 7. Prefer a pull from your own machine over SSH, so the VPS holds no credentials to it.
11. **Restore check.** Restore the latest dump and uploads into a scratch Compose project, run `tribo audit verify` and open the demo trip; repeat quarterly.
12. **Done.** Run exit criteria 1–2 by hand and record the release tag and date in the runbook.

## Risks and open questions

| Risk or question | Proposed default |
| --- | --- |
| Capacity is one developer, about 94 focused hours before go-live, with Claude sessions during work hours | Plan approved: Sprint 0 exit Thu 22 Oct, Drop A Sun 1 Nov, Drop B Sun 8 Nov. Run the critical path first; the scan job and nightly random leak seeds can slip to the week of 26 Oct |
| Node 26 is Current until 28 Oct | Pin Node 26 now, since it is Active LTS before go-live; fall back to Node 24 only if a dependency breaks |
| "A disk you own" is off the VPS and may not be reachable on day one | Pull nightly from the operator's own machine over SSH; until that works, keep dumps on a separate attached volume and say so in the runbook |
| Repository and CI host | Decided 17 Oct: public GitHub repository, Actions and public GHCR packages, all free; a ruleset protects main; secrets, env files and dumps are git-ignored |
| Cloudflare token for DNS-01 | Scoped to DNS edit on the one zone; only created when `acme-dns-cloudflare` is chosen |
| `501 not_implemented` is outside the closed error enum | Dev-only; the 1a gate fails if any 1a operation still returns it |
| The operation inventory's 15 gaps (G1–G15) were accepted on 17 Oct | Decided; 1a is now 86 operations after R36 removed debts and settle-up (68 before the trip, 18 right after). G1 (password change) and G13 (`/healthz`, `/v1/openapi.json`) land in 1a, and `/healthz` is already in task 6 |
