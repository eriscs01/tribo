import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { defineOperation } from './operation.js';
import { registry } from './operations/index.js';

const liveness = registry.find((op) => op.id === 'meta.liveness');
if (!liveness) throw new Error('meta.liveness missing');
const withPath = (path: string) => () => defineOperation({ ...liveness, path });

describe('defineOperation paths', () => {
  it.each([
    '/healthz',
    '/v1/trips',
    '/v1/trips/{tripId}/items/{itemId}',
    '/v1/auth/mfa/totp',
    '/v1/Me-2/files.v2',
  ])('accepts %s', (path) => {
    expect(withPath(path)).not.toThrow();
  });

  it.each([
    '',
    '/',
    '/v1/',
    '/v2/trips',
    'v1/trips',
    '/healthz/x',
    '/v1/trips?x=1',
    '/v1/trips#x',
    '/v1/trip_items',
    '/v1/trips/ x',
    '/v1/__proto__',
  ])('rejects %j', (path) => {
    expect(withPath(path)).toThrow(/unexpected path/);
  });
});

describe('defineOperation bodies', () => {
  const form = z.strictObject({ kind: z.string() });
  const { output: _output, ...bare } = liveness;

  it('takes a form only on a POST that declares the input its write validates', () => {
    expect(() =>
      defineOperation({ ...liveness, method: 'POST', form, input: form.extend({ n: z.int() }) }),
    ).not.toThrow();
    expect(() => defineOperation({ ...liveness, method: 'POST', form })).toThrow(/takes a form/);
    expect(() => defineOperation({ ...liveness, form, input: form })).toThrow(/takes a form/);
  });

  it('returns a file only from a GET without a JSON output', () => {
    expect(() => defineOperation({ ...bare, returnsFile: true })).not.toThrow();
    expect(() => defineOperation({ ...liveness, returnsFile: true, output: z.object({}) })).toThrow(
      /returns a file/,
    );
    expect(() => defineOperation({ ...bare, method: 'POST', returnsFile: true })).toThrow(
      /returns a file/,
    );
  });
});
