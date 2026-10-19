// Fails when the SPA's initial JavaScript exceeds the budget. Run after `pnpm build:web`:
// `pnpm check:bundle [dist/app]`. The measured size is printed and, in CI, put in the job summary.
import { appendFile } from 'node:fs/promises';
import { BUDGET_BYTES, checkBudget, initialJsFiles, measureInitialJs } from './bundle-budget.js';

const dist = process.argv[2] ?? 'dist/app';
const bytes = await measureInitialJs(dist);
const files = await initialJsFiles(dist);
const line = `Initial JS: ${(bytes / 1000).toFixed(2)} kB gzip of ${String(BUDGET_BYTES / 1000)} kB (${files.join(', ')})`;
console.log(line);
const { GITHUB_STEP_SUMMARY: summary } = process.env;
if (summary) await appendFile(summary, `### Bundle budget\n\n${line}\n`);

const failure = checkBudget(bytes, BUDGET_BYTES);
if (failure) {
  console.error(`::error::${failure}`);
  process.exitCode = 1;
}
