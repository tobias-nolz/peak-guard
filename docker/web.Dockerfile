# syntax=docker/dockerfile:1.10
# Builds the SPA and serves it with Caddy, which also reverse-proxies /api.

ARG NODE_IMAGE=node:24.21.0-alpine3.24

FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@peak-guard/web..."
COPY tsconfig.base.json tsconfig.dev.json ./
COPY packages/core packages/core
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @peak-guard/web exec vite build

FROM caddy:2.11-alpine AS runtime
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
# Run unprivileged; Caddy listens on 8080 inside the container.
RUN addgroup -S caddy && adduser -S -G caddy caddy \
 && mkdir -p /data /config && chown -R caddy:caddy /data /config
USER caddy
EXPOSE 8080
