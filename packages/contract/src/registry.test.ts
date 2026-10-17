import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fromCsvRow } from './csv-row.js';
import { parseCsv } from './csv.js';
import { PATH_PARAM_PREFIX } from './ids.js';
import { pathParams } from './operation.js';
import { registry } from './operations/index.js';

const csv = parseCsv(await readFile(new URL('../operations.csv', import.meta.url), 'utf8')).map(
  fromCsvRow,
);

describe('registry against operations.csv', () => {
  it('registers every CSV operation once, in CSV order', () => {
    expect(registry.map((op) => op.id)).toEqual(csv.map((op) => op.id));
    expect(registry).toHaveLength(130);
  });

  it.each(csv.map((row) => [row.id, row] as const))('%s matches its CSV row', (id, row) => {
    const op = registry.find((o) => o.id === id);
    expect(op).toBeDefined();
    // The columns task 3 names, then the rest the CSV defines.
    expect({
      method: op?.method,
      path: op?.path,
      auth: op?.auth,
      ifMatch: op?.ifMatch,
      idempotent: op?.idempotent,
    }).toEqual({
      method: row.method,
      path: row.path,
      auth: row.auth,
      ifMatch: row.ifMatch,
      idempotent: row.idempotent,
    });
    const { status: _status, input: _input, output: _output, ...rest } = op ?? {};
    expect(rest).toEqual(row);
  });

  it('has unique ids and unique method + path pairs', () => {
    expect(new Set(registry.map((op) => op.id)).size).toBe(registry.length);
    expect(new Set(registry.map((op) => `${op.method} ${op.path}`)).size).toBe(registry.length);
  });

  it('holds the 68 slice 1a operations: 46 in Drop A and 22 in Drop B', () => {
    const oneA = registry.filter((op) => op.slice === '1a');
    expect(oneA).toHaveLength(68);
    expect(oneA.filter((op) => op.drop === 'A')).toHaveLength(46);
    expect(oneA.filter((op) => op.drop === 'B')).toHaveLength(22);
  });

  it('maps every TypeID path parameter to a prefix', () => {
    const params = new Set(registry.flatMap((op) => pathParams(op.path)));
    for (const name of params) {
      if (name !== 'uid') expect(PATH_PARAM_PREFIX, name).toHaveProperty(name);
    }
  });

  it('gives a planned operation no input or output schema', () => {
    for (const op of registry.filter((o) => o.status === 'planned')) {
      expect(op.input ?? op.output, op.id).toBeUndefined();
    }
  });
});
