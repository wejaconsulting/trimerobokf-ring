import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerRoutes } from './routes/index.js';
import type { Runtime } from './runtime.js';

export async function buildApp(runtime: Runtime): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: runtime.config.logLevel },
  });

  // The review app is served from a different origin in development.
  await app.register(cors, { origin: true });

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
