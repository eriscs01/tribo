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

Expect these values: `allowusers tribo`, `permitrootlogin no`, `authenticationmethods publickey`, `passwordauthentication no`, `kbdinteractiveauthentication no` and `maxauthtries 3`. `/root/.ssh` should list no `authorized_keys`.

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

Check that the firewall covers the droplet with exactly these rules:

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
| `app`    | `ghcr.io/eriscs01/tribo-app:<tag>`                                 | Runs as `node` (uid 1000) on a read-only root filesystem with no capabilities; applies migrations at start                                                                                          |
| `db`     | `postgres:18.6` (pinned by digest)                                 | On an empty volume, creates the two roles and the database from the bootstrap files in the release's app image (the app image mounted twice, which needs the Docker Engine in `docker-minimum.env`) |
| `tunnel` | `cloudflare/cloudflared` (pinned by digest), profile `tunnel` only | Cloudflare Tunnel mode                                                                                                                                                                              |

Only `proxy` publishes ports (80, 443 and 443/udp). The database and the app are reachable only on the Compose network.

### Install a release (steps 6–8)

1. Put `deploy/` from the release tag in `/opt/tribo` and work there. Run `sh docker-check.sh`: it refuses a Docker Engine or Compose older than the release's `docker-minimum.env`, before anything starts.
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

Set `TRIBO_VERSION` to the new tag, then `sh docker-check.sh && docker compose pull && docker compose up -d`. Recreating the app container deletes its logs, so save them first if a problem is open ("Debugging a production problem", step 6). `docker-check.sh` refuses a Docker Engine or Compose older than `docker-minimum.env` in that release; upgrade them with `sudo apt-get install --only-upgrade docker-ce docker-ce-cli docker-compose-plugin` first. Migrations apply at app start under an advisory lock; they never need a down-migration, so rolling back is setting the old tag again.

### Releases

Pushing a tag `vX.Y.Z` on `main` runs CI. Once every job passes, its "Publish" job pushes `ghcr.io/eriscs01/tribo-app:vX.Y.Z` and `ghcr.io/eriscs01/tribo-proxy:vX.Y.Z` (linux/amd64) and lists both digests in the run summary. The packages are public, so the host pulls them without credentials (set each package's visibility to public in GitHub once, after its first push).

| Tag      | Date       | Notes                                                                                                                                                                                      |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v0.1.0` | 2026-10-18 | First release: Sprint 0 foundation (tasks 1–15 and 19), first images published to GHCR                                                                                                     |
| `v0.2.0` | 2026-10-18 | Tasks 17–18, secrets fix, Docker minimums; first deploy on the reference host; walking skeleton checked by hand on 2026-10-18; first nightly backup and restore check passed on 2026-10-18 |

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

ssh offers every `IdentityFile` that matches, in file order, and the keys in your agent before any of them. Your own login key also opens `tribo@<ipv4>`, so if ssh offers it first you get a full shell instead of `serve.sh`. Putting the alias first and turning off the agent for it make ssh offer the backup key alone first.

Copy the settings and set `TRIBO_BACKUP_DIR` to a directory on the disk you own, such as `/Volumes/Backup/tribo`:

```bash
mkdir -p ~/.config/tribo && cp deploy/backup/backup.env.example ~/.config/tribo/backup.env
```

Check that the key can do nothing but serve backups. The first command prints the release tag and `uploads=no` (until the documents module adds the upload volume); the second must fail with `refused 'id'`:

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

It checks the dump against its manifest checksum, starts the scratch database (whose init script creates the two roles and an empty database), restores the dump as the `postgres` superuser in one transaction with every object owned by `tribo_owner` and `tribo_app`'s grants as they were, copies the uploads in, starts the app (which finds no migration to apply) and the proxy, and runs `tribo audit verify`.

Check: the output ends with `All N chains intact.` and `passed`. Then open https://restore.tribo.localhost:8443 and accept the browser's warning (Caddy's internal CA, new on every run). Sign in as your admin from step 9, open the trip from exit criteria 1–2 and check that its items are there.

Delete the scratch project with its volumes, passwords and copy of the app key, then the file you exported:

```bash
sh deploy/backup/restore.sh --down
```

Record the check below, and repeat it every quarter and after any change to the backup scripts.

| Date       | Snapshot            | Release  | Chains   | Notes                                                                                       |
| ---------- | ------------------- | -------- | -------- | ------------------------------------------------------------------------------------------- |
| 2026-10-18 | `2026-10-18T213114` | `v0.2.0` | 3 intact | First snapshot from the launchd job, restored on the operator's Mac (Colima, Apple silicon) |

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
   | `incoming request`, `request completed`     | info  | Method, path, client IP (from Caddy), status and `responseTime` in ms                                                                                                                                       |
   | `request refused`                           | info  | An expected refusal: `problem` (the error code the caller got) and `status`. Never the values sent                                                                                                          |
   | `request failed`                            | warn  | A 5xx answer: `problem` and `status`. For `internal_error`, the `unhandled error` line beside it has the stack                                                                                              |
   | `unhandled error`                           | error | The exception and its stack (`err.stack`). The caller saw only `internal_error`                                                                                                                             |
   | `slow request`                              | warn  | Over the design's p95 budget: `responseTime` against `budgetMs` (300 for reads, 500 for writes)                                                                                                             |
   | `uncaught exception`, `unhandled rejection` | fatal | The process exited with code 1 and Compose restarted it; `requestId` is present when the failure escaped a request. `docker compose ps app` shows the restart; open an issue with the stack and the release |
   | `idle database connection lost`             | warn  | The database dropped a connection (`dbCode`); the pool reconnects on the next query and `/healthz` answers 503 until it can                                                                                 |

   To see a pattern rather than one request, grep for the message and the code, for example every `forbidden` today: `docker compose logs --no-color --since 24h app | grep '"msg":"request refused"' | grep '"problem":"forbidden"'`, or every slow request: `… | grep '"msg":"slow request"'`.

4. **Join it to what changed.** `docker compose exec app tribo audit request <id>` lists the audit events that request wrote, one per line: time (UTC), chain and seq, action, entity type, entity id, version after, surface, actor user id. No events means the request changed nothing (a read, or a refusal that rolled back). Audit rows hold ids and metadata only; to see a field's history, use the item's history once it ships (1b).
5. **Raise the log level for a while.** Set `TRIBO_LOG_LEVEL=debug` in `.env`, save the current logs (next step), then `docker compose up -d app`. Reproduce the problem, then set it back to `info` and run `docker compose up -d app` again. Debug lines follow the same rules: ids, codes and timings, never values.
6. **Retention, and keeping lines before they go.** The `local` driver keeps 5 files of 20 MB per container (`x-service` in `deploy/compose.yml`), so the oldest app lines rotate out as new ones arrive. A container's logs are deleted with the container, so recreating `app` (an upgrade, a log-level change, `docker compose down`) loses them. Save what you need first:

   ```bash
   docker compose logs --no-color --timestamps app >"app-$(date -u +%Y%m%dT%H%M%SZ).log"
   ```

   Log lines carry client IPs and user agents (personal data): keep saved files on the host or on your own disk, delete them when the problem is closed, and quote only the request id, operation id and problem code in issues.
