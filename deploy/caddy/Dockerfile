# syntax=docker/dockerfile:1
# Tribo proxy image: Caddy with the Cloudflare DNS module (one image for every TLS mode), the
# Caddyfile per mode and the built SPA it serves.
# Build from the repo root: docker build -f deploy/caddy/Dockerfile .
ARG NODE_IMAGE=node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913
ARG CADDY_BUILDER_IMAGE=caddy:2.11.7-builder@sha256:d842facfd63b960922e57444ff76fd8f0793a66dfdcf481af8026e1f4e6a39b4
ARG CADDY_IMAGE=caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af

FROM ${CADDY_BUILDER_IMAGE} AS caddy
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4

FROM ${NODE_IMAGE} AS web
RUN npm install -g pnpm@12.14.0 && rm -rf /root/.npm
ENV CI=true
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=tribo-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && pnpm exec tsc -b apps/web && pnpm build:web

FROM ${CADDY_IMAGE}
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=web /repo/apps/web/dist/app /srv/tribo
COPY deploy/caddy/site.caddy deploy/caddy/*.Caddyfile /etc/caddy/
COPY deploy/caddy/trusted-proxies /etc/caddy/trusted-proxies
COPY deploy/caddy/entrypoint.sh /usr/local/bin/tribo-proxy
CMD ["tribo-proxy"]
