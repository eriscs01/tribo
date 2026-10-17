import * as z from 'zod';

/** ISO 4217 alphabetic code. Minor-unit exponents come from a static table, never from Intl. */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code')
  .meta({ id: 'CurrencyCode' });

/** An amount in minor units with its currency, e.g. PHP 1,250.50 = { amountMinor: 125050 }. */
export const Money = z
  .object({
    amountMinor: z.int(),
    currency: CurrencyCode,
  })
  .meta({ id: 'Money' });

export type Money = z.infer<typeof Money>;
