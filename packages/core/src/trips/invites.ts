// The invites service: a trip's invite links, which the owner creates, lists and revokes.
// Invites are the trips module's table and credentials (0001_init.sql, rule 1): never
// versioned or snapshotted, so their writes record a metadata-only event, never a value.
// service.ts exposes this file.
import {
  decodeTypeId,
  ID_PREFIX,
  InviteInput,
  InvitePreviewInput,
  NoBody,
  type PageQuery,
} from '@tribo/contract';
import { newToken, tokenHash } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  ApiError,
  encodeCursor,
  validate,
  type Loaded,
  type RequestContext,
  type Tx,
  type WriteSpec,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordEvent } from '../audit/service.js';
import { memberPersons, personAccountId } from '../library/service.js';
import { writeOperation } from '../write-operation.js';
import { actingUser, idCursor, requireRole } from './membership.js';
import { canManageInvites, inviteStatus } from './policy.js';
import {
  findLiveInvite,
  insertInvite,
  listInvites,
  lockInvite,
  lockMembershipOf,
  revokeInvite,
  type InviteRole,
  type InviteRow,
} from './repo.js';
import { guardTrip } from './trip-guard.js';

/** An invite link as the owner sees it; the token is never part of it. */
export interface InviteRecord {
  id: string;
  tripId: string;
  role: InviteRole;
  personId: string | null;
  expiresAt: Date;
  maxUses: number | null;
  uses: number;
  status: 'active' | 'revoked' | 'expired' | 'used_up';
  revokedAt: Date | null;
  createdAt: Date;
}

/** invites.create's answer: the invite with its token and link, shown this once. */
export type CreatedInvite = InviteRecord & { token: string; link: string; redacted: false };

export interface InvitesService {
  /**
   * invites.create: the owner makes a link with a role, an expiry and optionally a use cap,
   * or pre-links it to a placeholder member to claim (single use). The token is returned
   * once, in a `/join#<token>` link; only its SHA-256 is stored.
   */
  create(ctx: RequestContext, tripId: string, body: unknown): Promise<CreatedInvite>;
  /** invites.list: the trip's invites in any state, oldest first, to its owner alone. */
  list(
    userId: string,
    tripId: string,
    page: PageQuery,
  ): Promise<{ items: InviteRecord[]; nextCursor: string | null }>;
  /**
   * invites.revoke: the owner closes a link for good. Invites carry no version, so it takes
   * no If-Match; revoking a revoked link answers it unchanged.
   */
  revoke(
    ctx: RequestContext,
    tripId: string,
    inviteId: string,
    body: unknown,
  ): Promise<InviteRecord>;
  /**
   * invites.preview: what an invite link opens, for anyone holding it: the trip's name, the
   * role and the placeholder to claim. Read only. Every link that opens nothing (unknown,
   * expired, revoked, used up, or its trip or placeholder gone) is the same invite_invalid,
   * reached through the same single query.
   */
  preview(body: unknown): Promise<InvitePreviewRecord>;
}

export interface InvitePreviewRecord {
  tripName: string;
  role: InviteRole;
  placeholderName: string | null;
}

const invitesCreate = writeOperation('invites.create', InviteInput);
const invitesRevoke = writeOperation('invites.revoke', NoBody);

