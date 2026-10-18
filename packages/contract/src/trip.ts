import * as z from 'zod';
import { ID_PREFIX, typeId, Uuid } from './ids.js';
import { CurrencyCode } from './money.js';
import { page } from './page.js';
import { Instant, TimeZone } from './time.js';

/** A trip's lifecycle as the API shows it; `archived` is rendered from archived_at. */
export const TripStatus = z
  .enum(['draft', 'planning', 'active', 'completed', 'archived'])
  .meta({ id: 'TripStatus' });

/**
 * trips.create. The caller becomes the owner. Destinations join when the places library
 * lands (a Drop A story); a new trip starts in draft.
 */
export const TripInput = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    currency: CurrencyCode,
    timezone: TimeZone,
  })
  .refine((t) => t.endDate >= t.startDate, {
    message: 'the trip ends before it starts',
    path: ['endDate'],
  })
  .meta({ id: 'TripInput' });

export type TripInput = z.infer<typeof TripInput>;

export const Trip = z
  .strictObject({
    id: typeId(ID_PREFIX.trip),
    name: z.string(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    currency: CurrencyCode,
    timezone: TimeZone,
    status: TripStatus,
    /** Places from the library, in travel order. */
    destinations: z.array(typeId(ID_PREFIX.place)),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Trip' });

export type Trip = z.infer<typeof Trip>;

/** trips.list: the caller's trips, latest start first. */
export const TripPage = page(Trip, 'TripPage');

export type TripPage = z.infer<typeof TripPage>;

/**
 * The sort key a trips.list cursor carries: the last row's start date and id. Clients see
 * only the opaque cursor, so this stays out of the OpenAPI document.
 */
export const TripCursorKey = z.tuple([z.iso.date(), Uuid]);
