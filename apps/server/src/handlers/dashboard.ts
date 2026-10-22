import { encodeTypeId, ID_PREFIX, MASKED, type TripDashboard } from '@tribo/contract';
import type { DashboardRecord, DashboardService } from '@tribo/core';
import { pathId, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';
import { itemView } from './items.js';
import { warningView } from './itinerary.js';

function dashboardView(d: DashboardRecord): TripDashboard {
  return {
    tripId: encodeTypeId(ID_PREFIX.trip, d.tripId),
    name: d.name,
    countdown: d.countdown,
    nextItem: d.nextItem === null ? null : itemView(d.nextItem),
    openTasks: d.openTasks.map(itemView),
    dueSoon: d.dueSoon.map((s) => ({ kind: s.kind, item: itemView(s.item) })),
    myShare: d.myShare === 'masked' ? MASKED : d.myShare,
    warnings: d.warnings.map(warningView),
  };
}

export function dashboardHandlers(dashboard: DashboardService): Handlers {
  return {
    // Sent with its representation ETag, and 304 on a matching If-None-Match: the registry
    // entry declares it (rule 4), so a poll that finds nothing new costs no transfer.
    'trips.dashboard': async (request): Promise<TripDashboard> =>
      dashboardView(await dashboard.get(signedIn(request).userId, pathId(request, 'tripId'))),
  };
}
