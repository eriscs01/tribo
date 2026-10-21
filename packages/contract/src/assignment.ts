// The assignment board of an item: RSVPs, room occupants, vehicle drivers and passengers,
// flight or ferry passengers and assignees, read and saved whole under its boardVersion.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { Warning } from './warning.js';

/** What a member is on an item's board. */
export const AllocationRole = z
  .enum(['attendee', 'occupant', 'driver', 'passenger', 'assignee'])
  .meta({ id: 'AllocationRole' });

export type AllocationRole = z.infer<typeof AllocationRole>;

/** An attendee's answer; `pending` until they give one. */
export const RsvpState = z.enum(['pending', 'yes', 'no', 'maybe']).meta({ id: 'RsvpState' });

/** One row of the board. */
export const Allocation = z
  .strictObject({
    membershipId: typeId(ID_PREFIX.membership),
    role: AllocationRole,
    /** The room of an occupant, the vehicle of a driver; a passenger's vehicle, if any. */
    unitId: typeId(ID_PREFIX.unit).nullable(),
    /** An attendee's answer; null for every other role. */
    rsvp: RsvpState.nullable(),
  })
  .meta({ id: 'Allocation' });

export type Allocation = z.infer<typeof Allocation>;

/** items.assignments.get: the whole board, its counter, and the advisory checks on it. */
export const ItemBoard = z
  .strictObject({
    itemId: typeId(ID_PREFIX.item),
    /** Also the ETag; items.assignments.replace takes it as If-Match. */
    boardVersion: z.int().min(1),
    allocations: z.array(Allocation),
    warnings: z.array(Warning),
  })
  .meta({ id: 'ItemBoard' });

export type ItemBoard = z.infer<typeof ItemBoard>;

/** One row of the board as written; an attendee's rsvp defaults to `pending`. */
export const AllocationInput = z
  .strictObject({
    membershipId: typeId(ID_PREFIX.membership),
    role: AllocationRole,
    unitId: typeId(ID_PREFIX.unit).nullable().optional(),
    rsvp: RsvpState.optional(),
  })
  .check((ctx) => {
    const { role, unitId, rsvp } = ctx.value;
    const issue = (path: string, message: string) =>
      ctx.issues.push({ code: 'custom', input: ctx.value, path: [path], message });
    if ((role === 'occupant' || role === 'driver') && unitId == null) {
      issue(
        'unitId',
        role === 'occupant' ? 'an occupant needs a room' : 'a driver needs a vehicle',
      );
    }
    if ((role === 'attendee' || role === 'assignee') && unitId != null) {
      issue('unitId', `an ${role} takes no unit`);
    }
    if (rsvp !== undefined && role !== 'attendee') issue('rsvp', 'only an attendee answers');
  })
  .meta({ id: 'AllocationInput' });

export type AllocationInput = z.infer<typeof AllocationInput>;

/**
 * items.assignments.replace: the whole board, replacing every row under If-Match on its
 * boardVersion. Each member holds each role once and one seat or bed per item; a member in
 * two rooms is room_double_booked.
 */
export const ItemBoardInput = z
  .strictObject({ allocations: z.array(AllocationInput).max(500) })
  .meta({ id: 'ItemBoardInput' });

export type ItemBoardInput = z.infer<typeof ItemBoardInput>;
