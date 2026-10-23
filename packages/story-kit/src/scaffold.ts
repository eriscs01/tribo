// The plan for one story's scaffold: which files gain what. Every step first checks whether
// its part is already there and skips it if so, so rerunning never overwrites a hand edit.
import { addImport, addToReturnedObject, AnchorError, appendBlock } from './source.js';
import type { SchemaName, Story } from './story.js';
import {
  contractHeader,
  handlerEntry,
  handlerFile,
  integrationTest,
  leakTest,
  pageStub,
  policyRow,
  sharedRule,
  schemaStub,
} from './templates.js';

/** The repository as the plan reads it; paths are relative to its root. */
export interface Workspace {
  read(path: string): string | null;
  /** File names directly under `dir`. */
  list(dir: string): string[];
}

export interface Plan {
  /** Final contents by path: the files to write. */
  writes: Map<string, string>;
  /** One line per step: what it added, or why it left the file alone. */
  report: string[];
}

const CONTRACT = 'packages/contract/src';
const HANDLERS = 'apps/server/src/handlers';
const TESTKIT = 'packages/testkit/src';

/** The workspace with this plan's own writes laid over it, so steps build on each other. */
class Draft {
  readonly writes = new Map<string, string>();

  readonly report: string[] = [];

  constructor(private readonly workspace: Workspace) {}

  read(path: string): string | null {
    return this.writes.get(path) ?? this.workspace.read(path);
  }

  list(dir: string): string[] {
    const pending = [...this.writes.keys()]
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => p.slice(dir.length + 1));
    return [...new Set([...this.workspace.list(dir), ...pending])];
  }

  write(path: string, content: string, note: string): void {
    this.writes.set(path, content);
    this.report.push(`${path}: ${note}`);
  }

  skip(path: string, why: string): void {
    this.report.push(`${path}: kept (${why})`);
  }
}

/** Which contract file exports `name`, if any does. */
function exporterOf(draft: Draft, name: string): string | null {
  const declares = new RegExp(`^export const ${name}\\b`, 'm');
  const file = draft
    .list(CONTRACT)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .find((f) => declares.test(draft.read(`${CONTRACT}/${f}`) ?? ''));
  return file ?? null;
}

function addSchema(draft: Draft, story: Story, schema: SchemaName, block: string, uses: string[]) {
  const existing = exporterOf(draft, schema.name);
  if (existing) {
    draft.skip(`${CONTRACT}/${existing}`, `${schema.name} exists`);
    return existing;
  }
  const path = `${CONTRACT}/${schema.file}`;
  const before = draft.read(path);
  let source = appendBlock(before ?? contractHeader(story), block);
  if (uses.length > 0) source = addImport(source, './page.js', uses);
  draft.write(path, source, `added ${schema.name}`);
  if (before === null) {
    const index = `${CONTRACT}/index.ts`;
    const line = `export * from './${schema.file.replace(/\.ts$/, '.js')}';`;
    const lines = (draft.read(index) ?? '').trimEnd().split('\n');
    // In name order, after the last `export *` line that sorts before it.
    const after = lines.findLastIndex((l) => l.startsWith('export * from') && l < line);
    lines.splice(after + 1, 0, line);
    draft.write(index, `${lines.join('\n')}\n`, `exports ${schema.file}`);
  }
  return schema.file;
}

/** The Input, Patch and Output schemas; returns where each one the registry names lives. */
function contractSchemas(draft: Draft, story: Story): Map<string, string> {
  const { op, resource, input, output } = story;
  const files = new Map<string, string>();
  const needsResource = output !== null && (story.isList || output.name === resource.name);
  if (needsResource) {
    files.set(
      resource.name,
      addSchema(
        draft,
        story,
        resource,
        schemaStub(resource.name, `${story.noun}, as ${op.id} returns it`),
        [],
      ),
    );
  }
  if (input) {
    files.set(
      input.name,
      addSchema(draft, story, input, schemaStub(input.name, `${op.id} body`), []),
    );
  }
  if (output && output.name !== resource.name) {
    const block = story.isList
      ? pageStub(output.name, resource.name, op.id)
      : schemaStub(output.name, `${op.id} response`);
    files.set(output.name, addSchema(draft, story, output, block, story.isList ? ['page'] : []));
  }
  return files;
}

