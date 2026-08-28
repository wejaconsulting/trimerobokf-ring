import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { dbConfigFromEnv } from '../config.js';
import { openDatabase } from '../client.js';

/**
 * Drops everything and re-applies migrations.
 *
 * For PGlite that means deleting the data directory; for Postgres it drops and
 * recreates the public schema (and drizzle's migration bookkeeping schema).
 */
const config = dbConfigFromEnv();

if (config.driver === 'pglite') {
  await rm(config.pgliteDataDir, { recursive: true, force: true });
  console.log(`Removed PGlite data directory ${config.pgliteDataDir}.`);
} else {
  const handle = await openDatabase(config);
  try {
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`create schema public`);
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    console.log('Dropped and recreated the public schema.');
  } finally {
    await handle.close();
  }
}

const fresh = await openDatabase(config);
try {
  await fresh.migrate();
  console.log(`Migrations re-applied (driver: ${fresh.driver}).`);
} finally {
  await fresh.close();
}
