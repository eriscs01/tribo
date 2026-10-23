# Tribo runbook

Operator procedures for the reference deployment. The step numbers follow "Reference VPS runbook" in `docs/design/sprint-0.md`.

## Reference VPS on DigitalOcean (steps 1–5)

Sprint 0 task 15. Steps 1–5 give a hardened Ubuntu host in Singapore with a DigitalOcean Cloud Firewall, ufw and Docker, and a Cloudflare DNS record in DNS-only mode. Run the commands from your own machine unless a step says "on the droplet". Replace the placeholders:

| Placeholder       | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `<host>`          | The Tribo host name, e.g. `tribo.example.com`                                                              |
| `<ipv4>` `<ipv6>` | The droplet's public addresses, from step 1                                                                |
| `<my-ip>/32`      | Your own public IPv4 (`curl -4 https://ifconfig.me`); see step 3 if your ISP changes it                    |
| `<key-id>`        | Your SSH key's ID or fingerprint in DigitalOcean (`doctl compute ssh-key list`); add one in step 1 if none |

The provisioning files are in `deploy/provision/`. Both are idempotent and hold no keys, IPs or account IDs:

- `provision.sh` covers steps 2–4 on the droplet. It creates the sudo user and limits SSH to that user's key, removing root's key. It turns on unattended security upgrades with an automatic reboot at 03:30 Manila time when an update needs one. It sets up ufw with SSH rate-limited, and installs Docker after checking the fingerprint of Docker's signing key. It works as droplet user data or over SSH, and rejects arguments that are not plain names or addresses.
- `do-firewall.sh` covers step 3 in DigitalOcean. It prints the `doctl` command that creates or updates the Cloud Firewall and runs it only with `--apply`.

### Before you start: account security

This repository is public, so the scripts and this runbook hold nothing secret. What protects the server are the accounts and the key below. Anyone who controls one of them controls the host, its DNS name or the code it runs.

- **Two-factor authentication on DigitalOcean, Cloudflare and GitHub.** Use an authenticator app or a security key, not SMS. Store the recovery codes in your password manager. The DigitalOcean account alone can open a console on the droplet, change the firewall and delete the droplet.
- **Your SSH key has a passphrase.** Load it with `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` instead of storing it without one. If the key leaks, remove it from the droplet's `authorized_keys` and from DigitalOcean (Settings → Security), then add a new one.
- **The `doctl` token is scoped and expires.** Create it under API → Tokens with custom scopes (`droplet: read`, `firewall: read, update`, `tag: read`) and an expiry of 90 days or less. Delete it there if your machine is lost. `doctl` keeps it in plain text in its config file (`~/Library/Application Support/doctl/config.yaml` on macOS), so never copy that file into the repository.
- **No secrets in the repository.** App keys, database passwords and tokens live only on the host under `deploy/secrets/` and in your password manager (steps 6–7).

### Keys in a directory of their own

The reference host's keys, host key and ssh settings can live in `~/.tribo-deploy/` instead of `~/.ssh`, so nothing else on your machine uses them and no tool that reads `~/.ssh` sees them. The v0.3.0 install did this:

```bash
mkdir -m 700 ~/.tribo-deploy && ssh-keygen -t ed25519 -C tribo-deploy -f ~/.tribo-deploy/id_ed25519
```

`~/.tribo-deploy/config` (mode 600) names the host once:

```plain
Host tribo-ref
  HostName <ipv4>
  User tribo
  IdentityFile ~/.tribo-deploy/id_ed25519
  IdentitiesOnly yes
  IdentityAgent none
  UserKnownHostsFile ~/.tribo-deploy/known_hosts
  StrictHostKeyChecking accept-new
```

Then `ssh -F ~/.tribo-deploy/config tribo-ref` stands for `ssh tribo@<ipv4>` in every step below (and `root@tribo-ref` for `root@<ipv4>`). Use `accept-new` only for the first connection, right after creating the droplet, then change it to `yes`. Step 10 adds the backup key's alias to the same file.

### Choices

| Item           | Choice                                                                 | Why                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region         | `sgp1` (Singapore)                                                     | Closest DigitalOcean region to the Philippines                                                                                                    |
| Size           | `s-1vcpu-2gb`: Basic Regular, 1 vCPU, 2 GB RAM, 50 GB SSD, US$12/month | Smallest plan that meets 1 vCPU / 2 GB / 25 GB (`doctl compute size list`, 18 Oct 2026). `s-2vcpu-2gb` (US$18) is the step up if the CPU is short |
| Image          | `ubuntu-24-04-x64` (Ubuntu 24.04 LTS)                                  | Current LTS that Docker supports. `ubuntu-26-04-x64` and `debian-13-x64` also work with `provision.sh`                                            |
| Authentication | SSH key only                                                           | DigitalOcean installs the key for root, and `provision.sh` moves it to the sudo user and closes root login                                        |
| IPv6           | On (`--enable-ipv6`)                                                   | Gives the AAAA record in step 5. It is off by default                                                                                             |
| Monitoring     | On (`--enable-monitoring`, free)                                       | CPU, memory and disk graphs and alert policies. It is off by default                                                                              |
| Droplet agent  | Default (on)                                                           | Gives the browser Droplet Console. It connects over SSH, so limiting 22 may block it                                                              |
| Backups        | Off                                                                    | Task 17 pulls nightly dumps to a disk you own. DigitalOcean backups cost a percentage of the droplet price and are optional                       |
| Cloud Firewall | `tribo-ref-fw`, applied by tag `tribo` (free)                          | The firewall covers the droplet from first boot. It drops traffic before the droplet, so ports Docker publishes past ufw stay closed here too     |
| Host firewall  | ufw with the same rules                                                | Second layer, as the design requires                                                                                                              |
| User data      | `deploy/provision/provision.sh`                                        | Hardens the host and installs Docker on first boot                                                                                                |

DigitalOcean's guidance adds to the design runbook in these ways:

- Keys chosen at creation reach root only, and cannot be added through DigitalOcean later. The sudo user gets them from root's `authorized_keys`.
- A Cloud Firewall made with `doctl` denies all outbound traffic unless you add outbound rules. `do-firewall.sh` allows all outbound TCP, UDP and ICMP, for apt, image pulls, ACME, DNS and NTP.
- When several firewalls cover a droplet, the union of their rules applies. Keep `tribo-ref-fw` the only firewall on the `tribo` tag.
- Port 443 is also opened for UDP in both firewalls, because Caddy serves HTTP/3 on it.

### Step 1. Host

Check that `doctl` is signed in (`doctl auth init` uses a token you create in the control panel under API; enter it yourself):

```bash
doctl account get --format Status
```

If `doctl compute ssh-key list` shows no key, add your public key:

```bash
doctl compute ssh-key create tribo-operator --public-key "$(cat ~/.ssh/id_ed25519.pub)"
```

Create the firewall first, so it covers the droplet as soon as it carries the tag. Review the printed command, then rerun with `--apply`:

```bash
sh deploy/provision/do-firewall.sh --ssh-from <my-ip>/32
```

Create the droplet:

```bash
doctl compute droplet create tribo-ref --region sgp1 --size s-1vcpu-2gb --image ubuntu-24-04-x64 --ssh-keys <key-id> --enable-ipv6 --enable-monitoring --tag-names tribo --user-data-file deploy/provision/provision.sh --wait
```

Check: the droplet is active in `sgp1` with the right size, image and tag, and its addresses are shown.

```bash
doctl compute droplet get tribo-ref --format Name,Status,Region,SizeSlug,Image,Tags,PublicIPv4,PublicIPv6
```

### Step 2. Access

