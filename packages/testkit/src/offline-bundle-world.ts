// What the offline bundle story tests against: the tickets world's trip (one member of each
// role, an outsider, a guest house, an e-bike rental, a shared ferry and bus, and another
// member's private flight) with something of every kind the bundle carries on it: tickets,
// overlays, expenses, files, a board, a sealed booking ref and emergency contacts. Every
// sealed value and every private note carries a marker, so a bundle that shows one is caught
// by value. Each call builds a fresh trip, so tests never share rows.
import { createOfflineBundleService, type OfflineBundleService } from '@tribo/core';
import { seal, sealJson, type Keyring } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import type { TestDatabase } from './database.js';
import {
  addAllocation,
  createExpense,
  createFile,
  createOverlay,
  createTicket,
} from './factories.js';
import { ticketsWorld } from './tickets-world.js';

export function offlineBundleService(
  db: Kysely<DB>,
  deps: Parameters<typeof createOfflineBundleService>[1] = {},
): OfflineBundleService {
  return createOfflineBundleService(db, deps);
}

/** The markers a bundle must never show: sealed plaintext and other members' private notes. */
export const SEALED_MARKERS = ['bundle-ref:', 'bundle-tkt:', 'bundle-sos:'] as const;

/** Seals a booking ref on the item, as items.create does. */
export async function sealBookingRef(
  db: Kysely<DB>,
  keys: Keyring,
  itemId: string,
  value: string,
): Promise<void> {
  await db
    .updateTable('tribo.items')
    .set({
      booking_ref_enc: seal(
        keys,
        { table: 'items', column: 'booking_ref_enc', rowId: itemId },
        value,
      ),
    })
    .where('id', '=', itemId)
    .execute();
}

/** Seals an emergency contact on the person, as me.update does. */
export async function sealEmergencyContact(
  db: Kysely<DB>,
  keys: Keyring,
  personId: string,
  contact: { name: string; phone: string },
): Promise<void> {
  await db
    .updateTable('tribo.persons')
    .set({
      emergency_contact_enc: sealJson(
        keys,
        { table: 'persons', column: 'emergency_contact_enc', rowId: personId },
        contact,
      ),
    })
    .where('id', '=', personId)
    .execute();
}

export async function offlineBundleWorld(tdb: TestDatabase) {
  const w = await ticketsWorld(tdb);
  const { db } = tdb;
  const ticket = (itemId: string, membershipId: string) =>
    createTicket(db, w.keys, {
      tripId: w.tripId,
      itemId,
      membershipId,
      seat: `seat-${membershipId.slice(-4)}`,
      ticketNo: `bundle-tkt:${membershipId}:${itemId}`,
      baggage: { checked_kg: 20 },
    });
  const overlay = (itemId: string, membershipId: string) =>
    createOverlay(db, {
      tripId: w.tripId,
      itemId,
      membershipId,
      note: `bundle-note:${membershipId}:${itemId}`,
    });

  await sealBookingRef(db, w.keys, w.ferry, 'bundle-ref:ferry');
  for (const person of [w.owner, w.member, w.other, w.viewer]) {
    // eslint-disable-next-line no-await-in-loop -- one row each
    await sealEmergencyContact(db, w.keys, person.personId, {
      name: `bundle-sos:${person.personId}`,
      phone: '+63 917 555 0100',
    });
  }
  await addAllocation(db, {
    tripId: w.tripId,
    itemId: w.lodging,
    membershipId: w.member.membershipId,
    role: 'occupant',
    unitId: w.room1,
  });
  await addAllocation(db, {
    tripId: w.tripId,
    itemId: w.rental,
    membershipId: w.member.membershipId,
    role: 'driver',
    unitId: w.bike,
  });

  return {
    ...w,
    bundle: offlineBundleService(db),
    seeded: {
      tickets: {
        memberFerry: await ticket(w.ferry, w.member.membershipId),
        memberBus: await ticket(w.bus, w.member.membershipId),
        ownerFerry: await ticket(w.ferry, w.owner.membershipId),
        otherFlight: await ticket(w.flight, w.other.membershipId),
        viewerFerry: await ticket(w.ferry, w.viewer.membershipId),
      },
      overlays: {
        memberFerry: await overlay(w.ferry, w.member.membershipId),
        otherFerry: await overlay(w.ferry, w.other.membershipId),
        otherFlight: await overlay(w.flight, w.other.membershipId),
        // Kept from before a demotion: a viewer keeps no overlay, so none is read.
        viewerFerry: await overlay(w.ferry, w.viewer.membershipId),
      },
      expenses: {
        ferry: await createExpense(db, {
          tripId: w.tripId,
          payerMembershipId: w.owner.membershipId,
          shares: [{ membershipId: w.member.membershipId, amount: 40_000 }],
          itemId: w.ferry,
        }),
        flight: await createExpense(db, {
          tripId: w.tripId,
          payerMembershipId: w.other.membershipId,
          shares: [{ membershipId: w.other.membershipId, amount: 90_000 }],
          itemId: w.flight,
        }),
        voided: await createExpense(db, {
          tripId: w.tripId,
          payerMembershipId: w.owner.membershipId,
          shares: [{ membershipId: w.owner.membershipId, amount: 1_000 }],
          voided: true,
        }),
      },
      files: {
        shared: await createFile(db, {
          tripId: w.tripId,
          ownerMembershipId: w.owner.membershipId,
          itemId: w.ferry,
          kind: 'ticket',
        }),
        othersPrivate: await createFile(db, {
          tripId: w.tripId,
          ownerMembershipId: w.other.membershipId,
          visibility: 'private',
        }),
        onFlight: await createFile(db, {
          tripId: w.tripId,
          ownerMembershipId: w.other.membershipId,
          itemId: w.flight,
        }),
        purged: await createFile(db, {
          tripId: w.tripId,
          ownerMembershipId: w.owner.membershipId,
          kind: 'id',
          purged: true,
        }),
        deleted: await createFile(db, {
          tripId: w.tripId,
          ownerMembershipId: w.owner.membershipId,
          deleted: true,
        }),
      },
    },
  };
}

export type OfflineBundleWorld = Awaited<ReturnType<typeof offlineBundleWorld>>;
