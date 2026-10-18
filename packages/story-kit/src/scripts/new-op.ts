// `pnpm new:op <id>`: scaffolds one slice 1a story from its registry entry (see scaffold.ts),
// formats what it wrote, then regenerates openapi.json, the web client and docs/backlog.md. Rerunning it adds
// only what is missing.
/* eslint-disable n/no-sync -- a one-shot CLI: each step needs the previous one's files */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from '@tribo/contract';
import { planScaffold, type Workspace } from '../scaffold.js';
import { storyOf } from '../story.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

const disk: Workspace = {
  read(path) {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(join(root, dir));
    } catch {
      return [];
    }
  },
};

const id = process.argv[2];
const op = registry.find((o) => o.id === id);
if (!op) {
  console.error(`usage: pnpm new:op <id>, with an id from operations.csv (got ${String(id)})`);
  process.exit(1);
}

const plan = planScaffold(storyOf(op), disk);
for (const [path, content] of plan.writes) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
for (const line of plan.report) console.log(line);

if (plan.writes.size > 0) {
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, { cwd: root, stdio: 'inherit' });
  run('pnpm', ['exec', 'prettier', '--write', '--log-level', 'warn', ...plan.writes.keys()]);
  run('pnpm', ['exec', 'tsc', '-b', 'packages/story-kit']);
  run('node', ['packages/contract/dist/scripts/write-openapi.js']);
  run('pnpm', ['--filter', '@tribo/web', 'client']);
  run('node', ['packages/story-kit/dist/scripts/write-backlog.js']);
}
console.log(
  `\n${op.id}: review the openapi.json diff, then meet the definition of done in CONTRIBUTING.md.`,
);
