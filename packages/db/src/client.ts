import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { DbConfig } from './config.js';
import * as schema from './schema/index.js';

export type Database = PgliteDatabase<typeof schema> | PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Database;
  readonly driver: DbConfig['driver'];
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

export async function openDatabase(config: DbConfig): Promise<DbHandle> {
  if (config.driver === 'pglite') {
    // PGlite creates its data directory with a non-recursive mkdir, so a nested
    // path such as `.pglite/dev` fails on a fresh clone unless the parent
    // already exists. Create the whole path first.
    if (!config.pgliteDataDir.startsWith('memory://')) {
      mkdirSync(config.pgliteDataDir, { recursive: true });
    }
    const client = new PGlite(config.pgliteDataDir);
    const db = drizzlePglite(client, { schema });
    return {
      db,
      driver: 'pglite',
      migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => client.close(),
    };
  }

  // `max: 1` keeps migrations and the seed deterministic; the API opens its own
  // pool with a normal size.
  const client = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });
  const db = drizzlePostgres(client, { schema });
  return {
    db,
    driver: 'postgres',
    migrate: () => migratePostgres(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

/** An ephemeral in-memory database, used by the integration tests. */
export async function openEphemeralDatabase(): Promise<DbHandle> {
  return openDatabase({
    driver: 'pglite',
    pgliteDataDir: 'memory://',
    databaseUrl: '',
  });
}

export { schema };
