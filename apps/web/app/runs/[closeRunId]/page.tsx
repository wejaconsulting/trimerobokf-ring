import Link from 'next/link';
import { api } from '../../../lib/api';
import { submitProposals } from '../../actions';
import { Crumbs, Panel, StatusBadge, Tile, statusLabel } from '../../ui';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  mock: 'Demodata (mock-adapter)',
  real: 'Fortnox',
  none: 'Ingen datakälla',
};

/**
 * Period view: the 14 workflow steps as a spine.
 *
 * The numbering is real - these steps run in this order - so 01–14 encodes
 * something the reader needs rather than decorating the list. Unimplemented
 * steps are shown rather than hidden: the point of the state machine is that a
 * consultant can see what the system did *not* do.
 */
export default async function PeriodPage({
  params,
  searchParams,
}: {
  params: Promise<{ closeRunId: string }>;
  searchParams: Promise<{ submitted?: string; blocked?: string; failed?: string; live?: string }>;
}) {
  const { closeRunId } = await params;
  const query = await searchParams;
  const detail = await api.closeRun(closeRunId);
  const { run, client, summary, steps, proposalCounts } = detail;

  const notImplementedBlocking = steps.filter((s) => !s.implemented && s.blocksCompletion).length;
  const approved = proposalCounts.approved_shadow ?? 0;
  const submitted = proposalCounts.submitted ?? 0;
  const alreadyBooked = proposalCounts.already_booked ?? 0;
  const failed = proposalCounts.submission_failed ?? 0;
  const proposalTotal = Object.values(proposalCounts).reduce((a, b) => a + b, 0);

  return (
    <>
      <Crumbs
        items={[
          { label: 'Byråöversikt', href: '/' },
          { label: client?.name ?? run.clientId, href: `/klienter/${encodeURIComponent(run.clientId)}` },
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

      {query.submitted !== undefined ? (
        <div
          className="note"
          data-tone={Number(query.submitted) > 0 ? 'clear' : Number(query.failed ?? 0) > 0 ? 'manual' : 'review'}
          style={{ marginBottom: 16 }}
          role="status"
        >
          {query.live === '1' ? (
            <>
              <strong>{query.submitted} förslag bokförda i Fortnox.</strong> {query.blocked} stoppade av skrivgrinden
              {Number(query.failed ?? 0) > 0 ? `, ${query.failed} misslyckade` : ''}. Varje förslag prövades individuellt.
            </>
          ) : (
            <>
              <strong>Ingenting skickades.</strong> {query.blocked} godkända förslag stoppades av skrivgrinden — shadow mode
              eller skrivflaggan är av. Orsakerna per förslag finns i auditloggen.
            </>
          )}
        </div>
      ) : null}

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

          <Panel title={`Bokföringsförslag (${proposalTotal})`}>
            <dl className="dl">
              <dt>Godkända, ej bokförda</dt>
              <dd>{approved}</dd>
              <dt>Bokförda i Fortnox</dt>
              <dd>{submitted}</dd>
              {alreadyBooked > 0 ? (
                <>
                  <dt>Redan bokförda tidigare</dt>
                  <dd>{alreadyBooked}</dd>
                </>
              ) : null}
              {failed > 0 ? (
                <>
                  <dt>Misslyckade</dt>
                  <dd>{failed}</dd>
                </>
              ) : null}
            </dl>
            {approved > 0 ? (
              <form action={submitProposals} style={{ marginTop: 12 }}>
                <input type="hidden" name="closeRunId" value={run.id} />
                <button className="btn btn-primary" type="submit">
                  Bokför godkända förslag
                </button>
                <p className="muted" style={{ fontSize: 12.5, marginBottom: 0, marginTop: 8 }}>
                  {run.shadowMode
                    ? 'Körningen gjordes i shadow mode: knappen prövar grinden och rapporterar varför varje förslag stoppas. Inget skickas.'
                    : 'Varje förslag prövas mot skrivgrindens sju villkor. Bara exakt den payload som godkändes kan bokföras.'}
                </p>
              </form>
            ) : null}
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
              <dt>Datakälla</dt>
              <dd>
                {run.dataSource === 'real' ? (
                  <strong>Fortnox · {run.dataSourceLabel ?? ''}</strong>
                ) : (
                  (SOURCE_LABEL[run.dataSource] ?? run.dataSource)
                )}
              </dd>
              <dt>Close run</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>
                {run.id}
              </dd>
              <dt>Correlation</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>
                {run.correlationId}
              </dd>
              <dt>Shadow mode</dt>
              <dd>{run.shadowMode ? 'Ja — inget skickas till Fortnox' : 'Nej — skrivgrinden avgör per förslag'}</dd>
              <dt>Status</dt>
              <dd>{statusLabel(summary.status)}</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}
