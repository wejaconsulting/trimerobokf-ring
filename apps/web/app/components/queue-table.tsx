'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatSek, type FindingListItem } from '../../lib/api';
import { DecisionBadge, Meter, SeverityBadge, StatusBadge, decisionTone } from '../ui';

/**
 * The review queue table.
 *
 * A consultant works this list for an hour at a time, so it is keyboard-first:
 * j/k move, Enter opens, Escape clears. The whole row is a click target, but
 * each row still holds a real link so the keyboard, middle-click and "open in
 * new tab" all keep working.
 */
export function QueueTable({ findings }: { findings: readonly FindingListItem[] }) {
  const router = useRouter();
  const [cursor, setCursor] = useState<number>(-1);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const open = useCallback(
    (index: number) => {
      const finding = findings[index];
      if (finding) router.push(`/findings/${finding.id}`);
    },
    [findings, router],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((c) => Math.min(findings.length - 1, c + 1));
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (event.key === 'Enter' && cursor >= 0) {
        event.preventDefault();
        open(cursor);
      } else if (event.key === 'Escape') {
        setCursor(-1);
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, findings.length, open]);

  useEffect(() => {
    if (cursor >= 0) rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="table-wrap">
      <table className="queue">
        <caption className="sr-only" style={{ position: 'absolute', left: -9999 }}>
          Avvikelser i review-kön. Använd j och k för att flytta, Enter för att öppna.
        </caption>
        <thead>
          <tr>
            <th scope="col">Avvikelse</th>
            <th scope="col">Konto / Leverantör</th>
            <th scope="col" className="num">
              Belopp
            </th>
            <th scope="col">Allvarlighet</th>
            <th scope="col">Beslut &amp; score</th>
            <th scope="col">Status</th>
            <th scope="col">Förslag</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding, index) => {
            const decided = finding.status !== 'open' && finding.status !== 'in_review';
            return (
              <tr
                key={finding.id}
                ref={(el) => {
                  rowRefs.current[index] = el;
                }}
                data-sev={finding.severity}
                className={`rowlink${decided ? ' is-decided' : ''}`}
                onClick={() => open(index)}
                style={
                  cursor === index
                    ? { background: 'var(--accent-wash)', outline: '1px solid var(--accent)' }
                    : undefined
                }
              >
                <td>
                  <a
                    href={`/findings/${finding.id}`}
                    className="cell-title"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {finding.description}
                  </a>
                  <span className="cell-sub" title={finding.type}>
                    {finding.type}
                    {finding.blocking ? ' · blockerande' : ''}
                  </span>
                </td>
                <td className="mono">
                  {finding.subject.accountNumber ?? '—'}
                  {finding.subject.supplierNumber ? ` · ${finding.subject.supplierNumber}` : ''}
                </td>
                <td className="num">{formatSek(finding.amount)}</td>
                <td>
                  <SeverityBadge severity={finding.severity} />
                </td>
                <td>
                  <DecisionBadge level={finding.decisionLevel} />
                  <div style={{ marginTop: 4 }}>
                    <Meter
                      value={finding.decisionScore}
                      tone={decisionTone(finding.decisionLevel)}
                    />
                  </div>
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
          })}
        </tbody>
      </table>
    </div>
  );
}
