import {
  EXPENSE_WRITES,
  honoursIdempotencyKey,
  IDEMPOTENCY_KEY_OPERATIONS,
  type Operation,
} from '@tribo/contract';

/**
 * How the Drop B limits (owned by @tribo/contract's drop-limits.ts) read in a story: the
 * backlog and the scaffolded tests both take these sentences from here.
 */
export function dropLimits(op: Operation): string[] {
  const limits: string[] = [];
  if (op.idempotent === 'key') {
    limits.push(
      honoursIdempotencyKey(op)
        ? 'Honours Idempotency-Key: 24 h per caller, the same key with a different body is idempotency_key_reused.'
        : `Takes no Idempotency-Key in 1a: only ${IDEMPOTENCY_KEY_OPERATIONS.join(' and ')} honour it; this create follows in 1b.`,
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
