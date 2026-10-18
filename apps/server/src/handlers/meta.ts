import { registry, toOpenApi } from '@tribo/contract';
import type { Handlers } from '../routes.js';

/** meta.openapi; meta.liveness is built into the server, since it needs the database ping. */
export function metaHandlers(): Handlers {
  // The document is a pure function of the registry, so it is built once per server.
  let document: ReturnType<typeof toOpenApi> | undefined;
  return {
    'meta.openapi': () => {
      document ??= toOpenApi(registry);
      return Promise.resolve(document);
    },
  };
}
