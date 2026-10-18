// Place schemas: the one shared library of places every account sees and adds to (G11).
import * as z from 'zod';
import { Links } from './contacts.js';
import { ID_PREFIX, typeId } from './ids.js';
import { Instant } from './time.js';

export const PlaceKind = z
  .enum(['destination', 'beach', 'landmark', 'port', 'airport', 'lodging', 'restaurant', 'other'])
  .meta({ id: 'PlaceKind' });

/** WGS 84 degrees; stored to six decimals (about 10 cm). */
export const LatLng = z
  .strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .meta({ id: 'LatLng' });

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

/** Opening hours as local wall-clock times, one entry per opening; rules are checked later. */
export const OpeningHours = z
  .array(
    z.strictObject({
      day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      opens: Clock,
      closes: Clock,
    }),
  )
  .max(50)
  .meta({ id: 'OpeningHours' });

export type OpeningHours = z.infer<typeof OpeningHours>;

/** library.places.create. */
export const PlaceInput = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    kind: PlaceKind.optional(),
    location: LatLng.optional(),
    address: z.string().trim().min(1).max(500).optional(),
    hours: OpeningHours.optional(),
    links: Links.optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
  })
  .meta({ id: 'PlaceInput' });

export type PlaceInput = z.infer<typeof PlaceInput>;

export const Place = z
  .strictObject({
    id: typeId(ID_PREFIX.place),
    name: z.string(),
    kind: PlaceKind,
    location: LatLng.nullable(),
    address: z.string().nullable(),
    hours: OpeningHours.nullable(),
    links: z.array(z.string()),
    notes: z.string().nullable(),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Place' });

export type Place = z.infer<typeof Place>;
