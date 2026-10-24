// The offline bundle: one trip as the caller may read it, for the SPA to keep in IndexedDB
// (Technical Design, "Offline"), sent with its representation ETag (rule 4, R12). Every part
// shows and masks exactly as its own read does; no revealed value is ever in it.
import * as z from 'zod';
import { ItemBoard } from './assignment.js';
import { Expense } from './expense.js';
import { FileMetadata } from './file.js';
import { ID_PREFIX, typeId } from './ids.js';
import { Item } from './item.js';
import { ItineraryDay } from './itinerary.js';
import { Member } from './member.js';
import { Overlay } from './overlay.js';
import { Ticket } from './ticket.js';
import { Trip } from './trip.js';
import { Unit } from './unit.js';
import { Warning } from './warning.js';

/** One view of the trip's itinerary: its days and the rule checks over them; the items are the bundle's. */
export const OfflineItinerary = z
  .strictObject({ days: z.array(ItineraryDay), warnings: z.array(Warning) })
  .meta({ id: 'OfflineItinerary' });

/**
 * trips.offlineBundle. Each collection is what its own read gives the caller (trips.get,
 * members.list, items.list, units.list, items.assignments.get, itinerary.get, tickets.list,
 * overlays.get, expenses.list, files.list), masked the same way, in id order (expenses by the
 * day spent, then id). Only the caller's own tickets and overlays are in it; a viewer keeps
 * no overlay. Sensitive values (booking refs, card last-4, ticket numbers, emergency
 * contacts) are always masked; reveals are never cached offline. Anything missing from the
 * next bundle is gone (removed, voided, deleted or hidden) and the client drops it.
 * `truncated` says a collection held more than 2000 rows and was cut to its first 2000; the
 * children of an item left out are left out with it.
 */
export const TripOfflineBundle = z
  .strictObject({
    trip: Trip,
    /** The caller's own membership: the one of `members` the bundle was made for. */
    membershipId: typeId(ID_PREFIX.membership),
    members: z.array(Member),
    items: z.array(Item),
    units: z.array(Unit),
    boards: z.array(ItemBoard),
    itinerary: z.strictObject({ me: OfflineItinerary, group: OfflineItinerary }),
    tickets: z.array(Ticket),
    overlays: z.array(Overlay),
    expenses: z.array(Expense),
    files: z.array(FileMetadata),
    truncated: z.boolean(),
  })
  .meta({ id: 'TripOfflineBundle' });

export type TripOfflineBundle = z.infer<typeof TripOfflineBundle>;
