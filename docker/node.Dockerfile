# syntax=docker/dockerfile:1.10
# Multi-stage build for the Node services (collector, api, mock-inverter).
# Usage: docker build -f docker/node.Dockerfile --build-arg APP=collector .

ARG NODE_IMAGE=node:24.21.0-alpine3.24

FROM ${NODE_IMAGE} AS build
ARG APP
RUN corepack enable
WORKDIR /repo
# Install dependencies first (cached unless manifests change).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/fronius/package.json packages/fronius/
COPY packages/sim/package.json packages/sim/
COPY apps/${APP}/package.json apps/${APP}/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@peak-guard/${APP}..."
COPY tsconfig.base.json tsconfig.dev.json ./
COPY packages packages
COPY apps/${APP} apps/${APP}
RUN pnpm --filter "@peak-guard/${APP}..." run build \
 && pnpm deploy --legacy --filter "@peak-guard/${APP}" --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
