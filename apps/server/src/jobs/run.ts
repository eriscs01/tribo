import { randomUUID } from 'node:crypto';
import type { DB } from '@tribo/db';
import type { RequestContext } from '@tribo/platform';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { inRequestScope } from '../request-scope.js';

/** One daily job: what it did comes back as counts (ids and numbers only), for its log line. */
export interface Job {
  /** Stable and unique: it names the job's log lines and its advisory lock. */
  name: string;
  run(ctx: RequestContext): Promise<Record<string, number>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The in-process daily jobs (Technical design, Architecture: "a timer guarded by a Postgres
 * advisory lock"; decision 0020). Every run mints a `job-<uuid>` request id that its log
 * lines and the records it writes carry, takes the job's session advisory lock on a
 * connection of its own (a run already holding it elsewhere is skipped), and logs start,
 * finish or failure. A failure is logged and never stops the process or the other jobs.
 */
export function createJobRunner(deps: {
  db: Kysely<DB>;
  log: FastifyBaseLogger;
  jobs: readonly Job[];
  /** How often every job runs; a day unless a test says otherwise. */
  everyMs?: number;
}) {
  const { db, jobs, everyMs = DAY_MS } = deps;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  async function runOne(job: Job): Promise<void> {
    const requestId = `job-${randomUUID()}`;
    const log = deps.log.child({ requestId, job: job.name });
    const ctx: RequestContext = { requestId, surface: 'system', userId: null };
    await new Promise<void>((resolve) => {
      inRequestScope(requestId, () => {
        db.connection()
          .execute(async (conn) => {
            const lockKey = sql`hashtextextended(${`tribo.job:${job.name}`}, 0)`;
            const { rows } = await sql<{
              locked: boolean;
            }>`SELECT pg_try_advisory_lock(${lockKey}) AS locked`.execute(conn);
            if (!rows[0]?.locked) {
              log.info('job skipped');
              return;
            }
            const started = performance.now();
            try {
              log.info('job started');
              const counts = await job.run(ctx);
              log.info(
                { ...counts, durationMs: Math.round(performance.now() - started) },
                'job finished',
              );
            } finally {
              await sql`SELECT pg_advisory_unlock(${lockKey})`.execute(conn);
            }
          })
          .catch((error: unknown) => {
            log.error({ err: error }, 'job failed');
          })
          .finally(resolve);
      });
    });
  }

  /** Every job once, one after another. */
  async function runAll(): Promise<void> {
    // eslint-disable-next-line no-await-in-loop -- jobs run one at a time, in registry order
    for (const job of jobs) await runOne(job);
  }

  const tick = () => {
    running = running.then(runAll);
  };

  return {
    runAll,
    /** Runs every job now, then every `everyMs`; the timer never keeps the process alive. */
    start() {
      tick();
      timer = setInterval(tick, everyMs);
      timer.unref();
    },
    /** Stops the timer and waits for a run in progress. */
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
