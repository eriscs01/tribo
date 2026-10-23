import type { Services } from '../runtime.js';
import type { Job } from './run.js';

/** Every daily job, in the order a run takes them; a new job is a new entry. */
export function dailyJobs(services: Pick<Services, 'idempotency' | 'files'>): Job[] {
  return [
    {
      name: 'idempotency-keys',
      run: async () => ({ deleted: await services.idempotency.deleteExpired() }),
    },
    {
      // Decision 0023: due files' blobs, by the key on their row, and a tombstone each.
      name: 'files-purge',
      run: (ctx, log) =>
        services.files.purgeDue(ctx, (fileId, error) => {
          log.error({ fileId, err: error }, 'file purge failed');
        }),
    },
  ];
}
