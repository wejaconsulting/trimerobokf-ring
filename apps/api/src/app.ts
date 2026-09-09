import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerDemoAuth } from './auth.js';
import { FORTNOX_CALLBACK_PATH } from './integrations/fortnox.js';
import { registerRoutes } from './routes/index.js';
import type { Runtime } from './runtime.js';

export async function buildApp(runtime: Runtime): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: runtime.config.logLevel },
  });

  // Locally the review app runs on another port, so any origin is reflected.
  // A deployment sets WEB_ORIGIN and the allowlist replaces that.
  await app.register(cors, {
    origin: runtime.config.corsOrigins.length > 0 ? [...runtime.config.corsOrigins] : true,
  });

  const authEnabled = registerDemoAuth(app, {
    user: runtime.config.demoUser,
    password: runtime.config.demoPassword,
    // The OAuth callback is opened by Fortnox's redirect, in whatever browser
    // state the person happens to be in, so a shared demo password is the wrong
    // check for it. It carries its own: a single-use, ten-minute, 256-bit state
    // value that the callback validates before doing anything at all.
    openPaths: ['/health', FORTNOX_CALLBACK_PATH],
  });
  if (authEnabled) {
    app.log.info(
      { openPaths: ['/health', FORTNOX_CALLBACK_PATH] },
      'Password gate enabled for all routes except the listed paths.',
    );
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    app.log.error({ err: error }, 'unhandled error');
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return reply.code(500).send({ error: 'internal_error', message });
  });

  await registerRoutes(app, runtime);
  return app;
}
