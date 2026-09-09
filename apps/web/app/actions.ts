'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, type DecisionBody } from '../lib/api';

/**
 * Records a review decision.
 *
 * The endpoint changes internal review status. Only when the operator has
 * switched live booking on (SHADOW_MODE=false, FORTNOX_WRITES_ENABLED=true and
 * the acknowledgement phrase) does the API go on to book the approved payload -
 * through the same seven-condition gate as every other write.
 */
export async function submitDecision(formData: FormData): Promise<void> {
  const findingId = String(formData.get('findingId') ?? '');
  const kind = String(formData.get('kind') ?? '') as DecisionBody['kind'];
  const comment = String(formData.get('comment') ?? '').trim();
  const decidedByUserId = String(formData.get('decidedByUserId') ?? 'user-anna-consultant');

  if (!findingId || !kind) return;

  const editedRows = formData.get('editedRows');
  let editedPayload: unknown;
  if (kind === 'edit_proposal' && typeof editedRows === 'string' && editedRows.trim().length > 0) {
    try {
      editedPayload = JSON.parse(editedRows);
    } catch {
      // An unparseable edit is recorded verbatim rather than dropped: the audit
      // log should show exactly what the consultant submitted.
      editedPayload = { raw: editedRows, parseError: true };
    }
  }

  await api.decide(findingId, {
    kind,
    decidedByUserId,
    ...(comment ? { comment } : {}),
    ...(editedPayload !== undefined ? { editedPayload } : {}),
  });

  revalidatePath(`/findings/${findingId}`);
  revalidatePath('/');
}

/** Starts and runs a close run for a client and period. */
export async function startCloseRun(formData: FormData): Promise<void> {
  const clientId = String(formData.get('clientId') ?? '');
  const periodKey = String(formData.get('periodKey') ?? '');
  if (!clientId || !periodKey) return;
  await api.startCloseRun(clientId, periodKey);
  revalidatePath('/');
}

const FORTNOX_SETTINGS_PATH = '/installningar/fortnox';

/**
 * Starts the Fortnox connection.
 *
 * The authorize URL is built by the API, which holds the client id; this action
 * only forwards the browser to it. The client secret never leaves the API
 * process, and nothing here ever sees a token.
 */
export async function connectFortnox(formData: FormData): Promise<void> {
  const clientId = String(formData.get('clientId') ?? '');
  const userId = String(formData.get('userId') ?? 'user-anna-consultant');
  if (!clientId) return;

  const { authorizeUrl } = await api.fortnoxConnect({
    clientId,
    userId,
    returnTo: `${FORTNOX_SETTINGS_PATH}?clientId=${encodeURIComponent(clientId)}`,
  });

  // `redirect` throws to unwind the action, so it must be outside the try/catch
  // of any caller that would swallow it.
  redirect(authorizeUrl);
}

/** Re-runs the live check against Fortnox. */
export async function verifyFortnox(formData: FormData): Promise<void> {
  const clientId = String(formData.get('clientId') ?? '');
  const userId = String(formData.get('userId') ?? 'user-anna-consultant');
  if (!clientId) return;
  await api.fortnoxVerify(clientId, userId);
  revalidatePath(FORTNOX_SETTINGS_PATH);
}

/** Revokes the grant at Fortnox and deletes the stored credential. */
export async function disconnectFortnox(formData: FormData): Promise<void> {
  const clientId = String(formData.get('clientId') ?? '');
  const userId = String(formData.get('userId') ?? 'user-anna-consultant');
  if (!clientId) return;
  await api.fortnoxDisconnect(clientId, userId);
  revalidatePath(FORTNOX_SETTINGS_PATH);
}

const DEFAULT_USER = 'user-anna-consultant';

/** Adds a client to the firm and opens its settings. */
export async function createClient(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  const organisationNumber = String(formData.get('organisationNumber') ?? '').trim();
  const userId = String(formData.get('userId') ?? DEFAULT_USER);
  if (!name || !organisationNumber) return;
  const { client } = await api.createClient({ name, organisationNumber, userId });
  revalidatePath('/');
  redirect(`/klienter/${encodeURIComponent(client.id)}?created=1`);
}

