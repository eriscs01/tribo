import {
  encodeTypeId,
  ID_PREFIX,
  PageQuery,
  type Expense,
  type ExpensePage,
} from '@tribo/contract';
import type { ExpenseRecord, ExpensesService } from '@tribo/core';
import { ifMatch, pathId, requestContext, signedIn } from '../context.js';
import { parsedQuery, type Handlers } from '../routes.js';

/** The service masks; this only names ids as the API does. */
function expenseView(expense: ExpenseRecord): Expense {
  return {
    id: encodeTypeId(ID_PREFIX.expense, expense.id),
    tripId: encodeTypeId(ID_PREFIX.trip, expense.tripId),
    itemId: expense.itemId === null ? null : encodeTypeId(ID_PREFIX.item, expense.itemId),
    category: expense.category,
    description: expense.description,
    spentOn: expense.spentOn,
    payerMembershipId: encodeTypeId(ID_PREFIX.membership, expense.payerMembershipId),
    amount: expense.amount,
    fxRate: expense.fxRate,
    tripAmount: expense.tripAmount,
    splitMethod: expense.splitMethod,
    shares: expense.shares.map((s) => ({
      membershipId: encodeTypeId(ID_PREFIX.membership, s.membershipId),
      amount: s.amount,
    })),
    version: expense.version,
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
  };
}

export function expensesHandlers(expenses: ExpensesService): Handlers {
  return {
    'expenses.create': async (request, reply) => {
      const expense = await expenses.create(
        requestContext(request),
        pathId(request, 'tripId'),
        request.body,
      );
      return reply.code(201).send(expenseView(expense));
    },
    'expenses.get': async (request) =>
      expenseView(await expenses.get(signedIn(request).userId, pathId(request, 'expenseId'))),
    'expenses.list': async (request): Promise<ExpensePage> => {
      const page = await expenses.list(
        signedIn(request).userId,
        pathId(request, 'tripId'),
        parsedQuery(request, PageQuery),
      );
      return { items: page.items.map(expenseView), nextCursor: page.nextCursor };
    },
    'expenses.update': async (request) =>
      expenseView(
        await expenses.update(
          requestContext(request),
          pathId(request, 'expenseId'),
          request.body,
          ifMatch(request),
        ),
      ),
    'expenses.void': async (request, reply) => {
      await expenses.void(
        requestContext(request),
        pathId(request, 'expenseId'),
        request.body,
        ifMatch(request),
      );
      return reply.code(204).send();
    },
  };
}
