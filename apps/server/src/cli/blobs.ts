import type { FilesService } from '@tribo/core';
import { CliError, type CliIo } from './io.js';

const USAGE = 'usage: tribo admin blobs unreferenced [--older-than-hours <n>]';
const HOUR_MS = 3_600_000;
/** Younger than this a blob may belong to an upload that has stored it and not yet committed. */
const DEFAULT_HOURS = 24;

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * `tribo admin blobs unreferenced [--older-than-hours <n>]`: lists the blob keys on the
 * uploads volume that no file row names, and `.tmp/` leftovers, each at least `n` hours old
 * (24 by default), with their sizes and a count. It reads only and deletes nothing: the
 * runbook says how to remove one after checking it. It prints keys, never file names.
 */
export async function adminBlobs(
  deps: { files: FilesService; io: CliIo },
  args: readonly string[],
): Promise<void> {
  const [subcommand, flag, value, ...extra] = args;
  const parsed = flag === undefined ? DEFAULT_HOURS : Number(value);
  const hours = flag === '--older-than-hours' && /^\d+$/.test(value ?? '') ? parsed : null;
  const valid = flag === undefined ? true : hours !== null && extra.length === 0;
  if (subcommand !== 'unreferenced' || !valid) throw new CliError(USAGE);

  const olderThan = new Date(Date.now() - (hours ?? DEFAULT_HOURS) * HOUR_MS);
  const found = { blobs: 0, blobBytes: 0, leftovers: 0, leftoverBytes: 0, ignored: 0 };
  for await (const entry of deps.files.unreferencedBlobs(olderThan, () => {
    found.ignored += 1;
  })) {
    deps.io.say(`${entry.key}  ${String(entry.sizeBytes)} bytes`);
    if (entry.leftover) {
      found.leftovers += 1;
      found.leftoverBytes += entry.sizeBytes;
    } else {
      found.blobs += 1;
      found.blobBytes += entry.sizeBytes;
    }
  }
  const ignored =
    found.ignored > 0
      ? `; ${plural(found.ignored, 'unexpected entry', 'unexpected entries')} ignored`
      : '';
  deps.io.say(
    `${plural(found.blobs, 'unreferenced blob', 'unreferenced blobs')}, ${String(found.blobBytes)} bytes; ` +
      `${plural(found.leftovers, 'leftover', 'leftovers')} in .tmp, ${String(found.leftoverBytes)} bytes${ignored}.`,
  );
}