/** Saves the client's accounting policy. Amounts arrive in kronor and are stored in öre. */
export async function updatePolicy(formData: FormData): Promise<void> {
  const clientId = String(formData.get('clientId') ?? '');
  if (!clientId) return;
  const userId = String(formData.get('userId') ?? DEFAULT_USER);
  const kronor = (key: string): number | undefined => {
    const raw = String(formData.get(key) ?? '').replace(/\s/g, '').replace(',', '.');
    if (raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.round(value * 100) : undefined;
  };
  const accounts = (key: string): number[] | undefined => {
    const raw = String(formData.get(key) ?? '').trim();
    if (raw === '') return [];
    const list = raw.split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1000 && n <= 9999);
    return list;
  };
  const materialityThreshold = kronor('materialityThreshold');
  const automationAmountLimit = kronor('automationAmountLimit');
  const historyWindowMonths = Number(formData.get('historyWindowMonths'));
  const amountDeviationThreshold = Number(String(formData.get('amountDeviationThreshold') ?? '').replace(',', '.'));

  await api.updatePolicy(clientId, {
    userId,
    ...(materialityThreshold !== undefined ? { materialityThreshold } : {}),
    ...(automationAmountLimit !== undefined ? { automationAmountLimit } : {}),
    ...(Number.isInteger(historyWindowMonths) && historyWindowMonths > 0 ? { historyWindowMonths } : {}),
    ...(Number.isFinite(amountDeviationThreshold) ? { amountDeviationThreshold } : {}),
    costCenterRequiredAccounts: accounts('costCenterRequiredAccounts') ?? [],
    projectRequiredAccounts: accounts('projectRequiredAccounts') ?? [],
    requireDocumentationForInputVat: formData.get('requireDocumentationForInputVat') === 'on',
    autoBookEnabled: formData.get('autoBookEnabled') === 'on',
  });
  revalidatePath(`/klienter/${clientId}`);
  revalidatePath('/');
  redirect(`/klienter/${encodeURIComponent(clientId)}?saved=1`);
}

/** Runs one period for every active client. */
export async function runAllClients(formData: FormData): Promise<void> {
  const periodKey = String(formData.get('periodKey') ?? '');
  if (!/^\d{4}-\d{2}$/.test(periodKey)) return;
  const result = await api.runAll(periodKey);
  revalidatePath('/');
  const failed = result.results.filter((r) => r.error).length;
  redirect(`/?ranAll=${encodeURIComponent(periodKey)}&clients=${result.results.length}&failed=${failed}`);
}

/** Asks the API to book the run's approved proposals through the write gate. */
export async function submitProposals(formData: FormData): Promise<void> {
  const closeRunId = String(formData.get('closeRunId') ?? '');
  if (!closeRunId) return;
  const result = await api.submitProposals(closeRunId);
  revalidatePath(`/runs/${closeRunId}`);
  redirect(
    `/runs/${encodeURIComponent(closeRunId)}?submitted=${result.submitted.length}&blocked=${result.blocked.length}&failed=${result.failed.length}&live=${result.liveBooking ? 1 : 0}`,
  );
}

/** The per-client write switch. Refused by the API while shadow mode is on. */
export async function toggleFortnoxWrites(formData: FormData): Promise<void> {
  const clientId = String(formData.get('clientId') ?? '');
  const userId = String(formData.get('userId') ?? DEFAULT_USER);
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!clientId) return;
  await api.fortnoxWrites(clientId, userId, enabled);
  revalidatePath(FORTNOX_SETTINGS_PATH);
  redirect(`${FORTNOX_SETTINGS_PATH}?clientId=${encodeURIComponent(clientId)}&writes=${enabled ? 'on' : 'off'}`);
}
