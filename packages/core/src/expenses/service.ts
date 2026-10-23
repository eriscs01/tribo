// The expenses module: the trip's ledger of what was spent and how each expense is split
// among the members included (Technical design, "Expenses"). Record only: no balances,
// debts or settle-up (R36).
import {
  decodeTypeId,
  ExpenseInput,
  ID_PREFIX,
  MASKED,
  type ExpenseSplit,
  type MaskedValue,
  type Money,
} from '@tribo/contract';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import {
  actingUser,
  ApiError,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { visibleItemTrip } from '../items/service.js';
import {
  allActiveMemberships,
  callerMembership,
  tripCurrency,
  type CallerMembership,
} from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import { equalShares, itemisedShares, tripAmountMinor, type Share } from './money.js';
import { canCreateExpense } from './policy.js';
import {
  findExpense,
  hasMoneyRows,
  insertExpense,
  listShares,
  sumShares,
  type ExpenseRow,
} from './repo.js';

/**
 * R9: money is recorded in the trip currency once the trip has an expense or a budget
 * line. A voided expense counts too: its frozen amounts come back on restore.
 */
export function moneyRecorded(db: Kysely<DB>, tripId: string): Promise<boolean> {
  return hasMoneyRows(forModule(db, 'expenses'), tripId);
}

/**
 * "My share" (R36): the sum of this membership's shares on the trip's expenses not voided,
 * in minor units of the trip currency; 0 with none. Never a balance: what the member paid
 * and who owes whom are not part of it. Whether the caller may see it is theirs to check.
 */
export function memberShare(db: Kysely<DB>, tripId: string, membershipId: string): Promise<number> {
  return sumShares(forModule(db, 'expenses'), tripId, membershipId);
}

/** An amount as one caller reads it: itself, or masked for a viewer without canViewCosts. */
export type Cost = Money | MaskedValue;

/** An expense as the expenses service answers it, already masked for the caller. */
export interface ExpenseRecord {
  id: string;
  tripId: string;
  /** Null on no item, or on one the caller cannot see. */
  itemId: string | null;
  category: string;
  description: string;
  spentOn: string;
  payerMembershipId: string;
  amount: Cost;
  fxRate: string;
  tripAmount: Cost;
  splitMethod: ValueOf<'tribo.expenses.split_method'>;
  shares: { membershipId: string; amount: Cost }[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpensesService {
  /**
   * expenses.create: records an expense in the trip currency with its shares frozen; the
   * payer and every member named must be active members of the trip.
   */
  create(ctx: RequestContext, tripId: string, body: unknown): Promise<ExpenseRecord>;
}

const expensesCreate = writeOperation('expenses.create', ExpenseInput);

type ShareRow = Awaited<ReturnType<typeof listShares>>[number];

/** numeric(18, 8) as text, without trailing zeros: '1.00000000' reads '1'. */
function plainRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/0+$/, '').replace(/\.$/, '') : rate;
}

/**
 * The one expense serializer: every amount masked for a caller who may not read costs,
 * the item link as the row gives it to this reader (repo.ts nulls a hidden one).
 */
function expenseRecord(
  row: ExpenseRow,
  shares: readonly ShareRow[],
  currency: string,
  viewer: Pick<CallerMembership, 'canViewCosts'>,
): ExpenseRecord {
  const cost = (amountMinor: number | string, of: string): Cost =>
    viewer.canViewCosts ? { amountMinor: Number(amountMinor), currency: of } : MASKED;
  return {
    id: row.id,
    tripId: row.trip_id,
    itemId: row.shown_item_id,
    category: row.category,
    description: row.description,
    spentOn: row.spent_on,
    payerMembershipId: row.payer_membership_id,
    amount: cost(row.amount_minor, row.currency),
    fxRate: plainRate(row.fx_rate),
    tripAmount: cost(row.trip_amount_minor, currency),
    splitMethod: row.split_method as ExpenseRecord['splitMethod'],
    shares: shares.map((s) => ({
      membershipId: s.membership_id,
      amount: cost(s.share_minor, currency),
    })),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The expense aggregate's snapshot: the row and its shares, as restore would copy them. */
function expenseSnapshot(row: ExpenseRow, shares: readonly ShareRow[]) {
  return {
    tripId: row.trip_id,
    itemId: row.item_id,
    category: row.category,
    description: row.description,
    spentOn: row.spent_on,
    payerMembershipId: row.payer_membership_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    fxRate: plainRate(row.fx_rate),
    tripAmountMinor: Number(row.trip_amount_minor),
    splitMethod: row.split_method,
    shares: shares.map((s) => ({
      membershipId: s.membership_id,
      shareMinor: Number(s.share_minor),
    })),
  };
}

const refused = (path: string, message: string) =>
  new ApiError('validation_failed', { errors: [{ path, message }] });

/**
 * The item an expense is on: one the caller sees (tribo.item_visible) in the expense's
 * trip. A hidden item, one of another trip and one that does not exist are refused alike.
 */
async function linkableItem(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
  itemId: string,
): Promise<string> {
  const id = decodeTypeId(ID_PREFIX.item, itemId);
  if ((await visibleItemTrip(db, userId, id)) !== tripId) {
    throw refused('/itemId', 'no such item in this trip');
  }
  return id;
}

/**
 * Members a body names must be active memberships of the trip, placeholders included
 * (decision 0007). One of another trip, a removed one and one that does not exist are
 * refused alike, by one query.
 */
async function requireMembers(
  db: Kysely<DB>,
  tripId: string,
  membershipIds: readonly string[],
  path: string,
): Promise<void> {
  if (!(await allActiveMemberships(db, tripId, membershipIds))) {
    throw refused(path, 'no such member in this trip');
  }
}

const memberId = (typeId: string) => decodeTypeId(ID_PREFIX.membership, typeId);

/** What a split freezes over the trip amount (R11, rule 2), with the path its members are at. */
function frozenShares(total: number, split: ExpenseSplit): { shares: Share[]; path: string } {
  if (split.method === 'equal') {
    return {
      shares: equalShares(total, split.membershipIds.map(memberId)),
      path: '/split/membershipIds',
    };
  }
  return {
    shares: itemisedShares(
      total,
      split.shares.map((s) => ({
        membershipId: memberId(s.membershipId),
        amountMinor: s.amountMinor,
      })),
    ),
    path: '/split/shares',
  };
}

/** Drop B takes the trip currency only, so the rate is 1 (decision 0016's limits). */
const TRIP_RATE = '1';

/**
 * Everything an amount and a split must be before they are written: in the trip currency,
 * shared among active members only, and summing to the trip amount.
 */
async function pricedExpense(
  tx: Tx,
  tripId: string,
  amount: { amountMinor: number; currency: string },
  split: ExpenseSplit,
) {
  const currency = await tripCurrency(tx, tripId);
  if (amount.currency !== currency) {
    throw refused('/amount/currency', 'expenses are in the trip currency');
  }
  const total = tripAmountMinor(amount.amountMinor, TRIP_RATE, amount.currency, currency);
  const { shares, path } = frozenShares(total, split);
  await requireMembers(
    tx,
    tripId,
    shares.map((s) => s.membershipId),
    path,
  );
  return { currency, total, shares };
}

/** The caller adding to the trip's ledger: their active membership, which a viewer's is not. */
async function recorder(tx: Tx, ctx: RequestContext, tripId: string) {
  const userId = actingUser(ctx);
  const membership = await callerMembership(tx, userId, tripId);
  if (membership === null) throw new ApiError('not_found');
  if (!canCreateExpense(membership.role)) throw new ApiError('forbidden');
  return { userId, membership };
}

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createExpensesService(db: Kysely<DB>, write: WritePath): ExpensesService {
  return {
    create(ctx, tripId, body) {
      return write(ctx, {
        operation: expensesCreate,
        target: { tripId },
        body,
        ifMatch: undefined,
        authorize: (tx, c, target) => recorder(tx, c, target.tripId),
        load: async (tx, target, input, { userId }) => {
          const itemId =
            input.itemId === undefined
              ? null
              : await linkableItem(tx, userId, target.tripId, input.itemId);
          const payer = memberId(input.payerMembershipId);
          await requireMembers(tx, target.tripId, [payer], '/payerMembershipId');
          const priced = await pricedExpense(tx, target.tripId, input.amount, input.split);
          return { tripId: target.tripId, itemId, payer, ...priced };
        },
        mutate: async (tx, _c, loaded, input, { userId, membership }) => {
          const expenses = forModule(tx, 'expenses');
          const id = await insertExpense(
            expenses,
            {
              tripId: loaded.tripId,
              itemId: loaded.itemId,
              category: input.category,
              description: input.description,
              spentOn: input.spentOn,
              payerMembershipId: loaded.payer,
              amountMinor: input.amount.amountMinor,
              currency: input.amount.currency,
              fxRate: TRIP_RATE,
              tripAmountMinor: loaded.total,
              splitMethod: input.split.method,
              createdBy: userId,
            },
            loaded.shares,
          );
          const row = await findExpense(expenses, userId, id);
          if (!row) throw new Error(`expense ${id} vanished inside its own write`);
          const shares = await listShares(expenses, [id]);
          return {
            action: 'create',
            aggregate: 'expense',
            entityId: id,
            tripId: loaded.tripId,
            version: row.version,
            snapshot: expenseSnapshot(row, shares),
            result: expenseRecord(row, shares, loaded.currency, membership),
          };
        },
      });
    },
  };
}
