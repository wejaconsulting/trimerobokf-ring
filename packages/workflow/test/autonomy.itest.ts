import { createModelProvider } from '@trimeros/agent';
import {
  DEMO_IDS,
  createRepositories,
  openEphemeralDatabase,
  seedDemoData,
  type DbHandle,
  type Repositories,
} from '@trimeros/db';
import { FORTNOX_CONNECTION_KIND } from '@trimeros/domain';
import {
  FortnoxHttpClient,
  MockFortnoxAdapter,
  RealFortnoxAdapter,
  SlidingWindowRateLimiter,
  hashPayload,
  type FortnoxDataSource,
  type FortnoxPortResolver,
} from '@trimeros/fortnox';
import { DEMO_PERIOD, buildSyntheticDataset, createFakeFortnoxServer, type FakeFortnoxServer } from '@trimeros/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseWorkflowEngine } from '../src/engine.js';
import { recordReviewDecision } from '../src/review.js';
import { AUTO_APPROVER_ID } from '../src/steps/consolidate.js';

/**
 * The autonomy path, end to end, against a fake Fortnox HTTP API.
 *
 * What is proven here:
 *  1. A close run reads a real-shaped Fortnox account through the real adapter
 *     and reaches the same conclusions as the mock adapter does.
 *  2. Policy-driven approval records system decisions bound to payload hashes.
 *  3. In shadow mode nothing is ever posted, whatever was approved.
 *  4. With shadow mode off and every switch on, exactly the approved bytes are
 *     posted, once, and a re-run does not book them again.
 *  5. A payload changed after approval, or a client whose writes are off, is
 *     stopped by the gate.
 */

const TOKEN = 'fake-access-token';
const scope = { tenantId: DEMO_IDS.tenant, clientId: DEMO_IDS.client };
const model = () => createModelProvider({ provider: 'fake', model: 'fake', timeoutMs: 5000, maxRetries: 0 });

function realResolver(server: FakeFortnoxServer, writesEnabled: boolean, shadowMode: boolean): FortnoxPortResolver {
  return {
    resolve: async (): Promise<FortnoxDataSource> => ({
      kind: 'real',
      port: new RealFortnoxAdapter({
        baseUrl: 'https://api.fortnox.example',
        tokenProvider: { getAccessToken: async () => TOKEN },
        writesEnabled,
        shadowMode,
        client: new FortnoxHttpClient({
          baseUrl: 'https://api.fortnox.example',
          tokenProvider: { getAccessToken: async () => TOKEN },
          fetchImpl: server.fetchImpl,
          rateLimiter: new SlidingWindowRateLimiter({ maxRequests: 10_000, windowMs: 1, sleep: async () => undefined }),
          sleep: async () => undefined,
        }),
      }),
      label: 'Nordvik Bygg AB · 556123-4567',
      reason: null,
    }),
  };
}

async function histogram(repos: Repositories, closeRunId: string): Promise<Record<string, number>> {
  const findings = await repos.listFindings({ tenantId: DEMO_IDS.tenant }, { closeRunId });
  const out: Record<string, number> = {};
  for (const f of findings) out[f.type] = (out[f.type] ?? 0) + 1;
  return out;
}

