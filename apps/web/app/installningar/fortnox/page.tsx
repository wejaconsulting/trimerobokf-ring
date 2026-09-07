import Link from 'next/link';
import { connectFortnox, disconnectFortnox, verifyFortnox } from '../../actions';
import { api, type FortnoxConnection, type FortnoxIntegrationStatus } from '../../../lib/api';
import { Crumbs, Panel } from '../../ui';

export const dynamic = 'force-dynamic';

/**
 * The Fortnox connection page.
 *
 * Written for the person who owns the accounting system, not for the developer
 * who deployed this. That shapes three choices:
 *
 *  - It states what access is requested and what the system will never do,
 *    before the button, not after. Consent that follows a click is not consent.
 *  - It reports what the running system is configured to do, never what this
 *    page assumes. A connection that cannot be verified says so.
 *  - It is explicit that connecting does not yet change the analysis. The
 *    plumbing is finished; the read paths that would use it are not.
 */

/** Plain-language descriptions of each scope on the Fortnox consent screen. */
const SCOPE_LABELS: Record<string, string> = {
  companyinformation: 'Företagsuppgifter — namn och organisationsnummer',
  bookkeeping: 'Bokföring — verifikationer, konton och verifikationsserier',
  invoice: 'Kundfakturor',
  supplierinvoice: 'Leverantörsfakturor',
  customer: 'Kundregister',
  supplier: 'Leverantörsregister',
  payment: 'Betalningar kopplade till fakturor',
  costcenter: 'Kostnadsställen',
};

const STATUS_LABELS: Record<FortnoxConnection['status'], string> = {
  connected: 'Ansluten',
  disconnected: 'Inte ansluten',
  needs_reconnect: 'Behöver anslutas igen',
};

/** Callback outcomes, translated. The codes come from our own API. */
const CALLBACK_MESSAGES: Record<string, string> = {
  connected: 'Anslutningen är klar och verifierad mot Fortnox.',
  connected_unverified:
    'Fortnox godkände anslutningen, men kontrollanropet gick inte igenom. Anslutningen finns — men den är inte bekräftad.',
  error: 'Anslutningen slutfördes inte.',
};

const ERROR_HINTS: Record<string, string> = {
  access_denied: 'Inloggningen avbröts, eller så nekades behörigheten i Fortnox.',
  invalid_state:
    'Länken var förbrukad eller äldre än tio minuter. Starta anslutningen igen från den här sidan.',
  missing_code_or_state: 'Fortnox svarade utan de uppgifter som behövs. Försök igen.',
  invalid_grant: 'Fortnox godtog inte koden. Starta om anslutningen.',
  invalid_client:
    'Fortnox känner inte igen applikationens uppgifter. Client-ID eller Client-Secret är fel.',
  token_request_timeout: 'Fortnox svarade inte i tid. Försök igen om en stund.',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });
}

