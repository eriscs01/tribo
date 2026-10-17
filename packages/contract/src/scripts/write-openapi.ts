// Writes packages/contract/openapi.json from the registry: `pnpm --filter @tribo/contract openapi`.
// CI regenerates it and fails when the committed file differs.
import { writeFile } from 'node:fs/promises';
import { toOpenApi } from '../openapi.js';
import { registry } from '../operations/index.js';

const doc = toOpenApi(registry);
await writeFile(
  new URL('../../openapi.json', import.meta.url),
  `${JSON.stringify(doc, null, 2)}\n`,
);
console.log(`wrote openapi.json with ${String(registry.length)} operations`);
