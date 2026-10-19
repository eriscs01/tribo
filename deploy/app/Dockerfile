# syntax=docker/dockerfile:1
# Tribo app image: the compiled server and its production dependencies, run as the
# unprivileged node user. The files are owned by root, so the process cannot change them,
# and Compose also mounts the root filesystem read-only.
# Build from the repo root: docker build -f deploy/app/Dockerfile .
ARG NODE_IMAGE=node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4

FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@12.14.0 && rm -rf /root/.npm
ENV CI=true
WORKDIR /repo
# Download every locked package into the store first, in a layer of its own: it is rebuilt
# only when the lockfile changes, so a code change reinstalls offline from the cached store.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline && pnpm build
# Reinstall with production dependencies only, then copy out the server and every workspace
# package it depends on at run time (dist, manifest, node_modules), plus the migrations the
# runner reads from packages/db.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && pnpm install --frozen-lockfile --prod --offline --filter-prod '@tribo/server...' \
    && mkdir /out \
    && cp -a --parents package.json node_modules packages/db/migrations packages/db/bootstrap /out \
    && for dir in $(pnpm -r --filter-prod '@tribo/server...' exec pwd); do \
         rel=${dir#/repo/}; cp -a --parents "$rel/package.json" "$rel/dist" "$rel/node_modules" /out; \
       done \
    && find /out -path '*/dist/*' \( -name '*.test.*' -o -name '*.tsbuildinfo' \) -delete

FROM ${NODE_IMAGE}
# npm and corepack are build tools; the running image needs only node.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
COPY deploy/app/tribo /usr/local/bin/tribo
# The release this image is: on every log line and from `tribo release show`. CI sets both
# (the tag and the commit); a local build is dev. Last, so a new commit rebuilds only this.
ARG TRIBO_RELEASE_VERSION=dev
ARG TRIBO_RELEASE_COMMIT=unknown
ENV TRIBO_RELEASE_VERSION=${TRIBO_RELEASE_VERSION} TRIBO_RELEASE_COMMIT=${TRIBO_RELEASE_COMMIT}
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
