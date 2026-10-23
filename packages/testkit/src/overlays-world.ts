// What the overlays stories test against: the board world's trip (one member of each role, an
// outsider, a shared guest house owned by the trip owner) plus a private item of another member
// and a second shared activity. Each call builds a fresh trip, so tests never share rows.
import { createOverlaysService, writePath, type OverlaysService } from '@tribo/core';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { boardWorld } from './board-world.js';
import type { TestDatabase } from './database.js';
import { createItem } from './factories.js';
import type { BuiltWorld } from './leak.js';

export function overlaysService(db: Kysely<DB>): OverlaysService {
  return createOverlaysService(db, writePath(db));
}

export async function overlaysWorld(tdb: TestDatabase) {
  const w = await boardWorld(tdb);
  const hidden = await createItem(tdb.db, {
    tripId: w.tripId,
    ownerMembershipId: w.other.membershipId,
    type: 'note',
    title: 'Surprise for the owner',
    visibility: 'private',
  });
  return { ...w, hidden };
}

export type OverlaysWorld = Awaited<ReturnType<typeof overlaysWorld>>;

/** The overlay rows an item has, live or not, oldest first. */
export function overlayRows(tdb: TestDatabase, itemId: string) {
  return tdb.db
    .selectFrom('tribo.overlays')
    .selectAll()
    .where('item_id', '=', itemId)
    .orderBy('id')
    .execute();
}

/** What a seeded overlay's note says, so a read that shows someone else's is caught by value. */
export const overlayNote = (membershipId: string, itemId: string) =>
  `ovl-note:${membershipId}:${itemId}`;

/**
 * Gives every membership of the world, removed ones included, an overlay on every item of its
 * trip, each carrying its owner's marker in the note, the checklist and the reminder. Returns
 * the reminder time so a test can look for it.
 */
export async function seedOverlays(trx: Kysely<DB>, world: BuiltWorld): Promise<void> {
  const rows = world.trips.flatMap((trip) =>
    trip.members.flatMap((member) =>
      trip.items.map((item) => ({
        trip_id: trip.id,
        item_id: item.id,
        membership_id: member.id,
        note: overlayNote(member.id, item.id),
        reminder_at: new Date('2026-11-13T02:00:00Z'),
        checklist: JSON.stringify([{ text: `ovl-check:${member.id}`, done: false }]),
      })),
    ),
  );
  if (rows.length > 0) await trx.insertInto('tribo.overlays').values(rows).execute();
}

/** The membership the account holds in the trip while it is active, or undefined. */
export function activeMembership(world: BuiltWorld, userId: string, tripId: string) {
  const person = world.persons.find((p) => p.userId === userId);
  const trip = world.trips.find((t) => t.id === tripId);
  return trip?.members.find((m) => m.personId === person?.id && !m.deleted);
}

/** A handle that counts the statements run through it. */
export function counted(db: Kysely<DB>) {
  const state = { queries: 0 };
  const handle = db.withPlugin({
    transformQuery(args) {
      state.queries += 1;
      return args.node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  });
  return { handle, state };
}
