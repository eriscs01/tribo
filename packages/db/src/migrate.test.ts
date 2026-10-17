import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadMigrations,
  MigrationError,
  MIGRATIONS_DIR,
  pendingMigrations,
  sha256,
  type Migration,
} from './migrate.js';

const file = (name: string, sql = `-- ${name}`): Migration => ({ name, sql, sha256: sha256(sql) });

describe('loadMigrations', () => {
  it('loads the numbered project migrations in order, skipping the superuser bootstrap', async () => {
    const names = (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.name);
    expect(names[0]).toBe('0001_init.sql');
    expect(names).not.toContain('0000_bootstrap.sql');
    expect(names).toEqual([...names].sort());
  });

  it('keeps BEGIN/COMMIT out of migration files, since the runner wraps each one', async () => {
    for (const m of await loadMigrations(MIGRATIONS_DIR)) {
      expect(m.sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    }
  });

  it('refuses two files with the same number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tribo-mig-'));
    await writeFile(join(dir, '0002_a.sql'), '');
    await writeFile(join(dir, '0002_b.sql'), '');
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('ignores files that are not numbered migrations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tribo-mig-'));
    await writeFile(join(dir, '0001_init.sql'), '');
    await writeFile(join(dir, 'notes.md'), '');
    await writeFile(join(dir, '1_bad.sql'), '');
    expect((await loadMigrations(dir)).map((m) => m.name)).toEqual(['0001_init.sql']);
  });
});

describe('pendingMigrations', () => {
  const a = file('0001_init.sql');
  const b = file('0002_next.sql');

  it('returns everything on an empty database', () => {
    expect(pendingMigrations([], [a, b])).toEqual([a, b]);
  });

  it('returns nothing when all are applied', () => {
    expect(pendingMigrations([a, b], [a, b])).toEqual([]);
  });

  it('returns only new files', () => {
    expect(pendingMigrations([a], [a, b])).toEqual([b]);
  });

  it('refuses when an applied file changed', () => {
    const edited = { ...a, sha256: sha256('-- edited') };
    expect(() => pendingMigrations([a], [edited, b])).toThrow(/changed after it ran/);
  });

  it('refuses when an applied file is missing', () => {
    expect(() => pendingMigrations([a, b], [a])).toThrow(/missing from disk/);
  });

  it('refuses a new file that sorts before an applied one', () => {
    const late = file('0001_late.sql');
    expect(() => pendingMigrations([b], [late, b])).toThrow(/sorts before/);
  });
});
