import { registry } from '@tribo/contract';
import type { Loaded, WriteSpec } from '@tribo/platform';

type WriteOperation<I> = WriteSpec<unknown, I, Loaded, unknown>['operation'];

/**
 * A registry operation with its input schema typed for a write spec. The schema must be the
 * one the registry declares, so the route, the OpenAPI document and the write never differ.
 */
export function writeOperation<I>(
  id: string,
  input: WriteOperation<I>['input'],
): WriteOperation<I> {
  const op = registry.find((o) => o.id === id);
  if (op?.status !== 'implemented' || op.input !== input) {
    throw new Error(`${id} is not an implemented operation with this input schema`);
  }
  return { ...op, input };
}
