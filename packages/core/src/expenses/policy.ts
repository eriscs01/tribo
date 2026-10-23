import { contributors } from '../roles.js';

/** expenses.create: owner, organizer, member (operations.csv); a viewer records nothing. */
export const canCreateExpense = contributors;
