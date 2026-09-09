import Link from 'next/link';
import { api, type ClientOverview, type FirmOverview } from '../lib/api';
import { createClient, runAllClients, startCloseRun } from './actions';
import { DecisionMix, Empty, Panel, StatusBadge, Tile, type MixSlice } from './ui';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  mock: 'demodata',
  real: 'Fortnox',
  none: 'ingen datakälla',
};

function defaultPeriod(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ ranAll?: string; clients?: string; failed?: string }>;
}) {
  const params = await searchParams;
  let clients: ClientOverview[];
  let overview: FirmOverview | null;
  try {
    [clients, overview] = await Promise.all([api.clients(), api.firmOverview().catch((): FirmOverview | null => null)]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Byråöversikt</h1>
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

  const latestPeriod = clients.map((c) => c.latestRun?.periodKey).filter(Boolean).sort().at(-1) ?? defaultPeriod();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Byråöversikt</h1>
          <div className="sub">Löpande redovisning och månadsavstämning mot Fortnox · {clients.length} klienter</div>
        </div>
        <div className="spacer" />
        <form action={runAllClients} className="row">
          <input
            type="text"
            name="periodKey"
            defaultValue={latestPeriod}
            aria-label="Period att köra för alla klienter"
            className="mono"
            style={{ width: 96, minWidth: 0 }}
          />
          <button className="btn btn-primary" type="submit" disabled={clients.length === 0}>
            Kör alla klienter
          </button>
        </form>
      </div>

      {params.ranAll ? (
        <div className="note" data-tone={Number(params.failed ?? 0) > 0 ? 'review' : 'clear'} style={{ marginBottom: 16 }} role="status">
          Period <span className="mono">{params.ranAll}</span> kördes för {params.clients} klient(er)
          {Number(params.failed ?? 0) > 0 ? `, ${params.failed} misslyckades — se respektive klient.` : '.'}
        </div>
      ) : null}

      {overview ? <FirmPanel overview={overview} /> : null}

      {clients.length === 0 ? (
        <Panel>
          <Empty title="Inga klienter ännu">
            Lägg till byråns första klient nedan, eller kör <code className="inline">pnpm db:seed</code> för demodata.
          </Empty>
        </Panel>
      ) : null}

      <div className="stack">
        {clients.map((entry) => (
          <ClientCard key={entry.client.id} entry={entry} />
        ))}

        <Panel title="Lägg till klient">
          <form action={createClient} className="fields">
            <label className="field">
              <span>Företagsnamn</span>
              <input type="text" name="name" required placeholder="Exempel Bygg AB" />
            </label>
            <label className="field">
              <span>Organisationsnummer</span>
              <input type="text" name="organisationNumber" required placeholder="556123-4567" className="mono" pattern="\d{6}-?\d{4}" />
            </label>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <span aria-hidden="true">&nbsp;</span>
              <button className="btn" type="submit">
                Lägg till
              </button>
            </div>
          </form>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Klienten får byråns standardpolicy och ingen datakälla. Nästa steg är att ansluta dess Fortnox under{' '}
            <Link href="/installningar/fortnox">Fortnox-anslutning</Link>.
          </p>
        </Panel>
      </div>
    </>
  );
}

/**
 * The number the firm actually cares about: how much of the work needed no one.
 * Computed by the API from the latest run of every client, never estimated here.
 */
function FirmPanel({ overview }: { overview: FirmOverview }) {
  const pct = Math.round(overview.automationRate * 100);
  const sources = Object.entries(overview.dataSources)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${SOURCE_LABEL[k] ?? k}`)
    .join(' · ');
  return (
    <Panel title="Automationsgrad" padded={false}>
      <div className="tiles">
        <Tile
          value={overview.items.total === 0 ? '—' : `${pct} %`}
          label="Utan mänsklig hantering"
          tone={pct >= 70 ? 'clear' : pct >= 40 ? 'review' : 'manual'}
          note={`${overview.items.clear + overview.items.automatic} av ${overview.items.total} poster`}
        />
        <Tile value={overview.items.review + overview.items.manual} label="Kräver konsult" tone="review" />
        <Tile value={overview.blockingFindings} label="Blockerande" tone={overview.blockingFindings > 0 ? 'manual' : 'clear'} />
        <Tile value={overview.proposals.approved} label="Godkända förslag" note="väntar på bokföring" />
        <Tile
          value={overview.proposals.submitted}
          label="Bokförda i Fortnox"
          tone={overview.proposals.submitted > 0 ? 'clear' : undefined}
          note={overview.liveBooking ? 'live-bokföring på' : overview.shadowMode ? 'shadow mode' : 'skrivning av'}
        />
      </div>
      <div className="panel-body" style={{ paddingTop: 10 }}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {overview.runsCounted} av {overview.clientCount} klienter har en körning
          {sources ? ` (datakälla: ${sources})` : ''}.{' '}
          {overview.shadowMode
            ? 'Systemet analyserar och föreslår; ingenting skickas till Fortnox.'
            : overview.liveBooking
              ? 'Live-bokföring är aktiv: godkända förslag bokförs via skrivgrinden.'
              : 'Shadow mode är av men skrivflaggan är inte satt: ingenting bokförs.'}
        </p>
      </div>
    </Panel>
  );
}

function ClientCard({ entry }: { entry: ClientOverview }) {
  const { client, latestRun, summary } = entry;
  const title = `${client.name} · ${client.organisationNumber}`;
  const settings = (
    <Link className="btn btn-sm" href={`/klienter/${encodeURIComponent(client.id)}`}>
      Inställningar
    </Link>
  );

  if (!latestRun || !summary) {
    return (
      <Panel title={title} actions={settings}>
        <Empty title="Ingen avstämning har körts">
          <form action={startCloseRun} className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <input type="hidden" name="clientId" value={client.id} />
            <input type="text" name="periodKey" defaultValue={defaultPeriod()} aria-label="Period" style={{ width: 104 }} className="mono" />
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
      title={title}
      actions={
        <div className="row">
          {settings}
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
        </div>
      }
      padded={false}
    >
      <div className="panel-body" style={{ paddingBottom: 4 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <StatusBadge status={summary.status} />
          <span className="faint">
            Period <span className="mono">{latestRun.periodKey}</span> · {summary.completedSteps ?? 0} av{' '}
            {summary.totalSteps ?? 14} steg klara · datakälla{' '}
            {latestRun.dataSource === 'real' ? (
              <strong>{latestRun.dataSourceLabel ?? 'Fortnox'}</strong>
            ) : (
              SOURCE_LABEL[latestRun.dataSource] ?? latestRun.dataSource
            )}
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
                <Link href={`/runs/${latestRun.id}`}>Visa alla {summary.reasons.length} hinder i periodvyn</Link>
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
