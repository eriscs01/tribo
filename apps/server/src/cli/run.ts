import { randomUUID } from 'node:crypto';
import type { ChainReport, IdentityService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { adminCreate } from './admin-create.js';
import type { Services } from '../runtime.js';
import { auditVerify } from './audit-verify.js';
import { CliError, type CliIo } from './io.js';

interface CommandDeps {
  identity: IdentityService;
  verifyAudit: (chainKey?: string) => Promise<ChainReport[]>;
  io: CliIo;
  issuer: string;
  ctx: RequestContext;
}

/** Commands by their two-word name; a new command is a new entry. */
const COMMANDS: Record<string, (deps: CommandDeps, args: readonly string[]) => Promise<void>> = {
  'admin create': adminCreate,
  'audit verify': auditVerify,
};

/** What a command needs from the runtime, opened only once the command is known. */
export type CliRuntime = Pick<Services, 'identity' | 'verifyAudit' | 'issuer'> & {
  close: () => Promise<void>;
};

/**
 * Runs `tribo <group> <verb> [args…]` and resolves to the exit code: 2 for an unknown
 * command, 1 for a command's refusal (a CliError), 0 otherwise. Other errors propagate.
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

  const runtime = await deps.open();
  try {
    await command(
      {
        identity: runtime.identity,
        verifyAudit: runtime.verifyAudit,
        io: deps.io,
        issuer: runtime.issuer,
        ctx: { requestId: `cli-${randomUUID()}`, surface: 'system', userId: null },
      },
      args,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    deps.stderr(`error: ${error.message}\n`);
    return 1;
  } finally {
    await runtime.close();
  }
}
