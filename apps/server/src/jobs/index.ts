import type { Services } from '../runtime.js';
import type { Job } from './run.js';

/**
 * Every daily job, in the order a run takes them; a new job is a new entry. The file purge
 * joins with B4 (documents).
 */
export function dailyJobs(services: Pick<Services, 'idempotency'>): Job[] {
  return [
    {
      name: 'idempotency-keys',
      run: async () => ({ deleted: await services.idempotency.deleteExpired() }),
    },
  ];
}
