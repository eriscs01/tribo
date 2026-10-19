import type { PrStatus } from './status.ts';

export type EventKind = 'ready' | 'ready-lost' | 'behind' | 'merged' | 'closed';

/** What the watcher has already told the orchestrator about one PR; persisted across runs. */
export interface Memory {
  sha: string;
  emitted: EventKind[];
  /** Set once merged or closed was emitted: the PR is no longer watched. */
  done?: true;
}

/**
 * Which events a newly computed status adds to what was already emitted. Level-triggered: the
 * caller recomputes the status on every pass, and this decides from the memory alone, so a
 * restart or a missed pass (the Mac slept) neither repeats nor loses an event. Ready and behind
 * are emitted once per head sha; ready-lost when a push replaces a head that was ready; merged
 * and closed once, after which the PR is done.
 */
export function nextEvents(
  memory: Memory | undefined,
  sha: string,
  status: PrStatus,
): { events: EventKind[]; memory: Memory } {
  if (memory?.done) return { events: [], memory };
  if (status.kind === 'merged' || status.kind === 'closed') {
    return { events: [status.kind], memory: { sha, emitted: [status.kind], done: true } };
  }
  const events: EventKind[] = [];
  let current: Memory = memory?.sha === sha ? memory : { sha, emitted: [] };
  if (memory && memory.sha !== sha && memory.emitted.includes('ready') && status.kind !== 'ready') {
    events.push('ready-lost');
  }
  if (
    (status.kind === 'ready' || status.kind === 'behind') &&
    !current.emitted.includes(status.kind)
  ) {
    events.push(status.kind);
  }
  if (events.length > 0) current = { sha, emitted: [...current.emitted, ...events] };
  return { events, memory: current };
}
