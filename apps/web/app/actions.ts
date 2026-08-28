'use server';

import { revalidatePath } from 'next/cache';
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
