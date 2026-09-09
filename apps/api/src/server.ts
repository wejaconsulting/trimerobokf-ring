import { buildApp } from './app.js';
import { createRuntime } from './runtime.js';

const runtime = await createRuntime();
const app = await buildApp(runtime);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await runtime.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: runtime.config.apiHost, port: runtime.config.apiPort });

app.log.info(
  {
    shadowMode: runtime.config.shadowMode,
    fortnoxAdapter: runtime.config.fortnoxAdapter,
    fortnoxWritesEnabled: runtime.config.fortnoxWritesEnabled,
    modelProvider: runtime.model.name,
    dbDriver: runtime.db.driver,
  },
  'Trimeros Accounting Agent API started in SHADOW MODE - no Fortnox writes are possible',
);
