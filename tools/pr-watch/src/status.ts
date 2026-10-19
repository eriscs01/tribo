import type { CheckRun, Pull } from './github.ts';

/** How a PR's required checks stand on its head commit. */
export type ChecksVerdict = 'passed' | 'pending' | 'failing';

/** Why an open PR is not ready yet; logged, never emitted (Auto-fix wakes the session for these). */
type WaitReason =
  'draft' | 'checks-pending' | 'checks-failing' | 'conflict' | 'mergeability-unknown' | 'threads';

export type PrStatus =
  | { kind: 'merged' }
  | { kind: 'closed' }
  | { kind: 'ready' }
  | { kind: 'behind' }
  | { kind: 'waiting'; reason: WaitReason };

/** Conclusions GitHub's required-checks rule accepts. */
const PASSING = new Set(['success', 'neutral', 'skipped']);

/**
 * A required check passes when one of its runs on the head passed (a re-run after a failure
 * counts), fails when it finished with nothing passing, and is pending until it reports.
 */
export function checksVerdict(
  required: readonly string[],
  runs: readonly CheckRun[],
): ChecksVerdict {
  const verdicts = required.map((name): ChecksVerdict => {
    const finished = runs.filter((run) => run.name === name && run.status === 'completed');
    if (finished.some((run) => PASSING.has(run.conclusion ?? ''))) return 'passed';
    return finished.length > 0 ? 'failing' : 'pending';
  });
  if (verdicts.includes('failing')) return 'failing';
  return verdicts.includes('pending') ? 'pending' : 'passed';
}

/**
 * Ready means the user can merge now: required checks green, no unresolved review thread, no
 * conflict, and not behind main (the ruleset requires an up-to-date branch). A missing approval
 * (mergeable_state "blocked") does not count against it: the user approves by merging.
 * `unresolvedThreads` is undefined when they were not read (the watcher reads them only once
 * the checks pass), which never counts as ready.
 */
export function prStatus({
  pull,
  checks,
  unresolvedThreads,
}: {
  pull: Pull;
  checks: ChecksVerdict | undefined;
  unresolvedThreads: number | undefined;
}): PrStatus {
  if (pull.merged) return { kind: 'merged' };
  if (pull.state === 'closed') return { kind: 'closed' };
  if (pull.draft) return { kind: 'waiting', reason: 'draft' };
  if (checks !== 'passed') {
    return { kind: 'waiting', reason: checks === 'failing' ? 'checks-failing' : 'checks-pending' };
  }
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') {
    return { kind: 'waiting', reason: 'conflict' };
  }
  if (pull.mergeable === null || pull.mergeable_state === 'unknown') {
    return { kind: 'waiting', reason: 'mergeability-unknown' };
  }
  if (unresolvedThreads !== 0) return { kind: 'waiting', reason: 'threads' };
  return pull.mergeable_state === 'behind' ? { kind: 'behind' } : { kind: 'ready' };
}
