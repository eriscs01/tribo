import type { IfMatch, Operation } from '@tribo/contract';
import type { DB, JsonValue, ValueOf } from '@tribo/db';
import type { Kysely, Transaction } from 'kysely';
import type * as z from 'zod';
import type { RequestContext } from './context.js';
import { ApiError } from './errors.js';
import { claimKey, requestHash } from './idempotency.js';

/** The one transaction a write runs in. Each module narrows it with forModule() for its repo. */
export type Tx = Transaction<DB>;

/** What `load` found and locked. */
export interface Loaded {
  /** The trip the write falls under, or null outside any trip (and for trips.create). */
  tripId: string | null;
  /** The aggregate's counter before this write; absent when the write creates the aggregate. */
  counter?: number;
}

/** One write to one aggregate: what becomes its snapshot and its audit event. */
export interface Change<R = unknown> {
  action: ValueOf<'audit.audit_events.action'>;
  /** The aggregate, which is the snapshot series: item, item_board, trip_budget, … */
  aggregate: string;
  entityId: string;
  /** The trip whose chain gets the event; for trips.create, the new trip. */
  tripId: string | null;
  /** The counter after this write: Loaded.counter + 1, or 1 for a create. */
  version: number;
  snapshot: JsonValue;
  restoredFrom?: number;
  /** What the operation answers with. */
  result: R;
  /**
   * Other aggregates the same write changed (trips.create makes the owner membership),
   * recorded after this one, each with its own snapshot and event.
   */
  related?: readonly WriteRecord[];
}

/** What the audit module stores for each write: the snapshot and the metadata-only event. */
export type WriteRecord = Omit<Change, 'result' | 'related'> & { versionBefore: number | null };

/**
 * The steps owned outside the platform, plugged in by core: the trips module decides
 * whether a trip takes writes, the audit module stores snapshot and event.
 */
export interface WritePorts {
  /** Locks the trip against archive and delete until commit; throws trip_archived or not_found. */
  guardTrip(tx: Tx, tripId: string, operationId: string): Promise<void>;
  record(tx: Tx, ctx: RequestContext, record: WriteRecord): Promise<void>;
}

/** `A` is what authorize found (the acting member, say), handed on to load and mutate. */
export interface WriteSpec<Target, Input, L extends Loaded, R, A = void> {
  /** Its input schema validates the body; its ifMatch names the counter to compare. */
  operation: Operation & { input: z.ZodType<Input> };
  /** Path parameters, already parsed by the adapter. */
  target: Target;
  body: unknown;
  /** The If-Match header as a counter value, if the caller sent one. */
  ifMatch: number | undefined;
  /** Throws forbidden or not_found; runs before the body is looked at. */
  authorize(tx: Tx, ctx: RequestContext, target: Target): Promise<A>;
  /** Reads and locks (FOR UPDATE) what the write changes. */
  load(tx: Tx, target: Target, input: Input, auth: A): Promise<L>;
  /** Applies the change and bumps the counter; business-rule failures throw ApiError. */
  mutate(tx: Tx, ctx: RequestContext, loaded: L, input: Input, auth: A): Promise<Change<R>>;
}

export type WritePath = <Target, Input, L extends Loaded, R, A = void>(
  ctx: RequestContext,
  spec: WriteSpec<Target, Input, L, R, A>,
) => Promise<R>;

/**
 * The single write path every mutating operation runs through, in one transaction:
 * authorize → validate → claim the Idempotency-Key → load FOR UPDATE → trip guard → If-Match
 * → mutate → snapshot + audit event → commit. Any failure, the audit insert included, rolls
 * the whole write back, the key's claim with it.
 */
export function createWritePath(db: Kysely<DB>, ports: WritePorts): WritePath {
  return (ctx, spec) =>
    db.transaction().execute(async (tx) => {
      const auth = await spec.authorize(tx, ctx, spec.target);
      const input = validate(spec.operation.input, spec.body);
      if (ctx.idempotency?.operationId === spec.operation.id) {
        await claimKey(tx, ctx.idempotency, requestHash(spec.target, spec.body));
      }
      const loaded = await spec.load(tx, spec.target, input, auth);
      if (loaded.tripId !== null) await ports.guardTrip(tx, loaded.tripId, spec.operation.id);
      checkIfMatch(spec.operation.ifMatch, spec.ifMatch, loaded.counter);

      const { result, related = [], ...change } = await spec.mutate(tx, ctx, loaded, input, auth);
      const versionBefore = loaded.counter ?? null;
      if (change.version !== (versionBefore ?? 0) + 1) {
        throw new Error(
          `${spec.operation.id} wrote ${change.aggregate} version ${String(change.version)} after ${String(versionBefore ?? 'none')}`,
        );
      }
      await ports.record(tx, ctx, { ...change, versionBefore });
      // eslint-disable-next-line no-await-in-loop -- audit events chain, so they append in order
      for (const record of related) await ports.record(tx, ctx, record);
      return result;
    });
}

/** Parses a body with the operation's schema; failures become validation_failed with field paths. */
export function validate<Input>(schema: z.ZodType<Input>, body: unknown): Input {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ApiError('validation_failed', {
    errors: parsed.error.issues.map((issue) => ({
      path: `/${issue.path.map(String).join('/')}`,
      message: issue.message,
    })),
  });
}

/**
 * Compares If-Match with the counter the operation declares. `version_or_new` needs it
 * only when the aggregate already exists; `no` (creates, and replacing a value only the
 * caller owns, like their RSVP) never looks at it.
 */
export function checkIfMatch(
  declared: IfMatch,
  given: number | undefined,
  current: number | undefined,
): void {
  if (declared === 'no') return;
  if (current === undefined) {
    if (declared === 'version_or_new') return;
    throw new Error(`an If-Match (${declared}) write loaded no counter`);
  }
  if (given === undefined) throw new ApiError('if_match_required');
  if (given !== current) {
    throw new ApiError('version_conflict', { detail: `current ${declared} is ${String(current)}` });
  }
}
