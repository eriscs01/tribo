import { readFile } from 'node:fs/promises';
import { Validator } from '@seriousme/openapi-schema-validator';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { toOpenApi } from './openapi.js';
import { defineOperation } from './operation.js';
import { registry } from './operations/index.js';
import { Money } from './money.js';
import { TimeInput } from './time.js';

const committed: unknown = JSON.parse(
  await readFile(new URL('../openapi.json', import.meta.url), 'utf8'),
);

describe('toOpenApi', () => {
  const doc = toOpenApi(registry);

  it('produces a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(doc);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it('matches the committed openapi.json (run `pnpm --filter @tribo/contract openapi`)', () => {
    expect(doc).toEqual(committed);
  });

  it('answers every planned operation with 501 not_implemented', () => {
    const paths = doc.paths as Record<string, Record<string, { responses: object }>>;
    for (const op of registry) {
      const responses = paths[op.path]?.[op.method.toLowerCase()]?.responses;
      expect(responses, op.id).toHaveProperty('501');
    }
  });

  it('renders schemas of an implemented operation, including base types', async () => {
    const base = registry[0];
    if (!base) throw new Error('empty registry');
    const op = defineOperation({
      ...base,
      id: 'test.create',
      method: 'POST',
      path: '/v1/test',
      status: 'implemented',
      input: z.object({ at: TimeInput, cost: Money }),
      output: z.object({ ok: z.boolean() }),
    });
    const single = toOpenApi([op]);
    expect((await new Validator().validate(single)).valid).toBe(true);
    expect(JSON.stringify(single)).toContain('"local"');
  });
});
