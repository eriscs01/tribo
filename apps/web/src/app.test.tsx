// @vitest-environment jsdom
// The walking skeleton's screens against a fake API: sign in with TOTP, list trips, create
// a trip, add an item and read it back. The real API is proven in apps/server's tests.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schemas } from './api/client';
import { sendCsrfFromSession } from './api/queries';
import { m } from './messages';
import { createAppRouter } from './router';

const CSRF = 'csrf-token-1';
const TRIP_ID = 'trp_01h455vb4pex5vsknk084sn02q';
const ITEM_ID = 'itm_01h455vb4pex5vsknk084sn02r';
const NOW = '2026-10-18T02:00:00.000Z';

const problem = (status: number, code: Schemas['ErrorCode'], extra = {}) =>
  Response.json(
    { type: 'about:blank', title: code, status, code, requestId: 'req-1', ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** An in-memory server for the operations the shell uses. */
function fakeApi() {
  const state = { signedIn: false, trips: [] as Schemas['Trip'][], items: [] as Schemas['Item'][] };
  const log: { method: string; path: string; body: unknown; csrf: string | null }[] = [];
  const session: Schemas['Session'] = {
    user: { id: 'usr_01h455vb4pex5vsknk084sn02s', username: 'ana', platformRole: 'admin' },
    mfaVerified: true,
    csrfToken: CSRF,
    expiresAt: '2026-10-19T02:00:00.000Z',
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body: unknown =
      request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
    log.push({
      method: request.method,
      path: url.pathname,
      body,
      csrf: request.headers.get('x-csrf-token'),
    });
    const route = `${request.method} ${url.pathname}`;
    if (route === 'POST /v1/auth/login') {
      const input = body as Schemas['LoginInput'];
      if (input.password !== 'correct horse battery') return problem(401, 'unauthenticated');
      if (input.totp === undefined) return problem(403, 'mfa_required');
      state.signedIn = true;
      return Response.json(session, { status: 201 });
    }
    if (!state.signedIn) return problem(401, 'unauthenticated');
    if (request.method !== 'GET' && request.headers.get('x-csrf-token') !== CSRF) {
      return problem(403, 'forbidden');
    }
    if (route === 'GET /v1/auth/session') return Response.json(session);
    if (route === 'GET /v1/trips') return Response.json({ items: state.trips, nextCursor: null });
    if (route === 'POST /v1/trips') {
      const input = body as Schemas['TripInput'];
      const trip: Schemas['Trip'] = {
        ...input,
        id: TRIP_ID,
        status: 'draft',
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      state.trips.unshift(trip);
      return Response.json(trip, { status: 201 });
    }
    if (route === `POST /v1/trips/${TRIP_ID}/items`) {
      const input = body as Schemas['ItemInput'];
      const start = input.start && 'local' in input.start ? input.start : null;
      const item: Schemas['Item'] = {
        id: ITEM_ID,
        tripId: TRIP_ID,
        type: input.type,
        title: input.title,
        status: 'planned',
        start: start ? { ...start, at: '2026-11-10T23:40:00.000Z' } : null,
        end: null,
        visibility: input.visibility ?? 'shared',
        ownerMembershipId: 'mem_01h455vb4pex5vsknk084sn02t',
        tags: [],
        version: 1,
        boardVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      state.items.push(item);
      return Response.json(item, { status: 201 });
    }
    if (route === `GET /v1/items/${ITEM_ID}`) {
      const item = state.items.find((i) => i.id === ITEM_ID);
      return item ? Response.json(item) : problem(404, 'not_found');
    }
    return problem(404, 'not_found');
  };

  return { state, log, fetch: vi.fn(handle) };
}

function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sendCsrfFromSession(queryClient);
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

let server: ReturnType<typeof fakeApi>;
beforeEach(() => {
  server = fakeApi();
  vi.stubGlobal('fetch', server.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('web shell', () => {
  it('signs in with TOTP, creates a trip, adds an item and reads it back', async () => {
    const user = userEvent.setup();
    const router = renderApp('/trips');

    // No session: the trip list sends the visitor to sign in, remembering where they were.
    await screen.findByRole('heading', { name: m.signIn.title });
    expect(router.state.location.search).toEqual({ redirect: '/trips' });

    await user.type(screen.getByLabelText(m.signIn.username), 'ana');
    await user.type(screen.getByLabelText(m.signIn.password), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: m.signIn.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(m.signIn.needCode);
    const code = screen.getByLabelText(new RegExp(m.signIn.code));
    expect(document.activeElement).toBe(code);

    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: m.signIn.submit }));
    await screen.findByRole('heading', { name: m.trips.title });
    expect(screen.getByText(m.trips.empty)).toBeTruthy();
    expect(server.log.find((r) => r.path === '/v1/auth/login' && r.body)?.body).toMatchObject({
      username: 'ana',
    });

    await user.click(screen.getByRole('link', { name: m.trips.create }));
    await user.type(await screen.findByLabelText(m.newTrip.name), 'Island weekend');
    await user.type(screen.getByLabelText(m.newTrip.startDate), '2026-11-11');
    await user.type(screen.getByLabelText(m.newTrip.endDate), '2026-11-14');
    const zone = screen.getByLabelText(m.newTrip.timezone);
    await user.clear(zone);
    await user.type(zone, 'Asia/Manila');
    await user.click(screen.getByRole('button', { name: m.newTrip.submit }));

    await screen.findByRole('heading', { name: 'Island weekend' });
    expect(router.state.location.pathname).toBe(`/trips/${TRIP_ID}`);
    const created = server.log.find((r) => r.method === 'POST' && r.path === '/v1/trips');
    expect(created).toMatchObject({
      csrf: CSRF,
      body: {
        name: 'Island weekend',
        startDate: '2026-11-11',
        endDate: '2026-11-14',
        currency: 'PHP',
        timezone: 'Asia/Manila',
      },
    });

    await user.selectOptions(screen.getByLabelText(m.addItem.type), 'transport');
    await user.type(screen.getByLabelText(m.addItem.itemTitle), 'Morning ferry');
    await user.click(screen.getByLabelText(m.addItem.timingTimed));
    await user.type(screen.getByLabelText(m.addItem.start), '2026-11-11T07:40');
    await user.click(screen.getByRole('button', { name: m.addItem.submit }));

    await screen.findByRole('heading', { name: 'Morning ferry' });
    expect(router.state.location.pathname).toBe(`/items/${ITEM_ID}`);
    expect(server.log.find((r) => r.method === 'POST' && r.path.endsWith('/items'))?.body).toEqual({
      type: 'transport',
      title: 'Morning ferry',
      visibility: 'shared',
      start: { local: '2026-11-11T07:40', tz: 'Asia/Manila' },
    });
    expect(screen.getByText(m.itemType.transport)).toBeTruthy();
    expect(screen.getByText(/Nov 11, 2026, 7:40\sAM GMT\+8/)).toBeTruthy();

    // A reload reads the item back with items.get rather than from the create response.
    cleanup();
    renderApp(`/items/${ITEM_ID}`);
    await screen.findByRole('heading', { name: 'Morning ferry' });
    await waitFor(() => {
      expect(server.log.some((r) => r.method === 'GET' && r.path === `/v1/items/${ITEM_ID}`)).toBe(
        true,
      );
    });
  });

  it('answers a wrong password without saying which part was wrong', async () => {
    const user = userEvent.setup();
    renderApp('/sign-in');
    await user.type(await screen.findByLabelText(m.signIn.username), 'ana');
    await user.type(screen.getByLabelText(m.signIn.password), 'wrong');
    await user.click(screen.getByRole('button', { name: m.signIn.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(m.signIn.wrong);
  });

  it('shows field errors from validation_failed next to their fields', async () => {
    server.state.signedIn = true;
    const user = userEvent.setup();
    renderApp('/trips/new');
    await user.type(await screen.findByLabelText(m.newTrip.name), 'Backwards');
    server.fetch.mockImplementation((request: Request) =>
      Promise.resolve(
        request.method === 'POST'
          ? problem(400, 'validation_failed', {
              errors: [{ path: '/endDate', message: 'the trip ends before it starts' }],
            })
          : Response.json({
              user: { id: 'usr_01h455vb4pex5vsknk084sn02s', username: 'ana', platformRole: 'user' },
              mfaVerified: true,
              csrfToken: CSRF,
              expiresAt: NOW,
            }),
      ),
    );
    await user.click(screen.getByRole('button', { name: m.newTrip.submit }));
    const endDate = await screen.findByLabelText(m.newTrip.endDate);
    await waitFor(() => {
      expect(endDate.getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByText('the trip ends before it starts')).toBeTruthy();
  });
});
