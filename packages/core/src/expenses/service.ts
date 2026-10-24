// The expenses module: the trip's ledger of what was spent and how each expense is split
// among the members included (Technical design, "Expenses"). Record only: no balances,
// debts or settle-up (R36).
import {
  decodeTypeId,
  ExpenseCursorKey,
  ExpenseInput,
  ExpensePatch,
  ID_PREFIX,
  MASKED,
  NoBody,
  type ExpenseSplit,
  type MaskedValue,
  type Money,
  type PageQuery,
} from '@tribo/contract';
import { forModule, type DB, type TripRole, type ValueOf } from '@tribo/db';
import {
  actingUser,
  ApiError,
  decodeCursor,
  invalidCursor,
  page,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { visibleItemTrip } from '../items/service.js';
import type { Holder } from '../roles.js';
import {
  allActiveMemberships,
  callerMembership,
  tripCurrency,
  type CallerMembership,
} from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import { equalShares, itemisedShares, tripAmountMinor, type Share } from './money.js';
import {
  canCreateExpense,
  canGetExpense,
  canListExpenses,
  canUpdateExpense,
  canVoidExpense,
} from './policy.js';
import {
  expenseTrip,
  findExpense,
  findLiveExpense,
  hasMoneyRows,
  insertExpense,
  listLiveExpenses,
  listShares,
  lockExpense,
  replaceShares,
  sumShares,
  updateExpense,
  voidExpense,
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
   * expenses.list: one page of the trip's ledger, every expense not voided, to every active
   * member; not_found to anyone else.
   */
  list(
    userId: string,
    tripId: string,
    query: PageQuery,
  ): Promise<{ items: ExpenseRecord[]; nextCursor: string | null }>;
  /**
   * expenses.get: one expense of a trip the caller is an active member of, unless voided;
   * not_found for any other.
   */
  get(userId: string, expenseId: string): Promise<ExpenseRecord>;
  /**
   * expenses.create: records an expense in the trip currency with its shares frozen; the
   * payer and every member named must be active members of the trip.
   */
  create(ctx: RequestContext, tripId: string, body: unknown): Promise<ExpenseRecord>;
  /**
   * expenses.update: merge-patches an expense under If-Match = version; a new amount or
   * split refreezes the shares, under the same rules as create.
   */
  update(
    ctx: RequestContext,
    expenseId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<ExpenseRecord>;
  /**
   * expenses.void: a soft delete under If-Match = version. The expense leaves the ledger and
   * my share; its frozen shares stay, for restore (1b).
   */
  void(
    ctx: RequestContext,
    expenseId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<void>;
}

const expensesCreate = writeOperation('expenses.create', ExpenseInput);
const expensesUpdate = writeOperation('expenses.update', ExpensePatch);
const expensesVoid = writeOperation('expenses.void', NoBody);

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

/**
 * The trip's ledger as `viewer` (the caller's active membership in the trip) reads it, the
 * first `limit` expenses by the day spent then id, masked and with hidden item links nulled
 * as expenses.list shows them: the offline bundle's expenses.
 */
export async function tripExpenses(
  db: Kysely<DB>,
  userId: string,
  viewer: CallerMembership,
  trip: { id: string; currency: string },
  limit: number,
): Promise<ExpenseRecord[]> {
  if (!canListExpenses(viewer.role)) return [];
  const expenses = forModule(db, 'expenses');
  const rows = await listLiveExpenses(expenses, userId, trip.id, { limit, after: null });
  const shares = Map.groupBy(
    await listShares(
      expenses,
      rows.map((row) => row.id),
    ),
    (share) => share.expense_id,
  );
  return rows.map((row) => expenseRecord(row, shares.get(row.id) ?? [], trip.currency, viewer));
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

/** A split over membership ids: one a body names, or the one an expense has frozen. */
type Split =
  | { method: 'equal'; membershipIds: string[] }
  | { method: 'itemised'; shares: { membershipId: string; amountMinor: number }[] };

function namedSplit(split: ExpenseSplit): Split {
  return split.method === 'equal'
    ? { method: 'equal', membershipIds: split.membershipIds.map(memberId) }
    : {
        method: 'itemised',
        shares: split.shares.map((s) => ({
          membershipId: memberId(s.membershipId),
          amountMinor: s.amountMinor,
        })),
      };
}

/**
 * The split an expense has, to refreeze over a new amount: an equal one among the same
 * members, an itemised one with the same amounts. Drop B writes no weight split, so one
 * written otherwise needs a new split sent with its new amount.
 */
function keptSplit(row: ExpenseRow, shares: readonly ShareRow[]): Split {
  if (row.split_method === 'equal') {
    return { method: 'equal', membershipIds: shares.map((s) => s.membership_id) };
  }
  if (row.split_method === 'itemised') {
    return {
      method: 'itemised',
      shares: shares.map((s) => ({
        membershipId: s.membership_id,
        amountMinor: Number(s.share_minor),
      })),
    };
  }
  throw refused('/split', 'send the split with the new amount');
}

/** What a split freezes over the trip amount (R11, rule 2), with the path its members are at. */
function frozenShares(total: number, split: Split): { shares: Share[]; path: string } {
  return split.method === 'equal'
    ? { shares: equalShares(total, split.membershipIds), path: '/split/membershipIds' }
    : { shares: itemisedShares(total, split.shares), path: '/split/shares' };
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
  split: Split,
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

/** expenses.list's cursor: the last row's day spent and id, or validation_failed at /cursor. */
function ledgerCursor(cursor: string): { spentOn: string; id: string } {
  const key = ExpenseCursorKey.safeParse(decodeCursor(cursor, 2));
  if (!key.success) throw invalidCursor();
  const [spentOn, id] = key.data;
  return { spentOn, id };
}

/** Stands in for the trip of an expense that does not exist, so its lookups still run. */
const NO_ROW = '00000000-0000-0000-0000-000000000000';

/**
 * An expense the reader may see, with their membership in its trip, or not_found: the
 * ledger stays whole, so every active member of a live trip sees its expenses that are
 * not voided. The same queries run whether the expense is voided, in another trip or
 * unknown, so neither the answer nor its cost tells them apart.
 */
async function readableExpense(
  db: Kysely<DB>,
  userId: string,
  expenseId: string,
  allowed: (role: TripRole) => boolean,
): Promise<{ row: ExpenseRow; membership: CallerMembership }> {
  const expenses = forModule(db, 'expenses');
  const membership = await callerMembership(
    db,
    userId,
    (await expenseTrip(expenses, expenseId)) ?? NO_ROW,
  );
  const row = await findLiveExpense(expenses, userId, expenseId);
  if (!row || !membership) throw new ApiError('not_found');
  if (!allowed(membership.role)) throw new ApiError('forbidden');
  return { row, membership };
}

/**
 * Who is acting on an expense they can see: their account and membership, and whether
 * `allowed` lets them. An expense is a member's own when they paid it (decision 0024). An
 * expense they cannot see does not exist for them, before any role is weighed.
 */
async function actingOnExpense(
  tx: Tx,
  ctx: RequestContext,
  expenseId: string,
  allowed: (holder: Holder) => boolean,
) {
  const userId = actingUser(ctx);
  const { row, membership } = await readableExpense(tx, userId, expenseId, () => true);
  if (!allowed({ role: membership.role, owns: row.payer_membership_id === membership.id })) {
    throw new ApiError('forbidden');
  }
  return { userId, membership };
}

/** The write path's load for one expense: the live row and its shares, locked until commit. */
async function lockedExpense(tx: Tx, target: { expenseId: string }, userId: string) {
  const expenses = forModule(tx, 'expenses');
  const row = await lockExpense(expenses, userId, target.expenseId);
  if (!row) throw new ApiError('not_found');
  return {
    tripId: row.trip_id,
    counter: row.version,
    row,
    shares: await listShares(expenses, [row.id]),
  };
}

/**
 * The item link a patch leaves: a link the caller cannot see stays when they send null
 * (their read showed them null), so they neither learn of it nor drop it unseen.
 */
async function patchedItem(
  tx: Tx,
  userId: string,
  row: ExpenseRow,
  itemId: string | null | undefined,
): Promise<string | null | undefined> {
  if (itemId === undefined) return undefined;
  if (itemId === null) return row.shown_item_id === row.item_id ? null : undefined;
  return linkableItem(tx, userId, row.trip_id, itemId);
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
    async list(userId, tripId, query) {
      const membership = await callerMembership(db, userId, tripId);
      if (membership === null) throw new ApiError('not_found');
      if (!canListExpenses(membership.role)) throw new ApiError('forbidden');
      const expenses = forModule(db, 'expenses');
      const rows = await listLiveExpenses(expenses, userId, tripId, {
        limit: query.limit + 1,
        after: query.cursor === undefined ? null : ledgerCursor(query.cursor),
      });
      const shown = page(rows, query.limit, (row) => [row.spent_on, row.id]);
      const shares = Map.groupBy(
        await listShares(
          expenses,
          shown.rows.map((row) => row.id),
        ),
        (share) => share.expense_id,
      );
      const currency = await tripCurrency(db, tripId);
      return {
        items: shown.rows.map((row) =>
          expenseRecord(row, shares.get(row.id) ?? [], currency, membership),
        ),
        nextCursor: shown.nextCursor,
      };
    },

    async get(userId, expenseId) {
      const { row, membership } = await readableExpense(db, userId, expenseId, canGetExpense);
      const shares = await listShares(forModule(db, 'expenses'), [row.id]);
      return expenseRecord(row, shares, await tripCurrency(db, row.trip_id), membership);
    },

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
          const priced = await pricedExpense(
            tx,
            target.tripId,
            input.amount,
            namedSplit(input.split),
          );
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

    update(ctx, expenseId, body, ifMatch) {
      return write(ctx, {
        operation: expensesUpdate,
        target: { expenseId },
        body,
        ifMatch,
        authorize: (tx, c, target) => actingOnExpense(tx, c, target.expenseId, canUpdateExpense),
        load: (tx, target, _patch, { userId }) => lockedExpense(tx, target, userId),
        mutate: async (tx, _c, { row, shares: frozen }, patch, { userId, membership }) => {
          const expenses = forModule(tx, 'expenses');
          const itemId = await patchedItem(tx, userId, row, patch.itemId);
          const payer =
            patch.payerMembershipId === undefined ? undefined : memberId(patch.payerMembershipId);
          if (payer !== undefined) {
            await requireMembers(tx, row.trip_id, [payer], '/payerMembershipId');
          }
          // Shares are refrozen only when the money changes, among active members only.
          const repriced =
            patch.amount === undefined && patch.split === undefined
              ? null
              : await pricedExpense(
                  tx,
                  row.trip_id,
                  patch.amount ?? { amountMinor: Number(row.amount_minor), currency: row.currency },
                  patch.split === undefined ? keptSplit(row, frozen) : namedSplit(patch.split),
                );
          const version = await updateExpense(
            expenses,
            row.id,
            {
              ...(itemId === undefined ? {} : { itemId }),
              ...(patch.category === undefined ? {} : { category: patch.category }),
              ...(patch.description === undefined ? {} : { description: patch.description }),
              ...(patch.spentOn === undefined ? {} : { spentOn: patch.spentOn }),
              ...(payer === undefined ? {} : { payerMembershipId: payer }),
              ...(patch.amount === undefined ? {} : { amountMinor: patch.amount.amountMinor }),
              ...(repriced === null
                ? {}
                : {
                    tripAmountMinor: repriced.total,
                    splitMethod: patch.split?.method ?? (row.split_method as Split['method']),
                  }),
            },
            userId,
          );
          if (repriced !== null)
            await replaceShares(expenses, row.id, row.trip_id, repriced.shares);
          const changed = await findExpense(expenses, userId, row.id);
          if (!changed) throw new Error(`expense ${row.id} vanished inside its own write`);
          const shares = await listShares(expenses, [row.id]);
          return {
            action: 'update',
            aggregate: 'expense',
            entityId: row.id,
            tripId: row.trip_id,
            version,
            snapshot: expenseSnapshot(changed, shares),
            result: expenseRecord(
              changed,
              shares,
              repriced?.currency ?? (await tripCurrency(tx, row.trip_id)),
              membership,
            ),
          };
        },
      });
    },

    void(ctx, expenseId, body, ifMatch) {
      return write(ctx, {
        operation: expensesVoid,
        target: { expenseId },
        body,
        ifMatch,
        authorize: (tx, c, target) => actingOnExpense(tx, c, target.expenseId, canVoidExpense),
        load: (tx, target, _input, { userId }) => lockedExpense(tx, target, userId),
        mutate: async (tx, _c, { row, shares }, _input, { userId }) => {
          const version = await voidExpense(forModule(tx, 'expenses'), row.id, userId);
          return {
            action: 'delete',
            aggregate: 'expense',
            entityId: row.id,
            tripId: row.trip_id,
            version,
            // The expense as it was: restore (1b) copies this snapshot forward.
            snapshot: expenseSnapshot(row, shares),
            result: undefined,
          };
        },
      });
    },
  };
}
