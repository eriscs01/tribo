# Local dev stack

Needs Docker (Colima, OrbStack or Docker Desktop) and Node 26 with pnpm.

| Command          | What it does                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev:up`    | Creates dev secrets on first run, then starts `db`, `app`, `web`, `seed` and `proxy`; returns when https://tribo.localhost/healthz answers |
| `pnpm dev:logs`  | Follows the app log                                                                                                                        |
| `pnpm dev:psql`  | psql as `tribo_app`                                                                                                                        |
| `pnpm dev:down`  | Stops the stack, keeps data                                                                                                                |
| `pnpm dev:reset` | Stops the stack and deletes every volume (database, Caddy CA, dependencies)                                                                |
| `pnpm dev:trust` | Copies Caddy's local root CA out and prints the command that trusts it, so browsers accept https://tribo.localhost                         |
| `pnpm dev:tribo` | Runs the `tribo` CLI in the app container, e.g. `pnpm dev:tribo admin create ana` (asks for a password and a TOTP code)                    |

- **db:** `postgres:18.6`. On an empty volume the init script runs `0000_bootstrap.sql` and sets both role passwords from `deploy/secrets/dev/`. The database is also on `127.0.0.1:55432` for GUI tools.
- **app:** runs from the repo bind mount, with its own Linux `node_modules` in named volumes. It installs, builds, then rebuilds on change (`tsc -b -w`, polling because some VMs drop host file events) and restarts (`node --watch`). Migrations apply at start.
- **web:** the SPA from Vite's dev server on port 5173, with hot reload (file polling on, as for app). It waits for app, whose start installs and builds the workspace. The app-shell service worker is registered only in production builds (`pnpm build:web`), never by the dev server.
- **seed:** a one-shot `deploy/dev/seed.sql` that adds a demo account `demo` (password `demo-password-dev`, no MFA), one trip and four items (shared, private, selected). It can be re-run.
- **proxy:** `caddy:2.11.7` with its internal CA on 80 and 443 (`TRIBO_DEV_HTTP_PORT` and `TRIBO_DEV_HTTPS_PORT` change them). It sends `/v1/*` and `/healthz` to app and everything else to web, so the SPA and the API share one origin. It sets `X-Request-Id` and passes one client IP.

Dev secrets in `deploy/secrets/dev/` are random, git-ignored and world-readable so the containers can read them. They are not for any real deployment.
