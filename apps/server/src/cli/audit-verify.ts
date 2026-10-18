import type { ChainReport } from '@tribo/core';
import { CliError, type CliIo } from './io.js';

/**
 * `tribo audit verify [chain key]`: checks every hash chain (or one, e.g. trip:<uuid>) and
 * prints one line per chain. Fails when any chain is broken, so a restore check or a cron
 * job can rely on the exit code.
 */
export async function auditVerify(
  deps: { verifyAudit: (chainKey?: string) => Promise<ChainReport[]>; io: CliIo },
  args: readonly string[],
): Promise<void> {
  if (args.length > 1) throw new CliError('usage: tribo audit verify [chain key]');
  const [chainKey] = args;
  const reports = await deps.verifyAudit(chainKey);
  if (chainKey !== undefined && reports.length === 0) {
    throw new CliError(`no audit chain ${chainKey}`);
  }
  for (const r of reports) {
    const state = r.brokenAt === null ? 'intact' : `BROKEN at seq ${String(r.brokenAt)}`;
    deps.io.say(
      `${r.chainKey}  ${String(r.events)} events, head seq ${String(r.headSeq)}  ${state}`,
    );
  }
  const broken = reports.filter((r) => r.brokenAt !== null).length;
  if (broken > 0)
    throw new CliError(`${String(broken)} of ${String(reports.length)} chains broken`);
  deps.io.say(`All ${String(reports.length)} chains intact.`);
}
