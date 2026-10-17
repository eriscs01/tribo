import type { ModuleDb } from '@tribo/db';

/** The expenses module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type ExpensesDb = ModuleDb<'expenses'>;
