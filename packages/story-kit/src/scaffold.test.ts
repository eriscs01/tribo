import { registry } from '@tribo/contract';
import { describe, expect, it } from 'vitest';
import { planScaffold, type Workspace } from './scaffold.js';
import { addImport } from './source.js';
import { storyOf, tripRolesOf } from './story.js';

/** A registry file as the importer writes it, every entry planned. */
const registryFile = (name: string, ids: string[]) =>
  [
    "import { defineOperation } from '../operation.js';",
    '',
    `export const ${name}Operations = [`,
    ...ids.map((id) => `  defineOperation({\n    id: '${id}',\n    status: 'planned',\n  }),`),
    '] as const;',
    '',
  ].join('\n');

/** The files the scaffold extends, in the shapes the checkout has them before any story. */
const FIXTURE: Record<string, string> = {
  'packages/contract/src/index.ts':
    "export * from './account.js';\nexport * from './item.js';\nexport { registry } from './operations/index.js';\n",
  'packages/contract/src/account.ts':
    "import * as z from 'zod';\n\nexport const Account = z.strictObject({});\n",
  'packages/contract/src/item.ts':
    "import * as z from 'zod';\n\nexport const Item = z.strictObject({});\n",
  'packages/contract/src/operations/items.ts': registryFile('items', [
    'items.list',
    'items.update',
  ]),
  'packages/contract/src/operations/expenses.ts': registryFile('expenses', [
    'expenses.list',
    'expenses.create',
  ]),
  'packages/contract/src/operations/members.ts': registryFile('members', ['members.add']),
  'packages/core/src/items/policy.ts':
    "import type { ValueOf } from '@tribo/db';\n\ntype TripRole = ValueOf<'tribo.memberships.trip_role'>;\n",
  'packages/core/src/expenses/policy.ts': 'export {};\n',
  'packages/core/src/trips/policy.ts': 'export {};\n',
  'apps/server/src/handlers/items.ts': [
    "import type { Handlers } from '../routes.js';",
    '',
    'export function itemHandlers(): Handlers {',
    '  return {',
    "    'items.get': () => Promise.resolve({}),",
    '  };',
    '}',
    '',
  ].join('\n'),
  'apps/server/src/handlers/index.ts': [
    "import type { Handlers } from '../routes.js';",
    "import { itemHandlers } from './items.js';",
    '',
    'export function operationHandlers(): Handlers {',
    '  return {',
    '    ...itemHandlers(),',
    '  };',
    '}',
    '',
  ].join('\n'),
};

/** The fixture with `over` laid on top; nothing reaches the disk. */
function workspace(over = new Map<string, string>()): Workspace {
  const files = new Map([...Object.entries(FIXTURE), ...over]);
  return {
    read: (path) => files.get(path) ?? null,
    list: (dir) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1)),
  };
}

const story = (id: string) => {
  const op = registry.find((o) => o.id === id);
  if (!op) throw new Error(`no ${id}`);
  return storyOf(op);
};

describe('storyOf', () => {
  it.each([
    ['items.update', 'item.ts', 'ItemPatch', 'Item'],
    ['items.list', 'item.ts', null, 'ItemPage'],
    ['items.delete', 'item.ts', null, null],
    ['items.reveal', 'item.ts', 'ItemRevealInput', 'ItemReveal'],
    ['items.assignments.replace', 'assignment.ts', 'AssignmentInput', 'Assignment'],
    ['library.people.update', 'person.ts', 'PersonPatch', 'Person'],
    ['members.setRole', 'member.ts', 'MemberSetRolePatch', 'MemberSetRole'],
    ['expenses.create', 'expense.ts', 'ExpenseInput', 'Expense'],
  ])('names %s schemas in %s: %s → %s', (id, file, input, output) => {
    const s = story(id);
    expect(s.contractFile).toBe(file);
    expect(s.input?.name ?? null).toBe(input);
    expect(s.output?.name ?? null).toBe(output);
  });

  it('reads trip roles from the roles column, leaving other rules to the story', () => {
    expect(tripRolesOf('owner, organizer, member (own/assigned)')).toEqual([
      'owner',
      'organizer',
      'member',
    ]);
    expect(tripRolesOf('item owner, organizer, owner')).toEqual(['organizer', 'owner']);
    expect(tripRolesOf('owner; self (non-owner leaving, G14)')).toEqual(['owner']);
    expect(tripRolesOf('self (not viewer)')).toBeNull();
    expect(tripRolesOf('any signed-in user')).toBeNull();
  });

  it('tags each story with its drop and refuses anything outside slice 1a', () => {
    expect(story('items.update').tag).toBe('drop-a');
    expect(story('tickets.create').tag).toBe('drop-b');
    expect(() => story('checklist.add')).toThrow(/slice 1b/);
  });

  it('names the error codes the CSV notes mention', () => {
    expect(story('items.update').noteCodes).toEqual(['masked_field_write', 'trip_archived']);
  });

  it('scaffolds every slice 1a story without an unknown module', () => {
    for (const op of registry.filter((o) => o.slice === '1a')) {
      expect(() => storyOf(op), op.id).not.toThrow();
    }
  });
});

