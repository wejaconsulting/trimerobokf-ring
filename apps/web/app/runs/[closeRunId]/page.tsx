import Link from 'next/link';
import { api } from '../../../lib/api';
import { Crumbs, Panel, StatusBadge, Tile, statusLabel } from '../../ui';

export const dynamic = 'force-dynamic';

/**
 * Period view: the 14 workflow steps as a spine.
 *
 * The numbering is real - these steps run in this order - so 01–14 encodes
 * something the reader needs rather than decorating the list. Unimplemented
 * steps are shown rather than hidden: the point of the state machine is that a
 * consultant can see what the system did *not* do.
 */
export default async function PeriodPage({ params }: { params: Promise<{ closeRunId: string }> }) {
  const { closeRunId } = await params;
  const detail = await api.closeRun(closeRunId);
  const { run, client, summary, steps } = detail;

  const notImplementedBlocking = steps.filter((s) => !s.implemented && s.blocksCompletion).length;

  return (
    <>
      <Crumbs
        items={[
          { label: 'Kundöversikt', href: '/' },
          { label: client?.name ?? run.clientId },
          { label: run.periodKey },
        ]}
      />

      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1>
            {client?.name ?? run.clientId} · {run.periodKey}
          </h1>
          <div className="sub">
            Regelverk <span className="mono">{run.ruleSetVersion}</span> · beslutsmodell{' '}
            <span className="mono">{run.decisionModelVersion}</span>
          </div>
        </div>
        <div className="spacer" />
        <div className="row">
          <StatusBadge status={summary.status} />
          <Link className="btn btn-primary" href={`/runs/${run.id}/queue`}>
            Öppna review-kö
          </Link>
        </div>
      </div>

      <div className="split">
        <Panel title="Processteg" padded={false}>
          <ol className="spine">
            {steps.map((step) => (
              <li key={step.stepKey} className="step" data-status={step.status}>
                <div className="step-gutter">
                  <div className="step-node">{String(step.order).padStart(2, '0')}</div>
                </div>
                <div>
                  <div className="step-name">{step.labelSv}</div>
                  <div className="step-msg">{step.message ?? step.descriptionSv}</div>
                  {!step.implemented && step.blocksCompletion ? (
                    <div className="step-flag">
                      <span aria-hidden="true">▲</span>
                      Bär verkligt bokföringsarbete — blockerar att perioden rapporteras komplett.
                    </div>
                  ) : null}
                </div>
                <div>
                  <StatusBadge status={step.status} />
                </div>
              </li>
            ))}
          </ol>
        </Panel>

        <div className="stack sticky-side">
          <Panel title="Sammanfattning" padded={false}>
            <div className="tiles">
              <Tile value={summary.clearItemCount} label="Klart" tone="clear" />
              <Tile value={summary.reviewCount} label="Review" tone="review" />
              <Tile value={summary.manualCount} label="Manuell" tone="manual" />
              <Tile
                value={summary.blockingFindingCount}
                label="Blockerande"
                tone={summary.blockingFindingCount > 0 ? 'manual' : 'clear'}
              />
            </div>
          </Panel>

          <Panel title={summary.canComplete ? 'Slutkontroll' : `Hinder (${summary.reasons.length})`}>
            {summary.canComplete ? (
              <div className="note" data-tone="clear">
                Alla blockerande kontroller är avklarade. Perioden kan rapporteras som komplett.
              </div>
            ) : (
              <>
                <ul className="plain" style={{ fontSize: 13 }}>
                  {summary.reasons.map((reason) => (
                    <li key={reason} className="muted">
                      {reason}
                    </li>
                  ))}
                </ul>
                {notImplementedBlocking > 0 ? (
                  <div className="note" data-tone="review" style={{ marginTop: 12 }}>
                    {notImplementedBlocking} av hindren är processteg som den här fasen inte
                    implementerar. De måste hanteras manuellt i Fortnox tills vidare — se{' '}
                    <code className="inline">docs/next-phases.md</code>.
                  </div>
                ) : null}
              </>
            )}
          </Panel>

          <Panel title="Körning">
            <dl className="dl">
              <dt>Close run</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>
                {run.id}
              </dd>
              <dt>Correlation</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>
                {run.correlationId}
              </dd>
              <dt>Shadow mode</dt>
              <dd>{run.shadowMode ? 'Ja — inget skickas till Fortnox' : 'Nej'}</dd>
              <dt>Status</dt>
              <dd>{statusLabel(summary.status)}</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}
