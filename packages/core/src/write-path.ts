import type { DB } from '@tribo/db';
import { createWritePath, type WritePath } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordWrite } from './audit/service.js';
import { guardTrip } from './trips/service.js';

/** The platform's write path with core's steps plugged in: the trips guard and the audit record. */
export function writePath(db: Kysely<DB>): WritePath {
  return createWritePath(db, { guardTrip, record: recordWrite });
}
