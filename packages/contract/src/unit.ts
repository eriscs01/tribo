// Unit schemas: the rooms of a lodging and the vehicles of a ground rental.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { MaskedValue } from './masked.js';
import { CurrencyCode, Money } from './money.js';
import { page } from './page.js';
import { Instant } from './time.js';

/** room: a lodging's room, its capacity the beds; vehicle: a ground rental, seats incl. driver. */
export const UnitKind = z.enum(['room', 'vehicle']).meta({ id: 'UnitKind' });

export type UnitKind = z.infer<typeof UnitKind>;

export const Unit = z
  .strictObject({
    id: typeId(ID_PREFIX.unit),
    itemId: typeId(ID_PREFIX.item),
    kind: UnitKind,
    label: z.string(),
    /** Beds of a room; seats of a vehicle, the driver's included. */
    capacity: z.int().min(1),
    bedType: z.string().nullable(),
    /** Nightly (room) or per-day (vehicle); masked as the item's cost is. */
    rate: z.union([Money, MaskedValue]).nullable(),
    /** Where the board shows it among the item's units, lowest first. */
    position: z.int().min(0),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Unit' });

export type Unit = z.infer<typeof Unit>;

/** units.list: one page of an item's units, in the order they were added. */
export const UnitPage = page(Unit, 'UnitPage');

export type UnitPage = z.infer<typeof UnitPage>;

/** A rate as written: never negative. */
const RateInput = z.strictObject({ amountMinor: z.int().min(0), currency: CurrencyCode });

/**
 * units.create. A room belongs to a lodging, a vehicle to a ground rental; a bed type is
 * a room's. Labels are unique among the item's live units.
 */
export const UnitInput = z
  .strictObject({
    kind: UnitKind,
    label: z.string().trim().min(1).max(100),
    capacity: z.int().min(1).max(100),
    bedType: z.string().trim().min(1).max(50).nullable().optional(),
    rate: RateInput.nullable().optional(),
    position: z.int().min(0).max(1000).optional(),
  })
  .check((ctx) => {
    if (ctx.value.kind === 'vehicle' && ctx.value.bedType != null) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['bedType'],
        message: 'a vehicle has no bed type',
      });
    }
  })
  .meta({ id: 'UnitInput' });

export type UnitInput = z.infer<typeof UnitInput>;

/**
 * units.update: JSON Merge Patch of a unit; absent keys stay, null clears. The kind never
 * changes. Sending back a masked rate is refused with masked_field_write, so echoing a
 * read never overwrites the real one. A capacity below the unit's current occupants is
 * capacity_exceeded.
 */
export const UnitPatch = z
  .strictObject({
    label: z.string().trim().min(1).max(100).optional(),
    capacity: z.int().min(1).max(100).optional(),
    bedType: z.string().trim().min(1).max(50).nullable().optional(),
    rate: z.union([MaskedValue, RateInput]).nullable().optional(),
    position: z.int().min(0).max(1000).optional(),
  })
  .meta({ id: 'UnitPatch' });

export type UnitPatch = z.infer<typeof UnitPatch>;
