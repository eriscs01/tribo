// CI job "Changes": decides whether a pull request touches code (decision 0013) and writes
// `code=true|false` to the GITHUB_OUTPUT file. Every event but a pull request runs everything.
//
//   node packages/story-kit/src/scripts/ci-changes.ts <event> [<base> <head>]
//
// It imports nothing outside node and the rule module, so the job runs it without an install.
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// node runs this file from source in CI, where only the ".ts" specifier resolves (tsconfig:
// rewriteRelativeImportExtensions turns it into ".js" in dist).
// eslint-disable-next-line import-x/extensions
import { isDocsPath } from '../ci-changes.ts';

const [event, base = 'HEAD^1', head = 'HEAD'] = process.argv.slice(2);
if (event === undefined) {
  console.error('ci-changes: usage: ci-changes.ts <event> [<base> <head>]');
  process.exit(2);
}

const paths =
  event === 'pull_request'
    ? (
        await promisify(execFile)('git', ['diff', '--name-only', '-z', base, head], {
          encoding: 'utf8',
        })
      ).stdout
        .split('\0')
        .filter(Boolean)
    : [];
const codePaths = paths.filter((path) => !isDocsPath(path));
const code = event !== 'pull_request' || codePaths.length > 0;

// The log shows what the decision saw, so a skipped run explains itself (runbook).
console.log(
  `ci-changes: event=${event} changed=${String(paths.length)} code-paths=${String(codePaths.length)} code=${String(code)}`,
);
for (const path of codePaths.slice(0, 20)) console.log(`ci-changes: code: ${path}`);
if (event === 'pull_request' && !code) console.log('ci-changes: documentation only');
if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(process.env.GITHUB_OUTPUT, `code=${String(code)}\n`);
}
