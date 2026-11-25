FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/certified-group-service/package.json ./packages/certified-group-service/package.json
RUN pnpm install --frozen-lockfile --filter .
COPY . .
# Stamp the group service version into .cgs-version. Railway injects
# RAILWAY_GIT_COMMIT_SHA; for local builds, run ./scripts/stamp-version.sh
# first so a .cgs-version is already present (resolve-version.sh validates it).
ARG RAILWAY_GIT_COMMIT_SHA
RUN ./scripts/resolve-version.sh
RUN pnpm build
RUN CI=true pnpm install --prod --frozen-lockfile --filter .

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/.cgs-version ./
COPY --from=builder /app/lexicons ./lexicons
COPY --from=builder /app/LICENSE /app/NOTICE ./
RUN mkdir -p /app/data/groups
EXPOSE 3000
CMD ["node", "dist/index.js"]
