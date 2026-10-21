// Advisory checks: reads and writes return them in warnings[]; they never refuse a write.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';

/** The rule checks' stable codes (Technical Design, "Rule checks"). */
export const WarningCode = z
  .enum([
    'overlap',
    'missing_transfer',
    'non_refundable',
    'non_changeable',
    'deposit_due',
    'missing_add_on',
    'no_licensed_driver',
  ])
  .meta({ id: 'WarningCode' });

export type WarningCode = z.infer<typeof WarningCode>;

/** One advisory finding, naming what it is about. */
export const Warning = z
  .strictObject({
    code: WarningCode,
    /** The room or vehicle it concerns. */
    unitId: typeId(ID_PREFIX.unit).optional(),
  })
  .meta({ id: 'Warning' });

export type Warning = z.infer<typeof Warning>;
