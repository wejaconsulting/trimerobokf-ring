# Trimeros Accounting Agent - API
#
# Workspace packages are consumed as TypeScript source (see docs/architecture.md,
# "Build strategy"), so the API runs under tsx and devDependencies stay in the
# image. That is a deliberate phase-1 trade-off, not an oversight: adding a
# bundler is listed in docs/next-phases.md.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Manifests first, so a source-only change reuses the install layer.
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
COPY packages/ packages/
COPY apps/api/ apps/api/

ENV NODE_ENV=production
# The platform injects PORT; config.ts binds 0.0.0.0 whenever it is present.
EXPOSE 4000
CMD ["pnpm", "--filter", "@trimeros/api", "start"]
