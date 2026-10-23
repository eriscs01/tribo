import { decodeTypeId, PATH_PARAM_PREFIX, TypeIdError } from '@tribo/contract';
import type { SignedIn } from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by authentication for every implemented operation that is not public. */
    signedIn?: SignedIn;
  }
}

/** The request context the REST adapter hands to core. */
export function requestContext(request: FastifyRequest): RequestContext {
  return {
    requestId: request.id,
    surface: 'web',
    userId: request.signedIn?.userId ?? null,
    ...(request.idempotency ? { idempotency: request.idempotency } : {}),
  };
}

/** The caller of an authenticated operation; authentication has already refused anyone else. */
export function signedIn(request: FastifyRequest): SignedIn {
  if (!request.signedIn) throw new ApiError('unauthenticated');
  return request.signedIn;
}

/**
 * A TypeID path parameter as its UUID. A malformed id names nothing, so it is not_found,
 * as an unknown one is.
 */
export function pathId(request: FastifyRequest, name: string): string {
  const prefix = PATH_PARAM_PREFIX[name];
  const value = (request.params as Record<string, unknown>)[name];
  if (prefix === undefined) throw new Error(`path parameter ${name} has no TypeID prefix`);
  try {
    return decodeTypeId(prefix, typeof value === 'string' ? value : '');
  } catch (error) {
    if (error instanceof TypeIdError) throw new ApiError('not_found');
    throw error;
  }
}

/** An entity tag whose opaque value is a counter: "3" or W/"3" (a bare 3 is accepted too). */
const COUNTER_TAG = /^(?:W\/)?"?(\d{1,9})"?$/;

/**
 * The If-Match header as the counter it names, or undefined when there is none. A header
 * that names no counter (`*`, a list, garbage) can match no version, so it comes back as
 * NaN and the write path answers version_conflict once it has loaded the row.
 */
export function ifMatch(request: FastifyRequest): number | undefined {
  const header = request.headers['if-match'];
  if (header === undefined) return undefined;
  const counter = COUNTER_TAG.exec(header.trim())?.[1];
  return counter === undefined ? Number.NaN : Number(counter);
}

/**
 * Whether the request carries `If-None-Match: *`, the precondition that creates something
 * only where it does not exist yet. Any other value names an entity tag, which names nothing
 * to create.
 */
export function createOnly(request: FastifyRequest): boolean {
  return request.headers['if-none-match']?.trim() === '*';
}
