import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<string>();

/**
 * Runs the rest of a request with its id in scope, so a failure that escapes it (an
 * uncaught exception, an unhandled rejection) can still be logged with the id.
 */
export function inRequestScope(requestId: string, next: () => void): void {
  scope.run(requestId, next);
}

/** The id of the request whose work is running, or undefined outside one. */
export function currentRequestId(): string | undefined {
  return scope.getStore();
}
