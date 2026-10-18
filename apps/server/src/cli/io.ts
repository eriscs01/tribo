import { createInterface } from 'node:readline';

/** How a command talks to the operator; tests script it. */
export interface CliIo {
  say(text: string): void;
  /** One line of input; `secret` input is not echoed on a terminal. */
  ask(question: string, options?: { secret?: boolean }): Promise<string>;
}

export class CliError extends Error {
  override name = 'CliError';
}

/**
 * stdin/stdout. On a terminal, secret answers are not echoed; from a pipe, each answer is
 * the next line, so a script can feed a command (`printf '%s\n' … | tribo admin create`).
 */
export function terminalIo(): CliIo & { close(): void } {
  const tty = process.stdin.isTTY;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const lines = rl[Symbol.asyncIterator]();
  // readline has no hidden input; muting its echo while a secret is typed is the usual way.
  /* eslint-disable no-underscore-dangle -- _writeToOutput is readline's own (private) hook */
  const echo = rl as unknown as { _writeToOutput(text: string): void };
  const write = echo._writeToOutput.bind(rl);
  let muted = false;
  echo._writeToOutput = (text) => {
    if (!muted) write(text);
  };
  /* eslint-enable no-underscore-dangle */

  return {
    say: (text) => {
      process.stdout.write(`${text}\n`);
    },
    async ask(question, { secret = false } = {}) {
      process.stdout.write(question);
      muted = secret && tty;
      const next = await lines.next();
      if (muted) process.stdout.write('\n');
      muted = false;
      if (next.done) throw new CliError('input ended before the command finished');
      return next.value;
    },
    close: () => {
      rl.close();
    },
  };
}
