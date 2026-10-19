// `tribo <command>` dispatch over the composed services: which command runs, what the
// operator sees on stderr and the exit code a script or cron job relies on.
import { randomBytes } from 'node:crypto';
import { AppKey } from '@tribo/crypto';
import { createTestDatabase, type TestDatabase } from '@tribo/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeServices } from '../runtime.js';
import type { CliIo } from './io.js';
import { runCli } from './run.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

/** The CLI as cli.ts runs it, with the operator's terminal and the runtime's lifetime recorded. */
function harness() {
  const said: string[] = [];
  const errors: string[] = [];
  const runtime = { opened: 0, closed: 0 };
  const io: CliIo = {
    say: (text) => said.push(text),
    ask: () => Promise.reject(new Error('no input in this test')),
  };
  const services = composeServices(tdb.db, new AppKey(randomBytes(32)), new URL('https://t.test'));
  const run = (argv: string[]) =>
    runCli(argv, {
      io,
      stderr: (text) => errors.push(text),
      open: () => {
        runtime.opened += 1;
        return Promise.resolve({
          ...services,
          close: () => {
            runtime.closed += 1;
            return Promise.resolve();
          },
        });
      },
    });
  return { run, said, errors, runtime };
}

describe('tribo <command>', () => {
  it('prints the commands and exits 2 for an unknown command, without opening the runtime', async () => {
    const cli = harness();
    expect(await cli.run(['admin', 'delete'])).toBe(2);
    expect(await cli.run([])).toBe(2);
    expect(cli.errors[0]).toBe(
      'usage: tribo <command>\ncommands:\n  admin create\n  audit verify\n',
    );
    expect(cli.runtime.opened).toBe(0);
  });

  it('runs the named command with its arguments and exits 0', async () => {
    const cli = harness();
    expect(await cli.run(['audit', 'verify'])).toBe(0);
    expect(cli.said.at(-1)).toMatch(/^All \d+ chains intact\.$/);
    expect(cli.errors).toEqual([]);
    expect(cli.runtime).toEqual({ opened: 1, closed: 1 });
  });

  it("prints a command's refusal as error: … and exits 1, closing the runtime", async () => {
    const cli = harness();
    expect(await cli.run(['audit', 'verify', 'trip:00000000-0000-0000-0000-000000000000'])).toBe(1);
    expect(cli.errors).toEqual([
      'error: no audit chain trip:00000000-0000-0000-0000-000000000000\n',
    ]);
    expect(cli.runtime).toEqual({ opened: 1, closed: 1 });
  });

  it('lets an unexpected failure through, still closing the runtime', async () => {
    const cli = harness();
    // The operator's input ends with an Error that is not a CliError: a crash, not a refusal.
    await expect(cli.run(['admin', 'create', 'ana'])).rejects.toThrow('no input in this test');
    expect(cli.errors).toEqual([]);
    expect(cli.runtime).toEqual({ opened: 1, closed: 1 });
  });
});
