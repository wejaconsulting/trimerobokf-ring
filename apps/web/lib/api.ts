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
};

// --- shapes the UI relies on ---------------------------------------------

export interface SystemStatus {
  shadowMode: boolean;
  fortnoxWritesEnabled: boolean;
  fortnoxAdapter: string;
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
  latestRun: { id: string; periodKey: string; status: string; shadowMode: boolean } | null;
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
    ruleSetVersion: string;
    decisionModelVersion: string;
    correlationId: string;
  };
  client: { id: string; name: string } | null;
  summary: RunSummary;
  steps: StepRow[];
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
    comment: string | null;
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
}

/** Formats an integer öre amount as Swedish kronor. */
export function formatSek(ore: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
  }).format(ore / 100);
}
