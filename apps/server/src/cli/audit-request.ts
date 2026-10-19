import type { RequestEvent } from '@tribo/core';
import { CliError, type CliIo } from './io.js';

/**
 * `tribo audit request <request id>`: one line per audit event the request wrote, in
 * order, so the request's log lines and what it changed join on one id. Ids and metadata
 * only; field values are never in audit rows.
 */
export async function auditRequest(
  deps: { requestAudit: (requestId: string) => Promise<RequestEvent[]>; io: CliIo },
  args: readonly string[],
): Promise<void> {
  const [requestId] = args;
  if (requestId === undefined || args.length > 1) {
    throw new CliError('usage: tribo audit request <request id>');
  }
  const events = await deps.requestAudit(requestId);
  if (events.length === 0) throw new CliError(`no audit events for request ${requestId}`);
  for (const e of events) {
    const version = e.versionAfter === null ? '-' : `v${String(e.versionAfter)}`;
    deps.io.say(
      [
        e.occurredAt.toISOString(),
        `${e.chainKey} #${String(e.seq)}`,
        `${e.action} ${e.entityType} ${e.entityId ?? '-'} ${version}`,
        e.surface,
        e.actorUserId ?? 'system',
      ].join('  '),
    );
  }
}
