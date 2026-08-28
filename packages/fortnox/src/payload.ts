import { type IsoDate, type Ore, toSek } from '@trimeros/domain';
import { FORTNOX_ENDPOINTS } from './endpoints.js';
import type { VoucherCreatePayload } from './ports.js';
import { hashPayload } from './write-policy.js';

export interface ProposalRowInput {
  readonly account: number;
  readonly debit: Ore;
  readonly credit: Ore;
  readonly description?: string;
  readonly costCenter?: string | null;
  readonly project?: string | null;
}

export interface ProposalInput {
  readonly description: string;
  readonly transactionDate: IsoDate;
  readonly series: string;
  readonly rows: readonly ProposalRowInput[];
}

/**
 * Builds the exact request that a future write would send.
 *
 * Amounts are converted from öre to kronor here and only here: Fortnox expects
 * decimal kronor on the wire, while every internal amount is an integer in öre.
 */
export function buildVoucherPayload(input: ProposalInput): VoucherCreatePayload {
  return {
    Voucher: {
      Description: input.description,
      TransactionDate: input.transactionDate,
      VoucherSeries: input.series,
      VoucherRows: input.rows.map((r) => ({
        Account: r.account,
        Debit: toSek(r.debit),
        Credit: toSek(r.credit),
        ...(r.description ? { Description: r.description } : {}),
        ...(r.costCenter ? { CostCenter: r.costCenter } : {}),
        ...(r.project ? { Project: r.project } : {}),
      })),
    },
  };
}

export interface SimulatedRequest {
  readonly method: 'POST';
  readonly endpoint: string;
  readonly payload: VoucherCreatePayload;
  readonly payloadHash: string;
  /** Always true in phase 1. Nothing left the process. */
  readonly simulated: true;
  readonly note: string;
}

/**
 * Produces the shadow-mode artefact the review UI shows: what would be sent,
 * where, and a hash that binds a human approval to these exact bytes.
 */
export function simulateVoucherCreate(input: ProposalInput): SimulatedRequest {
  const payload = buildVoucherPayload(input);
  return {
    method: 'POST',
    endpoint: FORTNOX_ENDPOINTS.vouchers,
    payload,
    payloadHash: hashPayload(payload),
    simulated: true,
    note: 'Shadow mode: this request was constructed and validated but never sent to Fortnox.',
  };
}
