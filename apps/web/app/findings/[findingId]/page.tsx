import Link from 'next/link';
import { api, formatSek, type ProposalDetail } from '../../../lib/api';
import { submitDecision } from '../../actions';
import { Card, DecisionBadge, Score, SeverityBadge, StatusBadge } from '../../ui';

export const dynamic = 'force-dynamic';

/**
 * Finding detail.
 *
 * Everything the consultant needs to decide without leaving the page: what was
 * detected, why the system reacted, which rules matched, the proposed booking
 * with its debit/credit rows, the exact Fortnox payload that *would* be sent,
 * and the audit history.
 */
export default async function FindingPage({ params }: { params: Promise<{ findingId: string }> }) {
  const { findingId } = await params;
  const detail = await api.finding(findingId);
  const { finding, run, matchedRules, proposals, decisions, auditHistory } = detail;

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">Kundöversikt</Link> /{' '}
        <Link href={`/runs/${finding.closeRunId}`}>{run?.periodKey ?? 'Period'}</Link> /{' '}
        <Link href={`/runs/${finding.closeRunId}/queue`}>Review-kö</Link> / Avvikelse
      </div>

      <div className="page-head">
        <div>
          <h1>{finding.description}</h1>
          <div className="sub">
            <span className="mono">{finding.type}</span> · {formatSek(finding.amount)}
          </div>
        </div>
        <div className="spacer" />
        <div className="btn-row">
          <SeverityBadge severity={finding.severity} />
          <DecisionBadge level={finding.decisionLevel} />
          <StatusBadge status={finding.status} />
          {finding.blocking ? <span className="badge badge-danger">Blockerande</span> : null}
        </div>
      </div>

      <div className="grid-2">
        <div>
          <Card title="Vad som upptäckts">
            <dl className="dl">
              <dt>Beskrivning</dt>
              <dd>{finding.description}</dd>
              <dt>Belopp</dt>
              <dd>{formatSek(finding.amount)}</dd>
              <dt>Konto</dt>
              <dd>{finding.subject.accountNumber ?? <span className="faint">—</span>}</dd>
              <dt>Leverantör</dt>
              <dd>{finding.subject.supplierNumber ?? <span className="faint">—</span>}</dd>
              <dt>Verifikation</dt>
              <dd className="mono">{finding.subject.voucherId ?? '—'}</dd>
              <dt>Kräver konsult</dt>
              <dd>{finding.requiresConsultant ? 'Ja' : 'Nej'}</dd>
            </dl>
          </Card>

          <Card title="Varför systemet reagerade">
            <p style={{ margin: '0 0 12px', whiteSpace: 'pre-line' }}>{finding.rationale}</p>
            <h3>Beslutsunderlag</h3>
            <div style={{ marginBottom: 10 }}>
              <Score value={finding.decisionScore} />{' '}
              <span className="faint">
                decision score — beräknad från observerbara signaler, inte från modellens egen
                självskattning
              </span>
            </div>
            <ul className="plain">
              {finding.decisionReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Card>

          <Card title={`Matchade regler (${matchedRules.length})`}>
            {matchedRules.length === 0 ? (
              <div className="faint">Inga regler kunde slås upp.</div>
            ) : (
              matchedRules.map((rule) => (
                <div key={rule.id} style={{ marginBottom: 12 }}>
                  <div>
                    <strong>{rule.titleSv}</strong>{' '}
                    <span className={`badge ${rule.kind === 'validation' ? 'badge-danger' : 'badge-info'}`}>
                      {rule.kind === 'validation' ? 'Validering' : 'Avvikelseregel'}
                    </span>
                  </div>
                  <div className="rule-explain">{rule.explanation}</div>
                  <div className="faint mono">{rule.version}</div>
                </div>
              ))
            )}
            {finding.occurrences > 1 ? (
              <div className="note" style={{ marginTop: 8 }}>
                {finding.occurrences} kontroller reagerade på samma underliggande problem och har
                slagits ihop till en post.
              </div>
            ) : null}
          </Card>

          <Card title="Underlag och evidens">
            {finding.evidence.length === 0 ? (
              <div className="faint">Inga evidensreferenser.</div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Typ</th>
                      <th>Referens</th>
                      <th>Etikett</th>
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
          </Card>

          {proposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}

          <Card title="Audit history" padded={false}>
            <div className="card-body">
              {auditHistory.length === 0 ? (
                <div className="faint">Inga händelser.</div>
              ) : (
                auditHistory
                  .slice()
                  .reverse()
                  .slice(0, 25)
                  .map((event) => (
                    <div className="audit-line" key={event.id}>
                      <div className="faint mono">{new Date(event.occurredAt).toLocaleString('sv-SE')}</div>
                      <div>
                        <span className="mono">{event.operation}</span>{' '}
                        <span
                          className={`badge ${
                            event.result === 'ok'
                              ? 'badge-ok'
                              : event.result === 'simulated'
                                ? 'badge-info'
                                : event.result === 'blocked'
                                  ? 'badge-warn'
                                  : 'badge-danger'
                          }`}
                        >
                          {event.result}
                        </span>{' '}
                        <span className="faint">
                          {event.actorKind}:{event.actorId}
                          {event.modelProvider ? ` · modell ${event.modelProvider}` : ''}
                          {event.promptVersion ? ` · prompt ${event.promptVersion}` : ''}
                          {event.fortnoxId ? ` · Fortnox-ID ${event.fortnoxId}` : ''}
                        </span>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </Card>
        </div>

        <div>
          <Card title="Föreslagen åtgärd">
            <p style={{ margin: 0 }}>{finding.suggestedAction}</p>
          </Card>

          <Card title="Beslut">
            <div className="note" style={{ marginBottom: 12 }}>
              Beslut här ändrar endast intern review-status. Ingenting skrivs till Fortnox.
            </div>
            <form action={submitDecision}>
              <input type="hidden" name="findingId" value={finding.id} />
              <input type="hidden" name="decidedByUserId" value="user-anna-consultant" />

              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="comment">Kommentar</label>
                <textarea id="comment" name="comment" rows={3} placeholder="Valfri motivering…" />
              </div>

              {proposals.length > 0 ? (
                <div className="field" style={{ marginBottom: 12 }}>
                  <label htmlFor="editedRows">Redigerat förslag (JSON)</label>
                  <textarea
                    id="editedRows"
                    name="editedRows"
                    rows={6}
                    defaultValue={JSON.stringify(proposals[0]?.rows ?? [], null, 2)}
                  />
                  <span className="faint">
                    Används endast vid &ldquo;Redigera förslag&rdquo;. Sparas i beslutsloggen.
                  </span>
                </div>
              ) : null}

              <div className="btn-row">
                <button className="btn btn-primary" type="submit" name="kind" value="approve">
                  Godkänn
                </button>
                <button className="btn btn-danger" type="submit" name="kind" value="reject">
                  Avvisa
                </button>
                <button className="btn" type="submit" name="kind" value="edit_proposal">
                  Redigera förslag
                </button>
                <button className="btn" type="submit" name="kind" value="request_information">
                  Begär underlag
                </button>
              </div>
            </form>
          </Card>

          <Card title={`Beslutshistorik (${decisions.length})`}>
            {decisions.length === 0 ? (
              <div className="faint">Inga beslut har fattats ännu.</div>
            ) : (
              decisions.map((decision) => (
                <div key={decision.id} style={{ marginBottom: 10 }}>
                  <div>
                    <strong>{decision.kind}</strong>{' '}
                    {decision.shadowOnly ? <span className="badge badge-info">shadow only</span> : null}
                  </div>
                  <div className="faint">
                    {decision.decidedByUserId} · {new Date(decision.createdAt).toLocaleString('sv-SE')}
                  </div>
                  {decision.comment ? <div className="muted">{decision.comment}</div> : null}
                </div>
              ))
            )}
          </Card>

          <Card title="Spårbarhet">
            <dl className="dl">
              <dt>Regel</dt>
              <dd className="mono">{finding.ruleId}</dd>
              <dt>Regelversion</dt>
              <dd className="mono">{finding.ruleVersion}</dd>
              <dt>Regelverk</dt>
              <dd className="mono">{run?.ruleSetVersion ?? '—'}</dd>
              <dt>Dedup-nyckel</dt>
              <dd className="mono" style={{ wordBreak: 'break-all' }}>
                {(finding as { deduplicationKey?: string }).deduplicationKey ?? '—'}
              </dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalDetail }) {
  const debit = proposal.rows.reduce((a, r) => a + r.debit, 0);
  const credit = proposal.rows.reduce((a, r) => a + r.credit, 0);

  return (
    <Card title="Bokföringsförslag" padded={false}>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <DecisionBadge level={proposal.decisionLevel} />
          <Score value={proposal.decisionScore} />
          <span className="badge badge-info">{proposal.status}</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {proposal.rationale}
        </p>
        <dl className="dl" style={{ marginBottom: 12 }}>
          <dt>Serie</dt>
          <dd className="mono">{proposal.series}</dd>
          <dt>Bokföringsdatum</dt>
          <dd className="mono">{proposal.transactionDate}</dd>
        </dl>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Konto</th>
              <th>Beskrivning</th>
              <th>Kostnadsställe</th>
              <th>Projekt</th>
              <th>Momskod</th>
              <th className="num">Debet</th>
              <th className="num">Kredit</th>
            </tr>
          </thead>
          <tbody>
            {proposal.rows.map((row) => (
              <tr key={row.id}>
                <td className="mono">{row.account}</td>
                <td>{row.description}</td>
                <td>{row.costCenter ?? <span className="faint">—</span>}</td>
                <td>{row.project ?? <span className="faint">—</span>}</td>
                <td>{row.vatCode ?? <span className="faint">—</span>}</td>
                <td className="num">{row.debit ? formatSek(row.debit) : ''}</td>
                <td className="num">{row.credit ? formatSek(row.credit) : ''}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} style={{ fontWeight: 600 }}>
                Summa {debit === credit ? '(balanserar)' : '(BALANSERAR INTE)'}
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

      <div className="card-body">
        <h3>Simulerat Fortnox-anrop</h3>
        <div className="note warn" style={{ marginBottom: 10 }}>
          Detta är exakt det anrop som <em>skulle</em> skickas. I shadow mode skickas det aldrig.
          Payload-hash <code className="inline">{proposal.simulatedPayloadHash}</code> binder ett
          framtida mänskligt godkännande till exakt dessa bytes.
        </div>
        <div className="mono" style={{ marginBottom: 8 }}>
          {proposal.simulatedFortnoxEndpoint}
        </div>
        <pre className="payload">{JSON.stringify(proposal.simulatedFortnoxPayload, null, 2)}</pre>
      </div>
    </Card>
  );
}
