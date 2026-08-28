import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations are generated against the Postgres dialect and applied
  // unchanged by both drivers (PGlite and node-postgres).
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://trimeros:trimeros@localhost:5433/trimeros',
  },
  verbose: true,
  strict: true,
});
