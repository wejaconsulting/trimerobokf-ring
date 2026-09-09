import Link from 'next/link';
import { api, formatSek, type ClientPolicy, type ClientRule } from '../../../lib/api';
import { updatePolicy } from '../../actions';
import { Crumbs, Panel } from '../../ui';

export const dynamic = 'force-dynamic';

/**
 * Client settings: the policy that turns the generic engine into "how this
 * client is handled", and the one switch that lets the system approve on its
 * own.
 *
 * Every amount is shown and entered in kronor; the API stores öre. The page
 * says in plain words what `autoBookEnabled` does and does not do, because
 * the person reading it is deciding how much to trust the system with.
 */

const RULE_LABELS: Record<string, string> = {
  supplier_account_mapping: 'Leverantör → konto',
  recurring_cost: 'Återkommande kostnad',
  vat_code_for_account: 'Momskod per konto',
  dimension_requirement: 'Krav på kostnadsställe',
  ignore_account: 'Ignorera konto',
};

function kr(ore: number): string {
  return (ore / 100).toLocaleString('sv-SE', { maximumFractionDigits: 2, useGrouping: false });
}

export default async function ClientSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ saved?: string; created?: string }>;
}) {
  const { clientId } = await params;
  const query = await searchParams;
  const [clients, status] = await Promise.all([api.clients(), api.systemStatus().catch(() => null)]);
  const entry = clients.find((c) => c.client.id === clientId);
  const loaded = await api.policy(clientId).catch((): { policy: ClientPolicy; rules: ClientRule[] } | null => null);
  const policy: ClientPolicy | null = loaded?.policy ?? null;
  const rules: ClientRule[] = loaded?.rules ?? [];

  const fortnox = await api.fortnoxStatus(clientId).catch(() => null);
  const connection = fortnox?.connection ?? null;

  return (
    <>
      <Crumbs items={[{ label: 'Byråöversikt', href: '/' }, { label: entry?.client.name ?? clientId }, { label: 'Inställningar' }]} />

      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1>{entry?.client.name ?? clientId}</h1>
          <div className="sub">
            {entry ? (
              <>
                Org.nr <span className="mono">{entry.client.organisationNumber}</span>
              </>
            ) : (
              'Okänd klient'
            )}
          </div>
        </div>
      </div>

      {query.created ? (
        <div className="note" data-tone="clear" style={{ marginBottom: 16 }} role="status">
          Klienten är tillagd med byråns standardpolicy. Anslut dess Fortnox nedan innan första körningen.
        </div>
      ) : null}
      {query.saved ? (
        <div className="note" data-tone="clear" style={{ marginBottom: 16 }} role="status">
          Policyn är sparad och ändringen är loggad. Den gäller från nästa körning.
        </div>
      ) : null}

      <div className="split">
        <div className="stack">
          {policy ? (
            <Panel title="Redovisningspolicy">
              <form action={updatePolicy}>
                <input type="hidden" name="clientId" value={clientId} />
                <div className="fields">
                  <label className="field">
                    <span>Väsentlighetsgräns (kr)</span>
                    <input type="text" name="materialityThreshold" defaultValue={kr(policy.materialityThreshold)} className="mono" inputMode="decimal" />
                    <small className="muted">Belopp på eller över gränsen går alltid till manuell bedömning.</small>
                  </label>
                  <label className="field">
                    <span>Gräns för automatisk hantering (kr)</span>
                    <input type="text" name="automationAmountLimit" defaultValue={kr(policy.automationAmountLimit)} className="mono" inputMode="decimal" />
                    <small className="muted">Över detta belopp får systemet aldrig hantera en post automatiskt.</small>
                  </label>
                  <label className="field">
                    <span>Historikfönster (månader)</span>
                    <input type="number" name="historyWindowMonths" min={1} max={36} defaultValue={policy.historyWindowMonths} className="mono" />
                  </label>
                  <label className="field">
                    <span>Avvikelsetröskel för belopp</span>
                    <input type="text" name="amountDeviationThreshold" defaultValue={String(policy.amountDeviationThreshold)} className="mono" inputMode="decimal" />
                    <small className="muted">0,5 = 50 % avvikelse från leverantörens historiska belopp räknas som ovanligt.</small>
                  </label>
                  <label className="field">
                    <span>Konton som kräver kostnadsställe</span>
                    <input type="text" name="costCenterRequiredAccounts" defaultValue={policy.costCenterRequiredAccounts.join(', ')} className="mono" placeholder="5010, 5410" />
                  </label>
                  <label className="field">
                    <span>Konton som kräver projekt</span>
                    <input type="text" name="projectRequiredAccounts" defaultValue={policy.projectRequiredAccounts.join(', ')} className="mono" />
                  </label>
                </div>

                <div className="stack" style={{ gap: 10, marginTop: 14 }}>
                  <label className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <input type="checkbox" name="requireDocumentationForInputVat" defaultChecked={policy.requireDocumentationForInputVat} style={{ marginTop: 4 }} />
                    <span>
                      <strong>Kräv underlag för ingående moms.</strong>{' '}
                      <span className="muted">Ingående moms föreslås aldrig utan kopplat underlag.</span>
                    </span>
                  </label>
                  <label className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <input type="checkbox" name="autoBookEnabled" defaultChecked={policy.autoBookEnabled} style={{ marginTop: 4 }} />
                    <span>
                      <strong>Låt systemet godkänna förslag på nivån Automatisk själv.</strong>{' '}
                      <span className="muted">
                        Gäller bara förslag som passerat samtliga hårda grindar (deterministisk regel, alla valideringar,
                        underlag finns, öppen period, inom beloppsgränsen, ingen motstridig avvikelse) och fått score ≥ 0,85.
                        Godkännandet binds till förslagets exakta payload och loggas med systemet som aktör. Om det sedan{' '}
                        <em>bokförs</em> avgörs av skrivgrinden: shadow mode av, skrivflaggan på, och klientens egen
                        skrivbrytare på.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="row" style={{ marginTop: 16 }}>
                  <button className="btn btn-primary" type="submit">
                    Spara policy
                  </button>
                  <span className="faint">Senast ändrad {new Date(policy.updatedAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>
              </form>
            </Panel>
          ) : (
            <Panel title="Redovisningspolicy">
              <div className="note" data-tone="manual">Klienten saknar policy. Kontakta den som driftsätter systemet.</div>
            </Panel>
          )}

          <Panel title={`Klientregler (${rules.length})`}>
            {rules.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Inga klientspecifika regler ännu. Regler är deterministiska och tolkas aldrig av en språkmodell.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Regel</th>
                      <th>Konfiguration</th>
                      <th>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={rule.id}>
                        <td>{RULE_LABELS[rule.kind] ?? rule.kind}</td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {Object.entries(rule.config)
                            .map(([k, v]) => `${k}=${String(v)}`)
                            .join(' · ')}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {rule.version}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="stack sticky-side">
          <Panel title="Datakälla">
            <dl className="dl">
              <dt>Fortnox</dt>
              <dd>
                {connection?.status === 'connected'
                  ? `Ansluten${connection.companyName ? ` · ${connection.companyName}` : ''}`
                  : connection?.status === 'needs_reconnect'
                    ? 'Behöver återanslutas'
                    : 'Inte ansluten'}
              </dd>
              <dt>Adapterläge</dt>
              <dd className="mono">{status?.fortnoxAdapter ?? '—'}</dd>
              <dt>Senaste körning</dt>
              <dd>
                {entry?.latestRun
                  ? `${entry.latestRun.periodKey} · ${entry.latestRun.dataSource === 'real' ? 'Fortnox' : entry.latestRun.dataSource === 'mock' ? 'demodata' : 'ingen datakälla'}`
                  : 'ingen'}
              </dd>
              <dt>Skrivning per klient</dt>
              <dd>{connection?.writesEnabled ? 'På' : 'Av'}</dd>
            </dl>
            <div className="row" style={{ marginTop: 12 }}>
              <Link className="btn" href={`/installningar/fortnox?clientId=${encodeURIComponent(clientId)}`}>
                Fortnox-anslutning
              </Link>
            </div>
          </Panel>

          {policy ? (
            <Panel title="Så läser du gränserna">
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                En post under {formatSek(policy.automationAmountLimit)} som matchar en deterministisk regel och har underlag kan
                hanteras automatiskt. Mellan gränsen och {formatSek(policy.materialityThreshold)} hamnar den i review. På eller
                över väsentlighetsgränsen krävs alltid manuell bedömning.
              </p>
              <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
                Språkmodellens egen säkerhet ingår aldrig i beslutet — se <code className="inline">docs/accounting-decision-model.md</code>.
              </p>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
