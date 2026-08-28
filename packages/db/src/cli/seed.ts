import { openDatabase } from '../client.js';
import { dbConfigFromEnv } from '../config.js';
import { seedDemoData } from '../seed/seed.js';

const handle = await openDatabase(dbConfigFromEnv());
try {
  await handle.migrate();
  const { tenantId, clientId } = await seedDemoData(handle.db);
  console.log(`Seeded demo tenant ${tenantId}, client ${clientId} (driver: ${handle.driver}).`);
  console.log('Next: run a close run with `pnpm demo:close-run`.');
} finally {
  await handle.close();
}
