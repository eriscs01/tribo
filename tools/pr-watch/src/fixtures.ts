import { readFileSync } from 'node:fs';

import type { CheckRun, Pull } from './github.ts';

/**
 * Responses recorded from api.github.com for eriscs01/tribo (trimmed to the fields the watcher
 * reads). Tests derive the other states from them, so every shape a test feeds in is one
 * GitHub really sends.
 */
function recorded(name: string): unknown {
  // eslint-disable-next-line n/no-sync -- test fixtures, read when a test builds its world
  return JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));
}

/** PR #50 merged, PR #52 closed unmerged (the watcher's probe PR). */
export const recordedPull = (name: 'pull-50-merged' | 'pull-52-closed'): Pull =>
  recorded(name) as Pull;

/** Recorded rules for main: ten required checks, strict, thread resolution required. */
export const rulesMain = (): unknown[] => recorded('rules-main') as unknown[];

/** The ten required check names, as the recorded ruleset lists them. */
export const requiredChecks = (): string[] =>
  (
    rulesMain().find((rule) => (rule as { type: string }).type === 'required_status_checks') as {
      parameters: { required_status_checks: { context: string }[] };
    }
  ).parameters.required_status_checks.map((check) => check.context);

/** PR #52 as GitHub reported it, reopened as a non-draft PR that is blocked only on review. */
export function openPull(overrides: Partial<Pull> = {}): Pull {
  return {
    ...recordedPull('pull-52-closed'),
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'blocked',
    ...overrides,
  };
}

/** The 17 check runs recorded on PR #52's head: every one completed, the ten required green. */
export const greenRuns = (): CheckRun[] =>
  (recorded('check-runs-52-green') as { check_runs: CheckRun[] }).check_runs;
