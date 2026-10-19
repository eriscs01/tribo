import { describe, expect, it } from 'vitest';

import { greenRuns, openPull, recordedPull, requiredChecks } from './fixtures.ts';
import type { CheckRun } from './github.ts';
import { checksVerdict, prStatus } from './status.ts';

const required = requiredChecks();

describe('checksVerdict', () => {
  it('passes when every required check has a green run on the head, whatever else ran', () => {
    expect(checksVerdict(required, greenRuns())).toBe('passed');
  });

  it('counts skipped and neutral required runs as passing', () => {
    const runs = greenRuns().map((run): CheckRun =>
      run.name === 'Coverage' ? { ...run, conclusion: 'skipped' } : { ...run },
    );
    runs.push({ name: 'Secret scan', status: 'completed', conclusion: 'neutral' });
    expect(checksVerdict(required, runs)).toBe('passed');
  });

  it('is pending while a required check has not reported yet', () => {
    const runs = greenRuns().filter((run) => run.name !== 'End to end');
    expect(checksVerdict(required, runs)).toBe('pending');
  });

  it('is pending while a required check is still running', () => {
    const runs = greenRuns().map((run): CheckRun =>
      run.name === 'End to end' ? { ...run, status: 'in_progress', conclusion: null } : run,
    );
    expect(checksVerdict(required, runs)).toBe('pending');
  });

  it('is failing when a required check failed, even while others still run', () => {
    const runs = greenRuns().map((run): CheckRun => {
      if (run.name === 'Unit') return { ...run, conclusion: 'failure' };
      if (run.name === 'End to end') return { ...run, status: 'queued', conclusion: null };
      return run;
    });
    expect(checksVerdict(required, runs)).toBe('failing');
  });

  it('ignores a failing check the ruleset does not require', () => {
    const runs = greenRuns().map((run): CheckRun =>
      run.name === 'CodeQL' ? { ...run, conclusion: 'failure' } : run,
    );
    expect(checksVerdict(required, runs)).toBe('passed');
  });
});

describe('prStatus', () => {
  const ready = { checks: 'passed', unresolvedThreads: 0 } as const;

  it('is ready when checks pass, no thread is open and only the review blocks the merge', () => {
    expect(prStatus({ pull: openPull(), ...ready })).toEqual({ kind: 'ready' });
    expect(prStatus({ pull: openPull({ mergeable_state: 'clean' }), ...ready })).toEqual({
      kind: 'ready',
    });
  });

  it('is behind, not ready, when main moved on (the ruleset requires an up-to-date branch)', () => {
    expect(prStatus({ pull: openPull({ mergeable_state: 'behind' }), ...ready })).toEqual({
      kind: 'behind',
    });
  });

  it('reports merged and closed from the recorded pulls', () => {
    const merged = recordedPull('pull-50-merged');
    const closed = recordedPull('pull-52-closed');
    expect(prStatus({ pull: merged, checks: undefined, unresolvedThreads: undefined })).toEqual({
      kind: 'merged',
    });
    expect(prStatus({ pull: closed, checks: undefined, unresolvedThreads: undefined })).toEqual({
      kind: 'closed',
    });
  });

  it.each([
    ['a draft', { pull: openPull({ draft: true }), ...ready }, 'draft'],
    [
      'pending checks',
      { pull: openPull(), checks: 'pending', unresolvedThreads: undefined },
      'checks-pending',
    ],
    [
      'failing checks',
      { pull: openPull(), checks: 'failing', unresolvedThreads: undefined },
      'checks-failing',
    ],
    [
      'a conflict',
      { pull: openPull({ mergeable: false, mergeable_state: 'dirty' }), ...ready },
      'conflict',
    ],
    [
      'mergeability still computing',
      { pull: openPull({ mergeable: null, mergeable_state: 'unknown' }), ...ready },
      'mergeability-unknown',
    ],
    [
      'an unresolved thread',
      { pull: openPull(), checks: 'passed', unresolvedThreads: 1 },
      'threads',
    ],
    [
      'threads not read yet',
      { pull: openPull(), checks: 'passed', unresolvedThreads: undefined },
      'threads',
    ],
  ] as const)('waits on %s', (_name, input, reason) => {
    expect(prStatus(input)).toEqual({ kind: 'waiting', reason });
  });
});
