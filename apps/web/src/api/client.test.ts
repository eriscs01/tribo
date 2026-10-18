// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, createApi, setCsrfToken, unwrap } from './client.js';

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

function stubFetch(response: () => Response) {
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((request: Request) => {
      requests.push(request);
      return Promise.resolve(response());
    }),
  );
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const api = createApi('https://tribo.test');

describe('API client', () => {
  it('sends the session CSRF token on unsafe methods only', async () => {
    const requests = stubFetch(() => json(200, { items: [], nextCursor: null }));
    setCsrfToken('csrf-1');
    await api.GET('/v1/trips', { params: { query: { limit: 5 } } });
    await api.POST('/v1/auth/logout');
    expect(requests[0]?.headers.get('x-csrf-token')).toBeNull();
    expect(requests[0]?.url).toBe('https://tribo.test/v1/trips?limit=5');
    expect(requests[1]?.headers.get('x-csrf-token')).toBe('csrf-1');
  });

  it('throws problem details as ApiProblem with field errors by top-level field', async () => {
    stubFetch(() =>
      json(
        400,
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          code: 'validation_failed',
          requestId: 'req-1',
          errors: [
            { path: '/endDate', message: 'the trip ends before it starts' },
            { path: '/start/local', message: 'bad time' },
          ],
        },
        'application/problem+json',
      ),
    );
    const failure = await unwrap(api.POST('/v1/trips', { body: {} as never })).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ApiProblem);
    expect((failure as ApiProblem).code).toBe('validation_failed');
    expect((failure as ApiProblem).fieldErrors()).toEqual({
      endDate: 'the trip ends before it starts',
      start: 'bad time',
    });
  });

  it('turns a non-problem failure (a proxy page) into internal_error', async () => {
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const failure = await unwrap(api.GET('/v1/trips')).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'internal_error' });
  });
});
