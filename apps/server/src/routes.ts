import type { Operation } from '@tribo/contract';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type * as z from 'zod';
import { ApiError, validate } from '@tribo/platform';
import { sendRepresentation } from './representation.js';

export type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export type Handlers = Readonly<Record<string, Handler>>;

declare module 'fastify' {
  interface FastifyContextConfig {
    operation?: Operation;
  }
  interface FastifyRequest {
    /** The operation's declared query, parsed before the handler runs; read it with parsedQuery. */
    parsedQuery?: unknown;
  }
}

/**
 * The query the route's hook already validated against `schema`. Naming the schema types
 * the result; a schema other than the operation's own is a programmer error.
 */
export function parsedQuery<S extends z.ZodObject>(
  request: FastifyRequest,
  schema: S,
): z.output<S> {
  if (request.routeOptions.config.operation?.query !== schema) {
    throw new Error(`${request.routeOptions.url ?? request.url} does not declare this query`);
  }
  return request.parsedQuery as z.output<S>;
}

/**
 * Mounts every registry operation as a route. An implemented operation runs its handler;
 * a planned one answers 501 not_implemented. An implemented operation that declares a query
 * has it validated before its handler runs; one that declares an ETag has its handler's
 * view sent through sendRepresentation with that kind of tag. A handler without an implemented operation, or
 * the reverse, stops the server at start rather than drifting silently.
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
    const { query, etag } = op;
    if (op.status === 'implemented' && !handler) {
      throw new Error(`implemented operation ${op.id} has no handler`);
    }
    app.route({
      method: op.method,
      url: op.path.replace(/\{(\w+)\}/g, ':$1'),
      config: { operation: op },
      // Every line the request logs names its operation, from the first one on.
      childLoggerFactory: (logger, bindings, options) =>
        logger.child({ ...bindings, operationId: op.id }, options),
      ...(handler && query
        ? {
            preValidation: (
              request: FastifyRequest,
              _reply: FastifyReply,
              done: HookHandlerDoneFunction,
            ) => {
              // A refusal throws here; Fastify routes it to the error handler.
              request.parsedQuery = validate(query, request.query);
              done();
            },
          }
        : {}),
      handler:
        handler && etag
          ? async (request: FastifyRequest, reply: FastifyReply) =>
              sendRepresentation(request, reply, await handler(request, reply), etag)
          : (handler ??
            (() => {
              throw new ApiError('not_implemented', {
                detail: `${op.id} is registered but not built yet`,
              });
            })),
    });
  }
}
