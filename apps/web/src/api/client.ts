import { CSRF_HEADER } from '@tribo/contract';
import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from '../generated/api';

export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];
export type ErrorCode = Schemas['ErrorCode'];

/** An RFC 9457 problem the server answered with; `code` is from the closed enum. */
export class ApiProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem.code);
    this.name = 'ApiProblem';
  }

  get code(): ErrorCode {
    return this.problem.code;
  }

  /** Field errors keyed by their top-level field (`/start/local` → `start`). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const error of this.problem.errors ?? []) {
      const field = error.path.split('/')[1] ?? '';
      if (field !== '' && !(field in out)) out[field] = error.message;
    }
    return out;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Where the session's CSRF token is read from at request time. The session owns the token
 * (auth.login and auth.session hand it out), so the client keeps no copy of its own.
 */
let csrfToken: () => string | null = () => null;

export function readCsrfTokenFrom(source: () => string | null) {
  csrfToken = source;
}

export const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    const token = UNSAFE.has(request.method) ? csrfToken() : null;
    if (token !== null) request.headers.set(CSRF_HEADER, token);
    return request;
  },
};

/** Same origin as the SPA: the session cookie is `__Host-`, so it never leaves this origin. */
export function createApi(baseUrl = globalThis.location.origin) {
  // Looked up per request, so tests can stub the global fetch.
  const client = createClient<paths>({ baseUrl, fetch: (request) => globalThis.fetch(request) });
  client.use(csrfMiddleware);
  return client;
}

export const api = createApi();

/** The data of a call, or its problem thrown as ApiProblem. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (response.ok) return data as T;
  throw new ApiProblem(isProblem(error) ? error : unknownProblem(response));
}

function isProblem(value: unknown): value is Problem {
  return typeof value === 'object' && value !== null && 'code' in value && 'status' in value;
}

/** A failure that did not come back as problem details (a proxy error, a network page). */
function unknownProblem(response: Response): Problem {
  return {
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
    code: 'internal_error',
    requestId: response.headers.get('x-request-id') ?? '',
  };
}
