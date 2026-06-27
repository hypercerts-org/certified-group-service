# Demo app (React SPA + Express BFF) — single-container image.
# The BFF serves both /api and the built client (see server/index.ts).
#
# Built with the REPO ROOT as the build context (Railway service Root Directory =
# repo root, dockerfilePath = demo/Dockerfile). The demo itself lives entirely
# under demo/; only demo/* is copied.
FROM node:22-slim AS builder
WORKDIR /app
# CI=true so pnpm runs non-interactively (e.g. `prune --prod` won't block on a
# TTY confirmation for purging modules).
ENV CI=true
RUN corepack enable

# Install the demo's deps from demo/ as its own pnpm workspace root (demo has its
# own pnpm-workspace.yaml carrying `allowBuilds`, so esbuild/core-js build their
# native pieces without an interactive `pnpm approve-builds`). Paths are relative
# to the repo root (the build context).
COPY demo/package.json demo/pnpm-lock.yaml demo/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY demo/ ./

# vite build -> dist/ (client), tsc -p tsconfig.server.json -> dist-server/ (BFF)
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
# The server listens on PORT (Railway's convention) then BFF_PORT then 3001.
EXPOSE 3001
CMD ["node", "dist-server/index.js"]
