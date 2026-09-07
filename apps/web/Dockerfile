# Trimeros Accounting Agent - review console
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/fortnox/package.json packages/fortnox/
COPY packages/rules/package.json packages/rules/
COPY packages/testing/package.json packages/testing/
COPY packages/workflow/package.json packages/workflow/

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json tsconfig.json ./
COPY packages/domain/ packages/domain/
COPY apps/web/ apps/web/

# Every page is force-dynamic, so the build needs no API and no database.
RUN pnpm --filter @trimeros/web build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@trimeros/web", "start"]
