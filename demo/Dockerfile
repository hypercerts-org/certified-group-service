# Demo app (React SPA + Express BFF) — single-container image.
# The BFF serves both /api and the built client (see server/index.ts).
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
# The demo is not a pnpm workspace member, so install with --ignore-workspace
# (otherwise pnpm treats the repo root workspace as context and skips it).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY . .
# vite build -> dist/ (client), tsc -p tsconfig.server.json -> dist-server/ (BFF)
RUN pnpm build
RUN pnpm prune --prod --ignore-workspace

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
