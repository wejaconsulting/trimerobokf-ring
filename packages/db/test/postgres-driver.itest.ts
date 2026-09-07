import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/client.js';
import { createRepositories } from '../src/repositories/index.js';
import { seedDemoData } from '../src/seed/seed.js';
import { DEMO_IDS } from '../src/seed/ids.js';

/**
 * Exercises the `postgres` driver, not PGlite's in-process one.
 *
 * A deployment sets DB_DRIVER=postgres, which swaps drizzle's PGlite driver for
 * postgres-js over a real TCP connection. The rest of the suite runs in-process
 * and would not catch a fault in that path, so this test serves PGlite over the
 * actual Postgres wire protocol and connects to it the way production would.
 */
describe('postgres driver (integration)', () => {
  const port = 55432;
  let pglite: PGlite;
  let server: PGLiteSocketServer;

  beforeAll(async () => {
    pglite = await PGlite.create();
    server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
    await server.start();
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    await pglite?.close();
  });

  it('migrates, seeds and queries over the wire protocol', async () => {
    const handle = await openDatabase({
      driver: 'postgres',
      pgliteDataDir: '',
      databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/template1`,
    });

    try {
      expect(handle.driver).toBe('postgres');
      await handle.migrate();

      const { tenantId, clientId } = await seedDemoData(handle.db);
      expect(tenantId).toBe(DEMO_IDS.tenant);

      const repos = createRepositories(handle.db);
      const clients = await repos.listClients({ tenantId });
      expect(clients).toHaveLength(1);
      expect(clients[0]?.name).toBe('Nordvik Konsult AB');

      // Money round-trips as an exact integer through numeric(20,0).
      const policy = await repos.getPolicy({ tenantId, clientId });
      expect(policy?.materialityThreshold).toBe(2_500_000);
      expect(typeof policy?.materialityThreshold).toBe('number');

      // jsonb columns come back as real arrays, not strings.
      expect(Array.isArray(policy?.costCenterRequiredAccounts)).toBe(true);

      // Seeding twice must stay idempotent on this driver too.
      await seedDemoData(handle.db);
      expect(await repos.listClients({ tenantId })).toHaveLength(1);
    } finally {
      await handle.close();
    }
  }, 120_000);
});
