import type {
  DashboardService,
  ExpensesService,
  FilesService,
  IdentityService,
  InvitesService,
  ItemsService,
  ItineraryService,
  LibraryService,
  MembersService,
  MyTasksService,
  OfflineBundleService,
  OverlaysService,
  TicketsService,
  TripsService,
  UnitsService,
} from '@tribo/core';
import type { Handlers } from '../routes.js';
import { authHandlers } from './auth.js';
import { dashboardHandlers } from './dashboard.js';
import { expensesHandlers } from './expenses.js';
import { filesHandlers } from './files.js';
import { invitesHandlers } from './invites.js';
import { itemHandlers } from './items.js';
import { itineraryHandlers } from './itinerary.js';
import { libraryHandlers } from './library.js';
import { membersHandlers } from './members.js';
import { offlineBundleHandlers } from './offline-bundle.js';
import { overlayHandlers } from './overlays.js';
import { ticketsHandlers } from './tickets.js';
import { tripHandlers } from './trips.js';
import { meHandlers } from './me.js';
import { metaHandlers } from './meta.js';
import { unitsHandlers } from './units.js';

/** The services the operation handlers call, as the runtime or a test builds them. */
export interface HandlerServices {
  identity: IdentityService;
  csrfSecret: Buffer;
  trips: TripsService;
  members: MembersService;
  invites: InvitesService;
  items: ItemsService;
  itinerary: ItineraryService;
  dashboard: DashboardService;
  myTasks: MyTasksService;
  offlineBundle: OfflineBundleService;
  overlays: OverlaysService;
  tickets: TicketsService;
  units: UnitsService;
  library: LibraryService;
  files: FilesService;
  expenses: ExpensesService;
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
    ...membersHandlers(services.members),
    ...invitesHandlers(services.invites, services.csrfSecret),
    ...itemHandlers(services.items),
    ...itineraryHandlers(services.itinerary),
    ...dashboardHandlers(services.dashboard),
    ...offlineBundleHandlers(services.offlineBundle),
    ...libraryHandlers(services.library),
    ...meHandlers(services.identity, services.library, services.myTasks),
    ...metaHandlers(),
    ...overlayHandlers(services.overlays),
    ...ticketsHandlers(services.tickets),
    ...unitsHandlers(services.units),
    ...filesHandlers(services.files),
    ...expensesHandlers(services.expenses),
  };
}
