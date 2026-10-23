// Invite schemas: a trip's invite links, as the owner creates, lists and revokes them.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { NewPassword, Session, Username } from './account.js';
import { Member, TripRole } from './member.js';
import { DisplayName } from './person.js';
import { Instant } from './time.js';
import { page } from './page.js';
import { secret } from './secret.js';

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
  token: secret(z.string()).optional(),
  link: secret(z.url()).optional(),
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

/** invites.list: one page of Invite. */
export const InvitePage = page(Invite, 'InvitePage');

export type InvitePage = z.infer<typeof InvitePage>;

/**
 * The secret an invite link carries, as the join page posts it from the `/join#<token>`
 * fragment: in a body, never a URL. Any string is a token; one that matches nothing is
 * invite_invalid like every other link that opens nothing.
 */
const InviteToken = z.string().min(1).max(128);

/** invites.preview body. */
export const InvitePreviewInput = z
  .strictObject({ token: InviteToken })
  .meta({ id: 'InvitePreviewInput' });

export type InvitePreviewInput = z.infer<typeof InvitePreviewInput>;

/**
 * invites.preview response: what the join page shows before anyone signs up, and nothing
 * more. `placeholderName` names the traveller a placeholder invite lets the joiner claim.
 */
export const InvitePreview = z
  .strictObject({
    tripName: z.string(),
    role: InviteRole,
    placeholderName: z.string().nullable(),
  })
  .meta({ id: 'InvitePreview' });

export type InvitePreview = z.infer<typeof InvitePreview>;

/**
 * invites.accept body. A new joiner chooses a username and password here (the account's
 * own person is named `displayName`, by default the placeholder it claims or else the
 * username); a signed-in caller sends the token alone and joins as themself.
 */
export const InviteAcceptInput = z
  .strictObject({
    token: InviteToken,
    account: z
      .strictObject({
        username: Username,
        password: NewPassword,
        displayName: DisplayName.optional(),
      })
      .optional(),
  })
  .meta({ id: 'InviteAcceptInput' });

export type InviteAcceptInput = z.infer<typeof InviteAcceptInput>;

/**
 * invites.accept response: the caller's membership in the trip. A new account comes back
 * signed in: `session` is its session (the cookie is set with it); a signed-in caller's is
 * null, since their session is the one they joined with.
 */
export const InviteAccept = z
  .strictObject({ member: Member, session: Session.nullable() })
  .meta({ id: 'InviteAccept' });

export type InviteAccept = z.infer<typeof InviteAccept>;
