import type { Operation } from '@tribo/contract';
import { createRateLimits } from '@tribo/platform';
import { operationHandlers } from './handlers/index.js';
import type { Release } from './config.js';
import type { Services } from './runtime.js';
import type { Handlers } from './routes.js';
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
    /** The rate limits' clock, in epoch milliseconds; adapter tests move their own. */
    now?: () => number;
    /** A registry in place of the contract's, and handlers over the app's; adapter tests only. */
    registry?: readonly Operation[];
    handlers?: Handlers;
  },
) {
  const {
    identity,
    trips,
    members,
    invites,
    items,
    itinerary,
    dashboard,
    myTasks,
    overlays,
    tickets,
    units,
    library,
    files,
    expenses,
  } = services;
  const csrf = csrfSecret(services.appKey);
  return buildServer({
    trustedProxies: config.trustedProxies,
    csrfSecret: csrf,
    authenticate: (token) => identity.authenticate(token),
    handlers: {
      ...operationHandlers({
        identity,
        csrfSecret: csrf,
        trips,
        members,
        invites,
        items,
        itinerary,
        dashboard,
        myTasks,
        overlays,
        tickets,
        units,
        library,
        files,
        expenses,
      }),
      ...config.handlers,
    },
    ...(config.registry ? { registry: config.registry } : {}),
    logLevel: config.logLevel,
    ...(config.release ? { release: config.release } : {}),
    ...(config.logStream ? { logStream: config.logStream } : {}),
    ping: services.ping,
    rateLimits: createRateLimits(config.now),
    idempotency: services.idempotency,
  });
}
