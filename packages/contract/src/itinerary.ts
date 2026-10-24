// Itinerary schemas: the merged day timeline itinerary.get returns (Technical Design,
// "Itinerary (F-06)").
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { Item } from './item.js';
import { TimeZone } from './time.js';
import { Warning } from './warning.js';

/** me = the items the caller owns or is on the board of; group = every item they can see. */
export const ItineraryView = z.enum(['me', 'group']).meta({ id: 'ItineraryView' });

export type ItineraryView = z.infer<typeof ItineraryView>;

/**
 * itinerary.get. `from`/`to` keep the days of that inclusive range, each item's days counted
 * in its own zones; without them the timeline covers every dated item.
 */
export const ItineraryQuery = z
  .strictObject({
    view: ItineraryView.default('group'),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'the range ends before it starts',
    path: ['to'],
  });

export type ItineraryQuery = z.infer<typeof ItineraryQuery>;

/**
 * Which part of an item a day shows: a one-day item whole, a longer one's start and end,
 * and a stay's check-in, each night it is stayed at, and its check-out.
 */
export const ItineraryPart = z
  .enum(['whole', 'start', 'end', 'check_in', 'staying', 'check_out'])
  .meta({ id: 'ItineraryPart' });

export type ItineraryPart = z.infer<typeof ItineraryPart>;

/** One line of a day: an item of `items`, the wall-clock time of that part in its own zone. */
export const ItineraryEntry = z
  .strictObject({
    itemId: typeId(ID_PREFIX.item),
    part: ItineraryPart,
    /** HH:mm in `tz`; null for all-day items and for the nights of a stay. */
    time: z.string().nullable(),
    tz: TimeZone.nullable(),
  })
  .meta({ id: 'ItineraryEntry' });

/** A local calendar day and its lines, all-day ones first, then by time. */
export const ItineraryDay = z
  .strictObject({ date: z.iso.date(), entries: z.array(ItineraryEntry) })
  .meta({ id: 'ItineraryDay' });

export type ItineraryDay = z.infer<typeof ItineraryDay>;

/**
 * itinerary.get: the days that have lines, the items they name (each once, masked as
 * items.list masks them), and the rule checks over those items alone.
 */
export const Itinerary = z
  .strictObject({
    view: ItineraryView,
    from: z.iso.date().nullable(),
    to: z.iso.date().nullable(),
    days: z.array(ItineraryDay),
    items: z.array(Item),
    warnings: z.array(Warning),
  })
  .meta({ id: 'Itinerary' });

export type Itinerary = z.infer<typeof Itinerary>;
