import type { ValueOf } from '@tribo/db';
import { ApiError } from './errors.js';
import type { IdempotencyClaim } from './idempotency.js';

/**
 * Who is acting and through what, as each adapter resolves it for one request. The write
 * path copies it into the audit event; IP and user agent stay in the request's log lines,
 * joined by requestId.
 */
export interface RequestContext {
  requestId: string;
  surface: ValueOf<'audit.audit_events.surface'>;
  /** null only for system work (jobs, CLI bootstrap). */
  userId: string | null;
  /** IANA zone the caller reported, for showing audit times in their local time. */
  actorTz?: string;
  /** PAT id or OAuth client_id (1b). */
  clientId?: string;
  clientName?: string;
  mcpSession?: string;
  /** The Idempotency-Key the caller sent, when the operation honours one (decision 0017). */
  idempotency?: IdempotencyClaim;
}

/** Writes need an account behind them; only system work runs without one. */
export function actingUser(ctx: RequestContext): string {
  if (ctx.userId === null) throw new ApiError('unauthenticated');
  return ctx.userId;
}
