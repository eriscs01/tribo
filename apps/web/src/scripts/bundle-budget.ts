/// <reference types="node" />
// The SPA's initial JavaScript against the design's budget (technical design, Operations ›
// Performance: initial JS ≤ 200 KB gzip); check-bundle.ts is the command. Initial JS is what dist/app/index.html loads before the first render:
// its module scripts and modulepreloads; lazy chunks load later and do not count.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipped = promisify(gzip);

/** 200 KB as Vite prints it (1 kB = 1000 bytes), gzipped. */
export const BUDGET_BYTES = 200_000;

const TAG = /<(script|link)\b[^>]*>/gi;
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1];

/** The JavaScript files index.html loads at start, relative to the build directory. */
export async function initialJsFiles(dist: string): Promise<string[]> {
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  const urls = [...html.matchAll(TAG)].flatMap(([tag, tagName = '']) => {
    const name = tagName.toLowerCase();
    const url = name === 'script' ? attr(tag, 'src') : attr(tag, 'href');
    const initial = name === 'script' || attr(tag, 'rel')?.toLowerCase() === 'modulepreload';
    return url !== undefined && initial ? [url.replace(/^\//, '')] : [];
  });
  if (urls.length === 0) throw new Error(`${join(dist, 'index.html')} names no script`);
  return [...new Set(urls)];
}

/** Gzipped bytes of the initial JavaScript. */
export async function measureInitialJs(dist: string): Promise<number> {
  const files = await initialJsFiles(dist);
  const sizes = await Promise.all(
    files.map(async (file) => (await gzipped(await readFile(join(dist, file)))).length),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** The failure message, or null when the size is within the budget. */
export function checkBudget(bytes: number, budget: number): string | null {
  return bytes > budget
    ? `initial JS is ${String(bytes)} bytes gzip, over the budget of ${String(budget)}`
    : null;
}
