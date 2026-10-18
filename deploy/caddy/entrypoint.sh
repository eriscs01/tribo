#!/bin/sh
# Starts Caddy with the Caddyfile that TRIBO_TLS_MODE names, after turning
# TRIBO_TRUSTED_PROXIES into the trusted-proxies/*.caddy file the Caddyfile imports.
set -eu

# The modes are the Caddyfiles in /etc/caddy; a new mode is a new file.
mode=${TRIBO_TLS_MODE:-acme-http}
config=/etc/caddy/$mode.Caddyfile
if [ ! -f "$config" ]; then
  echo "tribo proxy: unknown TRIBO_TLS_MODE '$mode'; known: $(cd /etc/caddy && ls *.Caddyfile | sed 's/\.Caddyfile$//' | tr '\n' ' ')" >&2
  exit 64
fi

proxies=${TRIBO_TRUSTED_PROXIES:-none}
case $proxies in
  none | cloudflare) TRIBO_PROXY_KIND=$proxies ;;
  *)
    TRIBO_PROXY_KIND=cidr
    TRIBO_PROXY_CIDRS=$(echo "$proxies" | tr ',' ' ')
    export TRIBO_PROXY_CIDRS
    ;;
esac
export TRIBO_PROXY_KIND

exec caddy run --config "$config" --adapter caddyfile
