import { describe, expect, it } from 'vitest';

import { createFakeGitHub, FAKE_TOKEN, readyWorld } from './fake-github.ts';
import { GitHubError, RateLimitedError } from './errors.ts';
import { createGitHub } from './github.ts';
import type { Pull } from './github.ts';
import { createLogger } from './log.ts';

const API = 'https://api.github.test';
const pullPath = '/repos/eriscs01/tribo/pulls/52';

function setup(fetchImpl?: typeof fetch) {
  const fake = createFakeGitHub(readyWorld());
  const lines: string[] = [];
  const log = createLogger({
    write: (line) => lines.push(line),
    run: 'pr-watch-test',
    secrets: [FAKE_TOKEN],
  });
  const github = createGitHub({
    apiUrl: API,
    token: FAKE_TOKEN,
    fetch: fetchImpl ?? ((input, init) => fake.handle(new Request(input, init))),
    log,
    now: () => 1_000_000,
  });
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { fake, github, lines, logged };
}

describe('GitHub client', () => {
  it('reads a resource with the token and logs one line per request, without the token', async () => {
    const { github, lines, logged } = setup();
    const { data } = await github.get(pullPath, 52);
    expect((data as Pull).head.sha).toBe('3a14390ebb297bd25e3e2fe2ae2a47ab34dc4032');
    expect(logged()).toEqual([
      expect.objectContaining({
        msg: 'github request',
        pr: 52,
        path: pullPath,
        status: 200,
        cached: false,
      }),
    ]);
    expect(lines.join('')).not.toContain(FAKE_TOKEN);
  });

  it('asks again with the ETag, and a 304 answers from the cached body', async () => {
    const { fake, github, logged } = setup();
    await github.get(pullPath, 52);
    const second = await github.get(pullPath, 52);
    expect(second.cached).toBe(true);
    expect((second.data as Pull).number).toBe(52);
    expect(fake.requests.map((request) => request.status)).toEqual([200, 304]);
    expect(logged()[1]).toEqual(expect.objectContaining({ status: 304, cached: true }));
  });

  it('turns an exhausted primary rate limit into a wait until its reset', async () => {
    const { fake, github } = setup();
    fake.failNext(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700' });
    await expect(github.get(pullPath, 52)).rejects.toEqual(new RateLimitedError(1_700_000));
  });

  it('turns a secondary rate limit into a wait of its Retry-After', async () => {
    const { fake, github } = setup();
    fake.failNext(429, { 'retry-after': '120' });
    await expect(github.get(pullPath, 52)).rejects.toEqual(new RateLimitedError(1_120_000));
  });

  it('fails other answers with a code naming the status', async () => {
    const { github, logged } = setup();
    await expect(github.get('/repos/eriscs01/tribo/pulls/999', 999)).rejects.toEqual(
      new GitHubError('http_404'),
    );
    expect(logged()[0]).toEqual(expect.objectContaining({ status: 404, code: 'http_404' }));
  });

  it('fails a 403 that is not a rate limit (a missing permission) instead of waiting', async () => {
    const { fake, github } = setup();
    fake.failNext(403, { 'x-ratelimit-remaining': '4000' });
    await expect(github.get(pullPath, 52)).rejects.toEqual(new GitHubError('http_403'));
  });

  it('fails an answer that is not JSON with a code', async () => {
    const { github } = setup(() => Promise.resolve(new Response('<html>', { status: 200 })));
    await expect(github.get(pullPath, 52)).rejects.toEqual(new GitHubError('bad_json'));
  });

  it('fails a timed-out request with its own code', async () => {
    const { github } = setup(() =>
      Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    await expect(github.get(pullPath, 52)).rejects.toEqual(new GitHubError('timeout'));
  });

  it('fails a network error with a code and never logs what the error quoted', async () => {
    const { github, lines } = setup(() =>
      Promise.reject(new TypeError(`fetch failed for token ${FAKE_TOKEN}`)),
    );
    await expect(github.get(pullPath, 52)).rejects.toEqual(new GitHubError('network'));
    expect(lines.join('')).not.toContain(FAKE_TOKEN);
  });

  it('reads GraphQL with the token, and fails a GraphQL error with a code', async () => {
    const { github } = setup();
    const query = 'query($number: Int!) { x }';
    const data = (await github.graphql(query, { number: 52 }, 52)) as { repository: unknown };
    expect(data.repository).toBeDefined();

    const failing = setup(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: 'bad' }] }), { status: 200 }),
      ),
    );
    await expect(failing.github.graphql(query, { number: 52 }, 52)).rejects.toEqual(
      new GitHubError('graphql'),
    );
  });
});

describe('logger', () => {
  it('redacts every secret wherever it appears in a line', () => {
    const lines: string[] = [];
    const log = createLogger({
      write: (line) => lines.push(line),
      run: 'pr-watch-test',
      secrets: [FAKE_TOKEN],
    });
    log.error('watch failed', { err: `Error: boom ${FAKE_TOKEN}\n    at x` });
    expect(lines[0]).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual(
      expect.objectContaining({ level: 'error', msg: 'watch failed', run: 'pr-watch-test' }),
    );
  });
});
