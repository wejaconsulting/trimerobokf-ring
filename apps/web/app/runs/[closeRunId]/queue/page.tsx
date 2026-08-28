import Link from 'next/link';
import { api, formatSek, type FindingListItem } from '../../../../lib/api';
import { Card, DecisionBadge, Score, SeverityBadge, StatusBadge } from '../../../ui';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Named filters, so the common triage moves are one click rather than a form. */
const QUICK_FILTERS = [
  { key: 'all', label: 'Alla', query: {} },
  { key: 'clear', label: 'Klart', query: { status: 'approved,resolved' } },
  { key: 'review', label: 'Review', query: { decisionLevel: 'review' } },
  { key: 'manual', label: 'Manuell bedömning', query: { decisionLevel: 'manual_assessment' } },
  {
    key: 'missing_docs',
    label: 'Saknar underlag',
    query: {
      type: 'anomaly.missing_documentation,validation.input_vat_without_documentation',
    },
  },
  { key: 'anomaly', label: 'Avvikelse', query: { severity: 'medium,high,critical' } },
  { key: 'blocking', label: 'Blockerande', query: { blocking: 'true' } },
] as const;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function QueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ closeRunId: string }>;
  searchParams: SearchParams;
}) {
  const { closeRunId } = await params;
  const sp = await searchParams;

  const active = first(sp.filter) ?? 'all';
  const preset = QUICK_FILTERS.find((f) => f.key === active) ?? QUICK_FILTERS[0];

  const query = new URLSearchParams({ ...preset.query });
  for (const key of [
    'account',
    'supplierNumber',
    'minAmount',
    'maxAmount',
    'minDecisionScore',
    'maxDecisionScore',
  ] as const) {
    const value = first(sp[key]);
    // Amounts are entered in kronor but the API speaks öre.
    if (!value) continue;
    if (key === 'minAmount' || key === 'maxAmount') {
      query.set(key, String(Math.round(Number(value) * 100)));
    } else {
      query.set(key, value);
    }
  }

  const [detail, findings] = await Promise.all([
    api.closeRun(closeRunId),
    api.findings(closeRunId, query.toString()),
  ]);

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">Kundöversikt</Link> / <Link href={`/runs/${closeRunId}`}>{detail.run.periodKey}</Link> /
        Review-kö
      </div>

      <div className="page-head">
        <div>
          <h1>Review-kö</h1>
          <div className="sub">
            {detail.client?.name} · {detail.run.periodKey} · {findings.length} post(er)
          </div>
        </div>
      </div>

      <Card title="Filter">
        <div className="chips" style={{ marginBottom: 14 }}>
          {QUICK_FILTERS.map((filter) => (
            <Link
              key={filter.key}
              className="chip"
              data-active={filter.key === active}
              href={`/runs/${closeRunId}/queue?filter=${filter.key}`}
            >
              {filter.label}
            </Link>
          ))}
        </div>

        <form className="filters" method="get">
          <input type="hidden" name="filter" value={active} />
          <div className="field">
            <label htmlFor="account">Konto</label>
            <input id="account" type="number" name="account" defaultValue={first(sp.account) ?? ''} />
          </div>
          <div className="field">
            <label htmlFor="supplierNumber">Leverantör</label>
            <input
              id="supplierNumber"
              type="text"
              name="supplierNumber"
              placeholder="L001"
              defaultValue={first(sp.supplierNumber) ?? ''}
            />
          </div>
          <div className="field">
            <label htmlFor="minAmount">Belopp från (kr)</label>
            <input id="minAmount" type="number" name="minAmount" defaultValue={first(sp.minAmount) ?? ''} />
          </div>
          <div className="field">
            <label htmlFor="maxAmount">Belopp till (kr)</label>
            <input id="maxAmount" type="number" name="maxAmount" defaultValue={first(sp.maxAmount) ?? ''} />
          </div>
          <div className="field">
            <label htmlFor="minDecisionScore">Score från</label>
            <input
              id="minDecisionScore"
              type="number"
              step="0.05"
              min="0"
              max="1"
              name="minDecisionScore"
              defaultValue={first(sp.minDecisionScore) ?? ''}
            />
          </div>
          <div className="field">
            <label htmlFor="maxDecisionScore">Score till</label>
            <input
              id="maxDecisionScore"
              type="number"
              step="0.05"
              min="0"
              max="1"
              name="maxDecisionScore"
              defaultValue={first(sp.maxDecisionScore) ?? ''}
            />
          </div>
          <button className="btn" type="submit">
            Tillämpa
          </button>
          <Link className="btn" href={`/runs/${closeRunId}/queue?filter=${active}`}>
            Rensa
          </Link>
        </form>
      </Card>

      <Card padded={false}>
        {findings.length === 0 ? (
          <div className="empty">Inga poster matchar filtret.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Avvikelse</th>
                  <th>Typ</th>
                  <th>Konto / Leverantör</th>
                  <th className="num">Belopp</th>
                  <th>Allvarlighet</th>
                  <th>Beslutsnivå</th>
                  <th>Score</th>
                  <th>Status</th>
                  <th>Förslag</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function FindingRow({ finding }: { finding: FindingListItem }) {
  return (
    <tr>
      <td>
        <Link href={`/findings/${finding.id}`}>{finding.description}</Link>
        {finding.blocking ? (
          <span className="badge badge-danger" style={{ marginLeft: 8 }}>
            Blockerande
          </span>
        ) : null}
      </td>
      <td className="mono">{finding.type}</td>
      <td>
        {finding.subject.accountNumber ? <span className="mono">{finding.subject.accountNumber}</span> : null}
        {finding.subject.accountNumber && finding.subject.supplierNumber ? ' · ' : null}
        {finding.subject.supplierNumber ? (
          <span className="mono">{finding.subject.supplierNumber}</span>
        ) : null}
        {!finding.subject.accountNumber && !finding.subject.supplierNumber ? (
          <span className="faint">—</span>
        ) : null}
      </td>
      <td className="num">{formatSek(finding.amount)}</td>
      <td>
        <SeverityBadge severity={finding.severity} />
      </td>
      <td>
        <DecisionBadge level={finding.decisionLevel} />
      </td>
      <td>
        <Score value={finding.decisionScore} />
      </td>
      <td>
        <StatusBadge status={finding.status} />
      </td>
      <td>
        {finding.hasProposal && finding.proposalDecisionLevel ? (
          <DecisionBadge level={finding.proposalDecisionLevel} />
        ) : (
          <span className="faint">—</span>
        )}
      </td>
    </tr>
  );
}
