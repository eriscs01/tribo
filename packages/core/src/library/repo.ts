import type { ModuleDb } from '@tribo/db';

/** The library module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type LibraryDb = ModuleDb<'library'>;

/** An account's own person: user_id set forever, created by the account itself. */
export function insertAccountPerson(db: LibraryDb, userId: string, displayName: string) {
  return db
    .insertInto('tribo.persons')
    .values({ user_id: userId, display_name: displayName, created_by: userId })
    .returning(['id', 'user_id', 'display_name', 'version'])
    .executeTakeFirstOrThrow();
}

/** The live person of an account, or undefined (an erased or deleted account has none). */
export function findAccountPerson(db: LibraryDb, userId: string) {
  return db
    .selectFrom('tribo.persons')
    .select('id')
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}
