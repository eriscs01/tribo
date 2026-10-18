import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { api, unwrap } from '../api/client';
import { sessionQuery } from '../api/queries';
import { m } from '../messages';

export function Layout() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useQuery(sessionQuery);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the new page's content after navigation, so screen readers announce it.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname]);

  const signOut = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/auth/logout')),
    onSettled: async () => {
      client.clear();
      client.setQueryData(sessionQuery.queryKey, null);
      await navigate({ to: '/sign-in', search: {} });
    },
  });

  return (
    <>
      <a className="skip-link" href="#main">
        {m.skipToContent}
      </a>
      <header className="app-header">
        <Link to="/trips" className="brand">
          {m.appName}
        </Link>
        {session ? (
          <div className="session">
            <span className="muted">{m.signedInAs(session.user.username)}</span>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                signOut.mutate();
              }}
              disabled={signOut.isPending}
            >
              {m.signOut}
            </button>
          </div>
        ) : null}
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
