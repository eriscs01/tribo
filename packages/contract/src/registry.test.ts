import { describe, expect, it } from 'vitest';
import { PATH_PARAM_PREFIX } from './ids.js';
import { defineOperation, pathParams } from './operation.js';
import { registry } from './operations/index.js';

describe('registry', () => {
  it('holds 130 operations', () => {
    expect(registry).toHaveLength(130);
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

  it('declares a representation ETag only on GET reads', () => {
    const base = registry.find((op) => op.id === 'trips.get');
    if (!base) throw new Error('trips.get missing');
    expect(() => defineOperation({ ...base, method: 'POST' })).toThrow(
      /trips.get declares an ETag but is not a GET read/,
    );
  });
});
