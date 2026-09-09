import { createModelProvider, modelConfigFromEnv, type ModelProvider } from '@trimeros/agent';
import {
  createRepositories,
  dbConfigFromEnv,
  openDatabase,
  seedDemoData,
  type DbHandle,
  type Repositories,
} from '@trimeros/db';
import { MockFortnoxAdapter, type FortnoxPortResolver, type FortnoxReadPort } from '@trimeros/fortnox';
import { buildSyntheticDataset } from '@trimeros/testing';
import { DatabaseWorkflowEngine, type WorkflowEngine } from '@trimeros/workflow';
import { appConfigFromEnv, type AppConfig } from './config.js';
import { createFortnoxIntegration, createFortnoxResolver, type FortnoxIntegration } from './integrations/fortnox.js';

/**
 * The composition root.
 *
 * Every dependency is chosen exactly once, here. In particular this is the only
 * place that decides how a client's Fortnox data source is resolved, and the
 * resolver can only hand out a write-enabled adapter when the configuration
 * passed every check in `appConfigFromEnv`.
 */
export interface Runtime {
  readonly config: AppConfig;
  readonly db: DbHandle;
  readonly repos: Repositories;
  /** The demo adapter: what clients on synthetic data read from. */
  readonly fortnox: FortnoxReadPort;
  /** Picks a client's data source (real account, demo data, or none) per run. */
  readonly fortnoxResolver: FortnoxPortResolver;
  readonly fortnoxIntegration: FortnoxIntegration;
  readonly model: ModelProvider;
  readonly engine: WorkflowEngine;
  close(): Promise<void>;
}

export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const config = appConfigFromEnv(env);
  const db = await openDatabase(dbConfigFromEnv(env));
  await db.migrate();

  // Hosted demos have nowhere to run `pnpm db:seed` by hand - Render's free
  // plan has no pre-deploy hook - so the demo tenant is seeded on boot instead.
  // `seedDemoData` is idempotent, so a restart or a second instance is a no-op.
  if (env.SEED_ON_BOOT === 'true') {
    await seedDemoData(db.db);
  }

  const repos = createRepositories(db.db);

  // The synthetic dataset stands in for a Fortnox account. It is generated in
  // memory and never persisted as "real" data.
  const fortnox = new MockFortnoxAdapter({ ...buildSyntheticDataset() });

  const fortnoxIntegration = createFortnoxIntegration(config, repos);
  const fortnoxResolver = createFortnoxResolver({ config, repos, integration: fortnoxIntegration, mock: fortnox });

  const model = createModelProvider(modelConfigFromEnv(env));

  const engine = new DatabaseWorkflowEngine({
    repos,
    fortnox: fortnoxResolver,
    model,
    shadowMode: config.shadowMode,
  });

  return {
    config,
    db,
    repos,
    fortnox,
    fortnoxResolver,
    fortnoxIntegration,
    model,
    engine,
    close: () => db.close(),
  };
}

export { MockFortnoxAdapter };
