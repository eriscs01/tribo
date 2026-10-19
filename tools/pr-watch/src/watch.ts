import type { CheckRun, GitHub, Pull } from './github.ts';
import { GitHubError, RateLimitedError } from './errors.ts';
import type { Logger } from './log.ts';
import type { StateStore, WatchState } from './state.ts';
import { checksVerdict, prStatus } from './status.ts';
import type { ChecksVerdict, PrStatus } from './status.ts';
import { nextEvents } from './transitions.ts';
import type { EventKind, Memory } from './transitions.ts';

/** Explicit PR numbers, or every open PR into main plus any remembered PR not yet done. */
export type Targets = number[] | 'all';

export type WatchResult =
  | { kind: 'events'; lines: string[] }
  /** The run reached its cap without an event. */
  | { kind: 'quiet' }
  /** Every PR asked for is already merged or closed. */
  | { kind: 'nothing' };

export interface WatchOptions {
  github: GitHub;
  repo: { owner: string; name: string };
  targets: Targets;
  store: StateStore;
  log: Logger;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  /** Time between passes; every PR is asked about at most once per pass. */
  intervalMs: number;
  maxRunMs: number;
}

const MAX_BACKOFF_MS = 15 * 60_000;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { reviewThreads(first: 100) { totalCount nodes { isResolved } } }
  }
}`;

interface ThreadsAnswer {
  repository: {
    pullRequest: { reviewThreads: { totalCount: number; nodes: { isResolved: boolean }[] } };
  };
}

/** What one run learnt about a PR's head; read again only when it can have changed. */
interface Seen {
  sha: string;
  checks?: ChecksVerdict;
  threads?: number;
}

/**
 * One loop for every watched PR. Each pass asks GitHub about each PR (with ETags), computes
 * its status, and compares it with what was already emitted. The run returns as soon as a pass
 * produced events, after saving them, so the orchestrator is woken once per batch and starts
 * the next run; it also returns at its cap. A rate limit pauses the whole loop until GitHub's
 * reset; any other failure backs that PR off, doubling up to 15 minutes.
 */
export async function watch(options: WatchOptions): Promise<WatchResult> {
  const { github, repo, targets, store, log, clock, intervalMs, maxRunMs } = options;
  const base = `/repos/${repo.owner}/${repo.name}`;
  const started = clock.now();
  const state: WatchState = await store.load();
  const seen = new Map<number, Seen>();
  const backoff = new Map<number, { failures: number; until: number }>();

  async function requiredChecks(branch: string, pr: number): Promise<string[]> {
    const { data } = await github.get(`${base}/rules/branches/${encodeURIComponent(branch)}`, pr);
    const rules = data as { type: string; parameters?: unknown }[];
    return rules.flatMap((rule) =>
      rule.type === 'required_status_checks'
        ? (
            rule.parameters as { required_status_checks: { context: string }[] }
          ).required_status_checks.map((check) => check.context)
        : [],
    );
  }

  async function poll(number: number): Promise<{ sha: string; status: PrStatus }> {
    const pull = (await github.get(`${base}/pulls/${String(number)}`, number)).data as Pull;
    const { sha } = pull.head;
    if (pull.merged || pull.state === 'closed') {
      return { sha, status: prStatus({ pull, checks: undefined, unresolvedThreads: undefined }) };
    }
    const before = seen.get(number);
    const current: Seen = before?.sha === sha ? before : { sha };
    if (current.checks !== 'passed') {
      const required = await requiredChecks(pull.base.ref, number);
      const { data } = await github.get(`${base}/commits/${sha}/check-runs?per_page=100`, number);
      current.checks = checksVerdict(required, (data as { check_runs: CheckRun[] }).check_runs);
    }
    const memory: Memory | undefined = state.prs[String(number)];
    const announced = memory?.sha === sha && memory.emitted.includes('ready');
    if (current.checks === 'passed' && (current.threads === undefined || !announced)) {
      const data = (await github.graphql(
        THREADS_QUERY,
        { owner: repo.owner, name: repo.name, number },
        number,
      )) as ThreadsAnswer;
      const threads = data.repository.pullRequest.reviewThreads;
      // More threads than one page holds counts as unresolved: never ready on a guess.
      current.threads =
        threads.nodes.filter((thread) => !thread.isResolved).length +
        Math.max(0, threads.totalCount - threads.nodes.length);
    }
    seen.set(number, current);
    return {
      sha,
      status: prStatus({ pull, checks: current.checks, unresolvedThreads: current.threads }),
    };
  }

  async function watched(): Promise<number[]> {
    const remembered = Object.entries(state.prs)
      .filter(([, memory]) => !memory.done)
      .map(([number]) => Number(number));
    if (targets !== 'all') {
      return targets.filter((number) => !state.prs[String(number)]?.done);
    }
    const open = (await github.get(`${base}/pulls?state=open&base=main&per_page=100`))
      .data as Pull[];
    return [...new Set([...open.map((pull) => pull.number), ...remembered])].sort((a, b) => a - b);
  }

  /** Logs the polled status, and returns the event lines it adds to what was emitted. */
  function record(number: number, { sha, status }: { sha: string; status: PrStatus }): string[] {
    backoff.delete(number);
    log.info('pr polled', {
      pr: number,
      sha,
      status: status.kind,
      reason: status.kind === 'waiting' ? status.reason : undefined,
    });
    const next = nextEvents(state.prs[String(number)], sha, status);
    state.prs[String(number)] = next.memory;
    return next.events.map((event) => {
      log.info('event', { pr: number, sha, event });
      return eventLine(number, event, sha);
    });
  }

  function backOff(number: number, error: unknown): void {
    if (!(error instanceof GitHubError)) throw error;
    const failures = (backoff.get(number)?.failures ?? 0) + 1;
    const retryInMs = Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
    backoff.set(number, { failures, until: clock.now() + retryInMs });
    log.warn('poll failed', { pr: number, code: error.code, failures, retryInMs });
  }

  /** A rate limit waits until GitHub's reset; a failed listing waits one pass. */
  function waitFor(error: unknown): number {
    if (error instanceof RateLimitedError) {
      const waitMs = Math.max(error.untilMs - clock.now(), 1000);
      log.warn('rate limited', { waitMs });
      return waitMs;
    }
    if (!(error instanceof GitHubError)) throw error;
    log.warn('list failed', { code: error.code, retryInMs: intervalMs });
    return intervalMs;
  }

  /** One pass over every watched PR: the run's result, or how long to wait for the next pass. */
  async function pass(): Promise<WatchResult | { kind: 'wait'; ms: number }> {
    let numbers: number[];
    try {
      numbers = await watched();
    } catch (error) {
      return { kind: 'wait', ms: waitFor(error) };
    }
    if (targets !== 'all' && numbers.length === 0) return { kind: 'nothing' };

    const lines: string[] = [];
    let limited: RateLimitedError | undefined;
    for (const number of numbers.filter((n) => (backoff.get(n)?.until ?? 0) <= clock.now())) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one PR after another spreads the requests
        lines.push(...record(number, await poll(number)));
      } catch (error) {
        if (error instanceof RateLimitedError) {
          limited = error;
          break;
        }
        backOff(number, error);
      }
    }
    if (lines.length > 0) {
      await store.save(state);
      return { kind: 'events', lines };
    }
    if (limited) return { kind: 'wait', ms: waitFor(limited) };
    if (clock.now() - started + intervalMs >= maxRunMs) {
      await store.save(state);
      return { kind: 'quiet' };
    }
    // At least a pass apart; longer when every PR is backed off past it.
    const retries = [...backoff.values()].map((entry) => entry.until - clock.now());
    const allBackedOff = numbers.length > 0 && retries.length === numbers.length;
    return { kind: 'wait', ms: Math.max(intervalMs, allBackedOff ? Math.min(...retries) : 0) };
  }

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- passes run one after another, by design
    const outcome = await pass();
    if (outcome.kind !== 'wait') return outcome;
    // eslint-disable-next-line no-await-in-loop -- the pause between two passes
    await clock.sleep(outcome.ms);
  }
}

/** The line the orchestrator reads: `PR #53 ready <sha>`, `PR #53 merged`. */
function eventLine(number: number, event: EventKind, sha: string): string {
  const withSha = event === 'ready' || event === 'ready-lost' || event === 'behind';
  return `PR #${String(number)} ${event}${withSha ? ` ${sha}` : ''}`;
}
