// The daily job runner (Technical design, "Daily jobs are in-process"; decision 0020): an
// in-process timer, a PostgreSQL advisory lock per job so only one process runs it, and a
// `job-<uuid>` request id on every line a run logs and every record it writes.
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { registry } from '@tribo/contract';
import { writePath } from '@tribo/core';
import { AppKey } from '@tribo/crypto';
import type { RequestContext } from '@tribo/platform';
import { createTestDatabase, type TestDatabase } from '@tribo/testkit';
import { sql } from 'kysely';
import * as z from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { composeServices, type Services } from '../runtime.js';
import { dailyJobs } from './index.js';
import { createJobRunner, type Job } from './run.js';

let tdb: TestDatabase;
let services: Services;
let log: Awaited<ReturnType<typeof buildApp>>['log'];
let close: () => Promise<void>;
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  tdb = await createTestDatabase();
  services = composeServices(tdb.db, new AppKey(randomBytes(32)), new URL('https://tribo.test'));
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const app = await buildApp(services, { trustedProxies: [], logLevel: 'info', logStream });
  ({ log } = app);
  close = () => app.close();
});
afterAll(async () => {
  await close();
  await tdb.destroy();
});

const JOB_ID = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const linesOf = (job: string) => lines.filter((l) => l.job === job);
let n = 0;
const jobName = () => {
  n += 1;
  return `test-job-${String(n)}`;
};

describe('job runner', () => {
  it('runs each job with its own job-<uuid> request id, on every line it logs', async () => {
    const name = jobName();
    const seen: RequestContext[] = [];
    const job: Job = {
      name,
      run: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ deleted: 2 });
      },
    };
    const runner = createJobRunner({ db: tdb.db, log, jobs: [job] });

    await runner.runAll();
    await runner.runAll();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ surface: 'system', userId: null });
    expect(seen[0]?.requestId).toMatch(JOB_ID);
    expect(seen[1]?.requestId).not.toBe(seen[0]?.requestId);
    const first = linesOf(name).filter((l) => l.requestId === seen[0]?.requestId);
    expect(first.map((l) => l.msg)).toEqual(['job started', 'job finished']);
    expect(first[1]).toMatchObject({ level: 30, deleted: 2 });
    expect(first[1]?.durationMs).toEqual(expect.any(Number));
  });

  it('writes its audit events under its request id, so `tribo audit request` finds them', async () => {
    const name = jobName();
    const base = registry.find((o) => o.id === 'library.places.create');
    if (!base) throw new Error('library.places.create is not registered');
    const write = writePath(tdb.db);
    let requestId = '';
    const job: Job = {
      name,
      run: async (ctx) => {
        requestId = ctx.requestId;
        await write(ctx, {
          operation: { ...base, input: z.object({}) },
          target: undefined,
          body: {},
          ifMatch: undefined,
          authorize: () => Promise.resolve(),
          load: () => Promise.resolve({ tripId: null }),
          mutate: async (tx) => {
            const row = await tx
              .insertInto('tribo.places')
              .values({ name: `Job place ${name}`, kind: 'destination' })
              .returning('id')
              .executeTakeFirstOrThrow();
            return {
              action: 'create',
              aggregate: 'place',
              entityId: row.id,
              tripId: null,
              version: 1,
              snapshot: {},
              result: row,
            };
          },
        });
        return {};
      },
    };

    await createJobRunner({ db: tdb.db, log, jobs: [job] }).runAll();

    const events = await services.requestAudit(requestId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', entityType: 'place', surface: 'system' });
  });

  it('runs a job in one process at a time: a second runner skips it while the first holds the lock', async () => {
    const name = jobName();
    let runs = 0;
    const job: Job = {
      name,
      run: async () => {
        runs += 1;
        await sql`SELECT pg_sleep(0.3)`.execute(tdb.db);
        return {};
      },
    };
    const one = createJobRunner({ db: tdb.db, log, jobs: [job] });
    const two = createJobRunner({ db: tdb.db, log, jobs: [job] });

    await Promise.all([one.runAll(), two.runAll()]);

    expect(runs).toBe(1);
    expect(linesOf(name).filter((l) => l.msg === 'job skipped')).toHaveLength(1);
    // The lock is released after the run, so the next one goes ahead.
    await two.runAll();
    expect(runs).toBe(2);
  });

  it('logs a failing job at error with its request id and goes on to the next job', async () => {
    const failing = jobName();
    const next = jobName();
    let nextRan = false;
    const runner = createJobRunner({
      db: tdb.db,
      log,
      jobs: [
        { name: failing, run: () => Promise.reject(new Error('disk full')) },
        {
          name: next,
          run: () => {
            nextRan = true;
            return Promise.resolve({});
          },
        },
      ],
    });

    await expect(runner.runAll()).resolves.toBeUndefined();

    const failure = linesOf(failing).find((l) => l.msg === 'job failed');
    expect(failure).toMatchObject({ level: 50, err: { message: 'disk full' } });
    expect(failure?.requestId).toMatch(JOB_ID);
    expect(nextRan).toBe(true);
  });

  it('runs every job when started and again on its timer, and stops cleanly', async () => {
    const name = jobName();
    let runs = 0;
    const runner = createJobRunner({
      db: tdb.db,
      log,
      everyMs: 100,
      jobs: [
        {
          name,
          run: () => {
            runs += 1;
            return Promise.resolve({});
          },
        },
      ],
    });

    runner.start();
    await expect.poll(() => runs, { timeout: 2000 }).toBeGreaterThanOrEqual(2);
    await runner.stop();
    const stoppedAt = runs;
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(runs).toBe(stoppedAt);
  });
});

describe('daily jobs', () => {
  it('registers each job once, by a unique name', () => {
    const names = dailyJobs(services).map((j) => j.name);
    expect(names).toContain('idempotency-keys');
    expect(new Set(names).size).toBe(names.length);
  });

  it('idempotency-keys deletes expired keys only', async () => {
    const row = (key: string, expired: boolean) => ({
      caller: 'user:00000000-0000-7000-8000-000000000001',
      key,
      operation_id: 'expenses.create',
      request_hash: randomBytes(32),
      response_status: 201,
      response_body: JSON.stringify({}),
      expires_at: sql<Date>`now() + ${expired ? sql`interval '-1 minute'` : sql`interval '1 hour'`}`,
    });
    await tdb.db
      .insertInto('tribo.idempotency_keys')
      .values([row('old-1', true), row('old-2', true), row('live', false)])
      .execute();
    const job = dailyJobs(services).find((j) => j.name === 'idempotency-keys');

    const counts = await job?.run({ requestId: 'job-test', surface: 'system', userId: null });

    expect(counts).toEqual({ deleted: 2 });
    const left = await tdb.db.selectFrom('tribo.idempotency_keys').select('key').execute();
    expect(left.map((r) => r.key)).toEqual(['live']);
  });
});
