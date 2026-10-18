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
  return { requestId: request.id, surface: 'web', userId: request.signedIn?.userId ?? null };
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
