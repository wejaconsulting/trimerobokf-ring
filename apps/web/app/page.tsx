import Link from 'next/link';
import { api, type ClientOverview } from '../lib/api';
import { startCloseRun } from './actions';
import { DecisionMix, Empty, Panel, StatusBadge, Tile, type MixSlice } from './ui';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  let clients: ClientOverview[];
  try {
    clients = await api.clients();
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Kundöversikt</h1>
            <div className="sub">Löpande redovisning och månadsavstämning mot Fortnox</div>
          </div>
        </div>
        <Panel>
          <div className="note" data-tone="manual">
            <strong>Kunde inte nå API:t.</strong> Starta backend med{' '}
            <code className="inline">pnpm dev:api</code> och ladda om sidan.
            <div className="faint" style={{ marginTop: 6 }}>
              {error instanceof Error ? error.message : String(error)}
            </div>
          </div>
        </Panel>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kundöversikt</h1>
          <div className="sub">Löpande redovisning och månadsavstämning mot Fortnox</div>
        </div>
      </div>

      {clients.length === 0 ? (
        <Panel>
          <Empty title="Inga klienter är seedade">
            Kör <code className="inline">pnpm db:seed</code> och ladda om sidan.
          </Empty>
        </Panel>
      ) : null}

      <div className="stack">
        {clients.map((entry) => (
          <ClientCard key={entry.client.id} entry={entry} />
        ))}
      </div>
    </>
  );
}

function ClientCard({ entry }: { entry: ClientOverview }) {
  const { client, latestRun, summary } = entry;

  if (!latestRun || !summary) {
    return (
      <Panel title={`${client.name} · ${client.organisationNumber}`}>
        <Empty title="Ingen avstämning har körts">
          <form action={startCloseRun} className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <input type="hidden" name="clientId" value={client.id} />
            <input type="text" name="periodKey" defaultValue="2025-08" aria-label="Period" style={{ width: 104 }} />
            <button className="btn btn-primary" type="submit">
              Kör avstämning
            </button>
          </form>
        </Empty>
      </Panel>
    );
  }

  const automatic = Math.max(0, summary.findingCount - summary.reviewCount - summary.manualCount);

  // Mutually exclusive buckets. "Blockerande" is not one of them - a blocking
  // finding is also a review or manual one - so it is reported separately.
  const slices: MixSlice[] = [
    { key: 'clear', label: 'Klart utan anmärkning', count: summary.clearItemCount },
    { key: 'automatic', label: 'Automatisk', count: automatic },
    { key: 'review', label: 'Review', count: summary.reviewCount },
    { key: 'manual', label: 'Manuell bedömning', count: summary.manualCount },
  ];

  const needsHuman = summary.reviewCount + summary.manualCount;
  const total = slices.reduce((sum, s) => sum + s.count, 0);

  return (
    <Panel
      title={`${client.name} · ${client.organisationNumber}`}
      actions={
        <form action={startCloseRun} className="row">
          <input type="hidden" name="clientId" value={client.id} />
          <input
            type="text"
            name="periodKey"
            defaultValue={latestRun.periodKey}
            aria-label="Period att stämma av"
            style={{ width: 96, minWidth: 0 }}
            className="mono"
          />
          <button className="btn btn-primary btn-sm" type="submit">
            Kör avstämning
          </button>
        </form>
      }
      padded={false}
    >
      <div className="panel-body" style={{ paddingBottom: 4 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <StatusBadge status={summary.status} />
          <span className="faint">
            Period <span className="mono">{latestRun.periodKey}</span> · {summary.completedSteps ?? 0} av{' '}
            {summary.totalSteps ?? 14} steg klara
          </span>
        </div>

        <h3>Beslutsmix · {total} poster</h3>
        <DecisionMix slices={slices} />

        <p className="muted" style={{ fontSize: 13, marginTop: 14, marginBottom: 0, maxWidth: '68ch' }}>
          {needsHuman === 0
            ? 'Ingen post kräver en konsult i den här perioden.'
            : `${needsHuman} av ${total} poster kräver en konsult. Resten passerade samtliga kontroller utan anmärkning.`}
        </p>
      </div>

      <div className="tiles" style={{ borderTop: '1px solid var(--rule)' }}>
        <Tile value={summary.clearItemCount} label="Klart" tone="clear" />
        <Tile value={summary.reviewCount} label="Review" tone="review" />
        <Tile value={summary.manualCount} label="Manuell bedömning" tone="manual" />
        <Tile value={summary.missingDocumentationCount ?? 0} label="Saknar underlag" />
        <Tile value={summary.findingCount} label="Avvikelser totalt" />
        <Tile
          value={summary.blockingFindingCount}
          label="Blockerande"
          tone={summary.blockingFindingCount > 0 ? 'manual' : 'clear'}
          note={summary.blockingFindingCount > 0 ? 'Hindrar att perioden stängs' : 'Inga hinder'}
        />
      </div>

      <div className="panel-body">
        {summary.canComplete ? (
          <div className="note" data-tone="clear">
            Alla blockerande kontroller är avklarade. Perioden kan rapporteras som komplett.
          </div>
        ) : (
          <div className="note" data-tone="review">
            <strong>Perioden kan inte rapporteras som komplett.</strong>
            <ul className="plain" style={{ marginTop: 6 }}>
              {summary.reasons.slice(0, 3).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {summary.reasons.length > 3 ? (
              <div style={{ marginTop: 6 }}>
                <Link href={`/runs/${latestRun.id}`}>
                  Visa alla {summary.reasons.length} hinder i periodvyn
                </Link>
              </div>
            ) : null}
          </div>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <Link className="btn" href={`/runs/${latestRun.id}`}>
            Periodvy
          </Link>
          <Link className="btn btn-primary" href={`/runs/${latestRun.id}/queue`}>
            Öppna review-kö
          </Link>
        </div>
      </div>
    </Panel>
  );
}
