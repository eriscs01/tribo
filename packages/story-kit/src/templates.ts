// What scaffolded code says. Each template is a first draft the story owns from then on:
// the scaffold writes it once and never again.
import { VALUE_SETS } from '@tribo/db';
import type { Story } from './story.js';

const SCAFFOLDED = 'Scaffolded by pnpm new:op';

export function contractHeader(story: Story): string {
  return `// ${story.noun} schemas: request and response shapes of its operations.\nimport * as z from 'zod';\n`;
}

/** A strict object the story fills in; `of` says which operation it serves. */
export function schemaStub(name: string, of: string): string {
  return [
    `/** ${of}. ${SCAFFOLDED}: the story declares its fields. */`,
    `export const ${name} = z.strictObject({}).meta({ id: '${name}' });`,
    '',
    `export type ${name} = z.infer<typeof ${name}>;`,
  ].join('\n');
}

export function pageStub(name: string, item: string, of: string): string {
  return [
    `/** ${of}: one page of ${item}. */`,
    `export const ${name} = page(${item}, '${name}');`,
    '',
    `export type ${name} = z.infer<typeof ${name}>;`,
  ].join('\n');
}

/**
 * The shared rules of packages/core/src/roles.ts, by the trip roles they let in. A roles
 * column reduces to one of them; one that does not needs a new rule there first.
 */
const SHARED_RULES: Readonly<Record<string, string>> = {
  'member,organizer,owner,viewer': 'anyMember',
  'member,organizer,owner': 'contributors',
  'organizer,owner': 'organizers',
  owner: 'ownerOnly',
};

/** The shared rule a set of trip roles reduces to, or null. */
export function sharedRule(roles: readonly string[]): string | null {
  return SHARED_RULES[[...new Set(roles)].sort().join(',')] ?? null;
}

export function policyRow(story: Story, rule: string): string {
  return [
    `/** ${story.op.id}: ${story.op.roles} (operations.csv). The story adds what a trip role can't say. */`,
    `export const ${story.policyName} = ${rule};`,
  ].join('\n');
}

export function handlerEntry(story: Story): string {
  const { id } = story.op;
  return [
    `    // ${SCAFFOLDED}: parse the request, call the service, map its result.`,
    `    '${id}': () =>`,
    `      Promise.reject(new ApiError('not_implemented', { detail: '${id} is scaffolded, not built' })),`,
  ].join('\n');
}

export function handlerFile(story: Story, fn: string): string {
  return [
    `import { ApiError } from '@tribo/platform';`,
    `import type { Handlers } from '../routes.js';`,
    '',
    `export function ${fn}(): Handlers {`,
    '  return {',
    handlerEntry(story),
    '  };',
    '}',
    '',
  ].join('\n');
}

/** The tests the definition of done asks for, as todos the story turns into tests. */
function specs(story: Story): string[] {
  const { op, tripRoles } = story;
  const out: string[] = [];
  if (tripRoles) {
    const refused = VALUE_SETS['tribo.memberships.trip_role'].filter((r) => !tripRoles.includes(r));
    out.push(
      `${refused.length > 0 ? `refuses ${refused.join(', ')} with forbidden; ` : ''}lets ${op.roles}`,
      'answers not_found to an account outside the trip',
    );
  } else {
    out.push(`enforces the roles column: ${op.roles}`);
  }
  if (story.input) out.push('refuses an invalid body with validation_failed, writing nothing');
  if (op.ifMatch === 'version_or_new') {
    out.push(
      'creates with If-None-Match: *, replaces with If-Match = version, else version_conflict',
    );
  } else if (op.ifMatch !== 'no') {
    out.push(
      `takes If-Match = ${op.ifMatch}: refuses none with if_match_required, a stale one with version_conflict`,
    );
  }
  if (story.isWrite) {
    out.push('records its audit event and entity_versions snapshot in the one transaction');
  }
  for (const code of story.noteCodes) out.push(`answers ${code} where operations.csv says so`);
  out.push(...story.limits);
  return out;
}

const quote = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

export function integrationTest(story: Story): string {
  const { op } = story;
  return [
    `// @module-tag ${story.tag}`,
    `// ${op.id} (Drop ${String(op.drop)}): ${op.notes}`,
    `// ${SCAFFOLDED}; the story turns each todo into a test (CONTRIBUTING.md, definition of done).`,
    `import { describe, it } from 'vitest';`,
    '',
    `describe(${quote(op.id)}, () => {`,
    ...specs(story).map((spec) => `  it.todo(${quote(spec)});`),
    '});',
    '',
  ].join('\n');
}

/** World ids and the oracle rule a list's rows follow, where the leak harness has them. */
const LIST_RULES: Record<string, { candidates: string; visible: string }> = {
  Trip: {
    candidates: '(world) => world.trips.map((t) => t.id)',
    visible: '(world, userId, id) => oracle.tripVisible(world, userId, id)',
  },
  Item: {
    candidates: '(world) => world.trips.flatMap((t) => t.items.map((i) => i.id))',
    visible: '(world, userId, id) => oracle.itemVisible(world, userId, id)',
  },
};

export function leakTest(story: Story): string {
  const { id } = story.op;
  const rule = LIST_RULES[story.noun];
  const todo = (what: string) => `() => {\n  throw new Error(${quote(`${id}: ${what}`)});\n}`;
  return [
    `// @module-tag ${story.tag}`,
    `// ${id} against the oracle: every account lists exactly the rows the oracle allows.`,
    `// ${SCAFFOLDED}: it fails until \`read\` calls the service${rule ? '' : ' and the oracle states the rule'}.`,
    `import fc from 'fast-check';`,
    `import { afterAll, beforeAll, describe, it } from 'vitest';`,
    `import { createTestDatabase, type TestDatabase } from './database.js';`,
    `import { leakRunOptions, listProperty, ${rule ? 'oracle, ' : ''}type ListRead } from './leak.js';`,
    '',
    'const options = leakRunOptions();',
    '',
    `/** ${id} through its service, one page large enough for any generated world. */`,
    `const read: ListRead = ${todo('read the list through its service')};`,
    '',
    'const property = (tdb: TestDatabase) =>',
    '  listProperty(',
    '    tdb.db,',
    '    read,',
    `    ${rule?.candidates ?? todo('name the candidate ids in the world')},`,
    `    ${rule?.visible ?? todo('add the visibility rule to the oracle in leak.ts')},`,
    '  );',
    '',
    `describe(${quote(`${id} against the oracle`)}, () => {`,
    '  let tdb: TestDatabase;',
    '  beforeAll(async () => {',
    '    tdb = await createTestDatabase();',
    '  });',
    '  afterAll(() => tdb.destroy());',
    '',
    // eslint-disable-next-line no-template-curly-in-string -- the generated test's own template
    '  it(`lists exactly what the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {',
    '    await fc.assert(property(tdb), options);',
    '  });',
    '});',
    '',
  ].join('\n');
}
