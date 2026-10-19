import { describe, expect, it } from 'vitest';

import type { PrStatus } from './status.ts';
import { nextEvents } from './transitions.ts';
import type { Memory } from './transitions.ts';

const sha1 = '3a14390ebb297bd25e3e2fe2ae2a47ab34dc4032';
const sha2 = '6cf813f759633139430a718a51caf17254941e9d';
const ready: PrStatus = { kind: 'ready' };
const behind: PrStatus = { kind: 'behind' };
const pending: PrStatus = { kind: 'waiting', reason: 'checks-pending' };

/** Feeds statuses in order, carrying the memory, and returns every event emitted. */
function run(steps: [string, PrStatus][], start?: Memory) {
  let memory = start;
  const events: string[] = [];
  for (const [sha, status] of steps) {
    const next = nextEvents(memory, sha, status);
    events.push(...next.events);
    ({ memory } = next);
  }
  return { events, memory };
}

describe('nextEvents', () => {
  it('emits ready once per head sha, however often the PR is seen ready', () => {
    expect(
      run([
        [sha1, pending],
        [sha1, ready],
        [sha1, ready],
        [sha1, ready],
      ]).events,
    ).toEqual(['ready']);
  });

  it('emits ready-lost when a push replaces a head that was ready, then ready again', () => {
    expect(
      run([
        [sha1, ready],
        [sha2, pending],
        [sha2, pending],
        [sha2, ready],
      ]).events,
    ).toEqual(['ready', 'ready-lost', 'ready']);
  });

  it('says nothing about a push to a head that was never ready', () => {
    expect(
      run([
        [sha1, pending],
        [sha2, pending],
      ]).events,
    ).toEqual([]);
  });

  it('emits behind once per head sha, also when a ready head falls behind main', () => {
    expect(
      run([
        [sha1, ready],
        [sha1, behind],
        [sha1, behind],
      ]).events,
    ).toEqual(['ready', 'behind']);
  });

  it('emits merged once and marks the PR done', () => {
    const result = run([
      [sha1, ready],
      [sha1, { kind: 'merged' }],
      [sha1, { kind: 'merged' }],
    ]);
    expect(result.events).toEqual(['ready', 'merged']);
    expect(result.memory?.done).toBe(true);
  });

  it('emits closed once', () => {
    expect(
      run([
        [sha1, pending],
        [sha1, { kind: 'closed' }],
        [sha1, { kind: 'closed' }],
      ]).events,
    ).toEqual(['closed']);
  });

  it('after a restart, recovers what it missed and repeats nothing it already emitted', () => {
    const before = run([[sha1, ready]]);
    const persisted = JSON.parse(JSON.stringify(before.memory)) as Memory;
    expect(run([[sha1, ready]], persisted).events).toEqual([]);
    expect(run([[sha1, { kind: 'merged' }]], persisted).events).toEqual(['merged']);
  });
});
