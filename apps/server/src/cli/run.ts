import { randomUUID } from 'node:crypto';
import type { ChainReport, IdentityService, RequestEvent } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import type { Release } from '../config.js';
import { adminCreate } from './admin-create.js';
import type { Services } from '../runtime.js';
import { auditRequest } from './audit-request.js';
import { auditVerify } from './audit-verify.js';
import { CliError, type CliIo } from './io.js';

interface CommandDeps {
  identity: IdentityService;
  verifyAudit: (chainKey?: string) => Promise<ChainReport[]>;
  requestAudit: (requestId: string) => Promise<RequestEvent[]>;
  release: Release;
  io: CliIo;
  issuer: string;
  ctx: RequestContext;
}

/** Commands by their two-word name; a new command is a new entry. */
const COMMANDS: Record<string, (deps: CommandDeps, args: readonly string[]) => Promise<void>> = {
  'admin create': adminCreate,
  'audit request': auditRequest,
  'audit verify': auditVerify,
  'release show': (deps) => {
    deps.io.say(`Tribo ${deps.release.version} (${deps.release.commit})`);
    return Promise.resolve();
  },
};

/** What a command needs from the runtime, opened only once the command is known. */
export type CliRuntime = Pick<Services, 'identity' | 'verifyAudit' | 'requestAudit' | 'issuer'> & {
  release: Release;
  close: () => Promise<void>;
};

/**
 * Runs `tribo <group> <verb> [args…]` and resolves to the exit code: 2 for an unknown
 * command, 1 for a command's refusal (a CliError), 0 otherwise. Other errors propagate.
 * A refusal or failure names the run's request id, which its audit events carry too.
 */
export async function runCli(
  argv: readonly string[],
  deps: { open: () => Promise<CliRuntime>; io: CliIo; stderr: (text: string) => void },
): Promise<number> {
  const [group = '', verb = '', ...args] = argv;
  const command = COMMANDS[`${group} ${verb}`];
  if (!command) {
    deps.stderr(
      `usage: tribo <command>\ncommands:\n${Object.keys(COMMANDS)
        .map((c) => `  ${c}`)
        .join('\n')}\n`,
    );
    return 2;
  }

  const requestId = `cli-${randomUUID()}`;
  const runtime = await deps.open();
  try {
    await command(
      {
        identity: runtime.identity,
        verifyAudit: runtime.verifyAudit,
        requestAudit: runtime.requestAudit,
        release: runtime.release,
        io: deps.io,
        issuer: runtime.issuer,
        ctx: { requestId, surface: 'system', userId: null },
      },
      args,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof CliError)) {
      deps.stderr(`error: unexpected failure (request ${requestId})\n`);
      throw error;
    }
    deps.stderr(`error: ${error.message} (request ${requestId})\n`);
    return 1;
  } finally {
    await runtime.close();
  }
}