On a droplet created with the user data, `provision.sh` has already run with its defaults; wait about five minutes after creation. Run it over SSH on a droplet created without the user data, or with `--ssh-from` to restrict 22 in ufw when your IP is fixed (step 3). `<login>` is `root` until the first run and `tribo` after it:

```bash
scp deploy/provision/provision.sh <login>@<ipv4>:
```

```bash
ssh <login>@<ipv4> sudo sh provision.sh
```

The first connection asks you to trust the host key. If the Droplet Console works, compare the fingerprint SSH shows with the one this prints in the console:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

If the console doesn't work, connect for the first time right after creating the droplet, from your own network. After that, a `REMOTE HOST IDENTIFICATION HAS CHANGED` warning is an incident, unless you have just recreated the droplet. In that case, remove the old key with `ssh-keygen -R <host>` and trust the new one.

Keep your current session open until the checks below pass from a second terminal. Check, on your machine:

```bash
ssh tribo@<ipv4> 'sudo sshd -T | grep -E "^(allowusers|permitrootlogin|authenticationmethods|passwordauthentication|kbdinteractiveauthentication|maxauthtries) "; sudo ls /root/.ssh'
```

Expect these values: `allowusers tribo`, `permitrootlogin no`, `authenticationmethods publickey`, `passwordauthentication no`, `kbdinteractiveauthentication no` and `maxauthtries 3`. `/root/.ssh` should list no `authorized_keys`, or an empty one: cloud-init can create an empty file again after `provision.sh` has removed it. Either grants nothing; `sudo find /root/.ssh -name authorized_keys -size +0` must print nothing.

```bash
ssh -o BatchMode=yes root@<ipv4> true
```

```bash
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive tribo@<ipv4> true
```

Both must fail with `Permission denied (publickey)`.

```bash
ssh tribo@<ipv4> 'systemctl is-active unattended-upgrades && apt-config dump | grep -E "Periodic::Unattended-Upgrade|Automatic-Reboot" && sudo unattended-upgrade --dry-run 2>&1 | tail -3'
```

Expect these values: `active`, `APT::Periodic::Unattended-Upgrade "1";`, `Unattended-Upgrade::Automatic-Reboot "true";`, `Automatic-Reboot-Time "19:30";` (the clock is UTC) and no errors. If something went wrong on first boot, read `/var/log/cloud-init-output.log`.

### Step 3. Firewall

The Cloud Firewall comes from step 1. Restrict SSH to your IP in the layer you can change without SSH:

- **Your IP changes (most home ISPs):** restrict 22 in the Cloud Firewall only and leave ufw's 22 open (the `provision.sh` default). When your IP changes, SSH times out; update the Cloud Firewall from your machine, then connect:

  ```bash
  sh deploy/provision/do-firewall.sh --ssh-from "$(curl -4s https://ifconfig.me)/32" --apply
  ```

  Restricting ufw as well would need SSH to undo after an IP change, which locks you out; the browser Droplet Console may not get in either.

- **Your IP is fixed:** also pass `--ssh-from <my-ip>/32` to `provision.sh`, so both layers restrict 22.

Without `doctl`, set it in the control panel: Networking → Firewalls → Create Firewall, name `tribo-ref-fw`.

