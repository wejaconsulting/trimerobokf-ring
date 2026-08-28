import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optional password gate for hosted demos.
 *
 * Mirrors the API's gate (apps/api/src/auth.ts) so a deployment is covered at
 * both doors. Disabled when DEMO_PASSWORD is unset, which is the local case.
 *
 * This is a shareable-link gate, not authentication. Phase 2 replaces it with
 * real sessions - see docs/security-and-permissions.md.
 */
export function middleware(request: NextRequest) {
  const password = process.env.DEMO_PASSWORD;
  if (!password) return NextResponse.next();

  const user = process.env.DEMO_USER ?? 'demo';
  const expected = `Basic ${btoa(`${user}:${password}`)}`;
  const provided = request.headers.get('authorization');

  if (provided !== expected) {
    return new NextResponse('Autentisering krävs', {
      status: 401,
      headers: {
        'www-authenticate': 'Basic realm="Trimeros Accounting Agent", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own static assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
