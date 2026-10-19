import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeGitHub, FAKE_TOKEN, readyWorld } from './fake-github.ts';
import { recordedPull } from './fixtures.ts';

const main = fileURLToPath(new URL('main.ts', import.meta.url));
const sha = '3a14390ebb297bd25e3e2fe2ae2a47ab34dc4032';

const world = readyWorld();
const fake = createFakeGitHub(world);
let dir: string;
let apiUrl: string;
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = req.method === 'POST' ? Buffer.concat(chunks) : undefined;
    const headers = Object.entries(req.headers).flatMap(([name, value]) =>
      typeof value === 'string' ? [[name, value] as [string, string]] : [],
    );
    fake
      .handle(
        new Request(`${apiUrl}${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          ...(body ? { body } : {}),
        }),
      )
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch(() => {
        res.destroy();
      });
  });
});

/** Runs the real script as the orchestrator does; `gh` on PATH is a stub printing the token. */
function runScript(args: string[], { withGh = true } = {}) {
  const path = withGh ? `${join(dir, 'bin')}:${process.env.PATH ?? ''}` : '/usr/bin:/bin';
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [
        main,
        ...args,
        '--repo',
        'eriscs01/tribo',
        '--api-url',
        apiUrl,
        '--state-dir',
        join(dir, 'state'),
      ],
      { env: { PATH: path, HOME: dir } },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-watch-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo ${FAKE_TOKEN}\n`);
  await chmod(join(bin, 'gh'), 0o755);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  apiUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('pr-watch, the real script against a fake GitHub', () => {
  it('prints the event, keeps its state and logs every request, never the token', async () => {
    const first = await runScript(['52', '--interval', '0.05']);
    expect(first).toEqual({ code: 0, stdout: `PR #52 ready ${sha}\n`, stderr: '' });

    const again = await runScript(['52', '--interval', '0.05', '--max-hours', '0.0001']);
    expect(again).toEqual({ code: 0, stdout: 'no events\n', stderr: '' });

    world.pulls.set(52, { ...recordedPull('pull-50-merged'), number: 52 });
    const merged = await runScript(['--all', '--interval', '0.05']);
    expect(merged.stdout).toBe('PR #52 merged\n');

    const done = await runScript(['52']);
    expect(done.stdout).toBe('nothing to watch\n');

    const state = await readFile(join(dir, 'state', 'eriscs01-tribo.json'), 'utf8');
    expect(JSON.parse(state)).toEqual({
      prs: {
        '52': { sha: recordedPull('pull-50-merged').head.sha, emitted: ['merged'], done: true },
      },
    });
    const log = await readFile(join(dir, 'state', 'eriscs01-tribo.log'), 'utf8');
    const lines = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'watch started', targets: '52' }));
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'event', pr: 52, sha, event: 'ready' }),
    );
    expect(lines.every((line) => String(line.run).startsWith('pr-watch-'))).toBe(true);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'watch finished', outcome: 'quiet' }),
    );
    expect(log + state).not.toContain(FAKE_TOKEN);
  });

  it('fails with a code, not a stack, when gh cannot give a token', async () => {
    const result = await runScript(['52'], { withGh: false });
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/^pr-watch error gh_auth_failed \(run pr-watch-[0-9a-f]+\)\n$/);
  });

  it('stops with the state file named, not its content, when the file is unreadable', async () => {
    const state = join(dir, 'state', 'eriscs01-tribo.json');
    await writeFile(state, '{ not json');
    const result = await runScript(['52']);
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(
      new RegExp(`^pr-watch error state_unreadable ${state} \\(run pr-watch-`),
    );
  });

  it('stops with the directory named when it cannot create its state directory', async () => {
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, '');
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        [
          main,
          '52',
          '--repo',
          'eriscs01/tribo',
          '--api-url',
          apiUrl,
          '--state-dir',
          join(blocker, 'x'),
        ],
        { env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir } },
        (error, stdout) => {
          resolve({ code: error ? (error.code as number) : 0, stdout });
        },
      );
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(
      /^pr-watch error state_dir_unwritable .*not-a-dir\/x \(run pr-watch-/,
    );
  });

  it('refuses a pass shorter than a minute against api.github.com', async () => {
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        [main, '52', '--interval', '5'],
        { env: { PATH: '/usr/bin:/bin' } },
        (error, stdout) => {
          resolve({ code: error ? (error.code as number) : 0, stdout });
        },
      );
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/^pr-watch error interval_too_short /);
  });
});
