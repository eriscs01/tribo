import { anyMember, contributors, organizersOrOwningMember } from '../roles.js';

/** expenses.create: owner, organizer, member (operations.csv); a viewer records nothing. */
export const canCreateExpense = contributors;

/**
 * expenses.get: every role; the ledger stays whole, and a viewer without canViewCosts reads
 * every amount masked.
 */
export const canGetExpense = anyMember;

/** expenses.list: every role; the ledger stays whole, masked as expenses.get masks it. */
export const canListExpenses = anyMember;

/**
 * expenses.update: the owner and organizers edit any expense, a member their own (one they
 * paid); a viewer none, whatever they paid (decision 0024).
 */
export const canUpdateExpense = organizersOrOwningMember;
