import * as z from 'zod';

/**
 * A sensitive value as every read shows it: present, but masked. The plaintext comes only
 * from the resource's audited reveal operation. Writing this value back is refused with
 * masked_field_write, so a client that echoes a read never overwrites the real value.
 */
export const MaskedValue = z.strictObject({ masked: z.literal(true) }).meta({ id: 'MaskedValue' });

export type MaskedValue = z.infer<typeof MaskedValue>;

export const MASKED: MaskedValue = { masked: true };
