# syntax=docker/dockerfile:1
# Tribo app image: the compiled server and its production dependencies, run as the
# unprivileged node user. The files are owned by root, so the process cannot change them,
# and Compose also mounts the root filesystem read-only.
# Build from the repo root: docker build -f deploy/app/Dockerfile .
ARG NODE_IMAGE=node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913

FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@12.14.0 && rm -rf /root/.npm
ENV CI=true
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=tribo-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && pnpm build
# Reinstall with production dependencies only, then copy out the server and every workspace
# package it depends on at run time (dist, manifest, node_modules), plus the migrations the
# runner reads from packages/db.
RUN --mount=type=cache,id=tribo-pnpm-store,target=/root/.local/share/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
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
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
