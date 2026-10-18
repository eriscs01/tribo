#!/bin/sh
# DigitalOcean Cloud Firewall for the reference mode (runbook step 3): inbound
# 22 from the operator, 80/tcp, 443/tcp+udp and ICMP; all outbound. It covers
# every droplet with the tag, so a droplet tagged at creation is never exposed.
#
# Usage:  sh do-firewall.sh [--name NAME] [--tag TAG] [--ssh-from CIDR[,CIDR...]] [--apply]
#   defaults: --name tribo-ref-fw  --tag tribo  --ssh-from 0.0.0.0/0,::/0
# Prints the doctl command; --apply runs it (create, or update when the
# firewall exists; an update replaces all rules and attachments).
set -eu

name=tribo-ref-fw
tag=tribo
ssh_from=0.0.0.0/0,::/0
apply=no

while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --tag) tag="$2"; shift 2 ;;
    --ssh-from) ssh_from="$2"; shift 2 ;;
    --apply) apply=yes; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

# Same inbound set as ufw in provision.sh.
anywhere=0.0.0.0/0,address:::/0
ssh_sources=$(echo "$ssh_from" | sed 's/,/,address:/g')
inbound="protocol:tcp,ports:22,address:$ssh_sources \
protocol:tcp,ports:80,address:$anywhere \
protocol:tcp,ports:443,address:$anywhere \
protocol:udp,ports:443,address:$anywhere \
protocol:icmp,address:$anywhere"
outbound="protocol:tcp,ports:0,address:$anywhere \
protocol:udp,ports:0,address:$anywhere \
protocol:icmp,address:$anywhere"

# A failed list must stop here, or the script would offer to create a duplicate.
firewalls=$(doctl compute firewall list --format ID,Name --no-header)
id=$(echo "$firewalls" | awk -v n="$name" '$2 == n { print $1 }')
if [ -n "$id" ]; then
  set -- doctl compute firewall update "$id" --name "$name"
else
  set -- doctl compute firewall create --name "$name"
fi
set -- "$@" --tag-names "$tag" --inbound-rules "$inbound" --outbound-rules "$outbound"

printf "'%s' " "$@"
echo
if [ "$apply" = yes ]; then exec "$@"; fi
