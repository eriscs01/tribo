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
