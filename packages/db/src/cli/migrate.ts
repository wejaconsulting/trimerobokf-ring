import { dbConfigFromEnv } from '../config.js';
import { openDatabase } from '../client.js';

const config = dbConfigFromEnv();
const handle = await openDatabase(config);
try {
  await handle.migrate();
  console.log(`Migrations applied (driver: ${handle.driver}).`);
} finally {
  await handle.close();
}
