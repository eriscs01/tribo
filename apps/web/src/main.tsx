import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { ApiProblem } from './api/client';
import { sendCsrfFromSession } from './api/queries';
import { createAppRouter } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A problem answer is final (not_found stays not_found); retry only network failures.
      retry: (failures, error) => !(error instanceof ApiProblem) && failures < 2,
    },
  },
});
sendCsrfFromSession(queryClient);
const router = createAppRouter(queryClient);

// The service worker precaches the app shell; production builds only.
if (import.meta.env.PROD) registerSW({ immediate: true });

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root');
createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
