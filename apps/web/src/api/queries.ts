import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { api, ApiProblem, readCsrfTokenFrom, unwrap, type Schemas } from './client';

export type Session = Schemas['Session'];
export type Trip = Schemas['Trip'];
export type TripPage = Schemas['TripPage'];

/** Query keys, in one place so writes invalidate exactly what they change. */
export const keys = {
  session: ['session'] as const,
  trips: ['trips'] as const,
  trip: (id: string) => ['trip', id] as const,
  item: (id: string) => ['item', id] as const,
};

/** The signed-in session, or null when there is none. */
export const sessionQuery = queryOptions({
  queryKey: keys.session,
  queryFn: async (): Promise<Session | null> => {
    try {
      return await unwrap(api.GET('/v1/auth/session'));
    } catch (error) {
      if (error instanceof ApiProblem && error.code === 'unauthenticated') return null;
      throw error;
    }
  },
  staleTime: 60_000,
});

/** Unsafe requests carry the CSRF token of whatever session this cache holds, or none. */
export function sendCsrfFromSession(client: QueryClient) {
  readCsrfTokenFrom(() => client.getQueryData<Session | null>(keys.session)?.csrfToken ?? null);
}

/** The trip list in the server's default page size (PageQuery in the contract). */
export const tripsQuery = infiniteQueryOptions({
  queryKey: keys.trips,
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/v1/trips', {
        params: {
          query: pageParam === null ? {} : { cursor: pageParam },
        },
      }),
    ),
  initialPageParam: null as string | null,
  getNextPageParam: (last: TripPage) => last.nextCursor,
});

/** A trip already in the trips list cache, so its page opens without a request. */
function cachedTrip(client: QueryClient, id: string): Trip | undefined {
  const list = client.getQueryData<InfiniteData<TripPage>>(keys.trips);
  return list?.pages.flatMap((p) => p.items).find((t) => t.id === id);
}

/**
 * One trip. trips.get is a Drop A story, so until it lands this walks trips.list (membership
 * only) until it finds the trip; a trip the caller is not in is not_found, as the API says.
 */
export function tripQuery(client: QueryClient, id: string) {
  return queryOptions({
    queryKey: keys.trip(id),
    queryFn: async (): Promise<Trip> => {
      let cursor: string | null = null;
      do {
        const query: { limit: number; cursor?: string } =
          cursor === null ? { limit: PAGE_LIMIT_MAX } : { limit: PAGE_LIMIT_MAX, cursor };
        // Pages follow one another: each cursor comes from the page before.
        // eslint-disable-next-line no-await-in-loop
        const page = await unwrap(api.GET('/v1/trips', { params: { query } }));
        const trip = page.items.find((t) => t.id === id);
        if (trip) return trip;
        cursor = page.nextCursor;
      } while (cursor !== null);
      throw new ApiProblem({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
        requestId: '',
      });
    },
    initialData: () => cachedTrip(client, id),
  });
}

export function itemQuery(id: string) {
  return queryOptions({
    queryKey: keys.item(id),
    queryFn: () => unwrap(api.GET('/v1/items/{itemId}', { params: { path: { itemId: id } } })),
  });
}
