import { createHash } from 'node:crypto';

import { greenRuns, openPull, rulesMain } from './fixtures.ts';
import type { CheckRun, Pull } from './github.ts';

/** What the fake GitHub currently holds; tests change it between passes. */
export interface FakeWorld {
  rules: unknown[];
  pulls: Map<number, Pull>;
  runs: Map<string, CheckRun[]>;
  /** isResolved of each review thread, by PR number. */
  threads: Map<number, boolean[]>;
}

interface FakeRequest {
  method: string;
  path: string;
  status: number;
}

export const FAKE_TOKEN = 'gho_FakeTokenForTestsOnly0123456789';

/** One open PR, green and ready, built from the recorded responses. */
export function readyWorld(): FakeWorld {
  const pull = openPull();
  return {
    rules: rulesMain(),
    pulls: new Map([[pull.number, pull]]),
    runs: new Map([[pull.head.sha, greenRuns()]]),
    threads: new Map([[pull.number, []]]),
  };
}

/**
 * The slice of the GitHub REST and GraphQL APIs the watcher calls, with ETags (an
 * If-None-Match that matches answers 304) and bearer-token checks. Unit tests call `handle`
 * as their fetch; the process test serves it over HTTP.
 */
export function createFakeGitHub(world: FakeWorld) {
  const requests: FakeRequest[] = [];
  const queued: { status: number; headers: Record<string, string> }[] = [];

  function answer(request: Request, status: number, body?: unknown): Response {
    const { pathname, search } = new URL(request.url);
    requests.push({ method: request.method, path: pathname + search, status });
    if (body === undefined) return new Response(null, { status });
    const text = JSON.stringify(body);
    const etag = `"${createHash('sha1').update(text).digest('hex')}"`;
    if (request.headers.get('if-none-match') === etag) {
      requests[requests.length - 1] = {
        method: request.method,
        path: pathname + search,
        status: 304,
      };
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(text, { status, headers: { etag, 'content-type': 'application/json' } });
  }

  function route(request: Request, query: string): unknown {
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === 'POST' && pathname.endsWith('/graphql')) {
      const { variables } = JSON.parse(query) as { variables: { number: number } };
      const nodes = (world.threads.get(variables.number) ?? []).map((isResolved) => ({
        isResolved,
      }));
      return {
        data: {
          repository: { pullRequest: { reviewThreads: { totalCount: nodes.length, nodes } } },
        },
      };
    }
    const parts = pathname.split('/').filter(Boolean);
    const [, , , resource, id, sub] = parts;
    if (resource === 'rules' && id === 'branches') return world.rules;
    if (resource === 'pulls' && id === undefined) {
      const state = searchParams.get('state');
      return [...world.pulls.values()].filter((pull) => pull.state === state);
    }
    if (resource === 'pulls') return world.pulls.get(Number(id));
    if (resource === 'commits' && sub === 'check-runs') {
      const runs = world.runs.get(id ?? '') ?? [];
      return { total_count: runs.length, check_runs: runs };
    }
    return undefined;
  }

  async function handle(request: Request): Promise<Response> {
    const query = request.method === 'POST' ? await request.text() : '';
    const failure = queued.shift();
    if (failure) {
      const { pathname, search } = new URL(request.url);
      requests.push({ method: request.method, path: pathname + search, status: failure.status });
      return new Response('{"message":"API rate limit exceeded"}', failure);
    }
    if (request.headers.get('authorization') !== `Bearer ${FAKE_TOKEN}`) {
      return answer(request, 401, { message: 'Bad credentials' });
    }
    const body = route(request, query);
    return body === undefined
      ? answer(request, 404, { message: 'Not Found' })
      : answer(request, 200, body);
  }

  return {
    handle,
    requests,
    /** The next request gets this answer instead of the real one. */
    failNext(status: number, headers: Record<string, string> = {}) {
      queued.push({ status, headers });
    },
  };
}
