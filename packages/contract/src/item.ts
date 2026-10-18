import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { AllDay, Instant, TimeInput, TimeZone } from './time.js';

export const ItemType = z
  .enum(['transport', 'lodging', 'ground', 'activity', 'meal', 'task', 'note', 'document'])
  .meta({ id: 'ItemType' });

export const ItemStatus = z
  .enum(['draft', 'planned', 'booked', 'confirmed', 'open', 'done', 'cancelled'])
  .meta({ id: 'ItemStatus' });

/** shared = every member; private = its owner only; selected = its owner and sharedWith. */
export const ItemVisibility = z
  .enum(['shared', 'private', 'selected'])
  .meta({ id: 'ItemVisibility' });

const isAllDay = (t: TimeInput) => 'date' in t;

/**
 * items.create. Times are wall-clock plus zone, or all-day dates, never mixed; the server
 * resolves the instants. Typed `details`, cost, booking refs and warnings[] join with the
 * per-type stories.
 */
export const ItemInput = z
  .strictObject({
    type: ItemType,
    title: z.string().trim().min(1).max(300),
    status: ItemStatus.optional(),
    start: TimeInput.optional(),
    end: TimeInput.optional(),
    visibility: ItemVisibility.optional(),
    /** Membership ids of this trip; only with visibility `selected`. */
    sharedWith: z.array(typeId(ID_PREFIX.membership)).max(200).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .check((ctx) => {
    const { start, end, visibility, sharedWith } = ctx.value;
    const issue = (path: string, message: string) =>
      ctx.issues.push({ code: 'custom', input: ctx.value, path: [path], message });
    if (end !== undefined && start === undefined) issue('end', 'an end needs a start');
    if (start !== undefined && end !== undefined) {
      if (isAllDay(start) !== isAllDay(end)) {
        issue('end', 'start and end are both timed or both all-day');
      } else if ('date' in start && 'date' in end && end.date < start.date) {
        issue('end', 'the item ends before it starts');
      }
    }
    if (sharedWith !== undefined && visibility !== 'selected') {
      issue('sharedWith', 'sharedWith needs visibility selected');
    }
  })
  .meta({ id: 'ItemInput' });

export type ItemInput = z.infer<typeof ItemInput>;

/** A stored time: wall-clock plus zone with the instant it resolved to, or an all-day date. */
export const ItemTime = z
  .union([z.strictObject({ local: z.string(), tz: TimeZone, at: Instant }), AllDay])
  .meta({ id: 'ItemTime' });

export type ItemTime = z.infer<typeof ItemTime>;

export const Item = z
  .strictObject({
    id: typeId(ID_PREFIX.item),
    tripId: typeId(ID_PREFIX.trip),
    type: ItemType,
    title: z.string(),
    status: ItemStatus,
    start: ItemTime.nullable(),
    end: ItemTime.nullable(),
    visibility: ItemVisibility,
    ownerMembershipId: typeId(ID_PREFIX.membership),
    tags: z.array(z.string()),
    version: z.int().min(1),
    boardVersion: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Item' });

export type Item = z.infer<typeof Item>;
