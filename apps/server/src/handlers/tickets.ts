import {
  encodeTypeId,
  ID_PREFIX,
  MASKED,
  PageQuery,
  type Ticket,
  type TicketPage,
} from '@tribo/contract';
import type { TicketRecord, TicketsService } from '@tribo/core';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';

/** Names ids and times as the API does; the ticket number is only ever shown as masked. */
function ticketView(ticket: TicketRecord): Ticket {
  return {
    id: encodeTypeId(ID_PREFIX.ticket, ticket.id),
    itemId: encodeTypeId(ID_PREFIX.item, ticket.itemId),
    passenger: encodeTypeId(ID_PREFIX.membership, ticket.passenger),
    seat: ticket.seat,
    ticketNo: ticket.ticketNo === 'masked' ? MASKED : null,
    baggage: ticket.baggage,
    version: ticket.version,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

export function ticketsHandlers(tickets: TicketsService): Handlers {
  return {
    // Seat, baggage and who holds a ticket are the group's business, not a shared cache's.
    'tickets.list': async (request, reply) => {
      const page = await tickets.list(
        signedIn(request).userId,
        pathId(request, 'itemId'),
        parsedQuery(request, PageQuery),
      );
      const answer: TicketPage = { items: page.items.map(ticketView), nextCursor: page.nextCursor };
      return reply.header('cache-control', 'private, no-store').send(answer);
    },

    'tickets.create': async (request, reply) => {
      const ticket = await tickets.create(
        requestContext(request),
        pathId(request, 'itemId'),
        request.body,
      );
      return reply.code(201).header('cache-control', 'private, no-store').send(ticketView(ticket));
    },

    'tickets.update': async (request, reply) => {
      const ticket = await tickets.update(
        requestContext(request),
        pathId(request, 'ticketId'),
        request.body,
        ifMatch(request),
      );
      return reply.header('cache-control', 'private, no-store').send(ticketView(ticket));
    },
  };
}
