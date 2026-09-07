import Link from 'next/link';
import { api, type FindingListItem } from '../../../../lib/api';
import { QueueTable } from '../../../components/queue-table';
import { Crumbs, Empty, Panel } from '../../../ui';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Named filters for the moves a consultant actually makes, each carrying its
 * own count so the queue can be triaged before a single filter is clicked.
 */
const QUICK_FILTERS = [
  { key: 'all', label: 'Alla', match: () => true },
  {
    key: 'blocking',
    label: 'Blockerande',
    match: (f: FindingListItem) => f.blocking,
  },
  {
    key: 'manual',
    label: 'Manuell bedömning',
    match: (f: FindingListItem) => f.decisionLevel === 'manual_assessment',
  },
  {
    key: 'review',
    label: 'Review',
    match: (f: FindingListItem) => f.decisionLevel === 'review',
  },
  {
    key: 'missing_docs',
    label: 'Saknar underlag',
    match: (f: FindingListItem) =>
      f.type === 'anomaly.missing_documentation' ||
      f.type === 'validation.input_vat_without_documentation',
  },
  {
    key: 'proposal',
    label: 'Har förslag',
    match: (f: FindingListItem) => f.hasProposal,
  },
  {
    key: 'decided',
    label: 'Avgjorda',
    match: (f: FindingListItem) => f.status !== 'open' && f.status !== 'in_review',
  },
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

  // The whole run is fetched once so every filter chip can show a live count;
  // the narrowing itself is cheap and happens here.
  const [detail, all] = await Promise.all([api.closeRun(closeRunId), api.findings(closeRunId)]);

  const account = first(sp.account);
  const supplier = first(sp.supplierNumber)?.toUpperCase();
  const minAmount = first(sp.minAmount);
  const maxAmount = first(sp.maxAmount);
  const minScore = first(sp.minDecisionScore);

  const preset = QUICK_FILTERS.find((f) => f.key === active) ?? QUICK_FILTERS[0];

  const findings = all.filter((f) => {
    if (!preset.match(f)) return false;
    if (account && String(f.subject.accountNumber ?? '') !== account) return false;
    if (supplier && (f.subject.supplierNumber ?? '').toUpperCase() !== supplier) return false;
    // Amounts are entered in kronor; findings carry integer öre.
    if (minAmount && Math.abs(f.amount) < Number(minAmount) * 100) return false;
    if (maxAmount && Math.abs(f.amount) > Number(maxAmount) * 100) return false;
    if (minScore && f.decisionScore < Number(minScore)) return false;
    return true;
  });

  const hasFieldFilter = Boolean(account || supplier || minAmount || maxAmount || minScore);

  return (
    <>
      <Crumbs
        items={[
          { label: 'Kundöversikt', href: '/' },
          { label: detail.run.periodKey, href: `/runs/${closeRunId}` },
          { label: 'Review-kö' },
        ]}
      />

      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1>Review-kö</h1>
          <div className="sub">
            {detail.client?.name} · {detail.run.periodKey} · {findings.length} av {all.length} poster
          </div>
        </div>
        <div className="spacer" />
        <div className="faint row" style={{ gap: 6 }}>
          <span className="kbd">j</span>
          <span className="kbd">k</span>
          flytta
          <span className="kbd">Enter</span>
          öppna
        </div>
      </div>

      <Panel title="Filter">
        <div className="chips" style={{ marginBottom: 14 }}>
          {QUICK_FILTERS.map((filter) => (
            <Link
              key={filter.key}
              className="chip"
              data-active={filter.key === active}
              href={`/runs/${closeRunId}/queue?filter=${filter.key}`}
            >
              {filter.label}
              <span className="n">{all.filter(filter.match).length}</span>
            </Link>
          ))}
        </div>

        <form className="fields" method="get">
          <input type="hidden" name="filter" value={active} />
          <div className="field">
            <label htmlFor="account">Konto</label>
            <input id="account" type="number" name="account" defaultValue={account ?? ''} placeholder="5410" />
          </div>
          <div className="field">
            <label htmlFor="supplierNumber">Leverantör</label>
            <input
              id="supplierNumber"
              type="text"
              name="supplierNumber"
              defaultValue={supplier ?? ''}
              placeholder="L001"
            />
          </div>
          <div className="field">
            <label htmlFor="minAmount">Belopp från (kr)</label>
            <input id="minAmount" type="number" name="minAmount" defaultValue={minAmount ?? ''} />
          </div>
          <div className="field">
            <label htmlFor="maxAmount">Belopp till (kr)</label>
            <input id="maxAmount" type="number" name="maxAmount" defaultValue={maxAmount ?? ''} />
          </div>
          <div className="field">
            <label htmlFor="minDecisionScore">Score minst</label>
            <input
              id="minDecisionScore"
              type="number"
              step="0.05"
              min="0"
              max="1"
              name="minDecisionScore"
              defaultValue={minScore ?? ''}
            />
          </div>
          <button className="btn" type="submit">
            Tillämpa
          </button>
          {hasFieldFilter ? (
            <Link className="btn" href={`/runs/${closeRunId}/queue?filter=${active}`}>
              Rensa
            </Link>
          ) : null}
        </form>
      </Panel>

      <Panel padded={false}>
        {findings.length === 0 ? (
          <Empty title="Inga poster matchar filtret">
            Prova ett bredare filter, eller{' '}
            <Link href={`/runs/${closeRunId}/queue`}>visa alla {all.length} poster</Link>.
          </Empty>
        ) : (
          <QueueTable findings={findings} />
        )}
      </Panel>
    </>
  );
}
