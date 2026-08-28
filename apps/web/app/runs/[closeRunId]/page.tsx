import Link from 'next/link';
import { api } from '../../../lib/api';
import { Card, Stat, StatusBadge } from '../../ui';

export const dynamic = 'force-dynamic';

/**
 * Period view: all 14 workflow steps and their status.
 *
 * Unimplemented steps are shown explicitly rather than hidden, because the
 * whole point of the state machine is that the consultant can see what the
 * system did *not* do.
 */
export default async function PeriodPage({ params }: { params: Promise<{ closeRunId: string }> }) {
  const { closeRunId } = await params;
  const detail = await api.closeRun(closeRunId);
  const { run, client, summary, steps } = detail;

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">Kundöversikt</Link> / {client?.name ?? run.clientId} / {run.periodKey}
      </div>

      <div className="page-head">
        <div>
          <h1>
            {client?.name ?? run.clientId} · {run.periodKey}
          </h1>
          <div className="sub">
            Close run <span className="mono">{run.id}</span> · regelverk{' '}
            <span className="mono">{run.ruleSetVersion}</span> · beslutsmodell{' '}
            <span className="mono">{run.decisionModelVersion}</span>
          </div>
        </div>
        <div className="spacer" />
        <div className="btn-row">
          <Link className="btn btn-primary" href={`/runs/${run.id}/queue`}>
            Öppna review-kö
          </Link>
        </div>
      </div>

      <Card padded={false}>
        <div className="stats">
          <Stat value={<StatusBadge status={summary.status} />} label="Status" />
          <Stat value={summary.clearItemCount} label="Klart" tone="ok" />
          <Stat value={summary.reviewCount} label="Review" tone="warn" />
          <Stat value={summary.manualCount} label="Manuell bedömning" tone="warn" />
          <Stat value={summary.findingCount} label="Avvikelser" />
          <Stat
            value={summary.blockingFindingCount}
            label="Blockerande"
            tone={summary.blockingFindingCount > 0 ? 'danger' : 'ok'}
          />
        </div>
      </Card>

      {!summary.canComplete ? (
        <div className="note warn" style={{ marginBottom: 16 }}>
          <strong>Perioden kan inte rapporteras som komplett.</strong>
          <ul className="plain" style={{ marginTop: 6 }}>
            {summary.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="note" style={{ marginBottom: 16 }}>
          Alla blockerande kontroller är avklarade. Perioden kan rapporteras som komplett.
        </div>
      )}

      <Card title="Processteg" padded={false}>
        <ul className="steps">
          {steps.map((step) => (
            <li key={step.stepKey} className={`step${step.implemented ? '' : ' is-notimpl'}`}>
              <div className="idx">{String(step.order).padStart(2, '0')}</div>
              <div>
                <div className="name">{step.labelSv}</div>
                <div className="msg">{step.message ?? step.description}</div>
                {!step.implemented && step.blocksCompletion ? (
                  <div className="msg" style={{ color: 'var(--warn)' }}>
                    Bär verkligt bokföringsarbete — blockerar att perioden rapporteras som komplett.
                  </div>
                ) : null}
              </div>
              <div>
                <StatusBadge status={step.status} />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
