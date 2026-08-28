import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trimeros Accounting Agent',
  description: 'Granskningskonsol för löpande redovisning och månadsavstämning mot Fortnox.',
};

/**
 * The shadow-mode banner is fetched from the API rather than hard-coded, so the
 * consultant is told what the *running system* is actually configured to do -
 * not what the UI assumes.
 */
async function ShadowBanner() {
  try {
    const status = await api.systemStatus();
    if (status.shadowMode && !status.fortnoxWritesEnabled) {
      return (
        <div className="shadow-banner">
          <span className="dot" />
          SHADOW MODE · inga Fortnox-anrop skrivs · adapter: {status.fortnoxAdapter}
        </div>
      );
    }
    return (
      <div className="shadow-banner" style={{ background: '#3a0d0d', borderColor: '#7d1715', color: '#ffb4b0' }}>
        <span className="dot" style={{ background: '#ff6b6b' }} />
        VARNING: skrivning mot Fortnox är aktiverad
      </div>
    );
  } catch {
    return (
      <div className="shadow-banner">
        <span className="dot" />
        API ej tillgängligt
      </div>
    );
  }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="sv">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <div className="brand">
              Trimeros Accounting Agent
              <small>Granska undantagen — inte allt</small>
            </div>
            <nav>
              <Link href="/">Kundöversikt</Link>
            </nav>
            <ShadowBanner />
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
