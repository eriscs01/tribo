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

Keep your current session open until the checks below pass from a second terminal. Check, on your machine:

The first connection asks you to trust the host key. If the Droplet Console works, compare the fingerprint SSH shows with the one the droplet prints there:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

If the console doesn't work, connect for the first time right after creating the droplet, from your own network. After that, a `REMOTE HOST IDENTIFICATION HAS CHANGED` warning is an incident, unless you have just recreated the droplet. In that case, remove the old key with `ssh-keygen -R <host>` and trust the new one.

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
