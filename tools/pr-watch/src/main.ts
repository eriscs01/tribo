/**
 * pr-watch: wakes the orchestrator session when a package PR becomes ready, falls behind, loses
 * ready after a push, merges or closes. Started with one background Bash call; prints one line
 * per event on stdout and exits, so the harness re-invokes the session. Usage and the event
 * lines are in docs/runbook.md ("PR watcher"); why it exists is in docs/decisions/0007.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { createGitHub } from './github.ts';
import { createLogger } from './log.ts';
import { createFileStore, StateError } from './state.ts';
import { watch } from './watch.ts';
import type { Targets } from './watch.ts';

const GITHUB_API = 'https://api.github.com';
const run = `pr-watch-${randomBytes(4).toString('hex')}`;

/** A refusal before the watch starts: printed as `pr-watch error <code>`, exit code 2. */
class UsageError extends Error {
  readonly code: string;

  constructor(code: string, detail = '') {
    super(detail);
    this.code = code;
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: 'boolean', default: false },
    repo: { type: 'string' },
    interval: { type: 'string', default: '60' },
    'max-hours': { type: 'string', default: '8' },
    'state-dir': { type: 'string', default: join(homedir(), '.cache', 'tribo-pr-watch') },
    'api-url': { type: 'string', default: GITHUB_API },
  },
});

async function output(command: string, args: string[], code: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(command, args);
    return stdout.trim();
  } catch {
    throw new UsageError(code);
  }
}

async function repository(): Promise<{ owner: string; name: string }> {
  const slug =
    values.repo ??
    /github\.com[:/](.+?)(?:\.git)?$/.exec(
      await output('git', ['remote', 'get-url', 'origin'], 'repo_unknown'),
    )?.[1];
  const [owner, name, extra] = (slug ?? '').split('/');
  if (!owner || !name || extra !== undefined) throw new UsageError('repo_unknown');
  return { owner, name };
}

function targets(): Targets {
  if (values.all) return 'all';
  const numbers = positionals.map(Number);
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new UsageError('usage', 'pr-watch <pr>... | --all');
  }
  return numbers;
}

async function start(): Promise<number> {
  const intervalMs = Number(values.interval) * 1000;
  const maxRunMs = Number(values['max-hours']) * 3_600_000;
  const apiUrl = values['api-url'];
  // GitHub's guidance and the shared rate limit: never ask the real API more than once a minute.
  if (!(intervalMs > 0) || (apiUrl === GITHUB_API && intervalMs < 60_000)) {
    throw new UsageError('interval_too_short', '--interval is seconds, at least 60');
  }
  if (!(maxRunMs > 0)) throw new UsageError('usage', '--max-hours must be positive');
  const watched = targets();
  const repo = await repository();
  const token = await output('gh', ['auth', 'token'], 'gh_auth_failed');
  if (!token) throw new UsageError('gh_auth_failed');

  const stateDir = values['state-dir'];
  try {
    await mkdir(stateDir, { recursive: true });
  } catch {
    throw new UsageError('state_dir_unwritable', stateDir);
  }
  const file = join(stateDir, `${repo.owner}-${repo.name}`);
  const logStream = createWriteStream(`${file}.log`, { flags: 'a' });
  // A log it cannot write would hide everything else: stop, naming the file.
  logStream.once('error', () => {
    console.log(`pr-watch error log_unwritable ${file}.log (run ${run})`);
    process.exit(2);
  });
  const log = createLogger({ write: (line) => logStream.write(line), run, secrets: [token] });
  const startedAt = Date.now();
  log.info('watch started', {
    repo: `${repo.owner}/${repo.name}`,
    targets: watched === 'all' ? 'all' : watched.join(','),
    intervalMs,
    maxRunMs,
    api: new URL(apiUrl).host,
  });
  process.once('SIGTERM', () => {
    log.warn('watch stopped', { signal: 'SIGTERM', ms: Date.now() - startedAt });
    logStream.end(() => process.exit(143));
  });

  try {
    const result = await watch({
      github: createGitHub({ apiUrl, token, log }),
      repo,
      targets: watched,
      store: createFileStore(`${file}.json`),
      log,
      clock: { now: Date.now, sleep: (ms) => sleep(ms) },
      intervalMs,
      maxRunMs,
    });
    log.info('watch finished', {
      outcome: result.kind,
      events: result.kind === 'events' ? result.lines.length : 0,
      ms: Date.now() - startedAt,
    });
    if (result.kind === 'events') for (const line of result.lines) console.log(line);
    else console.log(result.kind === 'quiet' ? 'no events' : 'nothing to watch');
    return 0;
  } catch (error) {
    if (error instanceof StateError) {
      log.error('watch failed', { code: error.code, file: error.path });
      console.log(`pr-watch error ${error.code} ${error.path} (run ${run})`);
      return 2;
    }
    log.error('watch failed', { code: 'internal', err: (error as Error).stack });
    console.log(`pr-watch error internal (run ${run}); see ${file}.log`);
    return 1;
  } finally {
    await new Promise<void>((resolve) => {
      logStream.end(resolve);
    });
  }
}

start().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Nothing is logged yet (no token or no state dir): this line, and the stack on stderr for
    // a bug, are the record. Neither can hold the token: it is read last, and only into memory.
    if (!(error instanceof UsageError)) {
      console.error((error as Error).stack);
      console.log(`pr-watch error internal (run ${run})`);
      process.exit(1);
    }
    console.log(
      `pr-watch error ${error.code}${error.message ? ` ${error.message}` : ''} (run ${run})`,
    );
    process.exit(2);
  },
);
