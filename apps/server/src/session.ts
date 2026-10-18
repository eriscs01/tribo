import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE } from '@tribo/contract';
import type { AppKey } from '@tribo/crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_OPTIONS = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' } as const;

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number) {
  return reply.setCookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: maxAgeSeconds });
}

export function clearSessionCookie(reply: FastifyReply) {
  return reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
}

export function sessionTokenOf(request: FastifyRequest): string | undefined {
  const token = request.cookies[SESSION_COOKIE];
  return token === undefined || token === '' ? undefined : token;
}

/** The CSRF key, derived from the app key so it needs no secret of its own. */
export function csrfSecret(appKey: AppKey): Buffer {
  // eslint-disable-next-line n/no-sync -- derived once at start-up, not per request
  return Buffer.from(hkdfSync('sha256', appKey.bytes(), Buffer.alloc(0), 'tribo csrf v1', 32));
}

/**
 * The CSRF token for a session: an HMAC of the session token, so it needs no storage, a
 * page on another origin cannot read or derive it, and it dies with the session.
 * auth.session hands it to the SPA, which sends it as X-CSRF-Token on unsafe methods.
 */
export function csrfTokenFor(secret: Buffer, sessionToken: string): string {
  return createHmac('sha256', secret).update(sessionToken).digest('base64url');
}

export function csrfValid(secret: Buffer, sessionToken: string, header: unknown): boolean {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(secret, sessionToken));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
