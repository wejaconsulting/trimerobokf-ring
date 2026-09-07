import { WORKFLOW_STEPS, getStepDefinition, periodKeyOf } from '@trimeros/domain';
import { FORTNOX_ENDPOINTS, UNVERIFIED_CAPABILITIES } from '@trimeros/fortnox';
import { RULES } from '@trimeros/rules';
import { recordReviewDecision } from '@trimeros/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '../runtime.js';

/**
 * HTTP surface for the review app.
 *
 * Authentication is out of scope for phase 1: the tenant is read from an
 * `x-tenant-id` header with a demo default, and every handler passes it into a
 * repository that will not query without it. See docs/security-and-permissions.md
 * for what phase 2 must add before this is exposed to more than one firm.
 */

const DEMO_TENANT = 'firm-trimeros';

function tenantOf(headers: Record<string, unknown>): string {
  const raw = headers['x-tenant-id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : DEMO_TENANT;
}

const decisionBodySchema = z.object({
  kind: z.enum(['approve', 'reject', 'edit_proposal', 'request_information']),
  decidedByUserId: z.string().min(1),
  comment: z.string().max(2000).optional(),
  editedPayload: z.unknown().optional(),
});

const findingFilterSchema = z.object({
  status: z.string().optional(),
  decisionLevel: z.string().optional(),
  severity: z.string().optional(),
  type: z.string().optional(),
  blocking: z.enum(['true', 'false']).optional(),
  account: z.coerce.number().int().optional(),
  supplierNumber: z.string().optional(),
  minAmount: z.coerce.number().int().optional(),
  maxAmount: z.coerce.number().int().optional(),
  minDecisionScore: z.coerce.number().optional(),
  maxDecisionScore: z.coerce.number().optional(),
});

const csv = (value: string | undefined): string[] | undefined =>
  value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined;

export async function registerRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const { repos, engine, config, fortnox, model } = runtime;

  app.get('/health', async () => ({ status: 'ok' }));

  /** Discloses the safety posture, so the UI can display it rather than assume it. */
  app.get('/api/system/status', async () => {
    const capabilities = await fortnox.capabilities();
    return {
      shadowMode: config.shadowMode,
      fortnoxWritesEnabled: config.fortnoxWritesEnabled,
      fortnoxAdapter: fortnox.adapterName,
      modelProvider: model.name,
      modelName: model.model,
      capabilities,
      unverifiedCapabilities: UNVERIFIED_CAPABILITIES,
      knownEndpoints: FORTNOX_ENDPOINTS,
    };
  });

  /** Client overview: one row per client with the latest run's counters. */
  app.get('/api/clients', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const clients = await repos.listClients({ tenantId });

    return Promise.all(
      clients.map(async (client) => {
        const runs = await repos.listCloseRuns({ tenantId }, client.id);
        const latest = runs[0];
        if (!latest) {
          return {
            client,
            latestRun: null,
            summary: null,
          };
        }
        const summary = await engine.getSummary(tenantId, latest.id);
        const steps = await repos.listSteps({ tenantId }, latest.id);
        const findings = await repos.listFindings({ tenantId }, { closeRunId: latest.id });
        return {
          client,
          latestRun: latest,
          summary: {
            ...summary,
            completedSteps: steps.filter((s) => s.status === 'completed').length,
            totalSteps: WORKFLOW_STEPS.length,
            missingDocumentationCount: findings.filter(
              (f) =>
                f.type === 'anomaly.missing_documentation' ||
                f.type === 'validation.input_vat_without_documentation',
            ).length,
          },
        };
      }),
    );
  });

  /** Starts and immediately executes a close run. */
  app.post('/api/clients/:clientId/close-runs', async (request, reply) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const params = z.object({ clientId: z.string() }).parse(request.params);
    const body = z.object({ periodKey: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.body);

    const { closeRunId } = await engine.startCloseRun({
      tenantId,
      clientId: params.clientId,
      periodKey: body.periodKey,
    });
    const summary = await engine.executeCloseRun(tenantId, closeRunId);
    return reply.code(201).send(summary);
  });

  app.get('/api/close-runs/:closeRunId', async (request, reply) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { closeRunId } = z.object({ closeRunId: z.string() }).parse(request.params);

    const run = await repos.getCloseRun({ tenantId }, closeRunId);
    if (!run) return reply.code(404).send({ error: 'close_run_not_found' });

    const [summary, steps, client] = await Promise.all([
      engine.getSummary(tenantId, closeRunId),
      repos.listSteps({ tenantId }, closeRunId),
      repos.getClient({ tenantId, clientId: run.clientId }),
    ]);

    return {
      run,
      client,
      summary,
      steps: steps.map((s) => {
        const def = getStepDefinition(s.stepKey as never);
        return {
          ...s,
          labelSv: def.labelSv,
          labelEn: def.labelEn,
          description: def.description,
          descriptionSv: def.descriptionSv,
          implemented: def.implemented,
          blocksCompletion: def.blocksCompletion,
        };
      }),
    };
  });

  /** Latest run for a client and period, so the UI can deep-link by period. */
  app.get('/api/clients/:clientId/close-runs', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { clientId } = z.object({ clientId: z.string() }).parse(request.params);
    return repos.listCloseRuns({ tenantId }, clientId);
  });

  /** The review queue. */
  app.get('/api/close-runs/:closeRunId/findings', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { closeRunId } = z.object({ closeRunId: z.string() }).parse(request.params);
    const query = findingFilterSchema.parse(request.query);

    const findings = await repos.listFindings(
      { tenantId },
      {
        closeRunId,
        ...(csv(query.status) ? { status: csv(query.status) } : {}),
        ...(csv(query.decisionLevel) ? { decisionLevel: csv(query.decisionLevel) } : {}),
        ...(csv(query.severity) ? { severity: csv(query.severity) } : {}),
        ...(csv(query.type) ? { type: csv(query.type) } : {}),
        ...(query.blocking !== undefined ? { blocking: query.blocking === 'true' } : {}),
        ...(query.account !== undefined ? { account: query.account } : {}),
        ...(query.supplierNumber ? { supplierNumber: query.supplierNumber } : {}),
        ...(query.minAmount !== undefined ? { minAmount: query.minAmount } : {}),
        ...(query.maxAmount !== undefined ? { maxAmount: query.maxAmount } : {}),
        ...(query.minDecisionScore !== undefined ? { minDecisionScore: query.minDecisionScore } : {}),
        ...(query.maxDecisionScore !== undefined ? { maxDecisionScore: query.maxDecisionScore } : {}),
      },
    );

    const proposals = await repos.listProposals({ tenantId }, closeRunId);
    const proposalsByFinding = new Map(proposals.map((p) => [p.findingId, p]));

    return findings.map((f) => ({
      ...f,
      hasProposal: proposalsByFinding.has(f.id),
      proposalDecisionLevel: proposalsByFinding.get(f.id)?.decisionLevel ?? null,
    }));
  });

  /** Everything the finding-detail view needs, in one request. */
  app.get('/api/findings/:findingId', async (request, reply) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { findingId } = z.object({ findingId: z.string() }).parse(request.params);

    const finding = await repos.getFinding({ tenantId }, findingId);
    if (!finding) return reply.code(404).send({ error: 'finding_not_found' });

    const [proposals, decisions, reviewItem, run] = await Promise.all([
      repos.listProposalsForFinding({ tenantId }, findingId),
      repos.listApprovalDecisions({ tenantId }, findingId),
      repos.getReviewItemForFinding({ tenantId }, findingId),
      repos.getCloseRun({ tenantId }, finding.closeRunId),
    ]);
    const proposalRows = await repos.listProposalRows(proposals.map((p) => p.id));
    const audit = await repos.listAuditEvents({ tenantId }, { closeRunId: finding.closeRunId });

    // The matched rules, expanded to their Swedish explanations.
    const ruleIds = new Set([finding.ruleId, ...finding.mergedFromRuleIds]);
    const matchedRules = Object.values(RULES).filter((r) => ruleIds.has(r.id));

    return {
      finding,
      run,
      reviewItem,
      matchedRules,
      proposals: proposals.map((p) => ({
        ...p,
        rows: proposalRows.filter((r) => r.proposalId === p.id),
      })),
      decisions,
      // Only the events that concern this run, trimmed to what the UI shows.
      auditHistory: audit.slice(-50),
    };
  });

  /**
   * Records a review decision.
   *
   * Approving here changes internal review status only. There is no code path
   * from this endpoint to a Fortnox write.
   */
  app.post('/api/findings/:findingId/decision', async (request, reply) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { findingId } = z.object({ findingId: z.string() }).parse(request.params);
    const body = decisionBodySchema.parse(request.body);

    const finding = await repos.getFinding({ tenantId }, findingId);
    if (!finding) return reply.code(404).send({ error: 'finding_not_found' });

    const result = await recordReviewDecision(repos, {
      tenantId,
      clientId: finding.clientId,
      findingId,
      kind: body.kind,
      decidedByUserId: body.decidedByUserId,
      comment: body.comment ?? null,
      editedPayload: body.editedPayload ?? null,
    });

    return reply.code(200).send(result);
  });

  /** Historical comparison for a supplier, used by the finding-detail view. */
  app.get('/api/clients/:clientId/suppliers/:supplierNumber/history', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { clientId, supplierNumber } = z
      .object({ clientId: z.string(), supplierNumber: z.string() })
      .parse(request.params);
    const policy = await repos.getPolicy({ tenantId, clientId });
    const months = policy?.historyWindowMonths ?? 12;

    const vouchers = await Promise.all(
      Array.from({ length: months }, async (_unused, index) => {
        const period = shiftPeriod(new Date().toISOString().slice(0, 7), -index);
        return fortnox.listVouchers(period);
      }),
    );

    return vouchers
      .flat()
      .filter((v) => v.supplierNumber === supplierNumber)
      .map((v) => ({
        voucherId: v.id,
        period: periodKeyOf(v.transactionDate),
        transactionDate: v.transactionDate,
        description: v.description,
        rows: v.rows,
      }));
  });

  app.get('/api/close-runs/:closeRunId/audit', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { closeRunId } = z.object({ closeRunId: z.string() }).parse(request.params);
    return repos.listAuditEvents({ tenantId }, { closeRunId });
  });

  app.get('/api/close-runs/:closeRunId/customer-requests', async (request) => {
    const tenantId = tenantOf(request.headers as Record<string, unknown>);
    const { closeRunId } = z.object({ closeRunId: z.string() }).parse(request.params);
    return repos.listCustomerRequests({ tenantId }, closeRunId);
  });
}

function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
