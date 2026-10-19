import { GitHubError, RateLimitedError } from './errors.ts';
import type { Logger } from './log.ts';

/** The fields of `GET /repos/{owner}/{repo}/pulls/{n}` the watcher reads. */
export interface Pull {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  mergeable_state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

/** One entry of `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GitHub {
  /** GET a REST path; `cached` is true when GitHub answered 304 to our ETag. */
  get(path: string, pr?: number): Promise<{ data: unknown; cached: boolean }>;
  /** POST a GraphQL query; resolves to its `data`. */
  graphql(query: string, variables: Record<string, unknown>, pr?: number): Promise<unknown>;
}

/**
 * The watcher's only way to GitHub. Every GET carries the ETag of the last answer for its
 * path, so an unchanged resource costs a 304, which GitHub does not count against the rate
 * limit. Logs one line per request (path, status, duration, remaining quota); the token is
 * sent only in the Authorization header and never logged.
 */
export function createGitHub({
  apiUrl,
  token,
  fetch: fetchImpl = fetch,
  log,
  now = Date.now,
  timeoutMs = 30_000,
}: {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  log: Logger;
  now?: () => number;
  timeoutMs?: number;
}): GitHub {
  const cache = new Map<string, { etag: string; data: unknown }>();
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'tribo-pr-watch',
    'x-github-api-version': '2022-11-28',
  };

  async function send(
    method: string,
    path: string,
    pr: number | undefined,
    init: { headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    const started = now();
    const line = { pr, method, path };
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: { ...headers, ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = (error as Error).name === 'TimeoutError' ? 'timeout' : 'network';
      log.warn('github request', { ...line, code, ms: now() - started });
      throw new GitHubError(code);
    }
    const fields = {
      ...line,
      status: response.status,
      cached: response.status === 304,
      remaining: response.headers.get('x-ratelimit-remaining') ?? undefined,
      ms: now() - started,
    };
    const waitUntil = rateLimitedUntil(response, now());
    if (waitUntil !== undefined) {
      log.warn('github request', { ...fields, code: 'rate_limited' });
      throw new RateLimitedError(waitUntil);
    }
    if (!response.ok && response.status !== 304) {
      log.warn('github request', { ...fields, code: `http_${String(response.status)}` });
      throw new GitHubError(`http_${String(response.status)}`);
    }
    log.info('github request', fields);
    return response;
  }

  async function json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubError('bad_json');
    }
  }

  return {
    async get(path: string, pr?: number) {
      const hit = cache.get(path);
      const response = await send('GET', path, pr, {
        ...(hit ? { headers: { 'if-none-match': hit.etag } } : {}),
      });
      if (response.status === 304 && hit) return { data: hit.data, cached: true };
      const data = await json<unknown>(response);
      const etag = response.headers.get('etag');
      if (etag) cache.set(path, { etag, data });
      return { data, cached: false };
    },
    async graphql(query: string, variables: Record<string, unknown>, pr?: number) {
      const response = await send('POST', '/graphql', pr, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body = await json<{ data?: unknown; errors?: unknown[] }>(response);
      if (body.errors?.length || body.data === undefined) throw new GitHubError('graphql');
      return body.data;
    },
  };
}

/** GitHub's primary limit (remaining 0 until reset) and secondary limit (Retry-After). */
function rateLimitedUntil(response: Response, nowMs: number): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) return nowMs + Number(retryAfter) * 1000;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    return Number(response.headers.get('x-ratelimit-reset')) * 1000;
  }
  return undefined;
}