/** `publicUrl` is the configured origin invite links name, never the Host header. */
export function createInvitesService(db: Kysely<DB>, publicUrl: URL): InvitesService {
  return {
    async list(userId, tripId, page) {
      await requireRole(db, userId, tripId, canManageInvites);
      // One extra row says whether another page follows.
      const rows = await listInvites(forModule(db, 'trips'), tripId, {
        limit: page.limit + 1,
        after: page.cursor === undefined ? null : idCursor(page.cursor),
      });
      const now = new Date();
      const items = rows.slice(0, page.limit).map((row) => inviteRecord(row, now));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > page.limit && last ? encodeCursor([last.id]) : null,
      };
    },

    create: (ctx, tripId, body) =>
      inviteWrite(db, ctx, invitesCreate, { tripId, body }, async (tx, userId, input) => {
        const expiresAt = futureExpiry(input.expiresAt);
        const terms = await inviteTerms(tx, tripId, input);
        const { token, hash } = newToken();
        const row = await insertInvite(forModule(tx, 'trips'), {
          tripId,
          tokenHash: hash,
          ...terms,
          expiresAt,
          createdBy: userId,
        });
        const link = new URL(`/join#${token}`, publicUrl).toString();
        return {
          row,
          action: 'create',
          result: { ...inviteRecord(row, new Date()), token, link, redacted: false },
        };
      }),

    async preview(body) {
      const { token } = validate(InvitePreviewInput, body);
      const invite = await findLiveInvite(forModule(db, 'trips'), tokenHash(token), {
        lock: false,
      });
      if (!invite) throw new ApiError('invite_invalid');
      const placeholder =
        invite.person_id === null
          ? undefined
          : (await memberPersons(db, [invite.person_id])).get(invite.person_id);
      return {
        tripName: invite.trip_name,
        role: invite.role as InviteRole,
        placeholderName: placeholder?.displayName ?? null,
      };
    },

    revoke: (ctx, tripId, inviteId, body) =>
      inviteWrite(db, ctx, invitesRevoke, { tripId, body }, async (tx) => {
        const trips = forModule(tx, 'trips');
        const invite = await lockInvite(trips, { tripId, inviteId });
        if (!invite) throw new ApiError('not_found');
        if (invite.revoked_at !== null) {
          return { row: invite, action: null, result: inviteRecord(invite, new Date()) };
        }
        const row = await revokeInvite(trips, invite.id);
        return { row, action: 'revoke', result: inviteRecord(row, new Date()) };
      }),
  };
}

/**
 * What one invite write did: the invite it touched, its event's action (null when it
 * changed nothing, as a second revoke) and the answer.
 */
interface InviteAct<R> {
  row: InviteRow;
  action: 'create' | 'revoke' | null;
  result: R;
}

/**
 * An invite write, in the write path's order and one transaction: the owner check, the
 * body, the trip guard, the change, then its metadata-only event (credentials have no
 * counter and no snapshot, so the snapshotting write path does not fit them).
 */
function inviteWrite<I, R>(
  db: Kysely<DB>,
  ctx: RequestContext,
  operation: WriteSpec<unknown, I, Loaded, unknown>['operation'],
  target: { tripId: string; body: unknown },
  act: (tx: Tx, userId: string, input: I) => Promise<InviteAct<R>>,
): Promise<R> {
  return db.transaction().execute(async (tx) => {
    const userId = actingUser(ctx);
    await requireRole(tx, userId, target.tripId, canManageInvites);
    const input = validate(operation.input, target.body);
    await guardTrip(tx, target.tripId, operation.id);
    const { row, action, result } = await act(tx, userId, input);
    if (action !== null) {
      await recordEvent(tx, ctx, {
        action,
        entityType: 'invite',
        entityId: row.id,
        tripId: row.trip_id,
      });
    }
    return result;
  });
}

/** An expiry must lie ahead: a link that is born expired opens nothing. */
function futureExpiry(expiresAt: string): Date {
  const at = new Date(expiresAt);
  if (at <= new Date()) {
    throw new ApiError('validation_failed', {
      errors: [{ path: '/expiresAt', message: 'must be in the future' }],
    });
  }
  return at;
}

/**
 * Whom the invite admits, as what, how often. An open invite takes the role and use cap it
 * names. R28: a placeholder invite's person must be an active placeholder member of this
 * trip, locked until commit, else invite_invalid whichever way it fails; it is single use
 * (invites_placeholder_single_use), and gives the placeholder's own role unless it names one.
 */
async function inviteTerms(
  tx: Tx,
  tripId: string,
  input: InviteInput,
): Promise<{ role: InviteRole; personId: string | null; maxUses: number | null }> {
  if (!('personId' in input)) {
    return { role: input.role, personId: null, maxUses: input.maxUses ?? null };
  }
  const personId = decodeTypeId(ID_PREFIX.person, input.personId);
  const membership = await lockMembershipOf(forModule(tx, 'trips'), tripId, personId);
  if (membership?.deleted_at !== null || (await personAccountId(tx, personId)) !== null) {
    throw new ApiError('invite_invalid');
  }
  // A placeholder never owns the trip, so its role is always one an invite gives.
  return { role: input.role ?? (membership.trip_role as InviteRole), personId, maxUses: 1 };
}

function inviteRecord(row: InviteRow, now: Date): InviteRecord {
  const invite = {
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    uses: row.uses,
    maxUses: row.max_uses,
  };
  return {
    id: row.id,
    tripId: row.trip_id,
    role: row.role as InviteRole,
    personId: row.person_id,
    ...invite,
    status: inviteStatus(invite, now),
    createdAt: row.created_at,
  };
}
