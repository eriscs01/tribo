import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { exitOnProcessFailure } from './process-failures.js';
import { inRequestScope } from './request-scope.js';

/** A process that records what was logged and the exit code, instead of exiting. */
function fakeProcess() {
  const events = new EventEmitter();
  const logged: { fields: Record<string, unknown>; msg: string }[] = [];
  const exits: number[] = [];
  const proc = Object.assign(events, { exit: (code: number) => void exits.push(code) });
  exitOnProcessFailure(proc, { fatal: (fields, msg) => void logged.push({ fields, msg }) });
  return { events, logged, exits };
}

describe('process-level failures', () => {
  it('logs an uncaught exception at fatal with the request it escaped from, then exits 1', () => {
    const { events, logged, exits } = fakeProcess();
    const error = new Error('boom');
    inRequestScope('req-escaped-1', () => events.emit('uncaughtException', error));
    expect(logged).toEqual([
      { fields: { err: error, requestId: 'req-escaped-1' }, msg: 'uncaught exception' },
    ]);
    expect(exits).toEqual([1]);
  });

  it('logs an unhandled rejection outside any request without a request id, then exits 1', () => {
    const { events, logged, exits } = fakeProcess();
    events.emit('unhandledRejection', 'a bare reason');
    expect(logged).toEqual([{ fields: { err: 'a bare reason' }, msg: 'unhandled rejection' }]);
    expect(exits).toEqual([1]);
  });
});
