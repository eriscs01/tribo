// docs/backlog.md: the slice 1a stories, rendered from the registry. The registry owns the
// stories; this file only shows them.
import type { Drop, Operation } from '@tribo/contract';
import { dropLimits } from './limits.js';

const DUE: Record<Drop, string> = { A: 'Sun 1 Nov', B: 'Sun 8 Nov' };

const IDEMPOTENCY: Record<Operation['idempotent'], string> = {
  key: 'creates (key)',
  natural: 'safe to repeat',
  no: 'never replayed',
};

function story(op: Operation): string[] {
  const done = op.status === 'implemented' ? 'x' : ' ';
  return [
    `- [${done}] \`${op.id}\` · Drop ${String(op.drop)} · \`${op.method} ${op.path}\``,
    `  - ${op.notes}`,
    `  - Roles: ${op.roles}. If-Match: \`${op.ifMatch}\`. Idempotency: ${IDEMPOTENCY[op.idempotent]}.`,
    ...dropLimits(op).map((limit) => `  - Limit: ${limit}`),
  ];
}

export function renderBacklog(registry: readonly Operation[]): string {
  const stories = registry.filter((op) => op.slice === '1a');
  const inDrop = (drop: Drop) => stories.filter((op) => op.drop === drop).length;
  const modules = [...new Set(stories.map((op) => op.module))];
  const lines = [
    '# Slice 1a backlog',
    '',
    '<!-- Generated from the operation registry by `pnpm backlog`; edit the registry, not this file. -->',
    '',
    `${String(stories.length)} stories: ${String(inDrop('A'))} in Drop A, due ${DUE.A}, and ${String(inDrop('B'))} in Drop B, due ${DUE.B}. ` +
      'Start one with `pnpm new:op <id>`; it is done when it meets the 1a definition of done in ' +
      '[CONTRIBUTING.md](../CONTRIBUTING.md). A ticked story is `implemented` in the registry. ' +
      'Its tests carry the Vitest tag `drop-a` or `drop-b`: `pnpm vitest run --tags-filter drop-b`.',
  ];
  for (const module of modules) {
    const ops = stories
      .filter((op) => op.module === module)
      .sort((a, b) => String(a.drop).localeCompare(String(b.drop)));
    lines.push('', `## ${module}`, '', ...ops.flatMap(story));
  }
  return `${lines.join('\n')}\n`;
}
