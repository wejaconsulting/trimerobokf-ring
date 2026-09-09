import { periodKeySchema } from '@trimeros/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '../runtime.js';

/**
 * Firm-level operations: the routes that let an accounting firm run the
 * system across its whole client list rather than one demo client.
 *
 * Every mutation here is audited with the user that made it. None of them
 * writes to Fortnox: adding a client, editing its policy and running a period
 * are all internal, and the one switch that concerns writing
 * (`autoBookEnabled`) only lets the system *approve* - booking still has to
 * pass the write gate.
 */

const DEFAULT_POLICY = {
  materialityThreshold: 2_500_000, // 25 000 kr in öre
  automationAmountLimit: 1_000_000, // 10 000 kr
  costCenterRequiredAccounts: [] as number[],
  projectRequiredAccounts: [] as number[],
  requireDocumentationForInputVat: true,
  historyWindowMonths: 12,
  amountDeviationThreshold: 0.5,
  vatRates: [0, 0.06, 0.12, 0.25],
  autoBookEnabled: false,
};

const createClientSchema = z.object({
  name: z.string().min(1).max(200),
  organisationNumber: z
    .string()
    .regex(/^\d{6}-?\d{4}$/, 'Organisationsnummer måste ha formen NNNNNN-NNNN')
    .transform((v) => (v.includes('-') ? v : `${v.slice(0, 6)}-${v.slice(6)}`)),
  userId: z.string().min(1).default('demo-user'),
});

const policyPatchSchema = z
  .object({
    materialityThreshold: z.number().int().min(0),
    automationAmountLimit: z.number().int().min(0),
    costCenterRequiredAccounts: z.array(z.number().int().min(1000).max(9999)),
    projectRequiredAccounts: z.array(z.number().int().min(1000).max(9999)),
    requireDocumentationForInputVat: z.boolean(),
    historyWindowMonths: z.number().int().min(1).max(36),
    amountDeviationThreshold: z.number().min(0).max(10),
    autoBookEnabled: z.boolean(),
  })
  .partial()
  .extend({ userId: z.string().min(1).default('demo-user') });

export async function registerFirmRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  tenantOf: (headers: Record<string, unknown>) => string,
): Promise<void> {
  const { repos, engine } = runtime;

  /** Adds a client. It has no data source until Fortnox is connected. */
  app.post('/api/clients', async (request, reply) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const body = createClientSchema.parse(request.body);
    const id = `client-${slug(body.name)}-${Date.now().toString(36)}`;

    const client = await repos.createClient(
      { id, tenantId, name: body.name, organisationNumber: body.organisationNumber, fortnoxCompanyRef: null, active: true },
      { id: `policy-${id}`, ...DEFAULT_POLICY },
    );

    await repos.appendAuditEvent({
      tenantId,
      clientId: client.id,
      actorKind: 'user',
      actorId: body.userId,
      operation: 'client.created',
      inputRefs: [`client:${client.id}`, `orgnr:${body.organisationNumber}`],
      result: 'ok',
      correlationId: `client-create-${client.id}`,
    });

    return reply.code(201).send({ client });
  });

  app.get('/api/clients/:clientId/policy', async (request, reply) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { clientId } = z.object({ clientId: z.string() }).parse(request.params);
    const policy = await repos.getPolicy({ tenantId, clientId });
    if (!policy) return reply.code(404).send({ error: 'policy_not_found' });
    const rules = await repos.listClientRules({ tenantId, clientId });
    return { policy, rules };
  });

  /** Edits the client's policy. Audited with the fields that changed. */
  app.patch('/api/clients/:clientId/policy', async (request, reply) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { clientId } = z.object({ clientId: z.string() }).parse(request.params);
    const { userId, ...patch } = policyPatchSchema.parse(request.body);

    const policy = await repos.updatePolicy({ tenantId, clientId }, patch);
    if (!policy) return reply.code(404).send({ error: 'policy_not_found' });

    await repos.appendAuditEvent({
      tenantId,
      clientId,
      actorKind: 'user',
      actorId: userId,
      operation: 'policy.updated',
      inputRefs: Object.entries(patch).map(([k, v]) => `${k}:${JSON.stringify(v)}`),
      result: 'ok',
      correlationId: `policy-${clientId}-${Date.now().toString(36)}`,
    });

    return { policy };
  });

  /**
   * Runs one period for every active client, sequentially.
   *
   * Sequential on purpose: the Fortnox rate limit is per access token, so
   * parallel runs against different clients would be fine, but parallel runs
   * against the same PGlite file are not - and one firm-wide button that
   * finishes in order is easier to reason about than a race.
   */
  app.post('/api/close-runs/run-all', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const body = z.object({ periodKey: periodKeySchema }).parse(request.body);
    const clients = (await repos.listClients({ tenantId })).filter((c) => c.active);

    const results: {
      clientId: string;
      clientName: string;
      closeRunId: string | null;
      status: string;
      findingCount: number;
      blockingFindingCount: number;
      clearItemCount: number;
      error: string | null;
    }[] = [];

    for (const client of clients) {
      try {
        const { closeRunId } = await engine.startCloseRun({ tenantId, clientId: client.id, periodKey: body.periodKey });
        const summary = await engine.executeCloseRun(tenantId, closeRunId);
        results.push({
          clientId: client.id,
          clientName: client.name,
          closeRunId,
          status: summary.status,
          findingCount: summary.findingCount,
          blockingFindingCount: summary.blockingFindingCount,
          clearItemCount: summary.clearItemCount,
          error: null,
        });
      } catch (error) {
        results.push({
          clientId: client.id,
          clientName: client.name,
          closeRunId: null,
          status: 'failed',
          findingCount: 0,
          blockingFindingCount: 0,
          clearItemCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { periodKey: body.periodKey, results };
  });

  /**
   * Firm dashboard: how much of the work the system is doing on its own.
   * Computed from the latest run of every client.
   */
  app.get('/api/firm/overview', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const clients = await repos.listClients({ tenantId });

    let clear = 0;
    let automatic = 0;
    let review = 0;
    let manual = 0;
    let blocking = 0;
    let submitted = 0;
    let approved = 0;
    let runs = 0;
    const sources: Record<string, number> = { mock: 0, real: 0, none: 0 };

    for (const client of clients) {
      const [latest] = await repos.listCloseRuns({ tenantId }, client.id);
      if (!latest) {
        sources.none = (sources.none ?? 0) + 1;
        continue;
      }
      runs += 1;
      sources[latest.dataSource] = (sources[latest.dataSource] ?? 0) + 1;
      const summary = await engine.getSummary(tenantId, latest.id);
      const counts = await repos.countProposalsByStatus({ tenantId }, latest.id);
      clear += summary.clearItemCount;
      review += summary.reviewCount;
      manual += summary.manualCount;
      automatic += Math.max(0, summary.findingCount - summary.reviewCount - summary.manualCount);
      blocking += summary.blockingFindingCount;
      submitted += counts.submitted ?? 0;
      approved += counts.approved_shadow ?? 0;
    }

    const total = clear + automatic + review + manual;
    return {
      clientCount: clients.length,
      runsCounted: runs,
      dataSources: sources,
      items: { clear, automatic, review, manual, total },
      /** Share of items that needed no human: clear + automatic. */
      automationRate: total === 0 ? 0 : Math.round(((clear + automatic) / total) * 1000) / 1000,
      blockingFindings: blocking,
      proposals: { approved, submitted },
      shadowMode: runtime.config.shadowMode,
      liveBooking: runtime.config.fortnoxWritesEnabled && !runtime.config.shadowMode,
    };
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