- Inbound: SSH TCP 22 from your IP; HTTP TCP 80, HTTPS TCP 443, UDP 443 and ICMP from All IPv4 and All IPv6.
- Outbound: ICMP, all TCP and all UDP to All IPv4 and All IPv6 (the panel's default).
- Apply to droplets: tag `tribo`.

Check that the firewall covers the droplet with exactly these rules. A firewall applied by tag can take a minute or two to reach a new droplet: until this lists it, a closed port answers `Connection refused` instead of timing out. `doctl compute firewall get` shows no droplet ids for it, because those list only droplets attached by id.

```bash
doctl compute firewall list-by-droplet "$(doctl compute droplet get tribo-ref --format ID --no-header)" --format Name,Status,Tags,InboundRules
```

Check ufw: `Status: active`, default deny incoming, 22/tcp `LIMIT` (at most 6 new connections in 30 seconds from one address), and 80/tcp, 443/tcp and 443/udp allowed.

```bash
ssh tribo@<ipv4> sudo ufw status verbose
```

Check from outside that a port outside the list is closed. This must time out:

```bash
nc -vz -w 5 <ipv4> 5432
```

### Step 4. Docker

`provision.sh` installs Docker Engine, Buildx and the Compose plugin from `download.docker.com` and adds the sudo user to the `docker` group. Check that the packages come from Docker's repository and that the user can run containers without sudo (log in again after a rerun):

```bash
ssh tribo@<ipv4> 'apt-cache policy docker-ce | grep -m1 download.docker.com && docker version --format "{{.Server.Version}}" && docker compose version && docker run --rm hello-world | grep -m1 Hello'
```

Check the trusted signing key and the daemon defaults. Expect fingerprint `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`, then `live-restore=true log=local`. With live restore, containers keep running while the daemon upgrades; the `local` log driver rotates logs so they can't fill the disk.

```bash
ssh tribo@<ipv4> 'gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | grep -m1 ^fpr; docker info --format "live-restore={{.LiveRestoreEnabled}} log={{.LoggingDriver}}"'
```

The release needs at least the Engine and Compose versions in `deploy/docker-minimum.env`, where each one's reason is noted; `docker-check.sh` checks them before every start (steps 6–8 and Upgrade).

Docker-published ports bypass ufw. The Cloud Firewall still blocks them, and `compose.yml` publishes only 80 and 443.

### Step 5. DNS

In the Cloudflare dashboard, open the zone → DNS → Records and add:

| Type | Name                      | Content  | Proxy status | TTL  |
| ---- | ------------------------- | -------- | ------------ | ---- |
| A    | the host part of `<host>` | `<ipv4>` | DNS only     | Auto |
| AAAA | the host part of `<host>` | `<ipv6>` | DNS only     | Auto |

Check that public DNS returns the droplet's own addresses, not Cloudflare's. If Cloudflare addresses come back, the record is still proxied:

```bash
dig +short A <host> @1.1.1.1
```

```bash
dig +short AAAA <host> @1.1.1.1
```

Limit who may issue certificates for the name, and sign the zone:

- **CAA:** add a record with type `CAA`, name the host part of `<host>`, flags `0`, tag "Only allow specific hostnames" (`issue`) and value `letsencrypt.org`. Another certificate authority then refuses to issue for the name.
- **DNSSEC:** go to DNS → Settings → Enable DNSSEC. If the domain is not registered through Cloudflare, add the DS record Cloudflare shows at your registrar.

Check: the first command prints `0 issue "letsencrypt.org"`; the second prints `ad`, meaning the answer was validated with DNSSEC.

```bash
dig +short CAA <host> @1.1.1.1
```

```bash
dig +dnssec A <host> @1.1.1.1 | grep -o ' ad'
```

Optionally, set reverse DNS by renaming the droplet to `<host>`. DigitalOcean creates the PTR record from a droplet name that is a fully qualified domain name.

## Deploy with Compose (steps 6–9)

Sprint 0 task 14. `deploy/compose.yml` runs Tribo in any deployment mode from the "Deployment-mode configuration" table in `docs/design/sprint-0.md`. Backups and the restore check are steps 10–11 below.

### What runs

| Service  | Image                                                              | Notes                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy`  | `ghcr.io/eriscs01/tribo-proxy:<tag>`                               | Caddy with the Cloudflare DNS module and the built SPA. `/v1/*` and `/healthz` go to `app`; everything else is the SPA, with `index.html` for unknown paths                                         |
| `app`    | `ghcr.io/eriscs01/tribo-app:<tag>`                                 | Runs as `node` (uid 1000) on a read-only root filesystem with no capabilities; applies migrations at start; writes encrypted uploads to the `uploads` volume, its one writable path                 |
| `db`     | `postgres:18.6` (pinned by digest)                                 | On an empty volume, creates the two roles and the database from the bootstrap files in the release's app image (the app image mounted twice, which needs the Docker Engine in `docker-minimum.env`) |
| `tunnel` | `cloudflare/cloudflared` (pinned by digest), profile `tunnel` only | Cloudflare Tunnel mode                                                                                                                                                                              |

Only `proxy` publishes ports (80, 443 and 443/udp). The database and the app are reachable only on the Compose network.

The volumes are `pgdata` (the database), `uploads` (uploaded files, encrypted with the app key, at `/var/lib/tribo/uploads` in `app`), `caddy_data` and `caddy_config`. Compose names them `tribo_<volume>` on the host, so the uploads are in `/var/lib/docker/volumes/tribo_uploads/_data`, where the backup (step 10) syncs them from. `docker compose down -v` deletes the uploads with the database.

Uploads are capped at 25 MiB ([decision 0019](decisions/0019-blob-store-and-upload-ceiling.md)). Caddy refuses a request body over 26 MiB (the file plus its multipart framing) before it reaches the app, and the app stops reading a file at 25 MiB; both answer `413` with the problem code `file_too_large`. Caddy's refusal writes no app log line, since the request never reached the app: its access log in `docker compose logs proxy` has the status. In Cloudflare proxied and tunnel modes the edge allows 100 MB, so the 25 MiB ceiling still holds.

### Install a release (steps 6–8)

1. Put `deploy/` from the release tag in `/opt/tribo` and work there. From a checkout on your machine (`sudo install -d -o tribo -g tribo /opt/tribo` on the host first):

   ```bash
   git archive <tag> deploy | ssh tribo@<ipv4> 'cd /opt/tribo && tar -x --strip-components=1 && chmod -R go-w /opt/tribo'
   ```

   The `chmod` matters: Ubuntu gives `tribo` umask 002, so the files arrive group-writable, and `backup/serve.sh` is the backup key's forced command. Run `sh docker-check.sh`: it refuses a Docker Engine or Compose older than the release's `docker-minimum.env`, before anything starts.

2. `cp .env.example .env`, then set `TRIBO_VERSION` (the release tag), `TRIBO_PUBLIC_URL`, `TRIBO_TLS_MODE`, `TRIBO_ACME_EMAIL` (acme modes) and `TRIBO_TRUSTED_PROXIES`. Compose refuses to start without the required ones and names the missing variable.
3. Create the secrets in `/opt/tribo/secrets/`:

   ```bash
   mkdir -p secrets && chmod 700 secrets && cd secrets
   openssl rand -out app_key 32
   for name in db_superuser_password db_owner_password db_app_password; do openssl rand -hex 32 >"$name"; done
   chmod 644 *
   ```

   Copy `app_key` off the box now (password manager or offline storage): without it, sensitive fields in any backup are unreadable. `db_superuser_password` is the `postgres` role's password, used only by the database container.

   Add the mode's own secrets, also mode 644:

   | Mode                  | Files                                                                               |
   | --------------------- | ----------------------------------------------------------------------------------- |
   | `acme-dns-cloudflare` | `cloudflare_api_token`: an API token with Zone · DNS · Edit on the one zone         |
   | `origin-cert`         | `origin_cert` and `origin_key`: a Cloudflare Origin CA certificate and its key, PEM |
   | `tunnel` profile      | `tunnel_token`: the token of a remotely managed tunnel                              |

   Compose bind-mounts each secret file into its container as it is on the host: it ignores a secret's `uid`, `gid` and `mode` outside Swarm. The containers run as other users (`postgres` is uid 999, the app's `node` is 1000), so the files must be readable by all (644). The directory is 700, so no other user on the host can reach them, and each container sees only the secrets it mounts. With mode 600 the database's init script stops at `Permission denied`.

   Check, before the first start: `ls -ld . && ls -l` shows `drwx------` for the directory and `-rw-r--r--` for each file.

4. `docker compose pull && docker compose up -d --wait`, then `docker compose logs -f proxy` until the certificate is issued (acme modes), and open `${TRIBO_PUBLIC_URL}/healthz` from a phone on mobile data. It answers `{"status":"ok"}`.

   If `app` stays unhealthy and `docker compose logs app` ends with `upload directory /var/lib/tribo/uploads is not writable`, the `uploads` volume is not mounted (a `compose.yml` from before `v0.4.0`) or not owned by uid 1000; take `deploy/` from the release tag again. The app checks the directory at start, before it serves anything.

   If `db` stays unhealthy on the first start, read why with `docker compose logs db | grep 'tribo init'`. The init script runs only on an empty volume, so after fixing the cause (usually the secrets' modes), delete the half-made volume and start again with `docker compose down -v && docker compose up -d --wait`. Do this only on a first install: `down -v` deletes the database.

5. First admin (step 9): `docker compose exec app tribo admin create <username>`; scan the TOTP code and store the recovery codes.

### Mode notes

- **Firewall.** Docker-published ports bypass `ufw` (step 4), so restrict 80 and 443 in the provider's firewall (step 3), or in the `DOCKER-USER` chain. This matters most in Cloudflare proxied mode, where 443 must admit only Cloudflare's ranges.
- **`acme-http`.** Ports 80 and 443 must reach the host for HTTP-01 and TLS-ALPN-01.
- **`acme-dns-cloudflare`.** No inbound port is needed for issuance; Caddy reads the token from the Docker secret at start.
- **`origin-cert`.** Set Cloudflare's SSL mode to Full (strict). Renew the Origin CA certificate before it expires by replacing the two files and running `docker compose up -d --force-recreate proxy`.
- **`internal`.** Caddy's own CA signs the certificate; its root is in the `caddy_data` volume. To trust it on a client: `docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt .`.
- **Cloudflare Tunnel.** Set `COMPOSE_PROFILES=tunnel`, `TRIBO_TRUSTED_PROXIES=cloudflare` and `TRIBO_TLS_MODE` to `origin-cert` or `internal`. In the tunnel's public hostname, set the service to `https://proxy:443` and the origin server name to the public host; with `internal`, also turn on "No TLS Verify". Close 80 and 443 in the firewall.
- **`TRIBO_TRUSTED_PROXIES=cloudflare`** takes the client IP from `CF-Connecting-IP` when the peer is in Cloudflare's published ranges (listed in `deploy/caddy/trusted-proxies/cloudflare.caddy`; refresh from https://www.cloudflare.com/ips/ if they change) or on the private Compose network (cloudflared).

### Upgrade

Take `deploy/` from the new tag as in step 6.1 (from `v0.4.0` on, `compose.yml` adds the `uploads` volume, which Compose creates on the next `up`), set `TRIBO_VERSION` to the new tag, then `sh docker-check.sh && docker compose pull && docker compose up -d`. Recreating the app container deletes its logs, so save them first if a problem is open ("Debugging a production problem", step 6). `docker-check.sh` refuses a Docker Engine or Compose older than `docker-minimum.env` in that release; upgrade them with `sudo apt-get install --only-upgrade docker-ce docker-ce-cli docker-compose-plugin` first. Migrations apply at app start under an advisory lock; they never need a down-migration, so rolling back is setting the old tag again.

### Releases

Pushing a tag `vX.Y.Z` on `main` runs CI. Once every job passes, its "Publish" job pushes `ghcr.io/eriscs01/tribo-app:vX.Y.Z` and `ghcr.io/eriscs01/tribo-proxy:vX.Y.Z` (linux/amd64) and lists both digests in the run summary. They are the images that Trivy scanned and End to end ran in the same run, retagged, not rebuilt ([decision 0014](decisions/0014-published-images-are-the-scanned-ones.md)); each scanned image's id and each pushed id and digest are in the jobs' logs (`gh run view <run> --log`) and in the run summary, which GitHub shows only to signed-in viewers. The packages are public, so the host pulls them without credentials (set each package's visibility to public in GitHub once, after its first push).

| Tag      | Date       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.1.0` | 2026-10-18 | First release: Sprint 0 foundation (tasks 1–15 and 19), first images published to GHCR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `v0.2.0` | 2026-10-18 | Tasks 17–18, secrets fix, Docker minimums; first deploy on the reference host; walking skeleton checked by hand on 2026-10-18; first nightly backup and restore check passed on 2026-10-18                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `v0.3.0` | 2026-10-23 | Drop A of slice 1a: 46 REST operations; rate limits; R1 fixes; migrations 0002–0003; fresh reference host (`acme-http`, [decision 0015](decisions/0015-reference-host-uses-acme-http.md)); first release that publishes the scanned images ([decision 0014](decisions/0014-published-images-are-the-scanned-ones.md)): app `sha256:e5595918ba526cb638d74134588c97ee18cfb14bfb3f2b7aaae8b4363605b3d6`, proxy `sha256:9479200f84b551aedbe51546fc5a340ca65af2474b8f3acc16e5166a2ae0b26f`; deployed and walking skeleton checked on 2026-10-23; reference host torn down 2026-10-23 (deploy verified, then removed) |

## Backups and restore (steps 10–11)

Sprint 0 task 17. Every night your own machine pulls a database dump and the upload volume from the host over SSH, into a dated snapshot on a disk you own, and keeps the newest 7. The host holds no credentials to that disk, and the key your machine uses can only read backups. Every quarter you restore the newest snapshot into a scratch Compose project on your machine and check every audit chain. Up to a day of edits can be lost; there is no point-in-time restore.

The files are in `deploy/backup/`. None holds a key, a password or an address:

| File                                                    | Runs on      | What it does                                                                                                                                         |
| ------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve.sh`                                              | the host     | The forced command of the backup key: answers `status`, `dump` (`pg_dump -Fc` in the `db` container) and a read-only rsync of the upload volume only |
| `pull.sh`                                               | your machine | The nightly backup: dump, upload sync with unchanged files hard-linked to the previous snapshot, manifest with the SHA-256, rotation to 7            |
| `ph.tribo.backup.plist`, `tribo-backup.{service,timer}` | your machine | The nightly timer at 02:00 Asia/Manila: launchd on macOS, systemd on Linux                                                                           |
| `restore.sh`, `restore-db.sh`, `compose.restore.yml`    | your machine | The restore check in the scratch project `tribo-restore`                                                                                             |
| `backup.env.example`                                    | your machine | Settings for `pull.sh` and `restore.sh`; copy to `~/.config/tribo/backup.env`                                                                        |

`pull.sh` and `restore.sh` share `snapshots.sh`, which names snapshots. A snapshot is a directory named by its Manila time, such as `2026-10-19T020000`, holding `tribo.dump`, `manifest` and, once the host has an upload volume, `uploads/`. A run that fails leaves a `.partial` directory, which the next run deletes. Snapshots do not contain the app key: that is the copy you made in step 7, and without it the sensitive fields in a restore are unreadable.

### Step 10. Backups

The backup key has no passphrase, so the nightly job can use it unattended. Its `authorized_keys` line forces `serve.sh` and turns off the shell, port forwarding and agent forwarding, so a stolen copy can read backups and nothing else. On your machine:

```bash
ssh-keygen -t ed25519 -N '' -C tribo-backup -f ~/.ssh/tribo_backup
```

Put `deploy/backup/` from this repository's `main` in `/opt/tribo/backup/` on the host (releases after `v0.1.0` include it with the rest of `deploy/`), then add the key with its forced command:

```bash
scp -r deploy/backup tribo@<ipv4>:/opt/tribo/
```

```bash
ssh tribo@<ipv4> "echo 'restrict,command=\"/opt/tribo/backup/serve.sh\" $(cat ~/.ssh/tribo_backup.pub)' >>~/.ssh/authorized_keys"
```

Add a host alias for the key at the top of `~/.ssh/config`, above any `Host *` block:

```plain
Host tribo-backup
  HostName <ipv4>
  User tribo
  IdentityFile ~/.ssh/tribo_backup
  IdentitiesOnly yes
  IdentityAgent none
```

With the keys in `~/.tribo-deploy/` (see "Keys in a directory of their own"), put this alias in `~/.tribo-deploy/config` instead, with `IdentityFile ~/.tribo-deploy/tribo_backup`, `UserKnownHostsFile ~/.tribo-deploy/known_hosts` and `StrictHostKeyChecking yes`, and set `TRIBO_SSH_CONFIG=$HOME/.tribo-deploy/config` in `backup.env` below: `pull.sh` then runs `ssh -F` with that file and never reads `~/.ssh/config`.

ssh offers every `IdentityFile` that matches, in file order, and the keys in your agent before any of them. Your own login key also opens `tribo@<ipv4>`, so if ssh offers it first you get a full shell instead of `serve.sh`. Putting the alias first and turning off the agent for it make ssh offer the backup key alone first.

Copy the settings and set `TRIBO_BACKUP_DIR` to a directory on the disk you own, such as `/Volumes/Backup/tribo`:

```bash
mkdir -p ~/.config/tribo && cp deploy/backup/backup.env.example ~/.config/tribo/backup.env
```

Check that the key can do nothing but serve backups. The first command prints the release tag and `uploads=yes` (`uploads=no` on a release before `v0.4.0`, which has no upload volume); the second must fail with `refused 'id'`:

```bash
ssh tribo-backup status
```

```bash
ssh tribo-backup id
```

If `status` prints `command not found` and `id` prints a `uid=` line, ssh logged in with another key. `ssh -v tribo-backup true 2>&1 | grep 'Server accepts'` names it; fix the alias as above until it names `tribo_backup`.

ufw admits at most 6 new SSH connections from one address in 30 seconds (step 3), and a backup opens up to three. If a command here fails with `Connection refused`, wait 30 seconds and run it again.

Run one backup by hand:

```bash
sh deploy/backup/pull.sh
```

Check: it ends with `snapshot … complete`, and the newest snapshot's `manifest` names the running release and a `dump_bytes` above zero. The upload sync goes through rrsync, which comes with Ubuntu's rsync package, and accepts only rsync 3 as the client. macOS ships openrsync instead, which rrsync refuses, so on a Mac install Homebrew's rsync (`brew install rsync`) and set `TRIBO_RSYNC=/opt/homebrew/bin/rsync` in `backup.env`. `pull.sh` stops with that advice once the host has an upload volume and the client is not rsync 3.

Install the nightly timer. On macOS, from the root of your checkout (launchd uses the Mac's own time zone, so with the Mac set to another zone, change `Hour` to the hour that is 02:00 in Manila):

```bash
sed "s#TRIBO_REPO#$PWD#" deploy/backup/ph.tribo.backup.plist >~/Library/LaunchAgents/ph.tribo.backup.plist
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ph.tribo.backup.plist && launchctl kickstart gui/$(id -u)/ph.tribo.backup
```

A run missed while the Mac sleeps happens when it wakes. The log is `~/Library/Logs/tribo-backup.log`. If it shows `Operation not permitted` on the backup disk, allow the disk under System Settings → Privacy & Security → Files and Folders (or Full Disk Access) for `sh`.

On Linux, the timer runs at 02:00 Asia/Manila in any time zone. With the checkout somewhere other than `~/tribo`, edit `ExecStart` first:

```bash
mkdir -p ~/.config/systemd/user && cp deploy/backup/tribo-backup.service deploy/backup/tribo-backup.timer ~/.config/systemd/user/
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now tribo-backup.timer && loginctl enable-linger "$USER"
```

Check the next morning: `ls "$TRIBO_BACKUP_DIR"` (the directory from `backup.env`) lists a snapshot stamped about `T0200`, and after eight nights it lists exactly 7. The timer's own state:

```bash
launchctl print gui/$(id -u)/ph.tribo.backup | grep -E 'state|last exit code'
```

```bash
systemctl --user list-timers tribo-backup.timer
```

Until your machine can pull (no disk yet, or the machine is away), keep a dump on a separate DigitalOcean Volume attached to the droplet, and remove this fallback once the pull works. On the host, with the volume mounted at `/mnt/backup`:

```bash
cd /opt/tribo && docker compose exec -T db pg_dump --username postgres --dbname tribo --format custom >/mnt/backup/tribo-$(date +%F).dump
```

### Step 11. Restore check

Run it on your own machine with Docker (Docker Desktop, OrbStack or Colima, with at least the Engine and Compose in `deploy/docker-minimum.env`; `restore.sh` runs `docker-check.sh` first), never on the host: `restore.sh` refuses a Docker engine that runs the production project `tribo`. The scratch project `tribo-restore` has its own volumes and network, fresh random database passwords, and publishes only `127.0.0.1:8443`. Its secrets and a copy of the app key live in `~/.local/state/tribo-restore/`, which only you can open, until `--down`. It runs the release the snapshot's manifest names (the images are linux/amd64, so they run emulated on Apple silicon).

Export the app key from your password manager or offline storage (step 7) to a file only you can read, and set `TRIBO_APP_KEY_FILE` to it in `~/.config/tribo/backup.env`. The file must hold the 32 raw bytes of `app_key` or their base64, 44 characters ending in `=`; raw bytes do not survive the clipboard, so keep a text copy as base64 (`openssl base64 -in app_key`). Check that it is the host's key: both commands print the same 8 characters (for a raw copy, drop `tr -d '\n' | base64 -d |`):

```bash
cat <key file> | tr -d '\n' | base64 -d | shasum -a 256 | cut -c1-8
```

```bash
ssh tribo@<ipv4> 'sha256sum /opt/tribo/secrets/app_key' | cut -c1-8
```

Then restore the newest snapshot (pass a snapshot directory to restore another):

```bash
sh deploy/backup/restore.sh
```

It checks the dump against its manifest checksum, starts the scratch database (whose init script creates the two roles and an empty database), restores the dump as the `postgres` superuser in one transaction with every object owned by `tribo_owner` and `tribo_app`'s grants as they were, copies the uploads in and checks every restored file against the snapshot by SHA-256, starts the app (which finds no migration to apply) and the proxy, and runs `tribo audit verify`.

Check: the output says `restored N uploaded files, each matching the snapshot` (when the snapshot has uploads) and ends with `All N chains intact.` and `passed`. A `does not match the snapshot` failure means the copy into the scratch volume lost or changed a file: check the disk space on your machine and run the check again. Then open https://restore.tribo.localhost:8443 and accept the browser's warning (Caddy's internal CA, new on every run). Sign in as your admin from step 9, open the trip from exit criteria 1–2 and check that its items are there.

Delete the scratch project with its volumes, passwords and copy of the app key, then the file you exported:

```bash
sh deploy/backup/restore.sh --down
```

Record the check below, and repeat it every quarter and after any change to the backup scripts.

| Date       | Snapshot            | Release  | Chains   | Notes                                                                                                                |
| ---------- | ------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| 2026-10-18 | `2026-10-18T213114` | `v0.2.0` | 3 intact | First snapshot from the launchd job, restored on the operator's Mac (Colima, Apple silicon)                          |
| 2026-10-23 | `2026-10-23T140622` | `v0.3.0` | 3 intact | Fresh reference host; manual `pull.sh` with `TRIBO_SSH_CONFIG`; walking skeleton trip and item present after restore |

## Walking skeleton check (step 12)

Sprint 0 task 18. Exit criteria 1–2 by hand on the reference host, over HTTPS, after a release is installed (steps 6–9). CI job "End to end" runs the same steps on every pull request, on `main` and on release tags (`apps/e2e/src/walking-skeleton.spec.ts`); this check proves them on the real host, certificate and DNS. Work in `/opt/tribo` on the droplet, and use a phone or laptop browser for the web steps. Use invented trip data only.

1. **Admin and TOTP (exit criterion 1).** If step 9 already made the first admin, sign in with that account at step 2 and skip this one. Otherwise run `docker compose exec app tribo admin create <username> "<display name>"`. Type a password (12–128 characters) twice. Add the printed key or `otpauth://` URI to your authenticator app, then type the six-digit code it shows. The command prints 10 recovery codes: store them in your password manager.
2. **Sign in.** Open `${TRIBO_PUBLIC_URL}` in the browser: it shows "Sign in". Enter the username, the password and the current authenticator code, then "Sign in". "My trips" opens and the header shows "Signed in as <username>".
3. **Trip (exit criterion 2).** "New trip": name `Siargao surf week`, first day `2026-11-10`, last day `2026-11-16`, currency `PHP`, time zone `Asia/Manila`; "Create trip". The trip page opens with that name.
4. **Item.** Under "Add an item", title `Island hopping`, then "Add item". The item page opens. Reload it: the title is still there and "Visible to" says "Everyone on the trip". Follow "Back to Siargao surf week", then "All trips": the trip is in the list.
5. **Audit chain.** On the droplet, look up the trip's chain and the item's event:

   ```bash
   docker compose exec -T db psql -U tribo_app -d tribo -c \
     "SELECT chain_key, seq, action, entity_type, surface FROM audit.audit_events WHERE trip_id = (SELECT id FROM tribo.trips WHERE name = 'Siargao surf week' ORDER BY created_at DESC LIMIT 1) ORDER BY seq"
   ```

   The last row is `trip:<uuid> | … | create | item | web`.

6. **Verify.** `docker compose exec app tribo audit verify trip:<uuid>`, with the chain key from step 5, prints `… intact`. Then `docker compose exec app tribo audit verify` ends with `All <n> chains intact.` and exits 0.
7. **Record.** In the "Releases" table above, add "walking skeleton checked by hand on <date>" to the notes of the tag you checked.

## Debugging a production problem

Everything a request leaves behind joins on its request id: its log lines, its problem body and its audit events. Logs are pino JSON on the app container's standard output, kept by Docker's `local` driver on the host; nothing is sent anywhere else. Work in `/opt/tribo` on the droplet.

1. **Get the request id.** Every error the web app shows ends with `Reference: <id>`; ask the user for it (a screenshot is fine). An API caller has it in the `X-Request-Id` response header and in every problem body as `requestId`. A `tribo` command that fails prints `(request cli-<uuid>)`.
2. **Know the release.** `docker compose exec app tribo release show` prints `Tribo <tag> (<commit>)`; every log line also carries `release` and `commit`, so lines from before an upgrade say which build wrote them. `/healthz` stays detail-free on purpose.
3. **Find its log lines.**

   ```bash
   docker compose logs --no-color --since 24h app | grep -F '"requestId":"<id>"'
   ```

   Each line names the operation (`operationId`, from the operation registry). What the messages mean:

   | `msg`                                       | Level | What it says                                                                                                                                                                                                |
   | ------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `incoming request`, `request completed`     | info  | Method, path, client IP (from Caddy), status and `responseTime` in ms. A `/healthz` probe that answers 200 writes neither; a failing one writes `request completed` with its 503                            |
   | `request refused`                           | info  | An expected refusal: `problem` (the error code the caller got) and `status`. Never the values sent                                                                                                          |
   | `request failed`                            | warn  | A 5xx answer: `problem` and `status`. For `internal_error`, the `unhandled error` line beside it has the stack                                                                                              |
   | `unhandled error`                           | error | The exception and its stack (`err.stack`). The caller saw only `internal_error`                                                                                                                             |
   | `slow request`                              | warn  | Over the design's p95 budget: `responseTime` against `budgetMs` (300 for reads, 500 for writes)                                                                                                             |
   | `uncaught exception`, `unhandled rejection` | fatal | The process exited with code 1 and Compose restarted it; `requestId` is present when the failure escaped a request. `docker compose ps app` shows the restart; open an issue with the stack and the release |
   | `job started`, `job finished`               | info  | A daily job's run (`job` names it): `job finished` adds `durationMs` and the job's counts (for `idempotency-keys`, `deleted`; for `files-purge`, `due`, `purged`, `failed`)                                 |
   | `job skipped`                               | info  | Another process held the job's lock, so this one did not run it. Expected only while two app containers overlap (an upgrade)                                                                                |
   | `job failed`                                | error | The run stopped with `err` and its stack; the process and the other jobs carry on, and the job runs again at its next turn                                                                                  |
   | `idempotent replay`                         | info  | A repeat of an Idempotency-Key answered with the stored `status`; the work and its audit events are under the first request's id                                                                            |
   | `idle database connection lost`             | warn  | The database dropped a connection (`dbCode`); the pool reconnects on the next query and `/healthz` answers 503 until it can                                                                                 |

| `database unreachable` | warn | A `/healthz` probe could not reach the database (`dbCode`) and answered 503; `docker compose ps` shows `app` unhealthy until it can |

To see a pattern rather than one request, grep for the message and the code, for example every `forbidden` today: `docker compose logs --no-color --since 24h app | grep '"msg":"request refused"' | grep '"problem":"forbidden"'`, or every slow request: `… | grep '"msg":"slow request"'`.

4. **Join it to what changed.** `docker compose exec app tribo audit request <id>` lists the audit events that request wrote, one per line: time (UTC), chain and seq, action, entity type, entity id, version after, surface, actor user id. No events means the request changed nothing (a read, or a refusal that rolled back). Audit rows hold ids and metadata only; to see a field's history, use the item's history once it ships (1b).

   Refusals that users most often report as "it won't let me" on members (operations `members.add` and `members.setRole`); each is the owner's to fix, not the operator's:

   | `problem`                 | Operation         | What to tell the owner                                                                  |
   | ------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
   | `person_has_account`      | `members.add`     | That person has an account: send them an invite link instead of adding them             |
   | `already_member`          | `members.add`     | The placeholder is already in the trip                                                  |
   | `mfa_required`            | `members.setRole` | The new owner must turn on two-factor sign-in first; a placeholder cannot own a trip    |
   | `owner_transfer_required` | `members.setRole` | The owner steps down only by making another member owner, which makes them an organizer |

   A handover shows in `tribo audit request <id>` as two `role_change` events on `membership`, the new owner's first.

   Refusals on rooms, vehicles and the assignment board (operations `units.update` and `items.assignments.replace`, 409 unless noted); each is the organizers' to fix, not the operator's. A refused save changes nothing, so `tribo audit request <id>` lists no events; a save that went through shows one `update` on `item_board`, and `units.delete` shows a `delete` on `unit` followed by an `update` on `item_board` (its allocations went with it).

   | `problem`                 | Operation                   | What to tell the organizer                                                                                                                                                                               |
   | ------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `capacity_exceeded`       | `items.assignments.replace` | A room or vehicle would hold more people than its capacity (a vehicle's counts its driver). Move someone, or raise the unit's capacity first                                                             |
   | `capacity_exceeded`       | `units.update`              | The new capacity is below the people already in the unit; take them off the board first                                                                                                                  |
   | `room_double_booked`      | `items.assignments.replace` | A member would be in two rooms on the same night: two rooms of this stay, or a room of another stay they can see that shares a night ([decision 0009](decisions/0009-units-and-the-assignment-board.md)) |
   | `driver_taken`            | `items.assignments.replace` | A vehicle would have two drivers                                                                                                                                                                         |
   | `version_conflict` (412)  | `items.assignments.replace` | Someone saved the board (or answered an RSVP, or deleted a unit) since it was loaded; reload it and save again                                                                                           |
   | `validation_failed` (400) | `items.assignments.replace` | The problem body's `errors[].path` names the row: a member removed from the trip, a deleted unit, a vehicle where a room belongs, or a role given twice                                                  |

   Refusals on invite links and leaving a trip (operations `invites.*` and `members.remove`). A link that opens nothing answers the same `invite_invalid` whatever the reason, on purpose: neither the joiner, the log line nor the timing says which ([decision 0011](decisions/0011-invites-joins-and-removals.md)). The owner sees each link's `status` (`active`, `revoked`, `expired`, `used_up`) in the trip's invite list, and makes a new link when one is dead. Invite tokens never reach a log line, an audit row or a URL (the link is `/join#<token>`, a fragment), so there is no token to look for.

   | `problem`                 | Operation                           | What to tell the user                                                                                                                                                                           |
   | ------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `invite_invalid` (410)    | `invites.preview`, `invites.accept` | The link is unknown, expired, revoked or used up, its trip is archived or deleted, or the traveller it was for left the trip (or was claimed through another link). Ask the owner for a new one |
   | `invite_invalid` (410)    | `invites.create`                    | The owner pre-linked a person who is not an active placeholder in this trip (an account holder joins with an open link)                                                                         |
   | `username_taken`          | `invites.accept`                    | Choose another username                                                                                                                                                                         |
   | `already_member`          | `invites.accept`                    | They are in the trip already: sign in instead of joining                                                                                                                                        |
   | `claim_conflict`          | `invites.accept`                    | Their account already has a row in this trip (now or before they left), so it cannot also take over the placeholder; the owner sends an open link (a rejoin) and removes the placeholder        |
   | `owner_transfer_required` | `members.remove`                    | The owner leaves only after making another member owner                                                                                                                                         |
   | `if_match_required` (428) | `members.remove`                    | A client sent no `If-Match`; the web app always sends the membership's version                                                                                                                  |

   In `tribo audit request <id>`, a join by a new account shows `create` on `user` and on `person`, then `create` (or `claim` for a placeholder link, `restore` for a rejoin) on `membership`, `update` on `invite` (one use) and `login` on `user`, all with the new account as actor. A claim that took a placeholder's last trip adds `merge` on `person` (the placeholder, now scrubbed and pointing at the joiner), and one that closed the trip's other links to that placeholder adds a `revoke` on each `invite`; a rejoin adds `restore` on each private `item` its removal took. A removal shows `delete` on `membership`, then an `update` on `item_board` for each board the member was on and a `delete` on each private `item` they owned.

   **Too many requests (`rate_limited`, 429).** The app counts writes in one-minute windows ([decision 0008](decisions/0008-rate-limits-and-client-address.md)): 10 a minute per client address for writes made without an account (signing in, password reset), and 120 a minute per signed-in account. Reads are never limited. The user sees the request refused with `Reference: <id>`; the response carries `Retry-After` (seconds until the window resets), and waiting that long is the whole fix. The `request refused` line has `operationId`, `problem: "rate_limited"` and `status: 429`, and on purpose neither the address nor the username; a refusal changes nothing, so `tribo audit request <id>` lists no events (a refused sign-in is not a `login_failed` either). The limits live in the app's memory, so restarting `app` clears them.
   - One user, now and then: expected, nothing to do.
   - Many unrelated users refused on `auth.login` at once: the app is probably counting every request as coming from one address, Caddy's. Check that `TRIBO_APP_TRUSTED_PROXIES` covers the Caddy container's network (default `loopback,uniquelocal`) and that `TRIBO_PROXY_KIND` matches how traffic arrives (Cloudflare or not). The `incoming request` line's `remoteAddress` shows the address the app saw.
   - One user refused on every write, minute after minute: something signed in as them (a script, a stuck tab) writes in a loop. `… | grep '"problem":"rate_limited"'` shows how often and on which `operationId`; the log never names the account, so ask the user what else is signed in as them, and have them sign out of it or stop it.

   **The itinerary and the dashboard** (operations `itinerary.get`, `trips.dashboard`) are reads: they refuse only with `not_found` (not in the trip, removed, or the trip deleted) and `validation_failed` (an itinerary range that ends before it starts), and `tribo audit request <id>` lists nothing for them. What users report and why ([decision 0012](decisions/0012-itinerary-and-dashboard.md)):
   - "A warning is missing": each user's warnings cover only the items they can see, so two people can see different warnings, on purpose. Drop A checks `overlap` and `no_licensed_driver` only; the other codes come with typed item details.
   - "The driver warning stays after I added my licence": the warning follows the driver's person record, read fresh on every request. Check that the licence was saved on the person who drives (`me.update` for an account, `library.people.update` for a placeholder) and that the board names that membership as driver.
   - "The dashboard never changes": its poll answers `304` while its ETag matches, and the ETag is the SHA-256 of that user's dashboard, so it changes as soon as anything they see changes (the countdown at midnight in the trip's zone included). A `request completed` line with status 304 is a poll that found nothing new.
   - A `slow request` line on either: both build from every item the user can see in one fixed set of queries; a trip of 300 items builds in about 75 ms (itinerary) and 115 ms (dashboard) on a laptop. Note the trip and how many items it holds, and open an issue with the request id.

   **Idempotency-Key** (operations `expenses.create` and `files.upload`, [decision 0017](decisions/0017-idempotency-key.md)). A client that retries a create sends the same `Idempotency-Key`; the first request runs, and a repeat by the same account within 24 hours gets the stored response with `Idempotent-Replayed: true`. A replay writes an `idempotent replay` line (info, with `operationId` and the replayed `status`) and no audit events, so `tribo audit request <id>` lists nothing for it; the events are under the first request's id. The key itself never reaches a log line.
   - `idempotency_key_reused` (422): the client sent a key it had already used for a different request (another body, path or operation). It is a client bug; nothing was written. Tell the client author to mint a new key per create.
   - `idempotent response not stored` (error, with `err`): the first request's write committed and its caller got the answer, but storing that answer failed (usually the database connection; the `err` says). Retries under that key are refused as below until it expires.
   - `internal_error` with an `unhandled error` line saying the operation `committed under a key with no stored response`: the first request's write committed, but its answer was never stored (the line above, or the app stopped between the commit and the reply), so it cannot be replayed. The write never runs a second time. Look for the first request's `idempotent response not stored`, `uncaught exception` or restart just before. The create did happen: tell the user to reload the list instead of retrying. The key's row expires 24 hours after the first request, and the daily `idempotency-keys` job deletes it; until then that key keeps answering `internal_error`, which a client that mints a key per create never sends again.

   **Files** (operations `files.*`, [decision 0021](decisions/0021-file-uploads.md)). Uploads are encrypted on the `uploads` volume under random blob keys; no file name ever reaches a path, a log line or an audit row, so a user reporting a file is asked for the request id, not the name. An upload's `tribo audit request <id>` shows one `create` on `file`; a refused upload changes nothing and stores nothing.

   | `problem`                     | Operation      | What to tell the user                                                                                                                                                                    |
   | ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `file_type_not_allowed` (415) | `files.upload` | Only PDF, JPEG, PNG, HEIC and WebP are kept, recognised from the file's bytes. Also when the file's name or declared type says another type than its bytes: rename it or export it again |
   | `file_too_large` (413)        | `files.upload` | Files are capped at 25 MiB; a larger scan can be saved at a lower resolution                                                                                                             |
   | `validation_failed` (400)     | `files.upload` | `errors[].path` names the field: `/file` when no file part came, `/itemId` when the item is not one the user can see in this trip (on purpose, the answer does not say which)            |
   | `trip_archived` (409)         | `files.upload` | The trip is archived and takes no new files                                                                                                                                              |

   Downloads (`files.download`) look the file up again on every request, so a file made private, moved to a private item or whose reader left the trip answers `404 not_found` at once; that is the rule working ([decision 0022](decisions/0022-file-downloads.md)). A purged file answers `410 file_purged`: retention deleted its bytes and nothing brings them back. Downloading a sensitive file (`id`, `ticket`, `voucher`) shows in `tribo audit request <id>` as one `reveal` on `file` with reason `content`; other downloads write no event.

   | `msg`                     | Level | What it says                                                                                                                                                                                                                                                                                                                           |
   | ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `file content unreadable` | error | The blob of `fileId` is missing, or its first chunk does not decrypt for that file (moved, swapped or damaged on the volume); the caller got `500 internal_error` and no bytes. `err` says which. Restore that blob from the newest backup that has it (step 11's snapshot `uploads/<key>`, the key from `blob_key` of the file's row) |
   | `file download failed`    | error | The same, found after the first 64 KiB had been sent: the response was cut short, so the client saw a failed download, never a whole-looking file. Same fix                                                                                                                                                                            |

   An `unhandled error` saying `file <id> did not commit and its blob <key> is left` means an upload failed and removing its bytes failed too (usually a full or read-only volume; the `err.cause` says). Nothing references that blob. Once the volume is fixed, remove it: `docker compose exec app rm /var/lib/tribo/uploads/<key>`, where `<key>` is the `ab/ab…` key from the line, never a path from anywhere else.

   **Expenses** (operations `expenses.*`, [decision 0024](decisions/0024-expenses.md)). Tribo records each expense and its split among the members included, nothing more: there are no balances or debts to look up (R36). Amounts and descriptions never reach a log line, an audit row or a problem body's message, so a user reporting an expense is asked for the request id, not the amount. A create shows one `create` on `expense` in `tribo audit request <id>`, an edit one `update`, a void one `delete`; a refused write changes nothing. A viewer without the cost grant reads every amount as `{"masked": true}`, and anyone who cannot see the item an expense is on reads its `itemId` as null; both are the rules working, not data loss.

   | `problem`                 | Operation                             | What to tell the user                                                                                                                                                                                                                                                                                                                                                                                                                                             |
   | ------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `validation_failed` (400) | `expenses.create`, `expenses.update`  | `errors[].path` names the field: `/amount/currency` (expenses are in the trip currency until FX entry ships), `/split/shares` (itemised amounts must add up to the amount, or a member is not in the trip), `/split/membershipIds` or `/payerMembershipId` (a member who is not, or no longer, in the trip; on purpose the answer does not say which), `/split/method` (weight splits come after the trip), `/itemId` (not an item the user can see in this trip) |
   | `forbidden` (403)         | `expenses.update`, `expenses.void`    | A member edits or voids only the expenses they paid; an organizer or the owner can do it for them. Viewers never can                                                                                                                                                                                                                                                                                                                                              |
   | `version_conflict` (412)  | `expenses.update`, `expenses.void`    | Someone changed the expense since it was loaded; reload it and try again                                                                                                                                                                                                                                                                                                                                                                                          |
   | `trip_archived` (409)     | `expenses.create`, `.update`, `.void` | The trip is archived and its ledger is read-only                                                                                                                                                                                                                                                                                                                                                                                                                  |

   An edit that changes the amount of an equal split re-splits it among the same members, so it is refused at `/split/membershipIds` when one of them has since left the trip: send the split again without them. A voided expense leaves the ledger and everyone's "my share", and still locks the trip's currency (`currency_locked` on `trips.update`), since a restore (1b) brings its amounts back.

   **Overlays and my tasks** (operations `overlays.*` and `me.tasks`, [decision 0025](decisions/0025-overlays-and-my-tasks.md)). An overlay is a member's own note, reminder and checklist on an item, and nobody else's: neither a log line, an audit row nor a problem body holds one, so a user reporting a lost note is asked for the request id, and `tribo audit request <id>` shows one `create`, `update` or `delete` on `overlay` with counters only. An overlay's audit event and snapshot are not for any other reader. The due-soon list on the dashboard and in `me.tasks` shows a task due within 7 days (overdue included) and the caller's own reminders within 7 days either side of now; a reminder older than that, one of a viewer, or one on an item the caller can no longer see is not shown, which is the rule working.

   | `problem`                 | Operation                 | What to tell the user                                                                                                                         |
   | ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
   | `if_match_required` (428) | `overlays.put`, `.delete` | Send `If-None-Match: *` to create an overlay and `If-Match` with its version to replace or remove it                                          |
   | `version_conflict` (412)  | `overlays.put`            | The overlay already exists (a create), is not at that version, or does not exist (a replace); `overlays.get` it and send the answer's version |
   | `forbidden` (403)         | `overlays.get`, `.put`    | Viewers keep no overlay                                                                                                                       |
   | `not_found` (404)         | `overlays.*`              | The item is not one the caller can see, or (get, delete) they have no overlay on it; on purpose the answer does not say which                 |
   | `trip_archived` (409)     | `overlays.put`, `.delete` | The trip is archived and read-only                                                                                                            |

   **Daily jobs** ([decision 0020](decisions/0020-daily-job-runner.md)). The app runs every job in `apps/server/src/jobs/index.ts` when it starts and then every 24 hours, one after another. Today that is `idempotency-keys`, which deletes Idempotency-Keys past their 24 hours, then `files-purge`, the retention purge ([decision 0023](decisions/0023-file-retention-purge.md)). Each run has its own request id, `job-<uuid>`, on each of its log lines and on every audit event it writes, so a run is followed like a request:

   ```bash
   docker compose logs --no-color --since 48h app | grep '"msg":"job '
   ```

   lists the runs: each `job started` line names the `job` and its `requestId`. Grep that id (step 3) for the run's lines, and `docker compose exec app tribo audit request job-<uuid>` (step 4) lists what it changed; `idempotency-keys` writes no events. No `job started` line for a day means the app has not been up for a whole day since its last start (each start runs every job) or the run is stuck: a `job started` with no `job finished` or `job failed` after it. Restarting `app` runs every job again; they are safe to repeat. A `job failed` line is a bug to report with its request id and stack.

   **The file purge** (`files-purge`) deletes the bytes of files due under `document_retention_days` (default 30): files deleted that long ago, every file of a trip deleted that long ago, and sensitive files (`id`, `ticket`, `voucher`) of a trip that ended that long ago. Each due file's row becomes a tombstone (`purged_at` set, name `purged`), its earlier snapshots are dropped, a `purge` event on `file` goes to the trip's chain, and the blob named on that row is deleted; nothing on the volume is deleted any other way. Its `job finished` line counts `due`, `purged` and `failed`; nothing is due before mid-December for a trip ending in November. To check it:
   - `tribo audit request job-<uuid>` lists one `purge` per file it purged.
   - A `file purge failed` line (error, with `fileId` and `err`) means that file stays as it was, bytes included, and is due again at the next run; the others went on. A full or read-only volume is the usual cause (`err` says). Once fixed, restart `app` to run it at once.
   - `failed` that stays above zero day after day for the same `fileId` is a bug to report with the line.

5. **Raise the log level for a while.** Set `TRIBO_LOG_LEVEL=debug` in `.env`, save the current logs (next step), then `docker compose up -d app`. Reproduce the problem, then set it back to `info` and run `docker compose up -d app` again. Debug lines follow the same rules: ids, codes and timings, never values.
6. **Retention, and keeping lines before they go.** The `local` driver keeps 5 files of 20 MB per container (`x-service` in `deploy/compose.yml`), so the oldest app lines rotate out as new ones arrive. A container's logs are deleted with the container, so recreating `app` (an upgrade, a log-level change, `docker compose down`) loses them. Save what you need first:

   ```bash
   docker compose logs --no-color --timestamps app >"app-$(date -u +%Y%m%dT%H%M%SZ).log"
   ```

   Log lines carry client IPs and user agents (personal data): keep saved files on the host or on your own disk, delete them when the problem is closed, and quote only the request id, operation id and problem code in issues.

## Maintaining the repository

### The dependency graph is out of date

GitHub's dependency graph cannot read pnpm 12's lockfile, so CI job "Dependency graph" submits it on every push to `main` ([decision 0010](decisions/0010-dependency-graph-submitted-from-ci.md)). If Dependabot alerts or `gh api repos/eriscs01/tribo/dependency-graph/sbom` look stale after a merge:

1. Open the job's log on the merge commit. It prints `submitted N packages from M projects` on success, or `dependency submission refused: <status> <body>` with GitHub's answer (a 403 means the job lost `contents: write`).
2. Reproduce without sending anything: `pnpm submit:deps --dry-run` prints the snapshot.
3. Re-run the job from the Actions tab. The job is not a required check, so a failure never blocks a merge.

### A CI run was quick: skipped, or really run?

A pull request that changes documentation only takes the quick path ([decision 0013](decisions/0013-ci-path-rules-and-single-test-run.md)): every required check still reports success, but the heavy jobs skip their steps. To tell a skipped run from a real one:

1. Open the run's **Changes** job and read its log. `ci-changes: … code=false` and `documentation only` mean the quick path; `code=true` lists the first paths that count as code (`ci-changes: code: <path>`).
2. In a skipped job (Unit, Integration, Leak properties, Coverage, Typecheck, Build and scan, End to end) every step shows as skipped (grey) and the job lasts a few seconds. A job that ran shows its steps green with real durations.
3. Pushes to `main`, tags, the nightly run and Publish never take the quick path.
4. If the **Changes** job itself failed, nothing is skipped: the other jobs see an empty `code` output and run everything. Fix the cause (usually `git diff` could not read the merge commit) and re-run.
5. A pull request that was wrongly quick (a path that should count as code is not in the rules) is fixed by adding the path to `packages/story-kit/src/ci-changes.ts` with a test, in the same pull request as the change that exposed it.

### End to end stalls installing the browser

The job caches `~/.cache/ms-playwright` by Playwright version and installs only the headless shell, with no `apt-get` (`--only-shell`, no `--with-deps`). The install step stops itself after 5 minutes, so a stall fails fast instead of using the job's 30.

1. A cache hit prints nothing to download; a miss downloads about 100 MB from Playwright's CDN. Read the step "Restore the Playwright browser" for `Cache restored` or `Cache not found`.
2. If the step timed out, re-run the job once. A second stall is the CDN or the runner network: wait, do not raise the timeout.
3. If a browser error names a missing shared library (`error while loading shared libraries`), the runner image changed: add `--with-deps` back to that step and keep its timeout.
4. Raising Playwright in `apps/e2e/package.json` changes the cache key, so the next run downloads once.

### The Trivy database cache

One cache entry per UTC day, `trivy-db-<date>`, shared by both image scans. After each scan the log prints the database's `UpdatedAt` and `NextUpdate`; a scan with `NextUpdate` in the past would have downloaded a newer one first. To clear it, delete the entry (`gh cache delete trivy-db-<date>`) and re-run: Trivy downloads a fresh database.
