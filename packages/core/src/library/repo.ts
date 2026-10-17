import type { ModuleDb } from '@tribo/db';

/** The library module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type LibraryDb = ModuleDb<'library'>;
