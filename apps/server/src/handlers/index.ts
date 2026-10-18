import type { IdentityService, ItemsService, LibraryService, TripsService } from '@tribo/core';
import type { Handlers } from '../routes.js';
import { authHandlers } from './auth.js';
import { itemHandlers } from './items.js';
import { libraryHandlers } from './library.js';
import { tripHandlers } from './trips.js';
import { meHandlers } from './me.js';
import { metaHandlers } from './meta.js';

/** The services the operation handlers call, as the runtime or a test builds them. */
export interface HandlerServices {
  identity: IdentityService;
  csrfSecret: Buffer;
  trips: TripsService;
  items: ItemsService;
  library: LibraryService;
}

/**
 * Every module's operation handlers, the one place a module's handler file is mounted:
 * mountRegistry refuses a server whose implemented operations lack a handler, so the app
 * and every test server take their handlers from here.
 */
export function operationHandlers(services: HandlerServices): Handlers {
  return {
    ...authHandlers(services.identity, services.csrfSecret),
    ...tripHandlers(services.trips),
    ...itemHandlers(services.items),
    ...libraryHandlers(services.library),
    ...meHandlers(services.identity),
    ...metaHandlers(),
  };
}
