import type { ModuleDb } from '@tribo/db';

/** The identity module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type IdentityDb = ModuleDb<'identity'>;
