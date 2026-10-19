import { describe, expect, it } from 'vitest';

import { createFakeGitHub, FAKE_TOKEN, readyWorld } from './fake-github.ts';
import type { FakeWorld } from './fake-github.ts';
import { openPull, recordedPull } from './fixtures.ts';
import type { Pull } from './github.ts';
import { createGitHub } from './github.ts';
import { createLogger } from './log.ts';
import type { WatchState } from './state.ts';
import { watch } from './watch.ts';
import type { Targets } from './watch.ts';

const sha = '3a14390ebb297bd25e3e2fe2ae2a47ab34dc4032';
const pushed = '1111111111111111111111111111111111111111';
const MINUTE = 60_000;

/**
 * Runs the watcher against a fake GitHub on a fake clock. `between[i]` changes the world while
 * the watcher sleeps after pass i, so a test scripts what GitHub reports over time.
 */
async function runWatch({
  world = readyWorld(),
  targets = [52],
  state = { prs: {} },
  between = [],
  maxRunMs = 10 * MINUTE,
  before,
}: {
  world?: FakeWorld;
  targets?: Targets;
  state?: WatchState;
  between?: ((world: FakeWorld) => void)[];
  maxRunMs?: number;
  before?: (fake: ReturnType<typeof createFakeGitHub>) => void;
} = {}) {
  const fake = createFakeGitHub(world);
  before?.(fake);
  const lines: string[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const log = createLogger({
    write: (line) => lines.push(line),
    run: 'pr-watch-test',
    secrets: [FAKE_TOKEN],
  });
  const github = createGitHub({
    apiUrl: 'https://api.github.test',
    token: FAKE_TOKEN,
    fetch: (input, init) => fake.handle(new Request(input, init)),
    log,
    now: () => now,
  });
  let saved: WatchState = structuredClone(state);
  const result = await watch({
    github,
    repo: { owner: 'eriscs01', name: 'tribo' },
    targets,
    store: {
      load: () => structuredClone(saved),
      save: (next) => {
        saved = structuredClone(next);
      },
    },
    log,
    clock: {
      now: () => now,
      sleep: (ms) => {
        between[sleeps.length]?.(world);
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    },
    intervalMs: MINUTE,
    maxRunMs,
  });
  const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, saved, fake, sleeps, logged, lines };
}

const pull = (world: FakeWorld): Pull => world.pulls.get(52) ?? openPull();
const setPull = (world: FakeWorld, overrides: Partial<Pull>) => {
  world.pulls.set(52, { ...pull(world), ...overrides });
};
const pathsOf = (fake: ReturnType<typeof createFakeGitHub>, part: string) =>
  fake.requests.filter((request) => request.path.includes(part));

describe('watch', () => {
  it('exits with a ready line when every condition holds, and remembers it', async () => {
    const { result, saved, logged } = await runWatch();
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 ready ${sha}`] });
    expect(saved.prs['52']).toEqual({ sha, emitted: ['ready'] });
    expect(logged).toContainEqual(
      expect.objectContaining({ msg: 'event', pr: 52, sha, event: 'ready' }),
    );
  });

  it('after a restart, repeats no event it already emitted and exits quietly at its cap', async () => {
    const { result, sleeps } = await runWatch({
      state: { prs: { '52': { sha, emitted: ['ready'] } } },
      maxRunMs: 5 * MINUTE,
    });
    expect(result).toEqual({ kind: 'quiet' });
    expect(sleeps.every((ms) => ms >= MINUTE)).toBe(true);
  });

  it('reports ready lost when a push replaces a head that was ready', async () => {
    const world = readyWorld();
    setPull(world, { head: { ref: 'scratch/pr-watch-probe', sha: pushed } });
    const { result } = await runWatch({
      world,
      state: { prs: { '52': { sha, emitted: ['ready'] } } },
    });
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 ready-lost ${pushed}`] });
  });

  it('reports behind when only an out-of-date branch keeps the PR from ready', async () => {
    const world = readyWorld();
    setPull(world, { mergeable_state: 'behind' });
    const { result } = await runWatch({ world });
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 behind ${sha}`] });
  });

  it('reports merged and closed from the recorded pulls, then stops watching', async () => {
    const merged = readyWorld();
    merged.pulls.set(52, { ...recordedPull('pull-50-merged'), number: 52 });
    const first = await runWatch({ world: merged });
    expect(first.result).toEqual({ kind: 'events', lines: ['PR #52 merged'] });
    const again = await runWatch({ world: merged, state: first.saved });
    expect(again.result).toEqual({ kind: 'nothing' });

    const closed = readyWorld();
    closed.pulls.set(52, recordedPull('pull-52-closed'));
    expect((await runWatch({ world: closed })).result).toEqual({
      kind: 'events',
      lines: ['PR #52 closed'],
    });
  });

  it('waits a pass apart, asks with ETags, and reads checks only until they pass for a head', async () => {
    const world = readyWorld();
    world.threads.set(52, [false]);
    const { result, fake, sleeps } = await runWatch({
      world,
      between: [() => undefined, (w) => w.threads.set(52, [true])],
    });
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 ready ${sha}`] });
    expect(sleeps).toEqual([MINUTE, MINUTE]);
    expect(pathsOf(fake, '/pulls/52').map((request) => request.status)).toEqual([200, 304, 304]);
    expect(pathsOf(fake, '/check-runs')).toHaveLength(1);
  });

  it('reads check runs again while they are pending, and threads only once they pass', async () => {
    const world = readyWorld();
    const green = world.runs.get(sha) ?? [];
    world.runs.set(
      sha,
      green.filter((run) => run.name !== 'End to end'),
    );
    const { result, fake } = await runWatch({
      world,
      between: [() => undefined, (w) => w.runs.set(sha, green)],
    });
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 ready ${sha}`] });
    expect(pathsOf(fake, '/check-runs')).toHaveLength(3);
    expect(pathsOf(fake, '/graphql')).toHaveLength(1);
  });

  it('reads the check runs of a new head after a push', async () => {
    const world = readyWorld();
    world.threads.set(52, [false]);
    const { fake } = await runWatch({
      world,
      maxRunMs: 3 * MINUTE,
      between: [
        (w) => {
          setPull(w, { head: { ref: 'scratch/pr-watch-probe', sha: pushed } });
        },
      ],
    });
    expect(pathsOf(fake, '/check-runs').map((request) => request.path)).toEqual([
      expect.stringContaining(sha),
      expect.stringContaining(pushed),
      expect.stringContaining(pushed),
    ]);
  });

  it('waits out a rate limit until its reset, then carries on', async () => {
    const { result, sleeps, logged } = await runWatch({
      before: (fake) => {
        fake.failNext(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1300' });
      },
    });
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 ready ${sha}`] });
    expect(sleeps[0]).toBe(300_000);
    expect(logged).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'rate limited', waitMs: 300_000 }),
    );
  });

  it('backs a failing PR off, doubling the wait, and logs each failure with its code', async () => {
    const { result, sleeps, logged } = await runWatch({
      before: (fake) => {
        fake.failNext(502);
        fake.failNext(502);
      },
    });
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 ready ${sha}`] });
    expect(sleeps).toEqual([2 * MINUTE, 4 * MINUTE]);
    expect(logged.filter((line) => line.msg === 'poll failed')).toEqual([
      expect.objectContaining({ level: 'warn', pr: 52, code: 'http_502', retryInMs: 2 * MINUTE }),
      expect.objectContaining({ level: 'warn', pr: 52, code: 'http_502', retryInMs: 4 * MINUTE }),
    ]);
  });

  it('waits a pass when listing the open PRs fails, and logs the code', async () => {
    const { result, sleeps, logged } = await runWatch({
      targets: 'all',
      before: (fake) => {
        fake.failNext(500);
      },
    });
    expect(result).toEqual({ kind: 'events', lines: [`PR #52 ready ${sha}`] });
    expect(sleeps).toEqual([MINUTE]);
    expect(logged).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'list failed', code: 'http_500' }),
    );
  });

  it('with all open PRs, also follows a remembered PR that left the open list', async () => {
    const world = readyWorld();
    world.pulls.set(50, recordedPull('pull-50-merged'));
    const { result } = await runWatch({
      world,
      targets: 'all',
      state: { prs: { '50': { sha: 'old', emitted: [] } } },
    });
    expect(result).toEqual({ kind: 'events', lines: ['PR #50 merged', `PR #52 ready ${sha}`] });
  });
});
