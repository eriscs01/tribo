import type { Operation } from '@tribo/contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export type Handlers = Readonly<Record<string, Handler>>;

declare module 'fastify' {
  interface FastifyContextConfig {
    operation?: Operation;
  }
}

/**
 * Mounts every registry operation as a route. An implemented operation runs its handler;
 * a planned one answers 501 not_implemented. A handler without an implemented operation,
 * or the reverse, stops the server at start rather than drifting silently.
 */
export function mountRegistry(
  app: FastifyInstance,
  registry: readonly Operation[],
  handlers: Handlers,
) {
  const ids = new Set(registry.map((op) => op.id));
  for (const id of Object.keys(handlers)) {
    const op = registry.find((o) => o.id === id);
    if (!ids.has(id) || op?.status !== 'implemented') {
      throw new Error(`handler ${id} has no implemented registry operation`);
    }
  }
  for (const op of registry) {
    const handler = handlers[op.id];
    if (op.status === 'implemented' && !handler) {
      throw new Error(`implemented operation ${op.id} has no handler`);
    }
    app.route({
      method: op.method,
      url: op.path.replace(/\{(\w+)\}/g, ':$1'),
      config: { operation: op },
      handler:
        handler ??
        (() => {
          throw new ApiError('not_implemented', {
            detail: `${op.id} is registered but not built yet`,
          });
        }),
    });
  }
}
