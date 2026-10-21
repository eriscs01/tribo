// Unit schemas: the rooms of a lodging and the vehicles of a ground rental.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { MaskedValue } from './masked.js';
import { Money } from './money.js';
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
