// Vendor schemas: the shared library of airlines, lodgings, operators and the like (G11).
import * as z from 'zod';
import { Contacts, Links } from './contacts.js';
import { ID_PREFIX, typeId } from './ids.js';
import { Instant } from './time.js';

export const VendorKind = z
  .enum([
    'airline',
    'lodging',
    'tour_operator',
    'rental',
    'ferry_line',
    'bus_line',
    'restaurant',
    'other',
  ])
  .meta({ id: 'VendorKind' });

/** library.vendors.create. */
export const VendorInput = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    kind: VendorKind.optional(),
    /** Where the vendor is, if it has one place; a merged place id resolves to its survivor. */
    placeId: typeId(ID_PREFIX.place).optional(),
    contacts: Contacts.optional(),
    links: Links.optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
  })
  .meta({ id: 'VendorInput' });

export type VendorInput = z.infer<typeof VendorInput>;

export const Vendor = z
  .strictObject({
    id: typeId(ID_PREFIX.vendor),
    name: z.string(),
    kind: VendorKind,
    placeId: typeId(ID_PREFIX.place).nullable(),
    contacts: Contacts,
    links: z.array(z.string()),
    notes: z.string().nullable(),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Vendor' });

export type Vendor = z.infer<typeof Vendor>;
