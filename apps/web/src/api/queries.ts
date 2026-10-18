import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { api, ApiProblem, setCsrfToken, unwrap, type Schemas } from './client';

export type Session = Schemas['Session'];
export type Trip = Schemas['Trip'];
export type TripPage = Schemas['TripPage'];
export type Item = Schemas['Item'];

/** Query keys, in one place so writes invalidate exactly what they change. */
export const keys = {
  session: ['session'] as const,
  trips: ['trips'] as const,
  trip: (id: string) => ['trip', id] as const,
  item: (id: string) => ['item', id] as const,
};

/** The signed-in session, or null when there is none; also arms the CSRF header. */
export const sessionQuery = queryOptions({
  queryKey: keys.session,
  queryFn: async (): Promise<Session | null> => {
    try {
      const session = await unwrap(api.GET('/v1/auth/session'));
      setCsrfToken(session.csrfToken);
      return session;
    } catch (error) {
      if (error instanceof ApiProblem && error.code === 'unauthenticated') {
        setCsrfToken(null);
        return null;
      }
      throw error;
    }
  },
  staleTime: 60_000,
});

const PAGE = 50;

export const tripsQuery = infiniteQueryOptions({
  queryKey: keys.trips,
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/v1/trips', {
        params: {
          query: pageParam === null ? { limit: PAGE } : { limit: PAGE, cursor: pageParam },
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
          cursor === null ? { limit: 200 } : { limit: 200, cursor };
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
