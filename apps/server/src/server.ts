import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import cookie from '@fastify/cookie';
import proxyAddr from '@fastify/proxy-addr';
import { CSRF_HEADER, registry as defaultRegistry, type Operation } from '@tribo/contract';
import type { SignedIn } from '@tribo/core';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { ApiError } from '@tribo/platform';
import { registerErrorHandling } from './errors.js';
import { loggerOptions } from './logger.js';
import { mountRegistry, type Handlers } from './routes.js';
import { csrfValid, sessionTokenOf } from './session.js';

export interface ServerDeps {
  /** proxy-addr trust list: names (loopback, uniquelocal), IPs or CIDRs. */
  trustedProxies: readonly string[];
  csrfSecret: Buffer;
  /** Resolves a session cookie to its live session, or null. */
  authenticate: (sessionToken: string) => Promise<SignedIn | null>;
  /** Resolves when the database answers; liveness depends on nothing else. */
  ping: () => Promise<void>;
  logLevel?: string;
  /** Log destination; tests capture lines here. */
  logStream?: NodeJS.WritableStream;
  registry?: readonly Operation[];
  /** Operation handlers (identity, later the other modules; tests add their own). */
  handlers?: Handlers;
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const trust = proxyAddr.compile([...deps.trustedProxies]);

  /** Caddy's X-Request-Id is kept only when the peer is a trusted proxy; otherwise we mint one. */
  const genReqId = (req: IncomingMessage): string => {
    const header = req.headers['x-request-id'];
    const peer = req.socket.remoteAddress ?? '';
    return typeof header === 'string' && REQUEST_ID.test(header) && trust(peer, 0)
      ? header
      : randomUUID();
  };

  const app = Fastify({
    logger: loggerOptions(deps.logLevel ?? 'info', deps.logStream),
    trustProxy: (address, hop) => trust(address, hop),
    genReqId,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    return503OnClosing: true,
  });

  await app.register(cookie);
  registerErrorHandling(app);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    const op = request.routeOptions.config.operation;
    if (!op || !UNSAFE.has(request.method) || !op.auth.includes('session')) return;
    const session = sessionTokenOf(request);
    // No cookie: not a session request, so authentication (not CSRF) decides.
    if (session && !csrfValid(deps.csrfSecret, session, request.headers[CSRF_HEADER])) {
      throw new ApiError('forbidden', { detail: 'missing or invalid CSRF token' });
    }
  });

  // Authentication runs only for implemented operations: a planned one answers 501 to anyone.
  app.addHook('onRequest', async (request) => {
    const op = request.routeOptions.config.operation;
    if (op?.status !== 'implemented' || op.auth.includes('public')) return;
    const token = op.auth.includes('session') ? sessionTokenOf(request) : undefined;
    const session = token === undefined ? null : await deps.authenticate(token);
    if (!session) throw new ApiError('unauthenticated');
    request.signedIn = session;
  });

  const builtIn: Handlers = {
    'meta.liveness': async (_request, reply) => {
      try {
        await deps.ping();
      } catch {
        return reply.code(503).send();
      }
      return { status: 'ok' };
    },
  };

  mountRegistry(app, deps.registry ?? defaultRegistry, { ...builtIn, ...deps.handlers });
  return app;
}
