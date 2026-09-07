import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerDemoAuth } from './auth.js';
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
  });
  if (authEnabled) app.log.info('Password gate enabled for all routes except /health.');

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
