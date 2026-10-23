// The expense arithmetic (Technical design, "Expenses"; R8, R11): integer minor units in
// BigInt, never floats, so a total and its shares are exact whatever the amount.
import { ApiError } from '@tribo/platform';

/**
 * ISO 4217 minor-unit exponents other than 2. A static table shipped with the app, never
 * the runtime's Intl data, so an ICU update never changes how a stored amount reads (R8).
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/** Digits after the decimal point of the currency's minor unit (PHP 2, JPY 0, KWD 3). */
export function minorExponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

/** expenses.fx_rate is numeric(18, 8): up to 10 integer digits and 8 decimals, above zero. */
const RATE = /^(\d{1,10})(?:\.(\d{1,8}))?$/;
const RATE_SCALE = 10n ** 8n;

function scaledRate(rate: string): bigint {
  const match = RATE.exec(rate);
  const scaled = match
    ? BigInt(match[1] ?? '0') * RATE_SCALE + BigInt((match[2] ?? '').padEnd(8, '0'))
    : 0n;
  if (scaled <= 0n)
    throw new Error(`fx rate ${rate} is not a positive decimal of at most 8 places`);
  return scaled;
}

/**
 * R8: `max(1, round half-up(amount × fxRate × 10^(e_trip − e_orig)))`, the amount in minor
 * units of the trip currency, with `fxRate` in trip-currency major units per original major
 * unit.
 */
export function tripAmountMinor(
  amountMinor: number,
  fxRate: string,
  currency: string,
  tripCurrency: string,
): number {
  const shift = minorExponent(tripCurrency) - minorExponent(currency);
  const numerator = BigInt(amountMinor) * scaledRate(fxRate) * 10n ** BigInt(Math.max(0, shift));
  const denominator = RATE_SCALE * 10n ** BigInt(Math.max(0, -shift));
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  const amount = rounded < 1n ? 1n : rounded;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiError('validation_failed', {
      errors: [{ path: '/amount/amountMinor', message: 'too large in the trip currency' }],
    });
  }
  return Number(amount);
}

/** One frozen share: a membership and its part of the trip amount, in minor units. */
export interface Share {
  membershipId: string;
  shareMinor: number;
}

/** Ascending, the order of codepoints (UUIDs are lowercase hex), never of the locale. */
function ascending<T>(a: T, b: T): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const byMembership = (a: { membershipId: string }, b: { membershipId: string }) =>
  ascending(a.membershipId, b.membershipId);

/**
 * The largest-remainder method: each membership gets the whole minor units of its quota,
 * and the units left over go one each to the largest remainders. Ties go to the lower
 * membership id (UUIDv7: who joined the trip first), so the same split always freezes the
 * same shares (decision 0024). Shares come in membership id order.
 */
function largestRemainder(
  total: number,
  weights: readonly { membershipId: string; weight: bigint }[],
): Share[] {
  const sum = weights.reduce((s, w) => s + w.weight, 0n);
  const quotas = [...weights].sort(byMembership).map((w) => {
    const exact = BigInt(total) * w.weight;
    return { membershipId: w.membershipId, units: exact / sum, remainder: exact % sum };
  });
  let left = BigInt(total) - quotas.reduce((s, q) => s + q.units, 0n);
  const order = quotas
    .map((q, index) => ({ q, index }))
    // Largest remainder first; equal ones keep membership order.
    .sort((a, b) => ascending(b.q.remainder, a.q.remainder) || a.index - b.index);
  for (const { q } of order) {
    if (left === 0n) break;
    q.units += 1n;
    left -= 1n;
  }
  return quotas.map((q) => ({ membershipId: q.membershipId, shareMinor: Number(q.units) }));
}

/** An equal split of `total` among these memberships: largest remainder over equal weights. */
export function equalShares(total: number, membershipIds: readonly string[]): Share[] {
  return largestRemainder(
    total,
    membershipIds.map((membershipId) => ({ membershipId, weight: 1n })),
  );
}

/**
 * An itemised split: the amounts as named, which must sum to `total` (R11, rule 2);
 * validation_failed at /split/shares otherwise.
 */
export function itemisedShares(
  total: number,
  shares: readonly { membershipId: string; amountMinor: number }[],
): Share[] {
  const named = shares.reduce((s, x) => s + BigInt(x.amountMinor), 0n);
  if (named !== BigInt(total)) {
    throw new ApiError('validation_failed', {
      errors: [
        // No amounts in the message: refusals are logged, and amounts never are.
        { path: '/split/shares', message: 'the shares must sum to the amount' },
      ],
    });
  }
  return shares
    .map((s) => ({ membershipId: s.membershipId, shareMinor: s.amountMinor }))
    .sort(byMembership);
}
