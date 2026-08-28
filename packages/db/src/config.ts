import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Database configuration.
 *
 * Two drivers, one dialect. `pglite` runs Postgres in-process (WASM), which is
 * what lets `pnpm test` and `pnpm smoke` work on a laptop or in CI with no
 * Docker daemon; `postgres` is the Docker Compose instance and the shape
 * production would use. The same generated migrations apply to both, so the two
 * paths cannot drift.
 */
export const dbConfigSchema = z.object({
  driver: z.enum(['pglite', 'postgres']).default('pglite'),
  /** Directory for the PGlite data files, or `memory://` for an ephemeral db. */
  pgliteDataDir: z.string().default('.pglite/dev'),
  databaseUrl: z.string().default('postgres://trimeros:trimeros@localhost:5433/trimeros'),
});

export type DbConfig = z.infer<typeof dbConfigSchema>;

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const config = dbConfigSchema.parse({
    driver: env.DB_DRIVER ?? 'pglite',
    pgliteDataDir: env.PGLITE_DATA_DIR ?? '.pglite/dev',
    databaseUrl: env.DATABASE_URL ?? undefined,
  });

  return { ...config, pgliteDataDir: resolvePgliteDataDir(config.pgliteDataDir) };
}

/**
 * Resolves a relative PGlite path against the workspace root, not the cwd.
 *
 * pnpm runs each package script from that package's own directory, so a bare
 * `.pglite/dev` would mean `packages/db/.pglite/dev` for `pnpm db:seed` and
 * `apps/api/.pglite/dev` for `pnpm dev:api` - two different databases, and a
 * seed the API could not see. Anchoring to the workspace root makes every
 * command in the README address the same database.
 */
export function resolvePgliteDataDir(dataDir: string): string {
  if (dataDir.startsWith('memory://') || path.isAbsolute(dataDir)) return dataDir;
  return path.join(findWorkspaceRoot(), dataDir);
}

function findWorkspaceRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No workspace marker found (e.g. an installed build): fall back to the cwd,
  // which is the previous behaviour.
  return process.cwd();
}
