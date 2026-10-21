# syntax=docker/dockerfile:1
# Tribo proxy image: Caddy with the Cloudflare DNS module (one image for every TLS mode), the
# Caddyfile per mode and the built SPA it serves.
# Build from the repo root: docker build -f deploy/caddy/Dockerfile .
ARG NODE_IMAGE=node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4
ARG CADDY_BUILDER_IMAGE=caddy:2.11.7-builder@sha256:8910fe662f448b860e8d16ef1c9a4f8946d3193bdc3e971bf0c55c9a2cf246f6
ARG CADDY_IMAGE=caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af

FROM ${CADDY_BUILDER_IMAGE} AS caddy
# golang.org/x/net is raised past Caddy 2.11.7's own v0.59.0 for CVE-2026-78669 (HTTP/2);
# drop the replace once a Caddy release requires v0.60.0 or later.
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4 \
      --replace golang.org/x/net=golang.org/x/net@v0.60.0

FROM ${NODE_IMAGE} AS web
RUN npm install -g pnpm@12.14.0 && rm -rf /root/.npm
ENV CI=true
WORKDIR /repo
# Download every locked package into the store first, in a layer of its own: it is rebuilt
# only when the lockfile changes, so a code change reinstalls offline from the cached store.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline && pnpm exec tsc -b apps/web && pnpm build:web

FROM ${CADDY_IMAGE}
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=web /repo/apps/web/dist/app /srv/tribo
COPY deploy/caddy/site.caddy deploy/caddy/*.Caddyfile /etc/caddy/
COPY deploy/caddy/trusted-proxies /etc/caddy/trusted-proxies
COPY deploy/caddy/entrypoint.sh /usr/local/bin/tribo-proxy
CMD ["tribo-proxy"]
