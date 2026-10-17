import { CSRF_HEADER } from '@tribo/contract';
import type { FastifyServerOptions } from 'fastify';

/**
 * Values that must never reach a log line: credentials, codes, tokens and sensitive fields,
 * wherever they appear in a logged object (request bodies are not logged at all).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  `req.headers["${CSRF_HEADER}"]`,
  'res.headers["set-cookie"]',
  ...['password', 'newPassword', 'currentPassword', 'totp', 'totpCode', 'code', 'recoveryCode'],
  ...['token', 'sessionToken', 'csrfToken', 'secret', 'appKey'],
].flatMap((path) => (path.includes('.') ? [path] : [path, `*.${path}`]));

export function loggerOptions(
  level: string,
  stream?: NodeJS.WritableStream,
): NonNullable<FastifyServerOptions['loggerInstance'] | FastifyServerOptions['logger']> {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    ...(stream ? { stream } : {}),
  };
}
