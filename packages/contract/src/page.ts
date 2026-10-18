import * as z from 'zod';

/** The largest page a list read returns. */
export const PAGE_LIMIT_MAX = 200;
export const PAGE_LIMIT_DEFAULT = 50;

/**
 * Keyset pagination for every list read: `limit` rows after the opaque `cursor` the previous
 * page returned. Query strings arrive as text, so `limit` is coerced.
 */
export const PageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});

export type PageQuery = z.infer<typeof PageQuery>;

/** One page of a list read; `nextCursor` is null on the last page. */
export function page<T extends z.ZodType>(item: T, id: string) {
  return z
    .strictObject({
      items: z.array(item),
      nextCursor: z.string().nullable(),
    })
    .meta({ id });
}
