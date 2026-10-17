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
