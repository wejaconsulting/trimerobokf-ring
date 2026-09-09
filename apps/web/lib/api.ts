/**
 * Server-side API client.
 *
 * Every call happens in a React Server Component or a Server Action, so the
 * browser never talks to the API directly and no tenant header is exposed to
 * client JavaScript.
 */
const BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';
const TENANT_ID = process.env.DEMO_TENANT_ID ?? 'firm-trimeros';

/**
 * When a deployment gates the API with a password, these server-side calls have
 * to present it too. The credentials never reach the browser: every fetch in
 * this file runs in a server component or a server action.
 */
const AUTH_HEADER = process.env.DEMO_PASSWORD
  ? `Basic ${Buffer.from(`${process.env.DEMO_USER ?? 'demo'}:${process.env.DEMO_PASSWORD}`).toString('base64')}`
  : undefined;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': TENANT_ID,
      ...(AUTH_HEADER ? { authorization: AUTH_HEADER } : {}),
      ...(init?.headers ?? {}),
    },
    // The review app must always reflect the current state of a close run.
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ApiError(response.status, `${response.status} ${path}: ${body.slice(0, 400)}`);
  }
  return (await response.json()) as T;
}

export const api = {
  systemStatus: () => request<SystemStatus>('/api/system/status'),
  clients: () => request<ClientOverview[]>('/api/clients'),
  closeRun: (closeRunId: string) => request<CloseRunDetail>(`/api/close-runs/${closeRunId}`),
  findings: (closeRunId: string, query = '') =>
    request<FindingListItem[]>(`/api/close-runs/${closeRunId}/findings${query ? `?${query}` : ''}`),
  finding: (findingId: string) => request<FindingDetail>(`/api/findings/${findingId}`),
  decide: (findingId: string, body: DecisionBody) =>
    request<DecisionResult>(`/api/findings/${findingId}/decision`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startCloseRun: (clientId: string, periodKey: string) =>
    request<{ closeRunId: string }>(`/api/clients/${clientId}/close-runs`, {
      method: 'POST',
      body: JSON.stringify({ periodKey }),
    }),

  fortnoxStatus: (clientId: string) =>
    request<FortnoxIntegrationStatus>(
      `/api/integrations/fortnox/status?clientId=${encodeURIComponent(clientId)}`,
    ),
  fortnoxConnect: (body: { clientId: string; userId: string; returnTo?: string }) =>
    request<{ authorizeUrl: string; expiresAt: string }>('/api/integrations/fortnox/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  fortnoxVerify: (clientId: string, userId: string) =>
    request<{ connection: FortnoxConnection }>('/api/integrations/fortnox/verify', {
      method: 'POST',
      body: JSON.stringify({ clientId, userId }),
    }),
  fortnoxDisconnect: (clientId: string, userId: string) =>
    request<{ revokedAtFortnox: boolean; connection: FortnoxConnection }>(
      '/api/integrations/fortnox/disconnect',
      { method: 'POST', body: JSON.stringify({ clientId, userId }) },
    ),
  fortnoxWrites: (clientId: string, userId: string, enabled: boolean) =>
    request<{ writesEnabled: boolean; connection: FortnoxConnection | null }>(
      '/api/integrations/fortnox/writes',
      { method: 'POST', body: JSON.stringify({ clientId, userId, enabled }) },
    ),

  // --- firm operations ----------------------------------------------------
  firmOverview: () => request<FirmOverview>('/api/firm/overview'),
  createClient: (body: { name: string; organisationNumber: string; userId: string }) =>
    request<{ client: { id: string; name: string; organisationNumber: string } }>('/api/clients', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  policy: (clientId: string) => request<{ policy: ClientPolicy; rules: ClientRule[] }>(`/api/clients/${clientId}/policy`),
  updatePolicy: (clientId: string, patch: Partial<ClientPolicy> & { userId: string }) =>
    request<{ policy: ClientPolicy }>(`/api/clients/${clientId}/policy`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  runAll: (periodKey: string) =>
    request<RunAllResult>('/api/close-runs/run-all', { method: 'POST', body: JSON.stringify({ periodKey }) }),
  submitProposals: (closeRunId: string, proposalIds?: string[]) =>
    request<SubmissionResult>(`/api/close-runs/${closeRunId}/submit`, {
      method: 'POST',
      body: JSON.stringify(proposalIds ? { proposalIds } : {}),
    }),
};

export interface ClientPolicy {
  id: string;
  clientId: string;
  materialityThreshold: number;
  automationAmountLimit: number;
  costCenterRequiredAccounts: number[];
  projectRequiredAccounts: number[];
  requireDocumentationForInputVat: boolean;
  historyWindowMonths: number;
  amountDeviationThreshold: number;
  vatRates: number[];
  autoBookEnabled: boolean;
  updatedAt: string;
}

export interface ClientRule {
  id: string;
  kind: string;
  version: string;
  active: boolean;
  config: Record<string, unknown>;
}

export interface FirmOverview {
  clientCount: number;
  runsCounted: number;
  dataSources: Record<string, number>;
  items: { clear: number; automatic: number; review: number; manual: number; total: number };
  automationRate: number;
  blockingFindings: number;
  proposals: { approved: number; submitted: number };
  shadowMode: boolean;
  liveBooking: boolean;
}

export interface RunAllResult {
  periodKey: string;
  results: {
    clientId: string;
    clientName: string;
    closeRunId: string | null;
    status: string;
    findingCount: number;
    blockingFindingCount: number;
    clearItemCount: number;
    error: string | null;
  }[];
}

export interface SubmissionResult {
  submitted: { proposalId: string; fortnoxVoucherId: string; reference: string }[];
  blocked: { proposalId: string; reasons: string[] }[];
  failed: { proposalId: string; error: string }[];
  liveBooking: boolean;
  note: string;
}

/**
 * The connection as the console is allowed to see it.
 *
 * Note what is absent: there is no token field, because the endpoint has none
 * to give. The console cannot leak a credential it is never sent.
 */
export interface FortnoxConnection {
  status: 'disconnected' | 'connected' | 'needs_reconnect';
  clientId: string;
  companyName: string | null;
  organisationNumber: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  connectedByUserId: string | null;
  refreshTokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  healthy: boolean;
  statusCode: string | null;
  writesEnabled: boolean;
}

export interface FortnoxIntegrationStatus {
  configured: boolean;
  /** Environment variables still missing, when `configured` is false. */
  missing?: string[];
  redirectUri?: string;
  requestedScopes: string[];
  shadowMode: boolean;
  connection: FortnoxConnection | null;
}

// --- shapes the UI relies on ---------------------------------------------

export interface SystemStatus {
  shadowMode: boolean;
  fortnoxWritesEnabled: boolean;
  /** mock | auto | real */
  fortnoxAdapter: string;
  fortnoxIntegrationConfigured: boolean;
  modelProvider: string;
  modelName: string;
  capabilities: {
    available: string[];
    unavailable: { capability: string; reason: string }[];
  };
}

export interface RunSummary {
  closeRunId: string;
  status: string;
  findingCount: number;
  blockingFindingCount: number;
  reviewCount: number;
  manualCount: number;
  clearItemCount: number;
  canComplete: boolean;
  reasons: string[];
  completedSteps?: number;
  totalSteps?: number;
  missingDocumentationCount?: number;
}

export interface ClientOverview {
  client: { id: string; name: string; organisationNumber: string };
  latestRun: {
    id: string;
    periodKey: string;
    status: string;
    shadowMode: boolean;
    dataSource: 'mock' | 'real' | 'none';
    dataSourceLabel: string | null;
  } | null;
  summary: RunSummary | null;
}

export interface StepRow {
  stepKey: string;
  status: string;
  message: string | null;
  reasonCode: string | null;
  order: number;
  labelSv: string;
  labelEn: string;
  description: string;
  descriptionSv: string;
  implemented: boolean;
  blocksCompletion: boolean;
}

export interface CloseRunDetail {
  run: {
    id: string;
    clientId: string;
    periodKey: string;
    status: string;
    shadowMode: boolean;
    dataSource: 'mock' | 'real' | 'none';
    dataSourceLabel: string | null;
    ruleSetVersion: string;
    decisionModelVersion: string;
    correlationId: string;
  };
  client: { id: string; name: string } | null;
  summary: RunSummary;
  steps: StepRow[];
  /** Proposal counts by status: simulated, approved_shadow, submitted, ... */
  proposalCounts: Record<string, number>;
}

export interface FindingListItem {
  id: string;
  type: string;
  severity: string;
  amount: number;
  description: string;
  decisionLevel: string;
  decisionScore: number;
  blocking: boolean;
  requiresConsultant: boolean;
  status: string;
  subject: { accountNumber?: number; supplierNumber?: string; voucherId?: string };
  hasProposal: boolean;
  proposalDecisionLevel: string | null;
}

export interface ProposalDetail {
  id: string;
  status: string;
  decisionLevel: string;
  decisionScore: number;
  decisionReasons: string[];
  description: string;
  rationale: string;
  series: string;
  transactionDate: string;
  simulatedFortnoxEndpoint: string;
  simulatedFortnoxPayload: unknown;
  simulatedPayloadHash: string;
  fortnoxVoucherId: string | null;
  fortnoxReference: string | null;
  submittedAt: string | null;
  submissionError: string | null;
  rows: {
    id: string;
    account: number;
    debit: number;
    credit: number;
    description: string;
    costCenter: string | null;
    project: string | null;
    vatCode: string | null;
  }[];
}

export interface FindingDetail {
  finding: FindingListItem & {
    clientId: string;
    closeRunId: string;
    rationale: string;
    suggestedAction: string;
    decisionReasons: string[];
    evidence: { kind: string; ref: string; label?: string }[];
    ruleId: string;
    ruleVersion: string;
    mergedFromRuleIds: string[];
    occurrences: number;
  };
  run: { periodKey: string; ruleSetVersion: string } | null;
  matchedRules: { id: string; version: string; titleSv: string; explanation: string; kind: string }[];
  proposals: ProposalDetail[];
  decisions: {
    id: string;
    kind: string;
    decidedByUserId: string;
    actorKind: string;
    comment: string | null;
    approvedPayloadHash: string | null;
    shadowOnly: boolean;
    createdAt: string;
  }[];
  auditHistory: {
    id: string;
    operation: string;
    result: string;
    occurredAt: string;
    actorKind: string;
    actorId: string;
    inputRefs: string[];
    ruleVersion: string | null;
    promptVersion: string | null;
    modelProvider: string | null;
    fortnoxId: string | null;
  }[];
}

export interface DecisionBody {
  kind: 'approve' | 'reject' | 'edit_proposal' | 'request_information';
  decidedByUserId: string;
  comment?: string;
  editedPayload?: unknown;
}

export interface DecisionResult {
  approvalDecisionId: string;
  findingStatus: string;
  reviewItemStatus: string;
  shadowOnly: boolean;
  note: string;
  /** Present when live booking is on and the decision was an approval. */
  submission: Omit<SubmissionResult, 'liveBooking' | 'note'> | null;
}

/** Formats an integer öre amount as Swedish kronor. */
export function formatSek(ore: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
  }).format(ore / 100);
}
