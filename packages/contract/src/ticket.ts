// Ticket schemas: a passenger's ticket on a transport item (seat, ticket number, baggage).
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { MaskedValue } from './masked.js';
import { page } from './page.js';
import { Instant } from './time.js';

/** Baggage as every read shows it: weights in kilograms, add-ons by name. */
export const Baggage = z
  .strictObject({
    checkedKg: z.number().min(0).max(100).nullable(),
    cabinKg: z.number().min(0).max(100).nullable(),
    addOns: z.array(z.string()),
  })
  .meta({ id: 'Baggage' });

export type Baggage = z.infer<typeof Baggage>;

/**
 * One passenger's ticket on a transport item. The ticket number is masked on every read,
 * its owner's included: it shows as masked when one is stored and as null when none is,
 * and its plaintext comes only from tickets.reveal.
 */
export const Ticket = z
  .strictObject({
    id: typeId(ID_PREFIX.ticket),
    itemId: typeId(ID_PREFIX.item),
    /** The membership of the trip the ticket is for; a placeholder's, too. */
    passenger: typeId(ID_PREFIX.membership),
    seat: z.string().nullable(),
    ticketNo: MaskedValue.nullable(),
    baggage: Baggage,
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Ticket' });

export type Ticket = z.infer<typeof Ticket>;

/** tickets.list: one page of an item's tickets, in the order they were added. */
export const TicketPage = page(Ticket, 'TicketPage');

export type TicketPage = z.infer<typeof TicketPage>;

/** Baggage as written: weights in kilograms, add-ons by name; what is left out stays empty. */
const BaggageInput = z.strictObject({
  checkedKg: z.number().min(0).max(100).nullable().optional(),
  cabinKg: z.number().min(0).max(100).nullable().optional(),
  addOns: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});

const SeatInput = z.string().trim().min(1).max(20);
const TicketNoInput = z.string().trim().min(1).max(100);

/**
 * tickets.create. The passenger is an active membership of the item's trip, a placeholder's
 * too; a passenger holds one live ticket per item. The item must be a transport item.
 */
export const TicketInput = z
  .strictObject({
    passenger: typeId(ID_PREFIX.membership),
    seat: SeatInput.nullable().optional(),
    ticketNo: TicketNoInput.nullable().optional(),
    baggage: BaggageInput.optional(),
  })
  .meta({ id: 'TicketInput' });

export type TicketInput = z.infer<typeof TicketInput>;
