import Link from 'next/link';
import { api, formatSek, type ProposalDetail } from '../../../lib/api';
import { submitDecision } from '../../actions';
import {
  Crumbs,
  DecisionBadge,
  Meter,
  Panel,
  SeverityBadge,
  StatusBadge,
  decisionTone,
} from '../../ui';

export const dynamic = 'force-dynamic';

/**
 * Finding detail.
 *
 * Laid out as a chain rather than a grid of cards, because the consultant is
 * following an argument: what was detected → why the system reacted → which
 * rules matched → what the evidence is → what we propose → exactly what would
 * be sent. The decision panel stays in view throughout, so acting never
 * requires scrolling back.
 */
export default async function FindingPage({ params }: { params: Promise<{ findingId: string }> }) {
  const { findingId } = await params;
  const detail = await api.finding(findingId);
  const { finding, run, matchedRules, proposals, decisions, auditHistory } = detail;
  const decided = finding.status !== 'open' && finding.status !== 'in_review';

  return (
    <>
      <Crumbs
        items={[
          { label: 'Kundöversikt', href: '/' },
          { label: run?.periodKey ?? 'Period', href: `/runs/${finding.closeRunId}` },
          { label: 'Review-kö', href: `/runs/${finding.closeRunId}/queue` },
          { label: finding.description },
        ]}
      />

      <div className="page-head" style={{ marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h1>{finding.description}</h1>
          <div className="sub row" style={{ gap: 10 }}>
            <span className="mono">{finding.type}</span>
            <span aria-hidden="true">·</span>
            <span className="mono">{formatSek(finding.amount)}</span>
          </div>
        </div>
        <div className="spacer" />
        <div className="row">
          <SeverityBadge severity={finding.severity} />
          <DecisionBadge level={finding.decisionLevel} />
          <StatusBadge status={finding.status} />
          {finding.blocking ? (
            <span className="badge" data-tone="manual">
              Blockerande
            </span>
          ) : null}
        </div>
      </div>

      <div className="split">
        <Panel padded={false}>
          <div className="panel-body">
            <div className="chain">
              {/* 1 — the observation */}
              <div className="chain-item">
                <div className="chain-mark">
                  <div className="chain-dot">1</div>
                </div>
                <div>
                  <div className="chain-title">Vad som upptäcktes</div>
                  <dl className="dl">
                    <dt>Belopp</dt>
                    <dd className="mono">{formatSek(finding.amount)}</dd>
                    <dt>Konto</dt>
                    <dd className="mono">{finding.subject.accountNumber ?? '—'}</dd>
                    <dt>Leverantör</dt>
                    <dd className="mono">{finding.subject.supplierNumber ?? '—'}</dd>
                    <dt>Verifikation</dt>
                    <dd className="mono">{finding.subject.voucherId ?? '—'}</dd>
                  </dl>
                </div>
              </div>

              {/* 2 — the reasoning */}
              <div className="chain-item">
                <div className="chain-mark">
                  <div className="chain-dot">2</div>
                </div>
                <div>
                  <div className="chain-title">Varför systemet reagerade</div>
                  <p style={{ margin: '0 0 12px', whiteSpace: 'pre-line', maxWidth: '72ch' }}>
                    {finding.rationale}
                  </p>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <Meter value={finding.decisionScore} tone={decisionTone(finding.decisionLevel)} />
                    <span className="faint">
                      decision score — beräknad från observerbara signaler, inte från modellens egen
                      självskattning
                    </span>
                  </div>
                  <ul className="plain muted" style={{ fontSize: 12.5 }}>
                    {finding.decisionReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* 3 — the rules */}
              <div className="chain-item">
                <div className="chain-mark">
                  <div className="chain-dot">3</div>
                </div>
                <div>
                  <div className="chain-title">Matchade regler ({matchedRules.length})</div>
                  {matchedRules.length === 0 ? (
                    <div className="faint">Inga regler kunde slås upp.</div>
                  ) : (
                    <div className="stack" style={{ gap: 10 }}>
                      {matchedRules.map((rule) => (
                        <div key={rule.id}>
                          <div className="row" style={{ gap: 8 }}>
                            <strong style={{ fontSize: 13 }}>{rule.titleSv}</strong>
                            <span
                              className="badge"
                              data-tone={rule.kind === 'validation' ? 'manual' : 'automatic'}
                            >
                              {rule.kind === 'validation' ? 'Validering' : 'Avvikelseregel'}
                            </span>
                          </div>
                          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                            {rule.explanation}
                          </div>
                          <div className="faint mono">{rule.version}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {finding.occurrences > 1 ? (
                    <div className="note" data-tone="automatic" style={{ marginTop: 12 }}>
                      {finding.occurrences} kontroller reagerade oberoende av varandra på samma
                      underliggande problem och har slagits ihop till en post.
                    </div>
                  ) : null}
                </div>
              </div>

              {/* 4 — the evidence */}
              <div className="chain-item">
                <div className="chain-mark">
                  <div className="chain-dot">4</div>
                </div>
                <div>
                  <div className="chain-title">Underlag och evidens</div>
                  {finding.evidence.length === 0 ? (
                    <div className="faint">Inga evidensreferenser.</div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Typ</th>
                            <th scope="col">Referens</th>
                            <th scope="col">Etikett</th>
                          </tr>
                        </thead>
                        <tbody>
                          {finding.evidence.map((item) => (
                            <tr key={`${item.kind}:${item.ref}`}>
                              <td className="mono">{item.kind}</td>
                              <td className="mono">{item.ref}</td>
                              <td>{item.label ?? <span className="faint">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* 5 — the proposal */}
              <div className="chain-item">
                <div className="chain-mark">
                  <div className="chain-dot">5</div>
                </div>
                <div>
                  <div className="chain-title">Bokföringsförslag</div>
                  {proposals.length === 0 ? (
                    <div className="faint">
                      Inget automatiskt förslag för den här avvikelsen — den kräver en bedömning.
                    </div>
                  ) : (
                    proposals.map((proposal) => <Proposal key={proposal.id} proposal={proposal} />)
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="panel-body" style={{ borderTop: '1px solid var(--rule)' }}>
            <h3>Audit history</h3>
            <div className="audit">
              {auditHistory.length === 0 ? (
                <div className="faint">Inga händelser.</div>
              ) : (
                auditHistory
                  .slice()
                  .reverse()
                  .map((event) => (
                    <div className="audit-row" key={event.id}>
                      <span className="audit-time">
                        {new Date(event.occurredAt).toLocaleString('sv-SE')}
                      </span>
                      <span>
                        <span className="mono">{event.operation}</span>{' '}
                        <span
                          className="badge no-dot"
                          data-tone={
                            event.result === 'ok'
                              ? 'clear'
                              : event.result === 'simulated'
                                ? 'automatic'
                                : event.result === 'blocked'
                                  ? 'review'
                                  : 'manual'
                          }
                        >
                          {event.result}
                        </span>{' '}
                        <span className="faint">
                          {event.actorKind}:{event.actorId}
                          {event.modelProvider ? ` · modell ${event.modelProvider}` : ''}
                          {event.promptVersion ? ` · prompt ${event.promptVersion}` : ''}
                        </span>
                      </span>
                    </div>
                  ))
              )}
            </div>
          </div>
        </Panel>

        <div className="stack sticky-side">
          <Panel title="Föreslagen åtgärd">
            <p style={{ margin: 0, fontSize: 13 }}>{finding.suggestedAction}</p>
          </Panel>

          <Panel title="Beslut">
            <div className="note" data-tone="automatic" style={{ marginBottom: 12 }}>
              Beslut ändrar endast intern review-status. Ingenting skickas till Fortnox.
            </div>

            {decided ? (
              <div className="note" data-tone="clear" style={{ marginBottom: 12 }}>
                Den här avvikelsen är redan avgjord (<StatusBadge status={finding.status} />). Ett
                nytt beslut ersätter det förra och loggas separat.
              </div>
            ) : null}

            <form action={submitDecision}>
              <input type="hidden" name="findingId" value={finding.id} />
              <input type="hidden" name="decidedByUserId" value="user-anna-consultant" />

              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="comment">Kommentar</label>
                <textarea id="comment" name="comment" rows={3} placeholder="Valfri motivering…" />
              </div>

              {proposals.length > 0 ? (
                <details style={{ marginBottom: 12 }}>
                  <summary
                    style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-secondary)' }}
                  >
                    Redigera förslaget innan du godkänner
                  </summary>
                  <div className="field" style={{ marginTop: 8 }}>
                    <textarea
                      id="editedRows"
                      name="editedRows"
                      rows={7}
                      className="mono"
                      defaultValue={JSON.stringify(proposals[0]?.rows ?? [], null, 2)}
                    />
                    <span className="faint">
                      Används endast vid &ldquo;Redigera förslag&rdquo;. Sparas i beslutsloggen.
                    </span>
                  </div>
                </details>
              ) : null}

              <div className="row">
                <button className="btn btn-primary" type="submit" name="kind" value="approve">
                  Godkänn
                </button>
                <button className="btn btn-danger" type="submit" name="kind" value="reject">
                  Avvisa
                </button>
                {proposals.length > 0 ? (
                  <button className="btn btn-sm" type="submit" name="kind" value="edit_proposal">
                    Redigera förslag
                  </button>
                ) : null}
                <button className="btn btn-sm" type="submit" name="kind" value="request_information">
                  Begär underlag
                </button>
              </div>
            </form>
          </Panel>

          <Panel title={`Beslutshistorik (${decisions.length})`}>
            {decisions.length === 0 ? (
              <div className="faint">Inga beslut har fattats ännu.</div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {decisions.map((decision) => (
                  <div key={decision.id}>
                    <div className="row" style={{ gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>{decision.kind}</strong>
                      {decision.shadowOnly ? (
                        <span className="badge no-dot" data-tone="automatic">
                          shadow only
                        </span>
                      ) : null}
                    </div>
                    <div className="faint">
                      {decision.decidedByUserId} ·{' '}
                      {new Date(decision.createdAt).toLocaleString('sv-SE')}
                    </div>
                    {decision.comment ? (
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {decision.comment}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Spårbarhet">
            <dl className="dl">
              <dt>Regel</dt>
              <dd className="mono">{finding.ruleId}</dd>
              <dt>Regelversion</dt>
              <dd className="mono">{finding.ruleVersion}</dd>
              <dt>Regelverk</dt>
              <dd className="mono">{run?.ruleSetVersion ?? '—'}</dd>
              <dt>Dedup-nyckel</dt>
              <dd className="mono">
                {(finding as { deduplicationKey?: string }).deduplicationKey ?? '—'}
              </dd>
            </dl>
            <div style={{ marginTop: 12 }}>
              <Link href={`/runs/${finding.closeRunId}/queue`}>← Tillbaka till review-kön</Link>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Proposal({ proposal }: { proposal: ProposalDetail }) {
  const debit = proposal.rows.reduce((a, r) => a + r.debit, 0);
  const credit = proposal.rows.reduce((a, r) => a + r.credit, 0);
  const balances = debit === credit;

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <DecisionBadge level={proposal.decisionLevel} />
        <Meter value={proposal.decisionScore} tone={decisionTone(proposal.decisionLevel)} />
        <StatusBadge status={proposal.status} />
      </div>

      <p className="muted" style={{ marginTop: 0, fontSize: 13, maxWidth: '72ch' }}>
        {proposal.rationale}
      </p>

      <div className="table-wrap" style={{ border: '1px solid var(--rule)', borderRadius: 4 }}>
        <table>
          <thead>
            <tr>
              <th scope="col">Konto</th>
              <th scope="col">Beskrivning</th>
              <th scope="col">K-ställe</th>
              <th scope="col">Projekt</th>
              <th scope="col">Momskod</th>
              <th scope="col" className="num">
                Debet
              </th>
              <th scope="col" className="num">
                Kredit
              </th>
            </tr>
          </thead>
          <tbody>
            {proposal.rows.map((row) => (
              <tr key={row.id}>
                <td className="mono">{row.account}</td>
                <td>{row.description}</td>
                <td className="mono">{row.costCenter ?? '—'}</td>
                <td className="mono">{row.project ?? '—'}</td>
                <td className="mono">{row.vatCode ?? '—'}</td>
                <td className="num">{row.debit ? formatSek(row.debit) : ''}</td>
                <td className="num">{row.credit ? formatSek(row.credit) : ''}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} style={{ fontWeight: 600 }}>
                Summa {balances ? '(balanserar)' : '(BALANSERAR INTE)'}
              </td>
              <td className="num" style={{ fontWeight: 600 }}>
                {formatSek(debit)}
              </td>
              <td className="num" style={{ fontWeight: 600 }}>
                {formatSek(credit)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 18 }}>Simulerat Fortnox-anrop</h3>
      <div className="note" data-tone="review" style={{ marginBottom: 10 }}>
        Detta är exakt det anrop som <em>skulle</em> skickas. I shadow mode skickas det aldrig.
        Payload-hashen <code className="inline">{proposal.simulatedPayloadHash}</code> binder ett
        framtida mänskligt godkännande till exakt dessa bytes — ändras en enda byte gäller inte
        godkännandet längre.
      </div>
      <div className="mono" style={{ marginBottom: 8 }}>
        {proposal.simulatedFortnoxEndpoint}
      </div>
      <pre className="payload">{JSON.stringify(proposal.simulatedFortnoxPayload, null, 2)}</pre>
    </div>
  );
}
