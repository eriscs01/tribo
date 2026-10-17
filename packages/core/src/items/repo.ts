import type { ModuleDb } from '@tribo/db';

/** The items module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type ItemsDb = ModuleDb<'items'>;
