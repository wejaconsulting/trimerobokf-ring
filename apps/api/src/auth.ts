import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Optional password gate for hosted demos.
 *
 * Phase 1 has no real authentication (see docs/security-and-permissions.md).
 * That is fine on localhost and not fine on a public URL: the data is synthetic
 * and writes are impossible, but an open endpoint still lets anyone trigger
 * close runs. This gate is the minimum that makes a shareable link acceptable -
 * it is NOT a substitute for the authentication phase 2 must add.
 *
 * Disabled when no password is set, so local development is unaffected.
 */
export interface DemoAuthOptions {
  readonly user: string;
  readonly password: string;
  /** Paths that stay open, so platform health checks keep working. */
  readonly openPaths?: readonly string[];
}

const DEFAULT_OPEN_PATHS = ['/health'];

export function registerDemoAuth(app: FastifyInstance, options: DemoAuthOptions): boolean {
  if (!options.password) return false;

  const openPaths = new Set(options.openPaths ?? DEFAULT_OPEN_PATHS);
  const expected = `Basic ${Buffer.from(`${options.user}:${options.password}`).toString('base64')}`;

  app.addHook('onRequest', async (request, reply) => {
    if (openPaths.has(request.url.split('?')[0] ?? request.url)) return;

    const provided = request.headers.authorization;
    if (!provided || !safeEqual(provided, expected)) {
      // The realm makes browsers show their own credential prompt, which is all
      // the UI this gate needs.
      reply.header('www-authenticate', 'Basic realm="Trimeros Accounting Agent", charset="UTF-8"');
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  return true;
}

/** Constant-time comparison that does not leak length through early return. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still spend the comparison so a wrong-length header is not distinguishable
    // by timing from a wrong-value one.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
