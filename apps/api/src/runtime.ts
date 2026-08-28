import { createModelProvider, modelConfigFromEnv, type ModelProvider } from '@trimeros/agent';
import { createRepositories, dbConfigFromEnv, openDatabase, type DbHandle, type Repositories } from '@trimeros/db';
import { MockFortnoxAdapter, createFortnoxAdapter, type FortnoxReadPort } from '@trimeros/fortnox';
import { buildSyntheticDataset } from '@trimeros/testing';
import { DatabaseWorkflowEngine, type WorkflowEngine } from '@trimeros/workflow';
import { appConfigFromEnv, type AppConfig } from './config.js';

/**
 * The composition root.
 *
 * Every dependency is chosen exactly once, here. In particular this is the only
 * place that decides which Fortnox adapter exists, and it can only produce the
 * mock one while shadow mode is on.
 */
export interface Runtime {
  readonly config: AppConfig;
  readonly db: DbHandle;
  readonly repos: Repositories;
  readonly fortnox: FortnoxReadPort;
  readonly model: ModelProvider;
  readonly engine: WorkflowEngine;
  close(): Promise<void>;
}

export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const config = appConfigFromEnv(env);
  const db = await openDatabase(dbConfigFromEnv(env));
  await db.migrate();

  const repos = createRepositories(db.db);

  // The synthetic dataset stands in for a Fortnox account. It is generated in
  // memory and never persisted as "real" data.
  const dataset = { ...buildSyntheticDataset() };
  const fortnox = createFortnoxAdapter(
    {
      adapter: config.fortnoxAdapter,
      shadowMode: config.shadowMode,
      writesEnabled: config.fortnoxWritesEnabled,
      baseUrl: config.fortnoxApiBaseUrl,
    },
    dataset,
  );

  const model = createModelProvider(modelConfigFromEnv(env));

  const engine = new DatabaseWorkflowEngine({
    repos,
    fortnox,
    model,
    shadowMode: config.shadowMode,
  });

  return {
    config,
    db,
    repos,
    fortnox,
    model,
    engine,
    close: () => db.close(),
  };
}

export { MockFortnoxAdapter };
