// `tribo admin blobs unreferenced`: the uploads volume against the files table, on a real
// database and a temporary volume. The command only reads: it lists keys and sizes.
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppKey } from '@tribo/crypto';
import {
  createFile,
  createTestDatabase,
  createTrip,
  createUser,
  type TestDatabase,
} from '@tribo/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeServices } from '../runtime.js';
import type { CliIo } from './io.js';
import { runCli } from './run.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const DAY_MS = 86_400_000;
const hex = () => randomBytes(16).toString('hex');
const keyOf = (id: string) => `${id.slice(0, 2)}/${id}`;

/** Every path under `dir` with its type, size and mtime: what "nothing changed" compares. */
async function snapshot(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    // eslint-disable-next-line no-await-in-loop -- a few entries, in order
    const info = await lstat(path);
    out.push(
      `${prefix}${name} ${info.isDirectory() ? 'dir' : String(info.size)} ${String(info.mtimeMs)}`,
    );
    // eslint-disable-next-line no-await-in-loop
    if (info.isDirectory()) out.push(...(await snapshot(path, `${prefix}${name}/`)));
  }
  return out;
}

async function put(root: string, key: string, bytes: number, ageMs: number) {
  const path = join(root, key);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 1));
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

/** A volume and a database with one trip; each test builds its own so none sees another's files. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tribo-blobs-'));
  const user = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner: user });
  const said: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    say: (text) => said.push(text),
    ask: () => Promise.reject(new Error('no input in this test')),
  };
  const services = composeServices(
    tdb.db,
    new AppKey(randomBytes(32)),
    new URL('https://t.test'),
    root,
  );
  const run = (...argv: string[]) =>
    runCli(['admin', 'blobs', ...argv], {
      io,
      stderr: (text) => errors.push(text),
      open: () =>
        Promise.resolve({
          ...services,
          release: { version: 'v1.2.3', commit: '0a1b2c3' },
          close: () => Promise.resolve(),
        }),
    });
  /** A files row whose blob is on the volume (or not) under `ageMs`. */
  const referenced = async (ageMs: number, onVolume = true) => {
    const id = await createFile(tdb.db, {
      tripId: trip.tripId,
      ownerMembershipId: trip.ownerMembershipId,
    });
    const row = await tdb.db
      .selectFrom('tribo.files')
      .select('blob_key')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (onVolume) await put(root, row.blob_key, 100, ageMs);
    return row.blob_key;
  };
  return { root, said, errors, run, referenced };
}

describe('tribo admin blobs unreferenced', () => {
  it('lists blobs no files row names, with their size, and counts them', async () => {
    const v = await setup();
    const kept = await v.referenced(2 * DAY_MS);
    const orphan = keyOf(hex());
    await put(v.root, orphan, 250, 2 * DAY_MS);

    expect(await v.run('unreferenced')).toBe(0);
    expect(v.said.join('\n')).toContain(orphan);
    expect(v.said.join('\n')).not.toContain(kept);
    expect(v.said.at(-1)).toBe('1 unreferenced blob, 250 bytes; 0 leftovers in .tmp, 0 bytes.');
    expect(v.errors).toEqual([]);
  });

  it('leaves out a blob newer than the cut-off, which may belong to an upload still committing', async () => {
    const v = await setup();
    await put(v.root, keyOf(hex()), 10, 60 * 1000);

    await v.run('unreferenced');
    expect(v.said.at(-1)).toMatch(/^0 unreferenced blobs, 0 bytes;/);
    await v.run('unreferenced', '--older-than-hours', '0');
    expect(v.said.at(-1)).toMatch(/^1 unreferenced blob, 10 bytes;/);
  });

  it('lists .tmp leftovers older than the cut-off, not a fresh partial', async () => {
    const v = await setup();
    const old = `.tmp/${hex()}.partial`;
    await put(v.root, old, 30, 3 * DAY_MS);
    await put(v.root, `.tmp/${hex()}.partial`, 30, 1000);

    await v.run('unreferenced');
    expect(v.said.join('\n')).toContain(old);
    expect(v.said.at(-1)).toBe('0 unreferenced blobs, 0 bytes; 1 leftover in .tmp, 30 bytes.');
  });

  it('prints keys only, never a name it cannot vouch for, and never leaves the volume', async () => {
    const v = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'tribo-outside-'));
    await put(outside, 'secret-plan.pdf', 77, 5 * DAY_MS);
    const real = `cc/cc${hex().slice(2)}`;
    await put(v.root, real, 5, 5 * DAY_MS);
    // A symlinked bucket, a symlinked blob, a ..-named entry and odd names: all are ignored.
    await symlink(outside, join(v.root, 'aa'));
    await mkdir(join(v.root, 'bb'), { recursive: true });
    await symlink(join(outside, 'secret-plan.pdf'), join(v.root, 'bb', `bb${hex().slice(2)}`));
    await writeFile(join(v.root, '..hidden'), 'x');
    await mkdir(join(v.root, '.tmp'), { recursive: true });
    await writeFile(join(v.root, '.tmp', 'passport-scan.jpg'), 'x');
    await symlink(outside, join(v.root, '.tmp', `${hex()}.partial`));
    const before = await snapshot(v.root);
    const outsideBefore = await snapshot(outside);

    expect(await v.run('unreferenced', '--older-than-hours', '0')).toBe(0);
    const out = v.said.join('\n');
    expect(out).toContain(real);
    for (const name of ['secret-plan', 'passport-scan', '..hidden', 'outside']) {
      expect(out).not.toContain(name);
    }
    expect(v.said.at(-1)).toBe(
      '1 unreferenced blob, 5 bytes; 0 leftovers in .tmp, 0 bytes; 5 unexpected entries ignored.',
    );
    // Read-only: neither the volume nor what the links point at changed.
    expect(await snapshot(v.root)).toEqual(before);
    expect(await snapshot(outside)).toEqual(outsideBefore);
    await rm(outside, { recursive: true });
  });

  it('streams the walk and the lookup in batches', async () => {
    const v = await setup();
    for (let i = 0; i < 1200; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential writes keep the test simple
      await put(v.root, keyOf(hex()), 1, 2 * DAY_MS);
    }
    const kept = await v.referenced(2 * DAY_MS);

    await v.run('unreferenced');
    expect(v.said.at(-1)).toMatch(/^1200 unreferenced blobs, 1200 bytes;/);
    expect(v.said.join('\n')).not.toContain(kept);
    expect((await stat(v.root)).isDirectory()).toBe(true);
  });

  it('refuses a missing subcommand or a bad cut-off with a usage line and exit 1', async () => {
    const v = await setup();
    expect(await v.run()).toBe(1);
    expect(await v.run('unreferenced', '--older-than-hours', 'soon')).toBe(1);
    expect(v.errors[0]).toMatch(
      /^error: usage: tribo admin blobs unreferenced \[--older-than-hours <n>\]/,
    );
  });
});
