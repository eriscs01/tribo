import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBudget, initialJsFiles, measureInitialJs } from './bundle-budget.js';

const gzipped = promisify(gzip);
let dist = '';

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'bundle-budget-'));
  await mkdir(join(dist, 'assets'));
});
afterEach(() => rm(dist, { recursive: true, force: true }));

const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;

describe('initial JavaScript', () => {
  it('is what index.html loads at start: the entry script and its modulepreloads, not lazy chunks or CSS', async () => {
    await writeFile(
      join(dist, 'index.html'),
      page(
        '<script type="module" crossorigin src="/assets/index-A.js"></script>' +
          '<link rel="modulepreload" crossorigin href="/assets/vendor-B.js">' +
          '<link rel="stylesheet" crossorigin href="/assets/index-C.css">',
      ),
    );
    expect(await initialJsFiles(dist)).toEqual(['assets/index-A.js', 'assets/vendor-B.js']);
  });

  it('is measured gzipped, summed over the initial files', async () => {
    const a = randomBytes(5000).toString('base64');
    const b = 'x'.repeat(50_000);
    await writeFile(join(dist, 'assets', 'a.js'), a);
    await writeFile(join(dist, 'assets', 'b.js'), b);
    await writeFile(
      join(dist, 'index.html'),
      page(
        '<script type="module" src="/assets/a.js"></script><link rel="modulepreload" href="/assets/b.js">',
      ),
    );
    expect(await measureInitialJs(dist)).toBe(
      (await gzipped(a)).length + (await gzipped(b)).length,
    );
  });

  it('is an error when index.html names no script, since a build without one is broken', async () => {
    await writeFile(join(dist, 'index.html'), page(''));
    await expect(initialJsFiles(dist)).rejects.toThrow(/no script/);
  });
});

describe('budget', () => {
  it('passes at the limit and fails one byte over, naming both sizes', () => {
    expect(checkBudget(200_000, 200_000)).toBeNull();
    expect(checkBudget(200_001, 200_000)).toMatch(/200001.*200000/);
  });
});
