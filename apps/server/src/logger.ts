import { hostname } from 'node:os';
import { CSRF_HEADER } from '@tribo/contract';
import type { FastifyServerOptions } from 'fastify';
import type { Release } from './config.js';

/**
 * Values that must never reach a log line: credentials, codes, tokens and sensitive fields,
 * wherever they appear in a logged object (request bodies are not logged at all).
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  `req.headers["${CSRF_HEADER}"]`,
  'res.headers["set-cookie"]',
  ...['password', 'newPassword', 'currentPassword', 'totp', 'totpCode', 'code', 'recoveryCode'],
  ...['token', 'sessionToken', 'csrfToken', 'secret', 'appKey'],
].flatMap((path) => (path.includes('.') ? [path] : [path, `*.${path}`]));

/** Every line names the release that wrote it, beside pino's own pid and hostname. */
export function loggerOptions(
  level: string,
  release: Release,
  stream?: NodeJS.WritableStream,
): NonNullable<FastifyServerOptions['loggerInstance'] | FastifyServerOptions['logger']> {
  return {
    level,
    base: {
      pid: process.pid,
      hostname: hostname(),
      release: release.version,
      commit: release.commit,
    },
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    ...(stream ? { stream } : {}),
  };
}
