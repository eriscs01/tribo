#!/usr/bin/env node
// tribo <command>: operator commands, run in the app container (`docker compose exec app tribo …`).
import { terminalIo } from './cli/io.js';
import { runCli } from './cli/run.js';
import { loadConfig } from './config.js';
import { openRuntime } from './runtime.js';

const io = terminalIo();
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    open: () => openRuntime(loadConfig(process.env), 'tribo-cli'),
    io,
    stderr: (text) => process.stderr.write(text),
  });
} finally {
  io.close();
}
