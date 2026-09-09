/**
 * Smoke test of the main flow.
 *
 * Starts the real API in a child process against a fresh database, seeds it,
 * runs a synthetic close run over HTTP and asserts the properties that matter
 * most: the workflow ran, findings were deduplicated, payloads were simulated,
 * a review decision sticks - and nothing was ever written to Fortnox.
 *
 * Run with: pnpm smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 4123);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '.pglite/smoke';
const TENANT = 'firm-trimeros';
const CLIENT = 'client-nordvik';
const PERIOD = '2025-08';

const env = {
  ...process.env,
  DB_DRIVER: 'pglite',
  PGLITE_DATA_DIR: DATA_DIR,
  API_PORT: String(PORT),
  API_HOST: '127.0.0.1',
  LOG_LEVEL: 'warn',
  SHADOW_MODE: 'true',
  FORTNOX_WRITES_ENABLED: 'false',
  FORTNOX_ADAPTER: 'mock',
  MODEL_PROVIDER: 'fake',
};

let checks = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { 'x-tenant-id': TENANT } });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // The server is not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`API did not become healthy within ${timeoutMs}ms`);
}

let server: ChildProcess | undefined;

try {
  console.log('Smoke test: Trimeros Accounting Agent\n');

  console.log('1. Preparing a fresh database');
  await rm(path.join(ROOT, DATA_DIR), { recursive: true, force: true });
  await run('node', ['node_modules/tsx/dist/cli.mjs', 'packages/db/src/cli/seed.ts']);

  console.log('\n2. Starting the API');
  server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'apps/api/src/server.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForHealth();

  console.log('\n3. Safety posture');
  const status = await get<{
    shadowMode: boolean;
    fortnoxWritesEnabled: boolean;
    fortnoxAdapter: string;
    modelProvider: string;
    capabilities: { unavailable: { capability: string }[] };
  }>('/api/system/status');
  check('shadow mode is on', status.shadowMode === true);
  check('Fortnox writes are disabled', status.fortnoxWritesEnabled === false);
  check('the mock adapter is in use', status.fortnoxAdapter === 'mock');
  check('the offline model provider is in use', status.modelProvider === 'fake');
  check(
    'unverified Fortnox capabilities are reported as unavailable',
    status.capabilities.unavailable.length > 0,
  );

  console.log('\n4. Running a synthetic close run');
  const summary = await post<{
    closeRunId: string;
    status: string;
    steps: { stepKey: string; status: string }[];
    findingCount: number;
    blockingFindingCount: number;
    reviewCount: number;
    manualCount: number;
    clearItemCount: number;
    canComplete: boolean;
    reasons: string[];
  }>(`/api/clients/${CLIENT}/close-runs`, { periodKey: PERIOD });

  check('all 14 workflow steps exist', summary.steps.length === 14, `got ${summary.steps.length}`);
  check(
    'the implemented steps completed',
    ['agent_readiness', 'completeness_check', 'general_ledger_review', 'consolidate_findings', 'accountant_report']
      .every((key) => summary.steps.find((s) => s.stepKey === key)?.status === 'completed'),
  );
  check(
    'unimplemented steps are marked not_implemented',
    summary.steps.some((s) => s.status === 'not_implemented'),
  );
  check('findings were created', summary.findingCount > 0, `got ${summary.findingCount}`);
  check('blocking findings were created', summary.blockingFindingCount > 0);
  check('items needing review were created', summary.reviewCount > 0);
  check('items needing manual assessment were created', summary.manualCount > 0);
  check('clean items were counted', summary.clearItemCount > 0);
  check('the period is NOT reported complete', summary.canComplete === false);
  check('the reason for not completing is explained', summary.reasons.length > 0);

  console.log('\n5. Review queue and deduplication');
  const findings = await get<
    { id: string; deduplicationKey: string; requiresConsultant: boolean; hasProposal: boolean }[]
  >(`/api/close-runs/${summary.closeRunId}/findings`);
  const keys = findings.map((f) => f.deduplicationKey);
  check('the queue is populated', findings.length > 0);
  check('every finding has a unique deduplication key', new Set(keys).size === keys.length);

  const blocking = await get<{ blocking: boolean }[]>(
    `/api/close-runs/${summary.closeRunId}/findings?blocking=true`,
  );
  check('the blocking filter works', blocking.length > 0 && blocking.every((f) => f.blocking));

  console.log('\n6. Simulated Fortnox payload');
  const withProposal = findings.find((f) => f.hasProposal);
  check('at least one finding carries a booking proposal', withProposal !== undefined);

  if (withProposal) {
    const detail = await get<{
      proposals: {
        status: string;
        simulatedFortnoxEndpoint: string;
        simulatedPayloadHash: string;
        simulatedFortnoxPayload: { Voucher: { VoucherRows: { Debit: number; Credit: number }[] } };
        rows: { debit: number; credit: number }[];
      }[];
      matchedRules: unknown[];
      auditHistory: { fortnoxId: string | null }[];
    }>(`/api/findings/${withProposal.id}`);

    const proposal = detail.proposals[0]!;
    check('the proposal is only simulated', proposal.status === 'simulated');
    check('the target endpoint is shown', proposal.simulatedFortnoxEndpoint === 'POST /3/vouchers');
    check('the payload is bound to a hash', /^[0-9a-f]{16}$/.test(proposal.simulatedPayloadHash));
    check('the payload has voucher rows', proposal.simulatedFortnoxPayload.Voucher.VoucherRows.length > 0);
    check(
      'the proposal balances',
      proposal.rows.reduce((a, r) => a + r.debit, 0) === proposal.rows.reduce((a, r) => a + r.credit, 0),
    );
    check('the matched rules are explained', detail.matchedRules.length > 0);
  }

  console.log('\n7. Review decision');
  const target = findings.find((f) => f.requiresConsultant)!;
  const decision = await post<{ shadowOnly: boolean; findingStatus: string; note: string }>(
    `/api/findings/${target.id}/decision`,
    { kind: 'approve', decidedByUserId: 'user-anna-consultant', comment: 'Smoke test' },
  );
  check('the decision is shadow-only', decision.shadowOnly === true);
  check('the finding is approved', decision.findingStatus === 'approved');

  const afterDecision = await get<{ finding: { status: string } }>(`/api/findings/${target.id}`);
  check('the decision persisted', afterDecision.finding.status === 'approved');

  console.log('\n8. Nothing reached Fortnox');
  const audit = await get<{ fortnoxId: string | null; result: string }[]>(
    `/api/close-runs/${summary.closeRunId}/audit`,
  );
  check('an audit trail exists', audit.length > 0);
  check('no audit event carries a Fortnox id', audit.every((e) => e.fortnoxId === null));
  check('writes were recorded as simulated', audit.some((e) => e.result === 'simulated'));

  const requests = await get<{ sentAt: string | null }[]>(
    `/api/close-runs/${summary.closeRunId}/customer-requests`,
  );
  check('no customer communication was sent', requests.every((r) => r.sentAt === null));

  console.log('\n9. Firm operations');
  const created = await post<{ client: { id: string; organisationNumber: string } }>('/api/clients', {
    name: 'Smoke Test AB',
    organisationNumber: '5590000001',
    userId: 'user-anna-consultant',
  });
  check('a client can be added', created.client.id.length > 0);
  check('the organisation number is normalised', created.client.organisationNumber === '559000-0001');

  const policy = await fetch(`${BASE}/api/clients/${CLIENT}/policy`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ autoBookEnabled: true, userId: 'user-anna-consultant' }),
  }).then((r) => r.json() as Promise<{ policy: { autoBookEnabled: boolean } }>);
  check('policy-driven approval can be switched on per client', policy.policy.autoBookEnabled === true);

  const runAll = await post<{ results: { clientId: string; closeRunId: string | null; error: string | null }[] }>(
    '/api/close-runs/run-all',
    { periodKey: PERIOD },
  );
  check('a period runs for every client', runAll.results.length === 2);
  const demoRun = runAll.results.find((r) => r.clientId === CLIENT);
  check('the demo client ran again', demoRun?.closeRunId !== null && demoRun?.error === null);

  const overview = await get<{
    automationRate: number;
    proposals: { approved: number; submitted: number };
    liveBooking: boolean;
  }>('/api/firm/overview');
  check('the firm overview reports an automation rate', overview.automationRate > 0 && overview.automationRate <= 1);
  check('the system approved automatic-level proposals itself', overview.proposals.approved > 0);
  check('nothing was booked', overview.proposals.submitted === 0 && overview.liveBooking === false);

  const submission = await post<{ submitted: unknown[]; blocked: { reasons: string[] }[]; liveBooking: boolean }>(
    `/api/close-runs/${demoRun?.closeRunId}/submit`,
    {},
  );
  check('submitting in shadow mode sends nothing', submission.submitted.length === 0 && submission.liveBooking === false);
  check(
    'every approved proposal is reported as blocked by shadow mode',
    submission.blocked.length > 0 && submission.blocked.every((b) => b.reasons.includes('shadow_mode_active')),
  );

  const laterAudit = await get<{ fortnoxId: string | null; operation: string }[]>(
    `/api/close-runs/${demoRun?.closeRunId}/audit`,
  );
  check('the blocked writes are in the audit log', laterAudit.some((e) => e.operation === 'fortnox.write_blocked'));
  check('still no audit event carries a Fortnox id', laterAudit.every((e) => e.fortnoxId === null));
} finally {
  server?.kill('SIGTERM');
}

console.log(`\n${checks - failures.length}/${checks} checks passed.`);
if (failures.length > 0) {
  console.error(`\nSmoke test FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('Smoke test PASSED — the main flow works, the firm operations work, and shadow mode held.');
process.exit(0);
