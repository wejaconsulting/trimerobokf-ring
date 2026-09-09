'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, type DecisionBody } from '../lib/api';

/**
 * Records a review decision.
 *
 * This is the only mutating action the review app exposes, and it reaches
 * exactly one endpoint, which changes internal review status only. There is no
 * action here - and no endpoint behind it - that writes to Fortnox.
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
