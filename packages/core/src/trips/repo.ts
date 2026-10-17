import type { ModuleDb } from '@tribo/db';

/** The trips module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type TripsDb = ModuleDb<'trips'>;
