import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { sessionQuery } from './api/queries';
import { ItemPage } from './pages/Item';
import { NewTripPage } from './pages/NewTrip';
import { SignInPage } from './pages/SignIn';
import { TripPage } from './pages/Trip';
import { TripsPage } from './pages/Trips';
import { Layout } from './ui/Layout';

interface RouterContext {
  queryClient: QueryClient;
}

const root = createRootRouteWithContext<RouterContext>()({ component: Layout });

const signIn = createRoute({
  getParentRoute: () => root,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  component: function SignInRoute() {
    const { redirect: target } = signIn.useSearch();
    return <SignInPage redirect={target} />;
  },
});

/** Every page but sign-in needs a session; without one, sign in and come back. */
const signedIn = createRoute({
  getParentRoute: () => root,
  id: 'signed-in',
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.query(sessionQuery);
    if (!session) redirect({ to: '/sign-in', search: { redirect: location.href }, throw: true });
    return { session };
  },
  component: Outlet,
});

const index = createRoute({
  getParentRoute: () => signedIn,
  path: '/',
  beforeLoad: () => {
    redirect({ to: '/trips', throw: true });
  },
});

const trips = createRoute({ getParentRoute: () => signedIn, path: '/trips', component: TripsPage });

const newTrip = createRoute({
  getParentRoute: () => signedIn,
  path: '/trips/new',
  component: NewTripPage,
});

const trip = createRoute({
  getParentRoute: () => signedIn,
  path: '/trips/$tripId',
  component: function TripRoute() {
    const { tripId } = trip.useParams();
    return <TripPage tripId={tripId} />;
  },
});

const item = createRoute({
  getParentRoute: () => signedIn,
  path: '/items/$itemId',
  component: function ItemRoute() {
    const { itemId } = item.useParams();
    return <ItemPage itemId={itemId} />;
  },
});

const routeTree = root.addChildren([
  signIn,
  signedIn.addChildren([index, trips, newTrip, trip, item]),
]);

/** `history` defaults to the browser's; tests pass a memory history. */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    ...(history ? { history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
