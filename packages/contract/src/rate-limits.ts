import type { Operation } from './operation.js';

/**
 * Which operations the in-app rate limits count (Technical design, Operations, "Rate
 * limits"; decision 0008): every implemented write. Reads are never limited, and a planned
 * operation does nothing to limit. The REST adapter and the OpenAPI document both read it.
 */
export function isRateLimited(op: Pick<Operation, 'method' | 'status'>): boolean {
  return op.status === 'implemented' && op.method !== 'GET';
}
