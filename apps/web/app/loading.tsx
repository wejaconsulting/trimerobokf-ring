/** Shown while a server component fetches. Mirrors the real layout so the page
 *  does not jump when the content lands. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="page-head">
        <div>
          <div className="skeleton" style={{ width: 260, height: 24 }} />
          <div className="skeleton" style={{ width: 380, height: 14, marginTop: 8 }} />
        </div>
      </div>
      <section className="panel">
        <div className="panel-body stack">
          <div className="skeleton" style={{ height: 34 }} />
          <div className="skeleton" style={{ height: 14, width: '60%' }} />
          <div className="skeleton" style={{ height: 14, width: '40%' }} />
        </div>
      </section>
      <span className="faint" style={{ position: 'absolute', left: -9999 }}>
        Laddar…
      </span>
    </div>
  );
}
