import Link from 'next/link';
import { api } from '../lib/api';
import { startCloseRun } from './actions';
import { Card, Stat, StatusBadge } from './ui';

export const dynamic = 'force-dynamic';

/**
 * Client overview.
 *
 * One row per client with the counters a consultant triages on: how far the
 * close run got, and how much of it needs a human.
 */
export default async function OverviewPage() {
  let clients;
  try {
    clients = await api.clients();
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Kundöversikt</h1>
            <div className="sub">Löpande redovisning och månadsavstämning</div>
          </div>
        </div>
        <div className="note danger">
          Kunde inte nå API:t. Starta backend med <code className="inline">pnpm dev:api</code> och ladda om.
          <div className="faint" style={{ marginTop: 6 }}>
            {error instanceof Error ? error.message : String(error)}
          </div>
        </div>
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
        <Card>
          <div className="empty">
            Inga klienter är seedade. Kör <code className="inline">pnpm db:seed</code>.
          </div>
        </Card>
      ) : null}

      {clients.map(({ client, latestRun, summary }) => (
        <Card
          key={client.id}
          title={`${client.name} · ${client.organisationNumber}`}
          actions={
            <form action={startCloseRun} className="btn-row">
              <input type="hidden" name="clientId" value={client.id} />
              <input
                type="text"
                name="periodKey"
                defaultValue={latestRun?.periodKey ?? '2025-08'}
                aria-label="Period"
                style={{ minWidth: 96 }}
              />
              <button className="btn btn-primary" type="submit">
                Kör avstämning
              </button>
            </form>
          }
          padded={false}
        >
          {latestRun && summary ? (
            <>
              <div className="stats">
                <Stat value={latestRun.periodKey} label="Period" />
                <Stat value={<StatusBadge status={summary.status} />} label="Close run" />
                <Stat
                  value={`${summary.completedSteps ?? 0}/${summary.totalSteps ?? 14}`}
                  label="Klara steg"
                />
                <Stat value={summary.clearItemCount} label="Klart (automatiskt)" tone="ok" />
                <Stat value={summary.reviewCount} label="Review" tone="warn" />
                <Stat value={summary.manualCount} label="Manuell bedömning" tone="warn" />
                <Stat
                  value={summary.missingDocumentationCount ?? 0}
                  label="Saknar underlag"
                  tone="warn"
                />
                <Stat value={summary.findingCount} label="Avvikelser" />
                <Stat
                  value={summary.blockingFindingCount}
                  label="Blockerande"
                  tone={summary.blockingFindingCount > 0 ? 'danger' : 'ok'}
                />
              </div>
              <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }} className="btn-row">
                <Link className="btn" href={`/runs/${latestRun.id}`}>
                  Periodvy
                </Link>
                <Link className="btn" href={`/runs/${latestRun.id}/queue`}>
                  Review-kö
                </Link>
                <span className="faint">
                  {summary.canComplete
                    ? 'Perioden kan rapporteras som komplett.'
                    : `Perioden är inte komplett: ${summary.reasons.length} hinder.`}
                </span>
              </div>
            </>
          ) : (
            <div className="empty">Ingen avstämning har körts för den här klienten ännu.</div>
          )}
        </Card>
      ))}
    </>
  );
}
