import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { api, type ClientOverview, type SystemStatus } from '../lib/api';
import { SideNav, type NavItem } from './components/side-nav';
import { ThemeToggle } from './components/theme-toggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trimeros Accounting Agent',
  description: 'Granskningskonsol för löpande redovisning och månadsavstämning mot Fortnox.',
};

/**
 * Applies the stored theme before first paint.
 *
 * Without this the page renders in the system theme and then flips, which on a
 * dark-mode machine is a white flash straight into the reader's eyes.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem('trimeros-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
`;

async function loadShell(): Promise<{
  status: SystemStatus | null;
  clients: ClientOverview[];
  reachable: boolean;
}> {
  try {
    const [status, clients] = await Promise.all([api.systemStatus(), api.clients()]);
    return { status, clients, reachable: true };
  } catch {
    return { status: null, clients: [], reachable: false };
  }
}

/**
 * The shadow-mode notice lives in the app chrome, not on a page.
 *
 * It reports what the running system is configured to do - read from the API,
 * never assumed - so it is true on every screen rather than on the one screen
 * that remembered to render it.
 */
function ShadowNotice({ status, reachable }: { status: SystemStatus | null; reachable: boolean }) {
  if (!reachable || !status) {
    return (
      <div className="shadow-chip is-alarm">
        <span className="dot" aria-hidden="true" />
        <span>
          <strong>API:t svarar inte</strong>
          Starta backend med <code style={{ fontSize: 11 }}>pnpm dev:api</code>.
        </span>
      </div>
    );
  }

  if (status.shadowMode && !status.fortnoxWritesEnabled) {
    return (
      <div className="shadow-chip">
        <span className="dot" aria-hidden="true" />
        <span>
          <strong>SHADOW MODE</strong>
          Inga Fortnox-anrop skickas. Adapter: {status.fortnoxAdapter}, modell: {status.modelProvider}.
        </span>
      </div>
    );
  }

  return (
    <div className="shadow-chip is-alarm">
      <span className="dot" aria-hidden="true" />
      <span>
        <strong>VARNING</strong>
        Skrivning mot Fortnox är aktiverad.
      </span>
    </div>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { status, clients, reachable } = await loadShell();
  const primary = clients[0];
  const run = primary?.latestRun;
  const summary = primary?.summary;

  const nav: NavItem[] = [
    { href: '/', label: 'Kundöversikt', exact: true },
    ...(run
      ? [
          { href: `/runs/${run.id}`, label: 'Periodvy' },
          {
            href: `/runs/${run.id}/queue`,
            label: 'Review-kö',
            count: summary?.findingCount ?? null,
          },
        ]
      : []),
  ];

  return (
    <html lang="sv" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600;700&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Hoppa till innehållet
        </a>

        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-mark" aria-hidden="true">
                TA
              </div>
              <div>
                <div className="brand-name">Trimeros</div>
                <div className="brand-tagline">Granska undantagen — inte allt</div>
              </div>
            </div>

            <div className="side-section">
              <div className="side-label">Navigering</div>
              <SideNav items={nav} />
            </div>

            {clients.length > 0 ? (
              <div className="side-section">
                <div className="side-label">Klienter</div>
                {clients.map(({ client, latestRun, summary: s }) => (
                  <Link
                    key={client.id}
                    href={latestRun ? `/runs/${latestRun.id}` : '/'}
                    className="side-client"
                  >
                    <div className="side-client-name">{client.name}</div>
                    <div className="side-client-meta">
                      {latestRun ? latestRun.periodKey : 'ingen körning'}
                      {s ? ` · ${s.blockingFindingCount} blockerande` : ''}
                    </div>
                  </Link>
                ))}
              </div>
            ) : null}

            <div className="side-foot">
              <ShadowNotice status={status} reachable={reachable} />
            </div>
          </aside>

          <div className="main">
            <header className="topbar">
              <div className="faint">
                {run ? (
                  <>
                    Period <span className="mono">{run.periodKey}</span>
                  </>
                ) : (
                  'Ingen aktiv period'
                )}
              </div>
              <div style={{ marginLeft: 'auto' }} className="row">
                <ThemeToggle />
              </div>
            </header>

            <main className="content" id="main">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
