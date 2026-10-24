import { encodeTypeId, ID_PREFIX, type TripOfflineBundle } from '@tribo/contract';
import type { OfflineBundleRecord, OfflineBundleService } from '@tribo/core';
import { pathId, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';
import { expenseView } from './expenses.js';
import { fileView } from './files.js';
import { itemView } from './items.js';
import { dayView, warningView } from './itinerary.js';
import { memberView } from './members.js';
import { overlayView } from './overlays.js';
import { ticketView } from './tickets.js';
import { tripView } from './trips.js';
import { boardView, unitView } from './units.js';

/** The bundle as the API names it: each part through the view its own read uses. */
function offlineBundleView(b: OfflineBundleRecord): TripOfflineBundle {
  const itinerary = (view: OfflineBundleRecord['itinerary']['me']) => ({
    days: view.days.map(dayView),
    warnings: view.warnings.map(warningView),
  });
  return {
    trip: tripView(b.trip),
    membershipId: encodeTypeId(ID_PREFIX.membership, b.membershipId),
    members: b.members.map(memberView),
    items: b.items.map(itemView),
    units: b.units.map(unitView),
    boards: b.boards.map(boardView),
    itinerary: { me: itinerary(b.itinerary.me), group: itinerary(b.itinerary.group) },
    tickets: b.tickets.map(ticketView),
    overlays: b.overlays.map(overlayView),
    expenses: b.expenses.map(expenseView),
    files: b.files.map(fileView),
    truncated: b.truncated,
  };
}

export function offlineBundleHandlers(bundle: OfflineBundleService): Handlers {
  return {
    // Sent with its representation ETag, and 304 on a matching If-None-Match (the registry
    // entry declares it, R12). The client keeps it in IndexedDB itself: no HTTP cache may.
    'trips.offlineBundle': async (request, reply): Promise<TripOfflineBundle> => {
      const view = offlineBundleView(
        await bundle.get(signedIn(request).userId, pathId(request, 'tripId')),
      );
      reply.header('cache-control', 'private, no-store');
      return view;
    },
  };
}
