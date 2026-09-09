import {
  FORTNOX_CONNECTION_KIND,
  FORTNOX_READ_SCOPES,
  FortnoxConnectionError,
  FortnoxOAuthError,
} from '@trimeros/fortnox';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FORTNOX_CALLBACK_PATH } from '../integrations/fortnox.js';
import type { Runtime } from '../runtime.js';

/**
 * Fortnox connection endpoints.
 *
 * Everything a person does to connect an accounting system goes through here.
 * Two things are true of every handler below:
 *
 *  - No response ever contains a token, an authorization code, or the client
 *    secret. Status responses are built from the connection row, which has no
 *    credential columns at all.
 *  - Connecting grants reading. It does not enable writing, and no route here
 *    can: the write gate lives in the Fortnox package and shadow mode fails it.
 */

const clientBodySchema = z.object({
  clientId: z.string().min(1),
  userId: z.string().min(1).default('demo-user'),
  returnTo: z.string().startsWith('/').max(512).optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export async function registerIntegrationRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  tenantOf: (headers: Record<string, unknown>) => string,
): Promise<void> {
  const integration = runtime.fortnoxIntegration;

  /** What the settings page needs to render, whether or not setup is finished. */
  app.get('/api/integrations/fortnox/status', async (request) => {
    const query = z.object({ clientId: z.string().min(1) }).parse(request.query);
    const tenantId = tenantOf(request.headers);

    if (!integration.configured) {
      return {
        configured: false,
        missing: integration.missing,
        requestedScopes: FORTNOX_READ_SCOPES,
        shadowMode: runtime.config.shadowMode,
        connection: null,
      };
    }

    const connection = await integration.service.getStatus({
      tenantId,
      clientId: query.clientId,
    });
    return {
      configured: true,
      redirectUri: integration.redirectUri,
      requestedScopes: FORTNOX_READ_SCOPES,
      shadowMode: runtime.config.shadowMode,
      connection,
    };
  });

  /**
   * Starts consent and hands back the Fortnox URL.
   *
   * The API returns the URL rather than redirecting, so the caller decides how
   * to present it - the console opens it, and a support case can copy it.
   */
  app.post('/api/integrations/fortnox/connect', async (request, reply) => {
    if (!integration.configured) {
      return reply.code(409).send({
        error: 'fortnox_not_configured',
        missing: integration.missing,
      });
    }
    const body = clientBodySchema.parse(request.body);
    const tenantId = tenantOf(request.headers);

    const { authorizeUrl, expiresAt } = await integration.service.beginAuthorization({
      tenantId,
      clientId: body.clientId,
      initiatedByUserId: body.userId,
      redirectUri: integration.redirectUri,
      ...(body.returnTo ? { returnTo: body.returnTo } : {}),
    });

    await runtime.repos.appendAuditEvent({
      tenantId,
      clientId: body.clientId,
      actorKind: 'user',
      actorId: body.userId,
      operation: 'fortnox.oauth.authorization_started',
      // Refs, not payloads: an audit row must never carry the credential it
      // describes. The redirect URI is configuration, not a secret.
      inputRefs: [`redirect_uri:${integration.redirectUri}`],
      result: 'ok',
      correlationId: `fortnox-connect-${Date.now()}`,
    });

    return { authorizeUrl, expiresAt };
  });

  /**
   * Where Fortnox sends the browser back.
   *
   * Deliberately outside the console's password gate - see buildApp. The
   * `state` it carries is a single-use, ten-minute, server-issued secret, which
   * is a stronger check than the shared demo password, and a gated callback
   * would fail for anyone whose browser did not happen to hold that password.
   */
  app.get(FORTNOX_CALLBACK_PATH, async (request, reply) => {
    if (!integration.configured) {
      return reply.code(409).send({ error: 'fortnox_not_configured' });
    }
    const query = callbackQuerySchema.parse(request.query);

    // Fortnox reports a refused consent by redirecting with `error`.
    if (query.error) {
      return reply.redirect(
        finishUrl(runtime, null, { status: 'error', code: query.error }),
      );
    }
    if (!query.code || !query.state) {
      return reply.redirect(
        finishUrl(runtime, null, { status: 'error', code: 'missing_code_or_state' }),
      );
    }

    try {
      const result = await integration.service.completeAuthorization({
        state: query.state,
        code: query.code,
      });

      await runtime.repos.appendAuditEvent({
        tenantId: result.tenantId,
        clientId: result.clientId,
        actorKind: 'user',
        actorId: result.summary.connectedByUserId ?? 'unknown',
        operation: 'fortnox.oauth.connected',
        inputRefs: [`scopes:${result.summary.grantedScopes.join(',')}`],
        result: result.summary.healthy ? 'ok' : 'degraded',
        ...(result.summary.statusCode ? { errorCode: result.summary.statusCode } : {}),
        correlationId: `fortnox-connect-${result.clientId}`,
      });

      return reply.redirect(
        finishUrl(runtime, result.returnTo, {
          status: result.summary.healthy ? 'connected' : 'connected_unverified',
          ...(result.summary.statusCode ? { code: result.summary.statusCode } : {}),
        }),
      );
    } catch (error) {
      const code =
        error instanceof FortnoxConnectionError || error instanceof FortnoxOAuthError
          ? error.code
          : 'unexpected_error';
      request.log.warn({ code }, 'Fortnox authorization callback failed');
      return reply.redirect(finishUrl(runtime, null, { status: 'error', code }));
    }
  });

  /** Re-runs the live check, so "is it still working?" has an answer. */
  app.post('/api/integrations/fortnox/verify', async (request, reply) => {
    if (!integration.configured) {
      return reply.code(409).send({ error: 'fortnox_not_configured' });
    }
    const body = clientBodySchema.parse(request.body);
    const connection = await integration.service.verifyConnection({
      tenantId: tenantOf(request.headers),
      clientId: body.clientId,
    });
    return { connection };
  });

  /**
   * The per-client write switch (condition 3 of the write gate).
   *
   * An audited administrative action. Turning it on does nothing by itself:
   * SHADOW_MODE=false, FORTNOX_WRITES_ENABLED=true and the acknowledgement
   * phrase are all still required on the server, and every voucher is still
   * bound to an approval of its exact payload.
   */
  app.post('/api/integrations/fortnox/writes', async (request, reply) => {
    const body = clientBodySchema.extend({ enabled: z.boolean() }).parse(request.body);
    const tenantId = tenantOf(request.headers);
    const scope = { tenantId, clientId: body.clientId };

    const connection = await runtime.repos.getIntegrationConnection(scope, FORTNOX_CONNECTION_KIND);
    if (!connection) {
      return reply.code(409).send({ error: 'not_connected' });
    }
    if (body.enabled && runtime.config.shadowMode) {
      return reply.code(409).send({
        error: 'shadow_mode_active',
        message: 'Skrivning kan inte aktiveras per klient medan servern kör i shadow mode.',
      });
    }

    await runtime.repos.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, {
      writesEnabled: body.enabled,
      mode: body.enabled ? 'real_read_write' : 'real_read_only',
    });
    await runtime.repos.appendAuditEvent({
      tenantId,
      clientId: body.clientId,
      actorKind: 'user',
      actorId: body.userId,
      operation: 'integration.writes_toggled',
      inputRefs: [`writes_enabled:${body.enabled}`, `shadow_mode:${runtime.config.shadowMode}`],
      result: 'ok',
      correlationId: `fortnox-writes-${body.clientId}`,
    });

    if (!integration.configured) {
      return { writesEnabled: body.enabled, connection: null };
    }
    return { writesEnabled: body.enabled, connection: await integration.service.getStatus(scope) };
  });

  app.post('/api/integrations/fortnox/disconnect', async (request, reply) => {
    if (!integration.configured) {
      return reply.code(409).send({ error: 'fortnox_not_configured' });
    }
    const body = clientBodySchema.parse(request.body);
    const tenantId = tenantOf(request.headers);
    const scope = { tenantId, clientId: body.clientId };

    const { revokedAtFortnox } = await integration.service.disconnect(scope);
    await runtime.repos.appendAuditEvent({
      tenantId,
      clientId: body.clientId,
      actorKind: 'user',
      actorId: body.userId,
      operation: 'fortnox.oauth.disconnected',
      inputRefs: [`revoked_at_fortnox:${revokedAtFortnox}`],
      result: 'ok',
      correlationId: `fortnox-disconnect-${body.clientId}`,
    });

    return {
      revokedAtFortnox,
      connection: await integration.service.getStatus(scope),
    };
  });
}

/**
 * Where to send the browser once the callback is done.
 *
 * `returnTo` is only ever a path from our own stored request, never anything
 * off the query string, so this cannot be turned into an open redirect.
 */
function finishUrl(
  runtime: Runtime,
  returnTo: string | null,
  params: Record<string, string>,
): string {
  const base = runtime.config.webBaseUrl.replace(/\/+$/, '');
  const path = returnTo && returnTo.startsWith('/') ? returnTo : '/installningar/fortnox';
  const search = new URLSearchParams(params).toString();
  return `${base}${path}?${search}`;
}