function registryEntry(draft: Draft, story: Story, files: Map<string, string>) {
  const { op, input, output } = story;
  const path = `${CONTRACT}/operations/${story.moduleFile}.ts`;
  const source = draft.read(path);
  const start = source?.indexOf(`id: '${op.id}',`) ?? -1;
  const end = start < 0 ? -1 : (source?.indexOf('}),', start) ?? -1);
  if (source === null || start < 0 || end < 0) throw new AnchorError(path, `the ${op.id} entry`);
  const entry = source.slice(start, end);
  if (!entry.includes("status: 'planned',")) {
    draft.skip(path, `${op.id} is implemented`);
    return;
  }
  const fields = [
    "status: 'implemented',",
    ...(story.isList ? ['query: PageQuery,'] : []),
    ...(input ? [`input: ${input.name},`] : []),
    ...(output ? [`output: ${output.name},`] : []),
  ];
  let next = `${source.slice(0, start)}${entry.replace("status: 'planned',", fields.join('\n'))}${source.slice(end)}`;
  const byFile = new Map<string, string[]>();
  for (const [name, file] of files) {
    if (name === input?.name || name === output?.name) {
      byFile.set(file, [...(byFile.get(file) ?? []), name]);
    }
  }
  if (story.isList) byFile.set('page.ts', [...(byFile.get('page.ts') ?? []), 'PageQuery']);
  for (const [file, names] of byFile) {
    next = addImport(next, `../${file.replace(/\.ts$/, '.js')}`, names);
  }
  draft.write(path, next, `${op.id} implemented with its schemas`);
}

function policy(draft: Draft, story: Story) {
  const { op, tripRoles, coreModule } = story;
  if (!tripRoles || !coreModule) {
    draft.report.push(`no policy row: the roles column (${op.roles}) is not a trip role`);
    return;
  }
  const path = `packages/core/src/${coreModule}/policy.ts`;
  const before = draft.read(path) ?? '';
  if (before.includes(op.id)) {
    draft.skip(path, `it already names ${op.id}`);
    return;
  }
  const rule = sharedRule(tripRoles);
  if (!rule) {
    draft.report.push(
      `no policy row: ${tripRoles.join(', ')} reduce to no rule in packages/core/src/roles.ts; add one there`,
    );
    return;
  }
  const source = addImport(appendBlock(before, policyRow(story, rule)), '../roles.js', [rule]);
  draft.write(path, source, `added ${story.policyName}`);
}

const HANDLERS_FUNCTION = /export function \w+Handlers\(/;

function handler(draft: Draft, story: Story) {
  const { id } = story.op;
  const holder = draft
    .list(HANDLERS)
    .find((f) => draft.read(`${HANDLERS}/${f}`)?.includes(`'${id}'`));
  if (holder) {
    draft.skip(`${HANDLERS}/${holder}`, `it handles ${id}`);
    return;
  }
  const path = `${HANDLERS}/${story.moduleFile}.ts`;
  const existing = draft.read(path);
  if (existing !== null) {
    const source = addImport(
      addToReturnedObject(path, existing, HANDLERS_FUNCTION, handlerEntry(story)),
      '@tribo/platform',
      ['ApiError'],
    );
    draft.write(path, source, `added a ${id} stub`);
    return;
  }
  const fn = `${story.moduleFile}Handlers`;
  draft.write(path, handlerFile(story, fn), `created with a ${id} stub`);
  const index = `${HANDLERS}/index.ts`;
  const mounted = addToReturnedObject(
    index,
    draft.read(index) ?? '',
    /export function operationHandlers\(/,
    `    ...${fn}(),`,
  );
  draft.write(index, addImport(mounted, `./${story.moduleFile}.js`, [fn]), `mounts ${fn}`);
}

function newFile(draft: Draft, path: string, content: () => string, note: string) {
  if (draft.read(path) !== null) draft.skip(path, 'it exists');
  else draft.write(path, content(), note);
}

export function planScaffold(story: Story, workspace: Workspace): Plan {
  const draft = new Draft(workspace);
  const files = contractSchemas(draft, story);
  registryEntry(draft, story, files);
  policy(draft, story);
  handler(draft, story);
  newFile(
    draft,
    `${TESTKIT}/${story.slug}.int.test.ts`,
    () => integrationTest(story),
    `tagged ${story.tag}`,
  );
  if (story.isList) {
    newFile(
      draft,
      `${TESTKIT}/${story.slug}.leak.test.ts`,
      () => leakTest(story),
      'registered with listProperty',
    );
  }
  return { writes: draft.writes, report: draft.report };
}
