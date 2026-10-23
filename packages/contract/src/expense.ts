// Expense schemas: the trip's ledger of what was spent and how each expense is split among
// the members included (Technical design, "Expenses"). Record only: no balances, debts or
// settle-up (R36).
import * as z from 'zod';
import { ID_PREFIX, typeId, Uuid } from './ids.js';
import { MaskedValue } from './masked.js';
import { CurrencyCode, Money } from './money.js';
import { page } from './page.js';
import { Instant } from './time.js';

/** How an expense is split. Drop B writes `equal` and `itemised`; `weight` follows after the trip. */
export const SplitMethod = z.enum(['equal', 'weight', 'itemised']).meta({ id: 'SplitMethod' });

export type SplitMethod = z.infer<typeof SplitMethod>;

/** A short code grouping expenses (food, lodging, transport, fees …). */
const Category = z.string().regex(/^[a-z0-9_]{1,40}$/, 'lowercase letters, digits and _');

/** An amount as a caller reads it: masked for a viewer without canViewCosts. */
const Cost = z.union([Money, MaskedValue]);

export const ExpenseShare = z
  .strictObject({
    membershipId: typeId(ID_PREFIX.membership),
    /** This member's part of tripAmount, in the trip currency; frozen when written. */
    amount: Cost,
  })
  .meta({ id: 'ExpenseShare' });

export type ExpenseShare = z.infer<typeof ExpenseShare>;

/**
 * One expense of the trip's ledger. Every member reads it; a viewer without canViewCosts
 * reads every amount masked. itemId is null when the expense is on no item, or on one the
 * caller cannot see.
 */
export const Expense = z
  .strictObject({
    id: typeId(ID_PREFIX.expense),
    tripId: typeId(ID_PREFIX.trip),
    itemId: typeId(ID_PREFIX.item).nullable(),
    category: Category,
    description: z.string(),
    spentOn: z.iso.date(),
    /** Who paid: a recorded fact, not the input to any netting (R36). */
    payerMembershipId: typeId(ID_PREFIX.membership),
    /** What was paid, in the currency it was paid in. */
    amount: Cost,
    /** Trip-currency major units per major unit of amount's currency; 1 in Drop B. */
    fxRate: z.string().regex(/^\d+(\.\d+)?$/),
    /** The amount in the trip currency (R8), which the shares sum to (R11). */
    tripAmount: Cost,
    splitMethod: SplitMethod,
    /** One per member included, the payer only if they share; in membership order. */
    shares: z.array(ExpenseShare),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Expense' });

export type Expense = z.infer<typeof Expense>;

const MembershipIds = z
  .array(typeId(ID_PREFIX.membership))
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, 'each member once');

const ItemisedShares = z
  .array(
    z.strictObject({
      membershipId: typeId(ID_PREFIX.membership),
      amountMinor: z.int().min(0),
    }),
  )
  .min(1)
  .max(200)
  .refine(
    (shares) => new Set(shares.map((s) => s.membershipId)).size === shares.length,
    'each member once',
  );

/**
 * Who shares in an expense, and how. `equal` splits the trip amount among the members named
 * by the largest-remainder method; `itemised` names each member's amount, and they must sum
 * to it. Every member named must be an active member of the trip, placeholders included.
 */
export const ExpenseSplit = z
  .discriminatedUnion('method', [
    z.strictObject({ method: z.literal('equal'), membershipIds: MembershipIds }),
    z.strictObject({ method: z.literal('itemised'), shares: ItemisedShares }),
  ])
  .meta({ id: 'ExpenseSplit' });

export type ExpenseSplit = z.infer<typeof ExpenseSplit>;

const Description = z.string().trim().min(1).max(300);

/** What was paid; Drop B takes the trip currency only, at a rate of 1. */
const AmountInput = z.strictObject({ amountMinor: z.int().min(1), currency: CurrencyCode });

/**
 * expenses.create. Drop B takes the trip currency only, at a rate of 1, so amount's currency
 * must be the trip's; an item must be one the caller sees in the same trip.
 */
export const ExpenseInput = z
  .strictObject({
    itemId: typeId(ID_PREFIX.item).optional(),
    category: Category,
    description: Description,
    spentOn: z.iso.date(),
    payerMembershipId: typeId(ID_PREFIX.membership),
    amount: AmountInput,
    split: ExpenseSplit,
  })
  .meta({ id: 'ExpenseInput' });

export type ExpenseInput = z.infer<typeof ExpenseInput>;

/**
 * expenses.list: one page of the trip's ledger, by the day spent then the order recorded;
 * voided expenses are not in it. Expenses only: no balances, debts or settle-up (R36).
 */
export const ExpensePage = page(Expense, 'ExpensePage');

export type ExpensePage = z.infer<typeof ExpensePage>;

/** expenses.list's keyset: the last row's day spent and id (the cursor's decoded form). */
export const ExpenseCursorKey = z.tuple([z.iso.date(), Uuid]);

/**
 * expenses.update, as JSON Merge Patch: absent keys stay. A new amount or split refreezes
 * the shares (an equal split re-splits among the same members; itemised amounts must sum
 * to the new amount, or come with a new split); anything else leaves them as frozen. itemId
 * null detaches the expense from its item, except from one the caller cannot see, which
 * stays (the read showed them null).
 */
export const ExpensePatch = z
  .strictObject({
    itemId: typeId(ID_PREFIX.item).nullable().optional(),
    category: Category.optional(),
    description: Description.optional(),
    spentOn: z.iso.date().optional(),
    payerMembershipId: typeId(ID_PREFIX.membership).optional(),
    amount: AmountInput.optional(),
    split: ExpenseSplit.optional(),
  })
  .meta({ id: 'ExpensePatch' });

export type ExpensePatch = z.infer<typeof ExpensePatch>;
