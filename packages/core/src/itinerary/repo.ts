import type { ModuleDb } from '@tribo/db';
import { sql } from 'kysely';

/** The itinerary module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type ItineraryDb = ModuleDb<'itinerary'>;

/** The calendar date an instant falls on in a zone: PostgreSQL is the tz database's one reader. */
export async function localDate(db: ItineraryDb, at: Date, tz: string): Promise<string> {
  const { rows } = await sql<{ day: string }>`
    SELECT ((${at}::timestamptz) AT TIME ZONE ${tz})::date::text AS day`.execute(db);
  const day = rows[0]?.day;
  if (day === undefined) throw new Error('PostgreSQL returned no date');
  return day;
}
