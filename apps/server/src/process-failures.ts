import type { EventEmitter } from 'node:events';
import { currentRequestId } from './request-scope.js';

/**
 * An uncaught exception or unhandled rejection leaves the process in a state nobody chose:
 * log it at fatal, with the request id when it escaped from a request, then exit 1 so
 * Compose restarts the app into a known one.
 */
export function exitOnProcessFailure(
  proc: Pick<EventEmitter, 'on'> & { exit(code: number): void },
  log: { fatal(fields: Record<string, unknown>, msg: string): void },
): void {
  const fail = (err: unknown, msg: string) => {
    const requestId = currentRequestId();
    log.fatal({ err, ...(requestId === undefined ? {} : { requestId }) }, msg);
    proc.exit(1);
  };
  proc.on('uncaughtException', (error: unknown) => {
    fail(error, 'uncaught exception');
  });
  proc.on('unhandledRejection', (reason: unknown) => {
    fail(reason, 'unhandled rejection');
  });
}