describe('planScaffold', () => {
  it('writes the schemas, registry entry, policy row, handler, tagged test and leak registration', () => {
    const plan = planScaffold(story('items.list'), workspace());
    expect([...plan.writes.keys()].sort()).toEqual([
      'apps/server/src/handlers/items.ts',
      'packages/contract/src/item.ts',
      'packages/contract/src/operations/items.ts',
      'packages/core/src/items/policy.ts',
      'packages/testkit/src/items-list.int.test.ts',
      'packages/testkit/src/items-list.leak.test.ts',
    ]);
    const entry = plan.writes.get('packages/contract/src/operations/items.ts') ?? '';
    expect(entry).toMatch(/status: 'implemented',\nquery: PageQuery,\noutput: ItemPage,/);
    expect(entry).toContain("import { PageQuery } from '../page.js';");
    expect(plan.writes.get('packages/contract/src/item.ts')).toContain(
      "export const ItemPage = page(Item, 'ItemPage');",
    );
    expect(plan.writes.get('packages/core/src/items/policy.ts')).toContain(
      'export function canListItem(role: TripRole): boolean',
    );
    expect(plan.writes.get('apps/server/src/handlers/items.ts')).toContain(
      "'items.list': () =>\n      Promise.reject(new ApiError('not_implemented'",
    );
    const int = plan.writes.get('packages/testkit/src/items-list.int.test.ts') ?? '';
    expect(int.split('\n')[0]).toBe('// @module-tag drop-a');
    const leak = plan.writes.get('packages/testkit/src/items-list.leak.test.ts') ?? '';
    expect(leak).toContain('listProperty(');
    expect(leak).toContain('oracle.itemVisible(world, userId, id)');
  });

  it('adds nothing on a rerun, so hand edits survive', () => {
    const first = planScaffold(story('expenses.create'), workspace());
    expect(first.writes.size).toBeGreaterThan(0);
    const edited = new Map(first.writes);
    edited.set('packages/testkit/src/expenses-create.int.test.ts', '// the story wrote this\n');
    const second = planScaffold(story('expenses.create'), workspace(edited));
    expect(second.writes.size).toBe(0);
    expect(second.report.every((line) => /kept|no policy row/.test(line))).toBe(true);
  });

  it('starts a contract file and a handler file for a module that has none, and mounts it', () => {
    const plan = planScaffold(story('expenses.create'), workspace());
    expect(plan.writes.get('packages/contract/src/index.ts')).toContain(
      "export * from './expense.js';",
    );
    expect(plan.writes.get('apps/server/src/handlers/expenses.ts')).toContain(
      'export function expensesHandlers(): Handlers',
    );
    const index = plan.writes.get('apps/server/src/handlers/index.ts') ?? '';
    expect(index).toContain('...expensesHandlers(),');
    expect(index).toContain("import { expensesHandlers } from './expenses.js';");
    // The empty placeholder policy gives way to the TripRole type and the row.
    const policy = plan.writes.get('packages/core/src/expenses/policy.ts') ?? '';
    expect(policy).not.toContain('export {};');
    expect(policy).toContain("import type { ValueOf } from '@tribo/db';");
  });

  it('writes the Drop B limits into the tests of the stories they bind', () => {
    const tests = (id: string) =>
      [...planScaffold(story(id), workspace()).writes]
        .filter(([path]) => path.endsWith('.int.test.ts'))
        .map(([, content]) => content)
        .join('');
    expect(tests('expenses.create')).toContain('Honours Idempotency-Key');
    expect(tests('expenses.create')).toContain('fx_rate = 1');
    expect(tests('expenses.create')).toContain('equal or itemised only');
    expect(tests('members.add')).toContain('Takes no Idempotency-Key in 1a');
    expect(tests('expenses.list')).not.toContain('Idempotency-Key');
  });

  it('keeps a story whose parts were all written by hand', () => {
    const byHand = new Map([
      [
        'packages/contract/src/item.ts',
        `${FIXTURE['packages/contract/src/item.ts'] ?? ''}export const ItemPatch = z.strictObject({});\n`,
      ],
      [
        'packages/contract/src/operations/items.ts',
        (FIXTURE['packages/contract/src/operations/items.ts'] ?? '').replace(
          /(id: 'items.update',\n\s+status: )'planned'/,
          "$1'implemented'",
        ),
      ],
      ['packages/core/src/items/policy.ts', '/** items.update: written by hand. */\n'],
      ['apps/server/src/handlers/trips.ts', "'items.update'"],
      ['packages/testkit/src/items-update.int.test.ts', '// by hand\n'],
    ]);
    const plan = planScaffold(story('items.update'), workspace(byHand));
    expect(plan.writes.size).toBe(0);
  });
});

describe('addImport', () => {
  it('merges into an existing import, else puts packages before relative paths', () => {
    const source = "import { a } from 'pkg';\nimport { b } from './b.js';\n";
    expect(addImport(source, 'pkg', ['c'])).toContain("import { a, c } from 'pkg';");
    expect(addImport(source, 'other', ['d'])).toBe(
      "import { a } from 'pkg';\nimport { d } from 'other';\nimport { b } from './b.js';\n",
    );
    expect(addImport(source, './e.js', ['e']).endsWith("import { e } from './e.js';\n")).toBe(true);
  });
});
