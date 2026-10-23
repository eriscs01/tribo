// The trip dashboard: one polled read that sums a trip up for the caller (Technical Design,
// "Web app" /trips/:id), sent with its representation ETag (rule 4).
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { Item } from './item.js';
import { MaskedValue } from './masked.js';
import { Money } from './money.js';
import { Instant, TimeZone } from './time.js';
import { Warning } from './warning.js';

/** Where today, in the trip's time zone, falls against the trip's dates. */
export const TripPhase = z.enum(['upcoming', 'underway', 'over']).meta({ id: 'TripPhase' });

export const Countdown = z
  .strictObject({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timezone: TimeZone,
    /** Whole days from today to the first day, in the trip's zone; 0 once it has begun. */
    daysToStart: z.int().min(0),
    phase: TripPhase,
  })
  .meta({ id: 'Countdown' });

/**
 * Why an item is due soon: `task_due` for a task of the caller's due within 7 days or
 * overdue, `reminder` for an item the caller set their own reminder on (overlays.put) that
 * falls within 7 days of now, either side. Nothing is pushed in 1a (F-08).
 */
export const DueSoonKind = z.enum(['task_due', 'reminder']).meta({ id: 'DueSoonKind' });

export const DueSoon = z
  .strictObject({
    kind: DueSoonKind,
    item: Item,
    /** The caller's own reminder time; on `reminder` entries only, and never anyone else's. */
    reminderAt: Instant.optional(),
  })
  .meta({ id: 'DueSoon' });

/**
 * trips.dashboard. Items show and mask as items.list shows them, and only items the caller
 * can see count anywhere. myShare is the sum of the caller's shares in the trip's expenses
 * (R36: no balances, no who-owes-whom), masked for a viewer without canViewCosts.
 */
export const TripDashboard = z
  .strictObject({
    tripId: typeId(ID_PREFIX.trip),
    name: z.string(),
    countdown: Countdown,
    /** The next item to start, tasks, notes and documents aside; null when none is ahead. */
    nextItem: Item.nullable(),
    /** The caller's tasks not done or cancelled, by due date. */
    openTasks: z.array(Item),
    dueSoon: z.array(DueSoon),
    myShare: z.union([Money, MaskedValue]),
    /** The rule checks over every item of the trip the caller can see. */
    warnings: z.array(Warning),
  })
  .meta({ id: 'TripDashboard' });

export type DueSoon = z.infer<typeof DueSoon>;

export type TripDashboard = z.infer<typeof TripDashboard>;
