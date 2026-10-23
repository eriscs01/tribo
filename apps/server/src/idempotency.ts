import { honoursIdempotencyKey, withoutSecrets } from '@tribo/contract';
import type { JsonValue } from '@tribo/db';
import {
  ApiError,
  type IdempotencyClaim,
  type IdempotencyStore,
  type IdempotentReplay,
} from '@tribo/platform';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** The Idempotency-Key this request claims, on an operation that honours one. */
    idempotency?: IdempotencyClaim;
  }
}

/** Names a replayed response (decision 0017); a first answer carries no such header. */
const REPLAYED_HEADER = 'idempotent-replayed';
const KEY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

/** The caller's key, or undefined when it sent none or the operation does not honour one. */
function claimOf(request: FastifyRequest): IdempotencyClaim | undefined {
  const op = request.routeOptions.config.operation;
  const key = request.headers[KEY_HEADER];
  if (!op || key === undefined || !honoursIdempotencyKey(op) || !request.signedIn) {
    return undefined;
  }
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new ApiError('validation_failed', {
      errors: [
        { path: '/headers/idempotency-key', message: `1 to ${String(MAX_KEY_LENGTH)} characters` },
      ],
    });
  }
  return { caller: `user:${request.signedIn.userId}`, key, operationId: op.id };
}

/**
 * Idempotency-Key for the operations that honour it (Technical design, API design,
 * "Idempotency"): the claim travels in the request context to the write path, which claims
 * it in the write's transaction; the response the claim got is stored here once sent. A
 * key belongs to an account, so an operation that honours one must not be public.
 */
export function registerIdempotency(app: FastifyInstance, store: IdempotencyStore) {
  app.addHook('onRoute', (route) => {
    const op = route.config?.operation;
    if (op && honoursIdempotencyKey(op) && op.auth.includes('public')) {
      throw new Error(`${op.id} honours Idempotency-Key but takes anonymous callers`);
    }
  });

  app.addHook('preHandler', (request, _reply, done) => {
    try {
      const claim = claimOf(request);
      if (claim) request.idempotency = claim;
    } catch (error) {
      done(error as Error);
      return;
    }
    done();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const claim = request.idempotency;
    if (!claim || reply.hasHeader(REPLAYED_HEADER)) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300 || typeof payload !== 'string') {
      return payload;
    }
    const output = request.routeOptions.config.operation?.output;
    const { body, redacted } = withoutSecrets(output, JSON.parse(payload) as unknown);
    // The write has committed: its caller still gets this answer. A retry under the key
    // then finds no stored response and is refused until the key expires (decision 0017).
    try {
      await store.storeResponse(claim, {
        status: reply.statusCode,
        body: body as JsonValue,
        redacted,
      });
    } catch (error) {
      request.log.error({ err: error }, 'idempotent response not stored');
    }
    return payload;
  });
}

/** Answers a repeat with the stored response, as the error handler's one 2xx. */
export function sendReplay(reply: FastifyReply, replay: IdempotentReplay) {
  reply.log.info({ status: replay.status }, 'idempotent replay');
  return reply.code(replay.status).header(REPLAYED_HEADER, 'true').send(replay.body);
}
