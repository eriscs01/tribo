import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { MaskedValue } from './masked.js';
import { CurrencyCode, Money } from './money.js';
import { page, PageQuery } from './page.js';
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

/** Either kind of time as a rule sees it: wall-clock plus zone, or an all-day date. */
type ItemTimeShape = { local: string; tz: string } | { date: string };

/**
 * The time rules one row can't fully state before the server resolves zones: an end needs
 * a start, both are timed or both all-day, and all-day dates run forwards. items.create
 * checks its body with it, items.update the merged result. A timed end before its start is
 * only known once PostgreSQL has resolved both zones (items_time_order).
 */
export function itemTimeProblem(
  start: ItemTimeShape | null | undefined,
  end: ItemTimeShape | null | undefined,
): string | null {
  if (end == null) return null;
  if (start == null) return 'an end needs a start';
  if ('date' in start !== 'date' in end) return 'start and end are both timed or both all-day';
  if ('date' in start && 'date' in end && end.date < start.date) {
    return 'the item ends before it starts';
  }
  return null;
}

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
    const timeProblem = itemTimeProblem(start, end);
    if (timeProblem !== null) issue('end', timeProblem);
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
    /** The booked price; masked for a viewer without canViewCosts. */
    cost: z.union([Money, MaskedValue]).nullable(),
    /** Masked for every reader when set; the plaintext comes only from items.reveal. */
    bookingRef: MaskedValue.nullable(),
    cardLast4: MaskedValue.nullable(),
    version: z.int().min(1),
    boardVersion: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Item' });

export type Item = z.infer<typeof Item>;

/**
 * items.list filters. `from`/`to` keep the items whose days (in their own zones) overlap
 * that inclusive range, so undated items drop out; `assignee=me` keeps the caller's tasks.
 */
export const ItemListQuery = PageQuery.extend({
  type: ItemType.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  assignee: z.literal('me').optional(),
}).refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
  message: 'the range ends before it starts',
  path: ['to'],
});

export type ItemListQuery = z.infer<typeof ItemListQuery>;

/** items.list: one page of the trip's items the caller may see, in the order they were added. */
export const ItemPage = page(Item, 'ItemPage');

export type ItemPage = z.infer<typeof ItemPage>;

/** A booked price as written: never negative. */
const CostInput = z.strictObject({ amountMinor: z.int().min(0), currency: CurrencyCode });

/**
 * items.update: JSON Merge Patch of an item; absent keys stay, null clears. The type and
 * owner never change. Sending back a masked value is refused with masked_field_write, so
 * echoing a read never overwrites the real one. sharedWith replaces the shares whole and
 * needs the resulting visibility to be `selected`; leaving `selected` drops them.
 */
export const ItemPatch = z
  .strictObject({
    title: z.string().trim().min(1).max(300).optional(),
    status: ItemStatus.optional(),
    start: TimeInput.nullable().optional(),
    end: TimeInput.nullable().optional(),
    visibility: ItemVisibility.optional(),
    /** Membership ids of this trip. */
    sharedWith: z.array(typeId(ID_PREFIX.membership)).max(200).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    cost: z.union([MaskedValue, CostInput]).nullable().optional(),
    bookingRef: z
      .union([MaskedValue, z.string().trim().min(1).max(100)])
      .nullable()
      .optional(),
    cardLast4: z
      .union([MaskedValue, z.string().regex(/^\d{4}$/, 'expected four digits')])
      .nullable()
      .optional(),
  })
  .meta({ id: 'ItemPatch' });

export type ItemPatch = z.infer<typeof ItemPatch>;

/** An answer to an item's invitation; `pending` is what the board shows before one. */
export const RsvpAnswer = z.enum(['yes', 'no', 'maybe']).meta({ id: 'RsvpAnswer' });

/** items.rsvp: the caller's own answer, replacing any earlier one (last write wins). */
export const ItemRsvpInput = z.strictObject({ rsvp: RsvpAnswer }).meta({ id: 'ItemRsvpInput' });

export type ItemRsvpInput = z.infer<typeof ItemRsvpInput>;

/** The caller's attendee row after items.rsvp, and the board counter it bumped. */
export const ItemRsvp = z
  .strictObject({
    itemId: typeId(ID_PREFIX.item),
    membershipId: typeId(ID_PREFIX.membership),
    rsvp: RsvpAnswer,
    boardVersion: z.int().min(1),
  })
  .meta({ id: 'ItemRsvp' });

export type ItemRsvp = z.infer<typeof ItemRsvp>;

/** The item fields a reveal can show: the ones every read masks. */
export const ItemRevealField = z.enum(['bookingRef', 'cardLast4']).meta({ id: 'ItemRevealField' });

export type ItemRevealField = z.infer<typeof ItemRevealField>;

/** items.reveal: which masked fields to show; each call is its own audited reveal (R2). */
export const ItemRevealInput = z
  .strictObject({
    fields: z
      .array(ItemRevealField)
      .min(1)
      .max(2)
      .refine((f) => new Set(f).size === f.length, 'each field once'),
  })
  .meta({ id: 'ItemRevealInput' });

export type ItemRevealInput = z.infer<typeof ItemRevealInput>;

/** The plaintext of the fields asked for (null when none is stored); never cached offline. */
export const ItemReveal = z
  .strictObject({
    bookingRef: z.string().nullable().optional(),
    cardLast4: z.string().nullable().optional(),
  })
  .meta({ id: 'ItemReveal' });

export type ItemReveal = z.infer<typeof ItemReveal>;
