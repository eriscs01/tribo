import type { ErrorCode, Problem } from '@tribo/contract';

/**
 * An expected failure with its closed code. Core and the write path throw it; each adapter
 * (REST today, MCP in 1b) renders it, as RFC 9457 problem details over HTTP.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: Pick<Problem, 'detail' | 'errors'> = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/**
 * Turns the violation of a named constraint into the contract error its owner chose, where
 * only the database can tell (a race on a unique key, a foreign key, a check that needs
 * resolved values). Any other error, another constraint's included, is rethrown as it is.
 */
export function onConstraint(
  error: unknown,
  errors: Readonly<Record<string, () => ApiError>>,
): never {
  const name =
    error instanceof Error && 'constraint' in error && typeof error.constraint === 'string'
      ? error.constraint
      : null;
  const toError = name !== null && Object.hasOwn(errors, name) ? errors[name] : undefined;
  if (toError) throw toError();
  throw error;
}
