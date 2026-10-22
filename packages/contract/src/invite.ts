// Invite schemas: a trip's invite links, as the owner creates, lists and revokes them.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { TripRole } from './member.js';
import { Instant } from './time.js';

/** The roles an invite gives: the trip has one owner, who hands over with members.setRole. */
export const InviteRole = TripRole.exclude(['owner']).meta({ id: 'InviteRole' });

export type InviteRole = z.infer<typeof InviteRole>;

/**
 * Where an invite stands, derived on every read: revoked by the owner, past its expiry,
 * used as often as `maxUses` allows, or still open.
 */
export const InviteStatus = z
  .enum(['active', 'revoked', 'expired', 'used_up'])
  .meta({ id: 'InviteStatus' });

export type InviteStatus = z.infer<typeof InviteStatus>;

/** The most uses one open invite takes; a placeholder invite is single use. */
export const INVITE_MAX_USES = 1000;

/**
 * An invite link as the owner sees it. The token is never part of it: it is shown once,
 * by invites.create, and only its SHA-256 is stored.
 */
export const Invite = z
  .strictObject({
    id: typeId(ID_PREFIX.invite),
    tripId: typeId(ID_PREFIX.trip),
    role: InviteRole,
    /** The placeholder member this invite lets its joiner claim; null for an open invite. */
    personId: typeId(ID_PREFIX.person).nullable(),
    expiresAt: Instant,
    /** null = any number of uses until it expires. */
    maxUses: z.int().min(1).nullable(),
    uses: z.int().min(0),
    status: InviteStatus,
    revokedAt: Instant.nullable(),
    createdAt: Instant,
  })
  .meta({ id: 'Invite' });

export type Invite = z.infer<typeof Invite>;

/**
 * invites.create response: the invite with its secret, shown once. `link` is
 * `<public URL>/join#<token>`, so the token stays in the fragment and never reaches a
 * proxy log. An idempotent replay (1b) omits both and says `redacted: true` (R2).
 */
export const InviteCreated = Invite.extend({
  token: z.string().optional(),
  link: z.url().optional(),
  redacted: z.boolean(),
}).meta({ id: 'InviteCreated' });

export type InviteCreated = z.infer<typeof InviteCreated>;

/**
 * invites.create body. An open invite names the role it gives and may cap its uses. A
 * placeholder invite names the placeholder member to claim instead: it is single use, and
 * its role defaults to the placeholder's own in the trip.
 */
export const InviteInput = z
  .union([
    z.strictObject({
      role: InviteRole,
      expiresAt: Instant,
      maxUses: z.int().min(1).max(INVITE_MAX_USES).optional(),
    }),
    z.strictObject({
      personId: typeId(ID_PREFIX.person),
      role: InviteRole.optional(),
      expiresAt: Instant,
    }),
  ])
  .meta({ id: 'InviteInput' });

export type InviteInput = z.infer<typeof InviteInput>;
