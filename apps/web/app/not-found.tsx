import Link from 'next/link';

export default function NotFound() {
  return (
    <>
      <div className="page-head">
        <h1>Sidan finns inte</h1>
      </div>
      <section className="panel">
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            Länken pekar på en körning eller avvikelse som inte finns i den här databasen. Det händer
            efter <code className="inline">pnpm db:reset</code>, eftersom id:n är körningsspecifika.
          </p>
          <Link className="btn btn-primary" href="/">
            Till kundöversikten
          </Link>
        </div>
      </section>
    </>
  );
}
