import { ApiProblem } from '../api/client';
import { m } from '../messages';

/** One sentence for a failed request; field errors are shown by their fields instead. */
export function problemMessage(error: unknown): string {
  if (error instanceof ApiProblem) {
    return m.errors.byCode[error.code] ?? m.errors.other(error.problem.requestId);
  }
  // fetch rejects with a TypeError when the network or the server is down.
  if (error instanceof TypeError) return m.errors.network;
  return m.errors.other('');
}

export function fieldErrorsOf(error: unknown): Record<string, string> {
  return error instanceof ApiProblem ? error.fieldErrors() : {};
}
