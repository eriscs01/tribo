import { anyMember, contributors } from '../roles.js';

/** expenses.create: owner, organizer, member (operations.csv); a viewer records nothing. */
export const canCreateExpense = contributors;

/**
 * expenses.get: every role; the ledger stays whole, and a viewer without canViewCosts reads
 * every amount masked.
 */
export const canGetExpense = anyMember;

/** expenses.list: every role; the ledger stays whole, masked as expenses.get masks it. */
export const canListExpenses = anyMember;
