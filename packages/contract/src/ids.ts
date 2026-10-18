/* eslint-disable no-bitwise -- Crockford base32 packs 5 bits per character */
import * as z from 'zod';

/**
 * TypeID prefixes for every resource the API names. Ids are UUIDv7 in the database and
 * `<prefix>_<26 Crockford base32 chars>` at the API edge. trp, itm and evt are fixed by
 * the design; the rest are set here and nowhere else.
 */
export const ID_PREFIX = {
  approval: 'apv',
  auditEvent: 'evt',
  checklistEntry: 'chk',
  expense: 'exp',
  file: 'fil',
  invite: 'inv',
  item: 'itm',
  mcpClient: 'mcl',
  membership: 'mem',
  oauthGrant: 'grt',
  person: 'per',
  personalAccessToken: 'pat',
  place: 'plc',
  session: 'ses',
  template: 'tpl',
  ticket: 'tkt',
  trip: 'trp',
  unit: 'unt',
  user: 'usr',
  vendor: 'vnd',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** Path parameters that carry a TypeID, by name. `uid` (OAuth interaction) is opaque. */
export const PATH_PARAM_PREFIX: Record<string, IdPrefix> = {
  approvalId: ID_PREFIX.approval,
  clientId: ID_PREFIX.mcpClient,
  entryId: ID_PREFIX.checklistEntry,
  expenseId: ID_PREFIX.expense,
  fileId: ID_PREFIX.file,
  grantId: ID_PREFIX.oauthGrant,
  inviteId: ID_PREFIX.invite,
  itemId: ID_PREFIX.item,
  membershipId: ID_PREFIX.membership,
  personId: ID_PREFIX.person,
  placeId: ID_PREFIX.place,
  templateId: ID_PREFIX.template,
  ticketId: ID_PREFIX.ticket,
  tokenId: ID_PREFIX.personalAccessToken,
  tripId: ID_PREFIX.trip,
  unitId: ID_PREFIX.unit,
  userId: ID_PREFIX.user,
  vendorId: ID_PREFIX.vendor,
};

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** A TypeID suffix: 26 Crockford base32 characters, the first at most 7 (128 bits). */
const SUFFIX_PATTERN = '[0-7][0-9a-hjkmnp-tv-z]{25}';
const SUFFIX = new RegExp(`^${SUFFIX_PATTERN}$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A database id in its canonical hyphenated form, as it travels inside the server. */
export const Uuid = z.string().regex(UUID, 'expected a UUID');

export class TypeIdError extends Error {
  override name = 'TypeIdError';
}

export function encodeTypeId(prefix: IdPrefix, uuid: string): string {
  if (!UUID.test(uuid)) throw new TypeIdError('not a UUID');
  let n = BigInt(`0x${uuid.replaceAll('-', '')}`);
  const out: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    out.push(ALPHABET.charAt(Number(n & 31n)));
    n >>= 5n;
  }
  return `${prefix}_${out.reverse().join('')}`;
}

export function decodeTypeId(prefix: IdPrefix, id: string): string {
  const suffix = id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : '';
  if (!SUFFIX.test(suffix)) throw new TypeIdError(`not a ${prefix} id`);
  let n = 0n;
  for (const char of suffix) n = (n << 5n) | BigInt(ALPHABET.indexOf(char));
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The regular expression source a TypeID with the given prefix matches, anchored. */
export function typeIdPattern(prefix: IdPrefix): string {
  return `^${prefix}_${SUFFIX_PATTERN}$`;
}

/** Zod schema for a TypeID with the given prefix, as it appears in JSON and paths. */
export function typeId(prefix: IdPrefix) {
  return z.string().regex(new RegExp(typeIdPattern(prefix)), `expected a ${prefix}_ id`);
}
