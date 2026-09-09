import type { ReactNode } from 'react';

/**
 * Presentational primitives for the review console.
 *
 * One rule runs through all of them: state is never carried by colour alone.
 * Every badge pairs its colour with a word, every meter prints its number, and
 * every severity stripe sits next to text that says the same thing.
 */

export type Tone = 'clear' | 'automatic' | 'review' | 'manual' | 'neutral';

const DECISION_LABEL: Record<string, string> = {
  automatic: 'Automatisk',
  review: 'Review',
  manual_assessment: 'Manuell bedömning',
};

const DECISION_TONE: Record<string, Tone> = {
  automatic: 'automatic',
  review: 'review',
  manual_assessment: 'manual',
};

const SEVERITY_LABEL: Record<string, string> = {
  info: 'Info',
  low: 'Låg',
  medium: 'Medel',
  high: 'Hög',
  critical: 'Kritisk',
};

const SEVERITY_TONE: Record<string, Tone> = {
  info: 'neutral',
  low: 'neutral',
  medium: 'review',
  high: 'manual',
  critical: 'manual',
};

const STATUS_LABEL: Record<string, string> = {
  // workflow steps
  completed: 'Klart',
  running: 'Pågår',
  pending: 'Väntar',
  blocked: 'Blockerat',
  failed: 'Fel',
  not_implemented: 'Ej implementerat',
  skipped: 'Överhoppat',
  // close runs
  awaiting_review: 'Väntar på granskning',
  // findings
  open: 'Öppen',
  in_review: 'Under granskning',
  approved: 'Godkänd',
  rejected: 'Avvisad',
  information_requested: 'Underlag begärt',
  resolved: 'Åtgärdad',
  superseded: 'Ersatt',
  // proposals
  simulated: 'Simulerad',
  approved_shadow: 'Godkänd — ej bokförd',
  submitting: 'Bokförs',
  submitted: 'Bokförd i Fortnox',
  submission_failed: 'Bokföring misslyckades',
  already_booked: 'Redan bokförd',
};

const STATUS_TONE: Record<string, Tone> = {
  completed: 'clear',
  running: 'automatic',
  pending: 'neutral',
  blocked: 'manual',
  failed: 'manual',
  not_implemented: 'review',
  skipped: 'neutral',
  awaiting_review: 'review',
  open: 'review',
  in_review: 'automatic',
  approved: 'clear',
  rejected: 'neutral',
  information_requested: 'automatic',
  resolved: 'clear',
  superseded: 'neutral',
  simulated: 'automatic',
  approved_shadow: 'clear',
  submitting: 'automatic',
  submitted: 'clear',
  submission_failed: 'manual',
  already_booked: 'neutral',
};

export function decisionTone(level: string): Tone {
  return DECISION_TONE[level] ?? 'neutral';
}

export function severityTone(severity: string): Tone {
  return SEVERITY_TONE[severity] ?? 'neutral';
}

export function DecisionBadge({ level }: { level: string }) {
  return (
    <span className="badge" data-tone={decisionTone(level)}>
      {DECISION_LABEL[level] ?? level}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className="badge" data-tone={severityTone(severity)}>
      {SEVERITY_LABEL[severity] ?? severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="badge" data-tone={STATUS_TONE[status] ?? 'neutral'}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/**
 * The decision score as a segmented gauge.
 *
 * Five segments rather than a continuous bar: a consultant comparing two rows
 * needs to see "3 of 5" at a glance, and a smooth bar makes 0.58 and 0.64 look
 * identical. The exact number is always printed beside it.
 */
export function Meter({ value, tone = 'neutral' }: { value: number; tone?: Tone }) {
  const filled = Math.max(0, Math.min(5, Math.round(value * 5)));
  return (
    <span className="meter" title={`Decision score ${value.toFixed(2)} av 1,00`}>
      <span className="meter-track" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} className={i < filled ? 'on' : ''} data-tone={tone} />
        ))}
      </span>
      {value.toFixed(2)}
    </span>
  );
}

export function Panel({
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
    <section className="panel">
      {title ? (
        <header>
          <h2>{title}</h2>
          {actions ? <div style={{ marginLeft: 'auto' }}>{actions}</div> : null}
        </header>
      ) : null}
      {padded ? <div className="panel-body">{children}</div> : children}
    </section>
  );
}

export function Tile({
  value,
  label,
  note,
  tone,
}: {
  value: ReactNode;
  label: string;
  note?: string;
  tone?: Tone;
}) {
  return (
    <div className="tile" {...(tone ? { 'data-tone': tone } : {})}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
      {note ? <div className="tile-note">{note}</div> : null}
    </div>
  );
}

export interface MixSlice {
  readonly key: Exclude<Tone, 'neutral'>;
  readonly label: string;
  readonly count: number;
}

/**
 * The decision mix: one stacked bar over mutually exclusive buckets.
 *
 * "Blocking" is deliberately NOT a segment here. A blocking finding is also a
 * review or manual one, so including it would double-count the period. It is
 * reported as its own figure instead.
 */
export function DecisionMix({ slices }: { slices: readonly MixSlice[] }) {
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) {
    return <div className="faint">Inga poster att fördela ännu.</div>;
  }

  return (
    <div>
      <div
        className="mix"
        role="img"
        aria-label={slices.map((s) => `${s.label}: ${s.count}`).join('. ')}
      >
        {slices
          .filter((s) => s.count > 0)
          .map((s) => {
            const share = s.count / total;
            return (
              <div
                key={s.key}
                className="mix-seg"
                data-k={s.key}
                style={{ flexGrow: s.count, flexBasis: 0 }}
                title={`${s.label}: ${s.count} (${Math.round(share * 100)} %)`}
              >
                {/* Direct label, but only where the segment can hold it. */}
                {share > 0.11 ? s.count : null}
              </div>
            );
          })}
      </div>
      <div className="mix-legend">
        {slices.map((s) => (
          <span className="mix-key" key={s.key}>
            <span className="swatch" style={{ background: `var(--${s.key})` }} aria-hidden="true" />
            {s.label}
            <span className="n">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Crumbs({ items }: { items: readonly { label: string; href?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Brödsmulor">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} style={{ display: 'contents' }}>
          {index > 0 ? (
            <span className="sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {item.href ? (
            <a href={item.href}>{item.label}</a>
          ) : (
            <span className="here">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}
