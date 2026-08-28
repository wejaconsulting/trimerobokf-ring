import type { ReactNode } from 'react';

/** Small presentational helpers shared across the review views. */

const DECISION_LABELS: Record<string, string> = {
  automatic: 'Automatisk',
  review: 'Review',
  manual_assessment: 'Manuell bedömning',
};

const DECISION_CLASS: Record<string, string> = {
  automatic: 'badge-ok',
  review: 'badge-warn',
  manual_assessment: 'badge-danger',
};

const SEVERITY_CLASS: Record<string, string> = {
  info: 'badge-neutral',
  low: 'badge-neutral',
  medium: 'badge-warn',
  high: 'badge-danger',
  critical: 'badge-danger',
};

const STATUS_CLASS: Record<string, string> = {
  completed: 'badge-ok',
  running: 'badge-info',
  pending: 'badge-neutral',
  blocked: 'badge-danger',
  failed: 'badge-danger',
  not_implemented: 'badge-warn',
  skipped: 'badge-neutral',
  awaiting_review: 'badge-warn',
  open: 'badge-warn',
  in_review: 'badge-info',
  approved: 'badge-ok',
  rejected: 'badge-neutral',
  information_requested: 'badge-info',
  resolved: 'badge-ok',
};

const STATUS_LABELS: Record<string, string> = {
  completed: 'Klart',
  running: 'Pågår',
  pending: 'Väntar',
  blocked: 'Blockerat',
  failed: 'Fel',
  not_implemented: 'Ej implementerat',
  skipped: 'Överhoppat',
  awaiting_review: 'Väntar på granskning',
  open: 'Öppen',
  in_review: 'Under granskning',
  approved: 'Godkänd',
  rejected: 'Avvisad',
  information_requested: 'Underlag begärt',
  resolved: 'Åtgärdad',
};

export function DecisionBadge({ level }: { level: string }) {
  return (
    <span className={`badge ${DECISION_CLASS[level] ?? 'badge-neutral'}`}>
      {DECISION_LABELS[level] ?? level}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge ${SEVERITY_CLASS[severity] ?? 'badge-neutral'}`}>{severity}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? 'badge-neutral'}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** The decision score, shown as a bar so it reads at a glance in a long queue. */
export function Score({ value }: { value: number }) {
  return (
    <span className="score">
      <span className="score-bar">
        <span style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      {value.toFixed(2)}
    </span>
  );
}

export function Stat({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  padded = true,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="card">
      {title ? (
        <header>
          <h2>{title}</h2>
          {actions ? <div style={{ marginLeft: 'auto' }}>{actions}</div> : null}
        </header>
      ) : null}
      {padded ? <div className="card-body">{children}</div> : children}
    </section>
  );
}
