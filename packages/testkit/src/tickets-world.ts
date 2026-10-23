// What the tickets stories test against: the board world's trip (one member of each role, an
// outsider, a guest house and an e-bike rental) plus three transport items: a shared ferry the
// trip owner holds, a shared bus the member holds, and a private flight of another member.
// Each call builds a fresh trip, so tests never share rows.
import type { Keyring } from '@tribo/crypto';
import { createTicketsService, writePath, type TicketsService } from '@tribo/core';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { boardWorld } from './board-world.js';
import type { TestDatabase } from './database.js';
import { createItem, createTicket } from './factories.js';
import { testKeys } from './keys.js';
import type { BuiltWorld } from './leak.js';

export function ticketsService(db: Kysely<DB>, keys: Keyring): TicketsService {
  return createTicketsService(db, writePath(db), keys);
}

export async function ticketsWorld(tdb: TestDatabase) {
  const w = await boardWorld(tdb);
  const keys = testKeys();
  const transport = (title: string, ownerMembershipId: string, visibility: 'shared' | 'private') =>
    createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId,
      type: 'transport',
      title,
      visibility,
      days: { start: '2026-11-11' },
    });
  return {
    ...w,
    keys,
    tickets: ticketsService(tdb.db, keys),
    ferry: await transport('Ferry to Coco Grove', w.owner.membershipId, 'shared'),
    bus: await transport('Bus to the pier', w.member.membershipId, 'shared'),
    flight: await transport('Flight home', w.other.membershipId, 'private'),
  };
}

export type TicketsWorld = Awaited<ReturnType<typeof ticketsWorld>>;

/** The ticket rows an item has, live or not, oldest first. */
export function ticketRows(tdb: TestDatabase, itemId: string) {
  return tdb.db
    .selectFrom('tribo.tickets')
    .selectAll()
    .where('item_id', '=', itemId)
    .orderBy('id')
    .execute();
}

/** What a seeded ticket says in its seat and number, so a read that shows one wrongly is caught by value. */
const ticketSeat = (membershipId: string, itemId: string) => `tkt-seat:${membershipId}:${itemId}`;
export const ticketNumber = (membershipId: string, itemId: string) =>
  `tkt-no:${membershipId}:${itemId}`;

export interface SeededTicket {
  id: string;
  itemId: string;
  membershipId: string;
  deleted: boolean;
}

/**
 * Gives every membership of the world, removed ones included, a live ticket on every
 * transport item of its trip (deleted ones too), and each item one removed ticket for its
 * owner. Each carries its passenger's and item's marker in the seat and the sealed number.
 */
export async function seedTickets(
  trx: Kysely<DB>,
  keys: Keyring,
  world: BuiltWorld,
): Promise<SeededTicket[]> {
  const seeded: SeededTicket[] = [];
  for (const trip of world.trips) {
    for (const item of trip.items.filter((i) => i.type === 'transport')) {
      const passengers = trip.members.map((m) => ({ membershipId: m.id, deleted: false }));
      passengers.push({ membershipId: item.ownerMembershipId, deleted: true });
      for (const { membershipId, deleted } of passengers) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, so one insert at a time
        const id = await createTicket(trx, keys, {
          tripId: trip.id,
          itemId: item.id,
          membershipId,
          seat: ticketSeat(membershipId, item.id),
          ticketNo: ticketNumber(membershipId, item.id),
          baggage: { checked_kg: 20 },
          deleted,
        });
        seeded.push({ id, itemId: item.id, membershipId, deleted });
      }
    }
  }
  return seeded;
}
