import type { Operation } from '@tribo/contract';

/**
 * The Drop B limits (Operation inventory, "Drops"): what slice 1a ships narrower than the
 * CSV row describes. The backlog and the scaffolded tests both read them from here.
 */

/** The only creates that honour Idempotency-Key in 1a; the others follow in 1b. */
export const IDEMPOTENCY_KEY_OPERATIONS: readonly string[] = ['expenses.create', 'files.upload'];

/** Writes that set an expense's amount and shares. */
export const EXPENSE_WRITES: readonly string[] = ['expenses.create', 'expenses.update'];

export function dropLimits(op: Operation): string[] {
  const limits: string[] = [];
  if (op.idempotent === 'key') {
    limits.push(
      IDEMPOTENCY_KEY_OPERATIONS.includes(op.id)
        ? 'Honours Idempotency-Key: 24 h per caller, the same key with a different body is idempotency_key_reused.'
        : 'Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.',
    );
  }
  if (EXPENSE_WRITES.includes(op.id)) {
    limits.push(
      'Trip currency only: fx_rate = 1; FX entry follows after the trip.',
      'Splits are equal or itemised only; weight follows after the trip.',
    );
  }
  return limits;
}
