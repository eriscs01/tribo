// Library search: people the caller may see, and the shared places and vendors, by name.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { PlaceKind } from './place.js';
import { VendorKind } from './vendor.js';

export const SEARCH_LIMIT_MAX = 50;

/** library.search. Query strings arrive as text, so `limit` is coerced. */
export const LibrarySearchQuery = z.strictObject({
  /** Matched against names: substrings and close spellings (trigram word similarity). */
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(20),
});

export type LibrarySearchQuery = z.infer<typeof LibrarySearchQuery>;

/** One match, best first; people only where tribo.person_visible lets the caller see them. */
export const LibraryHit = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('person'), id: typeId(ID_PREFIX.person), name: z.string() }),
    z.strictObject({
      kind: z.literal('place'),
      id: typeId(ID_PREFIX.place),
      name: z.string(),
      placeKind: PlaceKind,
    }),
    z.strictObject({
      kind: z.literal('vendor'),
      id: typeId(ID_PREFIX.vendor),
      name: z.string(),
      vendorKind: VendorKind,
    }),
  ])
  .meta({ id: 'LibraryHit' });

export type LibraryHit = z.infer<typeof LibraryHit>;

/** The best `limit` matches across people, places and vendors; a search has no next page. */
export const LibrarySearchResult = z
  .strictObject({ items: z.array(LibraryHit) })
  .meta({ id: 'LibrarySearchResult' });

export type LibrarySearchResult = z.infer<typeof LibrarySearchResult>;
