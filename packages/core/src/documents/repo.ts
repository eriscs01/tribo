import type { ModuleDb } from '@tribo/db';

/** The documents module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type DocumentsDb = ModuleDb<'documents'>;