describe('autonomy against a fake Fortnox API (integration)', () => {
  let handle: DbHandle;
  let repos: Repositories;
  let server: FakeFortnoxServer;
  const dataset = { ...buildSyntheticDataset() };

  beforeAll(async () => {
    handle = await openEphemeralDatabase();
    await handle.migrate();
    await seedDemoData(handle.db);
    repos = createRepositories(handle.db);
    server = createFakeFortnoxServer(dataset, { accessToken: TOKEN, pageSize: 8 });

    await repos.upsertIntegrationConnection({
      tenantId: DEMO_IDS.tenant,
      clientId: DEMO_IDS.client,
      kind: FORTNOX_CONNECTION_KIND,
      mode: 'real_read_only',
      scopes: ['bookkeeping'],
      credentialRef: `fortnox:${DEMO_IDS.tenant}:${DEMO_IDS.client}`,
      status: 'connected',
      healthy: true,
      writesEnabled: false,
      remoteCompanyName: 'Nordvik Bygg AB',
    });
    await repos.updatePolicy(scope, { autoBookEnabled: true });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  describe('shadow mode', () => {
    let closeRunId: string;
    let mockHistogram: Record<string, number>;

    beforeAll(async () => {
      // The mock comparison runs in its own database: processed source keys
      // and the history cache are per client, and sharing them would let the
      // two runs contaminate each other.
      const mockHandle = await openEphemeralDatabase();
      await mockHandle.migrate();
      await seedDemoData(mockHandle.db);
      const mockRepos = createRepositories(mockHandle.db);
      await mockRepos.updatePolicy(scope, { autoBookEnabled: true });
      const mockEngine = new DatabaseWorkflowEngine({
        repos: mockRepos,
        fortnox: new MockFortnoxAdapter(dataset),
        model: model(),
        shadowMode: true,
      });
      const mockRunId = (await mockEngine.startCloseRun({ ...scope, periodKey: DEMO_PERIOD })).closeRunId;
      await mockEngine.executeCloseRun(DEMO_IDS.tenant, mockRunId);
      mockHistogram = await histogram(mockRepos, mockRunId);
      await mockHandle.close();

      const engine = new DatabaseWorkflowEngine({
        repos,
        fortnox: realResolver(server, false, true),
        model: model(),
        shadowMode: true,
      });
      closeRunId = (await engine.startCloseRun({ ...scope, periodKey: DEMO_PERIOD })).closeRunId;
      await engine.executeCloseRun(DEMO_IDS.tenant, closeRunId);
    }, 120_000);

    it('reads the account through the real adapter with a bearer token, paginating', async () => {
      const run = await repos.getCloseRun({ tenantId: DEMO_IDS.tenant }, closeRunId);
      expect(run?.dataSource).toBe('real');
      expect(run?.dataSourceLabel).toContain('Nordvik');
      const steps = await repos.listSteps({ tenantId: DEMO_IDS.tenant }, closeRunId);
      const readiness = steps.find((s) => s.stepKey === 'agent_readiness');
      expect(readiness?.status).toBe('completed');
      expect(readiness?.message).toContain('Datakälla Fortnox');

      expect(server.calls.every((c) => c.authorized)).toBe(true);
      const pages = server.calls.filter((c) => c.path === '/3/vouchers').map((c) => c.query.page);
      expect(pages).toContain('2');
      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('reaches the same findings as the mock adapter on the same books', async () => {
      const real = await histogram(repos, closeRunId);
      // Fortnox voucher rows carry no VAT code (only accounts do), so the one
      // rule that compares a row's VAT code to history cannot fire on live
      // data. Everything else must agree exactly.
      const { 'anomaly.deviating_vat_code': _ignored, ...expected } = mockHistogram;
      expect(real).toEqual(expected);
      expect(Object.keys(real).length).toBeGreaterThan(3);
    });

    it('records policy-driven approvals as system decisions bound to the payload hash', async () => {
      const proposals = await repos.listProposals({ tenantId: DEMO_IDS.tenant }, closeRunId);
      const automatic = proposals.filter((p) => p.decisionLevel === 'automatic');
      expect(automatic.length).toBeGreaterThan(0);

      for (const proposal of automatic) {
        expect(proposal.status).toBe('approved_shadow');
        const decisions = await repos.listApprovalDecisions({ tenantId: DEMO_IDS.tenant }, proposal.findingId ?? '');
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({
          kind: 'approve',
          actorKind: 'system',
          decidedByUserId: AUTO_APPROVER_ID,
          approvedPayloadHash: hashPayload(proposal.simulatedFortnoxPayload),
          shadowOnly: true,
        });
      }
      // Anything that needs a person is untouched.
      for (const proposal of proposals.filter((p) => p.decisionLevel !== 'automatic')) {
        expect(proposal.status).toBe('simulated');
      }
    });

    it('never posts in shadow mode, and says why for every approved proposal', async () => {
      const engine = new DatabaseWorkflowEngine({
        repos,
        fortnox: realResolver(server, false, true),
        model: model(),
        shadowMode: true,
      });
      const before = server.calls.filter((c) => c.method === 'POST').length;
      const result = await engine.submitApprovedProposals(DEMO_IDS.tenant, closeRunId);

      expect(result.submitted).toHaveLength(0);
      expect(result.blocked.length).toBeGreaterThan(0);
      for (const b of result.blocked) {
        expect(b.reasons).toContain('shadow_mode_active');
        expect(b.reasons).toContain('feature_flag_disabled');
        expect(b.reasons).toContain('client_writes_disabled');
      }
      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(before);

      const audit = await repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { closeRunId });
      expect(audit.every((e) => e.fortnoxId === null)).toBe(true);
      expect(audit.some((e) => e.operation === 'fortnox.write_blocked')).toBe(true);
    });
  });

  describe('live booking (shadow mode off, every switch on)', () => {
    let closeRunId: string;
    let engine: DatabaseWorkflowEngine;

    beforeAll(async () => {
      await repos.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, {
        writesEnabled: true,
        mode: 'real_read_write',
      });
      engine = new DatabaseWorkflowEngine({
        repos,
        fortnox: realResolver(server, true, false),
        model: model(),
        shadowMode: false,
        fortnoxWritesEnabled: true,
      });
      closeRunId = (await engine.startCloseRun({ ...scope, periodKey: DEMO_PERIOD })).closeRunId;
      await engine.executeCloseRun(DEMO_IDS.tenant, closeRunId);
    }, 120_000);

    it('books exactly the auto-approved payloads, once each', async () => {
      const proposals = await repos.listProposals({ tenantId: DEMO_IDS.tenant }, closeRunId);
      const submitted = proposals.filter((p) => p.status === 'submitted');
      expect(submitted.length).toBeGreaterThan(0);
      expect(submitted.every((p) => p.decisionLevel === 'automatic')).toBe(true);

      const posts = server.calls.filter((c) => c.method === 'POST');
      expect(posts).toHaveLength(submitted.length);
      for (const proposal of submitted) {
        const post = posts.find((p) => JSON.stringify(p.body) === JSON.stringify(proposal.simulatedFortnoxPayload));
        expect(post, `POST body for ${proposal.id}`).toBeDefined();
        expect(proposal.fortnoxVoucherId).toMatch(/^\d+-[A-Z]+-\d+$/);
        expect(proposal.fortnoxReference).toMatch(/^[A-Z]+\d+$/);
        expect(proposal.submittedAt).toBeInstanceOf(Date);
      }

      const steps = await repos.listSteps({ tenantId: DEMO_IDS.tenant }, closeRunId);
      expect(steps.find((s) => s.stepKey === 'human_review')?.message).toContain('bokförda i Fortnox');

      const audit = await repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { closeRunId });
      const writes = audit.filter((e) => e.operation === 'fortnox.write_submitted');
      expect(writes).toHaveLength(submitted.length);
      expect(writes.every((e) => e.fortnoxId !== null)).toBe(true);
    });

    it('does not book the same correction again on a re-run', async () => {
      const posts = server.calls.filter((c) => c.method === 'POST').length;
      const rerun = (await engine.startCloseRun({ ...scope, periodKey: DEMO_PERIOD })).closeRunId;
      await engine.executeCloseRun(DEMO_IDS.tenant, rerun);

      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);
      const proposals = await repos.listProposals({ tenantId: DEMO_IDS.tenant }, rerun);
      expect(proposals.some((p) => p.status === 'already_booked')).toBe(true);
      expect(proposals.some((p) => p.status === 'submitted')).toBe(false);
    });

    it('books a human approval only for the exact bytes approved, and only while the client switch is on', async () => {
      // A fresh run with policy approval off: the auto-booked corrections come
      // back as already booked, the rest wait for a person.
      await repos.updatePolicy(scope, { autoBookEnabled: false });
      const rerun = (await engine.startCloseRun({ ...scope, periodKey: DEMO_PERIOD })).closeRunId;
      await engine.executeCloseRun(DEMO_IDS.tenant, rerun);
      const proposals = await repos.listProposals({ tenantId: DEMO_IDS.tenant }, rerun);
      const candidate = proposals.find((p) => p.status === 'simulated' && p.findingId);
      expect(candidate).toBeDefined();
      const proposalId = candidate?.id ?? '';
      const findingId = candidate?.findingId ?? '';

      const approve = () =>
        recordReviewDecision(repos, { ...scope, findingId, kind: 'approve', decidedByUserId: DEMO_IDS.users.consultant });

      // 1. Approved, then edited behind the consultant's back: refused.
      await approve();
      const payload = candidate?.simulatedFortnoxPayload as { Voucher: { Description: string } };
      await repos.updateProposal({ tenantId: DEMO_IDS.tenant }, proposalId, {
        simulatedFortnoxPayload: { ...payload, Voucher: { ...payload.Voucher, Description: 'ändrad efter godkännande' } },
      });
      let posts = server.calls.filter((c) => c.method === 'POST').length;
      let result = await engine.submitApprovedProposals(DEMO_IDS.tenant, rerun, [proposalId]);
      expect(result.submitted).toHaveLength(0);
      expect(result.blocked).toEqual([{ proposalId, reasons: ['payload_changed_since_approval'] }]);
      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);

      // 2. Re-approved as edited, but the client's write switch is off: refused.
      await approve();
      await repos.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, { writesEnabled: false });
      result = await engine.submitApprovedProposals(DEMO_IDS.tenant, rerun, [proposalId]);
      expect(result.submitted).toHaveLength(0);
      expect(result.blocked).toEqual([{ proposalId, reasons: ['client_writes_disabled'] }]);
      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);

      // 3. Switch back on: exactly the approved bytes are posted, once.
      await repos.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, { writesEnabled: true });
      posts = server.calls.filter((c) => c.method === 'POST').length;
      result = await engine.submitApprovedProposals(DEMO_IDS.tenant, rerun, [proposalId]);
      expect(result.submitted.map((r) => r.proposalId)).toEqual([proposalId]);
      const post = server.calls.filter((c) => c.method === 'POST').at(-1);
      expect((post?.body as { Voucher: { Description: string } }).Voucher.Description).toBe('ändrad efter godkännande');
      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(posts + 1);

      const stored = await repos.getProposal({ tenantId: DEMO_IDS.tenant }, proposalId);
      expect(stored?.status).toBe('submitted');
      expect(stored?.approvalDecisionId).toBeTruthy();

      // 4. Asking again does nothing: the claim moved it out of the approved state.
      result = await engine.submitApprovedProposals(DEMO_IDS.tenant, rerun, [proposalId]);
      expect(result.submitted).toHaveLength(0);
      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(posts + 1);
    });
  });
});
