import { readFile } from 'node:fs/promises';
import { registry } from '@tribo/contract';
import { describe, expect, it } from 'vitest';
import { renderBacklog } from './backlog.js';
import { EXPENSE_WRITES, IDEMPOTENCY_KEY_OPERATIONS } from './limits.js';

const committed = await readFile(new URL('../../../docs/backlog.md', import.meta.url), 'utf8');
const backlog = renderBacklog(registry);

describe('docs/backlog.md', () => {
  it('matches the registry (run `pnpm backlog`)', () => {
    expect(committed).toBe(backlog);
  });

  it('holds the 68 slice 1a stories, each tagged by drop, and nothing else', () => {
    const stories = backlog.match(/^- \[[ x]\] `[^`]+` · Drop [AB] ·/gm) ?? [];
    expect(stories).toHaveLength(68);
    expect(stories.filter((s) => s.endsWith('Drop A ·'))).toHaveLength(46);
    expect(stories.filter((s) => s.endsWith('Drop B ·'))).toHaveLength(22);
    expect(backlog).not.toContain('`checklist.add`');
  });

  it('groups the stories under one heading per CSV module', () => {
    const modules = new Set(registry.filter((op) => op.slice === '1a').map((op) => op.module));
    const headings = backlog.match(/^## .+$/gm) ?? [];
    expect(headings).toEqual([...modules].map((m) => `## ${m}`));
  });

  it('writes the Drop B limits into the stories they bind', () => {
    const entry = (id: string) => backlog.split('\n- [').find((s) => s.includes(`\`${id}\` ·`));
    expect(entry('expenses.create')).toMatch(/Honours Idempotency-Key/);
    expect(entry('files.upload')).toMatch(/Honours Idempotency-Key/);
    expect(entry('expenses.create')).toMatch(/fx_rate = 1/);
    expect(entry('expenses.update')).toMatch(/equal or itemised only/);
    expect(entry('items.create')).toMatch(/Takes no Idempotency-Key in 1a/);
  });

  it('names only operations the registry holds in its limits', () => {
    const ids = new Set(registry.map((op) => op.id));
    for (const id of [...IDEMPOTENCY_KEY_OPERATIONS, ...EXPENSE_WRITES]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});
