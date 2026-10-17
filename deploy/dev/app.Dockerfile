# Dev-only image: Node and pnpm at the versions the repo pins. The code comes from the bind mount.
FROM node:26.12.0-bookworm-slim
RUN npm install -g pnpm@12.14.0 && rm -rf /root/.npm
ENV CI=true
WORKDIR /repo
