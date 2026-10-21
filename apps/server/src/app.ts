import { operationHandlers } from './handlers/index.js';
import type { Release } from './config.js';
import type { Services } from './runtime.js';
import { buildServer } from './server.js';
import { csrfSecret } from './session.js';

/** The HTTP app over the composed services: what main.ts listens with. */
export function buildApp(
  services: Services,
  config: {
    trustedProxies: readonly string[];
    logLevel: string;
    release?: Release;
    /** Log destination; adapter tests capture lines here. */
    logStream?: NodeJS.WritableStream;
  },
) {
  const { identity, trips, members, items, library } = services;
  const csrf = csrfSecret(services.appKey);
  return buildServer({
    trustedProxies: config.trustedProxies,
    csrfSecret: csrf,
    authenticate: (token) => identity.authenticate(token),
    handlers: operationHandlers({ identity, csrfSecret: csrf, trips, members, items, library }),
    logLevel: config.logLevel,
    ...(config.release ? { release: config.release } : {}),
    ...(config.logStream ? { logStream: config.logStream } : {}),
    ping: services.ping,
  });
}
