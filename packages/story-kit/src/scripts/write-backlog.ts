// Writes docs/backlog.md from the registry: `pnpm backlog`. backlog.test.ts fails when the
// committed file differs.
import { writeFile } from 'node:fs/promises';
import { registry } from '@tribo/contract';
import { renderBacklog } from '../backlog.js';

await writeFile(new URL('../../../../docs/backlog.md', import.meta.url), renderBacklog(registry));
console.log('wrote docs/backlog.md');