function daysUntil(value: string | null): number | null {
  if (!value) return null;
  return Math.round((new Date(value).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export default async function FortnoxSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; status?: string; code?: string }>;
}) {
  const params = await searchParams;
  const clients = await api.clients().catch(() => []);
  const clientId = params.clientId ?? clients[0]?.client.id ?? '';

  let status: FortnoxIntegrationStatus | null = null;
  let loadError: string | null = null;
  if (clientId) {
    try {
      status = await api.fortnoxStatus(clientId);
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Okänt fel';
    }
  }

  const connection = status?.connection ?? null;
  const client = clients.find((c) => c.client.id === clientId);
  const refreshDays = daysUntil(connection?.refreshTokenExpiresAt ?? null);

  return (
    <>
      <Crumbs items={[{ label: 'Kundöversikt', href: '/' }, { label: 'Fortnox-anslutning' }]} />

      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1>Fortnox-anslutning</h1>
          <div className="sub">
            {client ? client.client.name : 'Ingen klient vald'} · anslutningen ger{' '}
            <strong>endast läsbehörighet</strong>
          </div>
        </div>
      </div>

      {params.status ? (
        <div
          className="note"
          data-tone={params.status === 'connected' ? 'clear' : params.status === 'error' ? 'manual' : 'review'}
          style={{ marginBottom: 16 }}
          role="status"
        >
          {CALLBACK_MESSAGES[params.status] ?? 'Anslutningen returnerade ett okänt svar.'}
          {params.code ? (
            <>
              {' '}
              {ERROR_HINTS[params.code] ?? null}{' '}
              <span className="muted">
                (teknisk kod: <code className="inline">{params.code}</code>)
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="split">
        <div className="stack">
          {loadError ? (
            <Panel title="Kunde inte läsa status">
              <div className="note" data-tone="manual">
                API:et svarade inte: <code className="inline">{loadError}</code>
              </div>
            </Panel>
          ) : null}

          {status && !status.configured ? (
            <Panel title="Inte färdigkonfigurerad än">
              <p style={{ marginTop: 0 }}>
                Applikationen är inte registrerad hos Fortnox ännu, så det går inte att ansluta.
                Det här är ett steg för den som driftsätter systemet — inte för dig som ska logga
                in.
              </p>
              <p className="muted" style={{ fontSize: 13 }}>
                Följande saknas i miljön:{' '}
                {(status.missing ?? []).map((name, index) => (
                  <span key={name}>
                    {index > 0 ? ', ' : ''}
                    <code className="inline">{name}</code>
                  </span>
                ))}
                . Se <code className="inline">docs/fortnox-oauth.md</code>.
              </p>
            </Panel>
          ) : null}

          <Panel title="Behörigheter som efterfrågas">
            <p style={{ marginTop: 0 }}>
              När du loggar in visar Fortnox en godkännandesida. Det här är vad den kommer att
              gälla — allt är läsning:
            </p>
            <ul className="plain" style={{ fontSize: 13.5 }}>
              {(status?.requestedScopes ?? Object.keys(SCOPE_LABELS)).map((scope) => (
                <li key={scope}>
                  <span className="mono">{scope}</span> — {SCOPE_LABELS[scope] ?? 'läsbehörighet'}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Vad systemet gör och inte gör">
            <div className="note" data-tone="clear" style={{ marginBottom: 12 }}>
              <strong>Systemet får:</strong> läsa bokföring och underlag, analysera perioden, skapa
              bokföringsförslag och visa exakt vilket anrop som <em>skulle</em> skickas.
            </div>
            <div className="note" data-tone="manual">
              <strong>Systemet får inte:</strong> bokföra i Fortnox, ändra eller ta bort något,
              låsa perioder eller skicka mejl till dina kunder. Ingen skrivbehörighet begärs, och
              skrivning är dessutom avstängd i koden
              {status?.shadowMode ? ' (shadow mode är aktivt)' : ''}.
            </div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
              Du kan när som helst koppla från här, eller återkalla behörigheten inne i Fortnox.
            </p>
          </Panel>

          <Panel title="Vad som händer efter att du anslutit">
            <p style={{ marginTop: 0, marginBottom: 0 }}>
              Den här versionen kopplar upp och verifierar anslutningen, men analysen körs
              fortfarande på demodata. Inläsningen av din riktiga bokföring är nästa steg — se{' '}
              <code className="inline">docs/next-phases.md</code>. Anslutningen är alltså
              förberedd och testad, inte påslagen i arbetsflödet.
            </p>
          </Panel>
        </div>

        <div className="stack sticky-side">
          <Panel title="Status">
            {connection ? (
              <>
                <dl className="dl">
                  <dt>Status</dt>
                  <dd>
                    <strong>{STATUS_LABELS[connection.status]}</strong>
                    {connection.status === 'connected' && !connection.healthy
                      ? ' (obekräftad)'
                      : ''}
                  </dd>
                  {connection.companyName ? (
                    <>
                      <dt>Företag i Fortnox</dt>
                      <dd>{connection.companyName}</dd>
                    </>
                  ) : null}
                  {connection.organisationNumber ? (
                    <>
                      <dt>Org.nr</dt>
                      <dd className="mono">{connection.organisationNumber}</dd>
                    </>
                  ) : null}
                  {connection.connectedAt ? (
                    <>
                      <dt>Ansluten sedan</dt>
                      <dd>{formatDate(connection.connectedAt)}</dd>
                    </>
                  ) : null}
                  {connection.lastCheckedAt ? (
                    <>
                      <dt>Senast kontrollerad</dt>
                      <dd>{formatDate(connection.lastCheckedAt)}</dd>
                    </>
                  ) : null}
                  <dt>Skrivbehörighet</dt>
                  <dd>{connection.writesEnabled ? 'Ja' : 'Nej — avstängt'}</dd>
                </dl>

                {connection.statusCode ? (
                  <div className="note" data-tone="review" style={{ marginTop: 12 }}>
                    Senaste kontrollen gav{' '}
                    <code className="inline">{connection.statusCode}</code>.
                  </div>
                ) : null}

                {refreshDays !== null && refreshDays < 10 && connection.status === 'connected' ? (
                  <div className="note" data-tone="review" style={{ marginTop: 12 }}>
                    Behörigheten behöver förnyas inom {Math.max(refreshDays, 0)} dagar om systemet
                    inte används under tiden.
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {clientId ? 'Ingen anslutning ännu.' : 'Välj en klient först.'}
              </p>
            )}
          </Panel>

          {status?.configured && clientId ? (
            <Panel title="Åtgärder">
              <div className="stack" style={{ gap: 10 }}>
                {connection?.status === 'connected' ? (
                  <>
                    <form action={verifyFortnox}>
                      <input type="hidden" name="clientId" value={clientId} />
                      <button className="btn" type="submit">
                        Kontrollera anslutningen
                      </button>
                    </form>
                    <form action={disconnectFortnox}>
                      <input type="hidden" name="clientId" value={clientId} />
                      <button className="btn" type="submit">
                        Koppla från
                      </button>
                    </form>
                  </>
                ) : (
                  <form action={connectFortnox}>
                    <input type="hidden" name="clientId" value={clientId} />
                    <button className="btn btn-primary" type="submit">
                      {connection?.status === 'needs_reconnect'
                        ? 'Anslut igen till Fortnox'
                        : 'Anslut till Fortnox'}
                    </button>
                  </form>
                )}
              </div>
              <p className="muted" style={{ fontSize: 12.5, marginBottom: 0, marginTop: 12 }}>
                Knappen skickar dig till Fortnox inloggning. Länken är giltig i tio minuter.
              </p>
            </Panel>
          ) : null}

          {status?.redirectUri ? (
            <Panel title="Teknisk information">
              <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
                Den här adressen måste vara registrerad som <em>redirect URI</em> på
                Fortnox-applikationen, tecken för tecken. Skiljer den sig ens på ett snedstreck
                avbryter Fortnox inloggningen.
              </p>
              <code className="inline" style={{ wordBreak: 'break-all', fontSize: 12 }}>
                {status.redirectUri}
              </code>
            </Panel>
          ) : null}

          {clients.length > 1 ? (
            <Panel title="Klient">
              <div className="stack" style={{ gap: 6 }}>
                {clients.map(({ client: c }) => (
                  <Link
                    key={c.id}
                    href={`/installningar/fortnox?clientId=${encodeURIComponent(c.id)}`}
                    className="side-client"
                    {...(c.id === clientId ? { 'aria-current': 'page' as const } : {})}
                  >
                    <div className="side-client-name">{c.name}</div>
                  </Link>
                ))}
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
