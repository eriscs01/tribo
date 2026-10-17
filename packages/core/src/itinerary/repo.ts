import type { ModuleDb } from '@tribo/db';

/** The itinerary module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type ItineraryDb = ModuleDb<'itinerary'>;
