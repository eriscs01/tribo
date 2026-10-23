import { encodeTypeId, ID_PREFIX, type Expense } from '@tribo/contract';
import type { ExpenseRecord, ExpensesService } from '@tribo/core';
import { pathId, requestContext, signedIn } from '../context.js';
import type { Handlers } from '../routes.js';

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
  };
}
