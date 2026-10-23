import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { equalShares, itemisedShares, minorExponent, tripAmountMinor } from './money.js';

/** A UUID-shaped id that sorts by its number: the order memberships joined. */
const mid = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const sum = (shares: readonly { shareMinor: number }[]) =>
  shares.reduce((total, s) => total + s.shareMinor, 0);

describe('minorExponent (R8: a static ISO 4217 table, never Intl)', () => {
  it('knows the currencies whose minor unit is not a hundredth', () => {
    expect(minorExponent('PHP')).toBe(2);
    expect(minorExponent('EUR')).toBe(2);
    expect(minorExponent('JPY')).toBe(0);
    expect(minorExponent('KRW')).toBe(0);
    expect(minorExponent('KWD')).toBe(3);
    expect(minorExponent('BHD')).toBe(3);
    expect(minorExponent('CLF')).toBe(4);
  });
});

describe('tripAmountMinor (R8)', () => {
  it('is the amount itself in the trip currency at rate 1', () => {
    expect(tripAmountMinor(125_050, '1', 'PHP', 'PHP')).toBe(125_050);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (amount) => {
        expect(tripAmountMinor(amount, '1', 'PHP', 'PHP')).toBe(amount);
      }),
    );
  });

  it('scales by the exponents of both currencies and the rate per major unit', () => {
    // JPY 1,000 at 0.37 PHP per yen: PHP 370.00.
    expect(tripAmountMinor(1_000, '0.37', 'JPY', 'PHP')).toBe(37_000);
    // KWD 1.250 at 185.5 PHP per dinar: PHP 231.875 → 231.88.
    expect(tripAmountMinor(1_250, '185.5', 'KWD', 'PHP')).toBe(23_188);
    // EUR 10.00 at 162.12345678 JPY per euro: JPY 1,621.2345678 → 1,621.
    expect(tripAmountMinor(1_000, '162.12345678', 'EUR', 'JPY')).toBe(1_621);
  });

  it('rounds half up, and never to less than one minor unit', () => {
    // PHP 0.01 at 0.5 EUR per peso: EUR 0.005 → 0.01.
    expect(tripAmountMinor(1, '0.5', 'PHP', 'EUR')).toBe(1);
    // PHP 0.03 at 0.5: 0.015 → 0.02; at 0.49999999 → 0.01.
    expect(tripAmountMinor(3, '0.5', 'PHP', 'EUR')).toBe(2);
    expect(tripAmountMinor(3, '0.49999999', 'PHP', 'EUR')).toBe(1);
    // A tiny amount at a tiny rate still costs one minor unit.
    expect(tripAmountMinor(1, '0.00000001', 'KWD', 'JPY')).toBe(1);
  });

  it('refuses a trip amount past the safe integers with validation_failed at /amount/amountMinor', () => {
    expect(() => tripAmountMinor(Number.MAX_SAFE_INTEGER, '2', 'PHP', 'PHP')).toThrow(
      expect.objectContaining({
        code: 'validation_failed',
        extra: { errors: [expect.objectContaining({ path: '/amount/amountMinor' })] },
      }),
    );
  });

  it('refuses a rate that is not a positive decimal of at most 8 places', () => {
    for (const rate of ['0', '-1', '1e3', '1.123456789', 'abc', '', '12345678901']) {
      expect(() => tripAmountMinor(100, rate, 'PHP', 'PHP')).toThrow(/rate/);
    }
  });
});

describe('equalShares (R11: largest remainder, frozen)', () => {
  it('splits evenly when it can', () => {
    expect(equalShares(900, [mid(3), mid(1), mid(2)])).toEqual([
      { membershipId: mid(1), shareMinor: 300 },
      { membershipId: mid(2), shareMinor: 300 },
      { membershipId: mid(3), shareMinor: 300 },
    ]);
  });

  it('gives the leftover minor units to the earliest memberships, whatever order they came in', () => {
    const shares = equalShares(1_000, [mid(9), mid(4), mid(7)]);
    expect(shares).toEqual([
      { membershipId: mid(4), shareMinor: 334 },
      { membershipId: mid(7), shareMinor: 333 },
      { membershipId: mid(9), shareMinor: 333 },
    ]);
    expect(equalShares(1_000, [mid(7), mid(9), mid(4)])).toEqual(shares);
  });

  it('gives one minor unit across many members to the first, and zero to the rest', () => {
    const many = Array.from({ length: 40 }, (_, i) => mid(40 - i));
    const shares = equalShares(1, many);
    expect(shares[0]).toEqual({ membershipId: mid(1), shareMinor: 1 });
    expect(shares.slice(1).every((s) => s.shareMinor === 0)).toBe(true);
  });

  it('property: one share per member, summing to the total, no two more than one unit apart', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 60 }),
        (total, members) => {
          const shares = equalShares(total, members.map(mid));
          expect(shares).toHaveLength(members.length);
          expect(new Set(shares.map((s) => s.membershipId)).size).toBe(members.length);
          expect(sum(shares)).toBe(total);
          const amounts = shares.map((s) => s.shareMinor);
          expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
          expect(amounts.every((a) => Number.isSafeInteger(a) && a >= 0)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('property: small totals over many members still sum exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 100 }), (total, n) => {
        const shares = equalShares(
          total,
          Array.from({ length: n }, (_, i) => mid(i + 1)),
        );
        expect(sum(shares)).toBe(total);
        if (total < n) expect(shares.filter((s) => s.shareMinor === 1)).toHaveLength(total);
      }),
    );
  });
});

describe('itemisedShares (R11)', () => {
  it('keeps each named amount, in membership order', () => {
    expect(
      itemisedShares(1_000, [
        { membershipId: mid(2), amountMinor: 600 },
        { membershipId: mid(1), amountMinor: 400 },
      ]),
    ).toEqual([
      { membershipId: mid(1), shareMinor: 400 },
      { membershipId: mid(2), shareMinor: 600 },
    ]);
  });

  it('refuses amounts that do not sum to the total with validation_failed at /split/shares', () => {
    for (const shares of [
      [{ membershipId: mid(1), amountMinor: 999 }],
      [
        { membershipId: mid(1), amountMinor: 600 },
        { membershipId: mid(2), amountMinor: 401 },
      ],
    ]) {
      let error: unknown;
      try {
        itemisedShares(1_000, shares);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        code: 'validation_failed',
        extra: { errors: [{ path: '/split/shares' }] },
      });
    }
  });

  it('property: whatever passes sums to the total', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 30 }),
        fc.array(fc.nat({ max: 1_000_000 }), { minLength: 30, maxLength: 30 }),
        (members, amounts) => {
          const named = members.map((m, i) => ({
            membershipId: mid(m),
            amountMinor: amounts[i] ?? 0,
          }));
          const total = named.reduce((t, s) => t + s.amountMinor, 0);
          if (total === 0) return;
          expect(sum(itemisedShares(total, named))).toBe(total);
          expect(() => itemisedShares(total + 1, named)).toThrow(ApiError);
        },
      ),
    );
  });
});
