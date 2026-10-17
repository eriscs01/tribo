import type { ModuleDb } from '@tribo/db';

/** The audit module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type AuditDb = ModuleDb<'audit'>;
