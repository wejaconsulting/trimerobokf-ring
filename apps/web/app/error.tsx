'use client';

import { useEffect } from 'react';

/** Error boundary. States what failed and what to do about it - no apology,
 *  no vagueness. */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <div className="page-head">
        <h1>Sidan kunde inte laddas</h1>
      </div>
      <section className="panel">
        <div className="panel-body">
          <div className="note" data-tone="manual">
            <strong>Anropet mot API:t misslyckades.</strong> Kontrollera att backend kör
            (<code className="inline">pnpm dev:api</code>) och att <code className="inline">API_BASE_URL</code>{' '}
            pekar rätt.
          </div>
          <p className="faint" style={{ marginTop: 12, marginBottom: 16 }}>
            {error.message}
          </p>
          <button className="btn btn-primary" type="button" onClick={reset}>
            Försök igen
          </button>
        </div>
      </section>
    </>
  );
}
