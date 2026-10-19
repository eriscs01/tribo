import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileStore, StateError } from './state.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-watch-state-'));
});
afterEach(async () => {
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

describe('the state file', () => {
  it('starts empty when there is no file yet', async () => {
    expect(await createFileStore(join(dir, 'state.json')).load()).toEqual({ prs: {} });
  });

  it('reads back what was saved, creating its directory', async () => {
    const path = join(dir, 'nested', 'state.json');
    const state = { prs: { '53': { sha: 'abc', emitted: ['ready' as const] } } };
    await createFileStore(path).save(state);
    expect(await createFileStore(path).load()).toEqual(state);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(state);
  });

  it('refuses a damaged file by naming it, never by quoting it', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{"prs": 7}');
    await expect(createFileStore(path).load()).rejects.toEqual(
      new StateError('state_unreadable', path),
    );
    await writeFile(path, 'not json');
    await expect(createFileStore(path).load()).rejects.toEqual(
      new StateError('state_unreadable', path),
    );
  });

  it('refuses a file it cannot read, and a directory it cannot write', async () => {
    const path = join(dir, 'state.json');
    await mkdir(path);
    await expect(createFileStore(path).load()).rejects.toEqual(
      new StateError('state_unreadable', path),
    );
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    const inLocked = join(locked, 'state.json');
    await expect(createFileStore(inLocked).save({ prs: {} })).rejects.toEqual(
      new StateError('state_unwritable', inLocked),
    );
    await chmod(locked, 0o700);
  });
});
