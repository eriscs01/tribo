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
        : `Takes no Idempotency-Key in 1a: only ${listed(IDEMPOTENCY_KEY_OPERATIONS)} honour it; this create follows in 1b.`,
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

/** "a", "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}
