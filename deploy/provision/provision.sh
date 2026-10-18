#!/bin/sh
# Hardens a fresh Ubuntu LTS or Debian stable host and installs Docker
# (runbook steps 2-4). Idempotent: run it again after changing a flag.
#
# Usage, as root:  sh provision.sh [--user NAME] [--ssh-from CIDR[,CIDR...]]
#   --user      sudo user to create and the only SSH login afterwards (default: tribo)
#   --ssh-from  sources allowed to reach port 22 in ufw (default: anywhere)
#
# Also works unchanged as droplet user data (cloud-init runs it as root on first
# boot with the defaults). The sudo user gets root's authorized_keys when it has
# none, so the provider's SSH key carries over; the script holds no keys or IPs.
set -eu

user=tribo
ssh_from=any
# Docker's release signing key, as published at docs.docker.com/engine/install.
docker_key_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

while [ $# -gt 0 ]; do
  case "$1" in
    --user) user="$2"; shift 2 ;;
    --ssh-from) ssh_from="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

# Both values end up in sshd, sudoers and ufw rules, so accept only plain names
# and addresses.
echo "$user" | grep -Eqx '[a-z_][a-z0-9_-]{0,31}' || { echo "invalid --user: $user" >&2; exit 64; }
for source in $(echo "$ssh_from" | tr ',' ' '); do
  echo "$source" | grep -Eqx 'any|[0-9a-fA-F:.]+(/[0-9]{1,3})?' || { echo "invalid --ssh-from entry: $source" >&2; exit 64; }
done

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
case "$ID" in
  ubuntu | debian) ;;
  *) echo "unsupported distribution: $ID" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt_get() { apt-get -y -q -o DPkg::Lock::Timeout=600 "$@"; }

log() { echo "provision: $*"; }

upgrade_packages() {
  log "updating packages"
  apt_get update
  apt_get upgrade
  apt_get install ca-certificates curl gnupg ufw unattended-upgrades
}

create_sudo_user() {
  if ! id "$user" >/dev/null 2>&1; then
    log "creating user $user"
    useradd --create-home --shell /bin/bash --groups sudo "$user"
  fi
  usermod -aG sudo "$user"
  # The account has no password, so sudo must not ask for one. Membership of
  # the docker group is root-equivalent anyway; the SSH key is the credential.
  echo "$user ALL=(ALL) NOPASSWD:ALL" >"/etc/sudoers.d/90-$user"
  chmod 440 "/etc/sudoers.d/90-$user"
  visudo -cf "/etc/sudoers.d/90-$user" >/dev/null

  home=$(getent passwd "$user" | cut -d: -f6)
  keys="$home/.ssh/authorized_keys"
  if [ ! -s "$keys" ] && [ -s /root/.ssh/authorized_keys ]; then
    log "moving root's authorized_keys to $user"
    install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
    install -m 600 -o "$user" -g "$user" /root/.ssh/authorized_keys "$keys"
  fi
  # Refuse to close root login before the new user can log in.
  [ -s "$keys" ] || { echo "$keys is empty; add a public key, then rerun" >&2; exit 1; }
  # Root can no longer log in over SSH; leave no key behind for it either.
  rm -f /root/.ssh/authorized_keys
}

harden_ssh() {
  log "SSH: key login for $user only"
  # sshd keeps the first value it reads, so 00- wins over cloud-init's 50- file.
  cat >/etc/ssh/sshd_config.d/00-tribo-hardening.conf <<EOF
AllowUsers $user
PermitRootLogin no
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
EOF
  # Ubuntu 24.04 starts sshd from ssh.socket: /run/sshd and the service may not
  # exist yet, and an inactive service picks up the config on its next start.
  install -d -m 755 /run/sshd
  sshd -t
  systemctl try-reload-or-restart ssh
}

enable_security_upgrades() {
  log "enabling unattended security upgrades with a nightly reboot when needed"
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  # Kernel and libc fixes only apply after a reboot. The host clock is UTC:
  # 19:30 UTC is 03:30 in Manila, after the 02:00 backup.
  cat >/etc/apt/apt.conf.d/52tribo-unattended-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "19:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
  systemctl enable --now unattended-upgrades
}

configure_ufw() {
  log "configuring ufw: 22 from $ssh_from (rate limited), 80/tcp, 443/tcp+udp"
  # Rebuilding from a reset keeps reruns exact when --ssh-from changes.
  # Same inbound set as do-firewall.sh; user data must be one file, so it is not shared.
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  for source in $(echo "$ssh_from" | tr ',' ' '); do
    ufw limit proto tcp from "$source" to any port 22
  done
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
  rm -f /etc/ufw/*.rules.[0-9]*
}

install_docker() {
  log "installing Docker Engine and the Compose plugin from download.docker.com"
  for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'ok installed'; then
      apt_get remove "$pkg"
    fi
  done
  install -d -m 755 /etc/apt/keyrings
  key=$(mktemp)
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$key"
  # Trust the downloaded key only if it is Docker's published one.
  fingerprint=$(gpg --show-keys --with-colons "$key" | awk -F: '/^fpr/ { print $10; exit }')
  if [ "$fingerprint" != "$docker_key_fingerprint" ]; then
    rm -f "$key"
    echo "Docker signing key has fingerprint $fingerprint, expected $docker_key_fingerprint" >&2
    exit 1
  fi
  install -m 644 "$key" /etc/apt/keyrings/docker.asc
  rm -f "$key"
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt_get update
  apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  configure_docker_daemon
  systemctl enable --now docker
  usermod -aG docker "$user"
}

configure_docker_daemon() {
  # Host-wide defaults; compose.yml sets the per-service limits. Containers keep
  # running through a daemon upgrade, and logs rotate so they cannot fill the disk.
  daemon=$(mktemp)
  cat >"$daemon" <<'EOF'
{
  "live-restore": true,
  "log-driver": "local"
}
EOF
  if cmp -s "$daemon" /etc/docker/daemon.json; then
    rm -f "$daemon"
    return
  fi
  install -d -m 755 /etc/docker
  install -m 644 "$daemon" /etc/docker/daemon.json
  rm -f "$daemon"
  if systemctl is-active --quiet docker; then systemctl restart docker; fi
}

upgrade_packages
create_sudo_user
harden_ssh
enable_security_upgrades
configure_ufw
install_docker
log "done; log in as $user and run the runbook checks"
