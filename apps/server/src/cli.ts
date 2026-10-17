#!/usr/bin/env node
// tribo <command>: operator commands, run in the app container (`docker compose exec app tribo …`).
import { randomUUID } from 'node:crypto';
import type { IdentityService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { adminCreate } from './cli/admin-create.js';
import { CliError, terminalIo, type CliIo } from './cli/io.js';
import { loadConfig } from './config.js';
import { openRuntime } from './runtime.js';

interface CommandDeps {
  identity: IdentityService;
  io: CliIo;
  issuer: string;
  ctx: RequestContext;
}

/** Commands by their two-word name; a new command is a new entry. */
const COMMANDS: Record<string, (deps: CommandDeps, args: readonly string[]) => Promise<void>> = {
  'admin create': adminCreate,
};

const [group = '', verb = '', ...args] = process.argv.slice(2);
const command = COMMANDS[`${group} ${verb}`];
if (!command) {
  process.stderr.write(
    `usage: tribo <command>\ncommands:\n${Object.keys(COMMANDS)
      .map((c) => `  ${c}`)
      .join('\n')}\n`,
  );
  process.exit(2);
}

const config = loadConfig(process.env);
const runtime = await openRuntime(config, 'tribo-cli');
const io = terminalIo();
try {
  await command(
    {
      identity: runtime.identity,
      io,
      issuer: `Tribo (${config.publicUrl.host})`,
      ctx: { requestId: `cli-${randomUUID()}`, surface: 'system', userId: null },
    },
    args,
  );
} catch (error) {
  if (!(error instanceof CliError)) throw error;
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  io.close();
  await runtime.close();
}
