import {
  encodeTypeId,
  ID_PREFIX,
  ItineraryQuery,
  type Itinerary,
  type ItineraryDay,
  type Warning,
} from '@tribo/contract';
import type { DayRecord, ItineraryRecord, ItineraryService, WarningRecord } from '@tribo/core';
import { pathId, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';
import { itemView } from './items.js';

const item = (id: string) => encodeTypeId(ID_PREFIX.item, id);

/** A rule check as reads that cover many items show it, with type ids. */
export function warningView(w: WarningRecord): Warning {
  return {
    code: w.code,
    itemId: item(w.itemId),
    ...(w.withItemId === undefined ? {} : { withItemId: item(w.withItemId) }),
    ...(w.unitId === undefined ? {} : { unitId: encodeTypeId(ID_PREFIX.unit, w.unitId) }),
  };
}

/** A day of the itinerary and its lines, with type ids. */
export function dayView(d: DayRecord): ItineraryDay {
  return { date: d.date, entries: d.entries.map((e) => ({ ...e, itemId: item(e.itemId) })) };
}

function itineraryView(it: ItineraryRecord): Itinerary {
  return {
    view: it.view,
    from: it.from,
    to: it.to,
    days: it.days.map(dayView),
    items: it.items.map(itemView),
    warnings: it.warnings.map(warningView),
  };
}

export function itineraryHandlers(itinerary: ItineraryService): Handlers {
  return {
    'itinerary.get': async (request): Promise<Itinerary> =>
      itineraryView(
        await itinerary.get(
          signedIn(request).userId,
          pathId(request, 'tripId'),
          parsedQuery(request, ItineraryQuery),
        ),
      ),
  };
}
