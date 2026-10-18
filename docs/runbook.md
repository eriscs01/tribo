# Tribo operator runbook

How to run a Tribo instance with `deploy/compose.yml`. The steps follow the reference VPS runbook in `docs/design/sprint-0.md`; the deployment modes and their settings are in its "Deployment-mode configuration" table. Backups and the restore check (runbook steps 10–11) arrive with Sprint 0 task 17.

## What runs

| Service  | Image                                                              | Notes                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy`  | `ghcr.io/eriscs01/tribo-proxy:<tag>`                               | Caddy with the Cloudflare DNS module and the built SPA. `/v1/*` and `/healthz` go to `app`; everything else is the SPA, with `index.html` for unknown paths               |
| `app`    | `ghcr.io/eriscs01/tribo-app:<tag>`                                 | Runs as `node` (uid 1000) on a read-only root filesystem with no capabilities; applies migrations at start                                                                |
| `db`     | `postgres:18.6` (pinned by digest)                                 | On an empty volume, creates the two roles and the database from the bootstrap files in the release's app image (an image mount, so Docker Engine 28 or later is required) |
| `tunnel` | `cloudflare/cloudflared` (pinned by digest), profile `tunnel` only | Cloudflare Tunnel mode                                                                                                                                                    |

Only `proxy` publishes ports (80, 443 and 443/udp). The database and the app are reachable only on the Compose network.

## Install a release (steps 6–8)

1. Put `deploy/` from the release tag in `/opt/tribo` and work there.
2. `cp .env.example .env`, then set `TRIBO_VERSION` (the release tag), `TRIBO_PUBLIC_URL`, `TRIBO_TLS_MODE`, `TRIBO_ACME_EMAIL` (acme modes) and `TRIBO_TRUSTED_PROXIES`. Compose refuses to start without the required ones and names the missing variable.
3. Create the secrets in `/opt/tribo/secrets/`:

   ```bash
   mkdir -p secrets && cd secrets
   openssl rand -out app_key 32
   for name in db_superuser_password db_owner_password db_app_password; do openssl rand -hex 32 >"$name"; done
   chmod 600 *
   ```

   Copy `app_key` off the box now (password manager or offline storage): without it, sensitive fields in any backup are unreadable. `db_superuser_password` is the `postgres` role's password, used only by the database container.

   Add the mode's own secrets, also mode 600:

   | Mode                  | Files                                                                               |
   | --------------------- | ----------------------------------------------------------------------------------- |
   | `acme-dns-cloudflare` | `cloudflare_api_token`: an API token with Zone · DNS · Edit on the one zone         |
   | `origin-cert`         | `origin_cert` and `origin_key`: a Cloudflare Origin CA certificate and its key, PEM |
   | `tunnel` profile      | `tunnel_token`: the token of a remotely managed tunnel                              |

   Compose mounts each secret into its container owned by that container's user with mode 400, so the host files can stay 600 and owned by the operator.

4. `docker compose pull && docker compose up -d`, then `docker compose logs -f proxy` until the certificate is issued (acme modes), and open `${TRIBO_PUBLIC_URL}/healthz` from a phone on mobile data. It answers `{"status":"ok"}`.
5. First admin (step 9): `docker compose exec app tribo admin create <username>`; scan the TOTP code and store the recovery codes.

## Mode notes

- **Firewall.** Docker publishes ports through its own iptables rules, which bypass `ufw`. Restrict 80/443 in the provider's firewall, or add the rules to the `DOCKER-USER` chain. This matters most for Cloudflare proxied mode, where 443 must admit only Cloudflare's ranges.
- **`acme-http`.** Ports 80 and 443 must reach the host for HTTP-01 and TLS-ALPN-01.
- **`acme-dns-cloudflare`.** No inbound port is needed for issuance; Caddy reads the token from the Docker secret at start.
- **`origin-cert`.** Set Cloudflare's SSL mode to Full (strict). Renew the Origin CA certificate before it expires by replacing the two files and running `docker compose up -d --force-recreate proxy`.
- **`internal`.** Caddy's own CA signs the certificate; its root is in the `caddy_data` volume. To trust it on a client: `docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt .`.
- **Cloudflare Tunnel.** Set `COMPOSE_PROFILES=tunnel`, `TRIBO_TRUSTED_PROXIES=cloudflare` and `TRIBO_TLS_MODE` to `origin-cert` or `internal`. In the tunnel's public hostname, set the service to `https://proxy:443` and the origin server name to the public host; with `internal`, also turn on "No TLS Verify". Close 80 and 443 in the firewall.
- **`TRIBO_TRUSTED_PROXIES=cloudflare`** takes the client IP from `CF-Connecting-IP` when the peer is in Cloudflare's published ranges (listed in `deploy/caddy/trusted-proxies/cloudflare.caddy`; refresh from https://www.cloudflare.com/ips/ if they change) or on the private Compose network (cloudflared).

## Upgrade

Set `TRIBO_VERSION` to the new tag, then `docker compose pull && docker compose up -d`. Migrations apply at app start under an advisory lock; they never need a down-migration, so rolling back is setting the old tag again.

## Releases

Pushing a tag `vX.Y.Z` on `main` runs CI. Once every job passes, its "Publish" job pushes `ghcr.io/eriscs01/tribo-app:vX.Y.Z` and `ghcr.io/eriscs01/tribo-proxy:vX.Y.Z` (linux/amd64) and lists both digests in the run summary. The packages are public, so the host pulls them without credentials (set each package's visibility to public in GitHub once, after its first push).

| Tag | Date | Notes |
| --- | ---- | ----- |
