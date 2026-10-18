// The running Compose stack, reached the way an operator reaches it: `docker compose exec`.
// COMPOSE_FILE picks the stack (default: the dev stack); paths in it are from the repo root.
import { spawn } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? 'deploy/compose.dev.yml';

interface Exec {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * `docker compose exec -T <service> <command…>`, answering prompts: each time stdout matches
 * a prompt's pattern, its answer (computed from the output so far) is written as one line.
 */
async function composeExec(
  service: string,
  command: readonly string[],
  prompts: readonly { when: RegExp; answer: (stdout: string) => string }[] = [],
): Promise<Exec> {
  const child = spawn('docker', ['compose', 'exec', '-T', service, ...command], {
    cwd: REPO_ROOT,
    env: { ...process.env, COMPOSE_FILE },
  });
  const pending = [...prompts];
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    while (pending[0]?.when.test(stdout)) {
      const prompt = pending.shift();
      if (prompt) child.stdin.write(`${prompt.answer(stdout)}\n`);
    }
    if (pending.length === 0 && !child.stdin.writableEnded) child.stdin.end();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  if (pending.length === 0) child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { stdout, stderr, exitCode };
}

function succeeded(what: string, run: Exec): string {
  if (run.exitCode !== 0) {
    throw new Error(`${what} exited ${String(run.exitCode)}\n${run.stdout}\n${run.stderr}`);
  }
  return run.stdout;
}

/** `tribo <args…>` in the app container; the relative path works in the dev and release images. */
function tribo(args: readonly string[], prompts?: Parameters<typeof composeExec>[2]) {
  return composeExec('app', ['node', 'apps/server/dist/cli.js', ...args], prompts);
}

/**
 * `tribo admin create`, typed as an operator would: the password twice, then a code from
 * the key it prints. Returns that key, which the authenticator app now holds.
 */
export async function createAdmin(input: {
  username: string;
  displayName: string;
  password: string;
  codeFor: (key: string) => string;
}): Promise<{ key: string; recoveryCodes: string[] }> {
  const keyOf = (stdout: string) => /^ {2}key: ([A-Z2-7]+)$/m.exec(stdout)?.[1] ?? '';
  const stdout = succeeded(
    'tribo admin create',
    await tribo(
      ['admin', 'create', input.username, input.displayName],
      [
        { when: /Password \(12–128 characters\): $/, answer: () => input.password },
        { when: /Repeat password: $/, answer: () => input.password },
        { when: /Six-digit code from the app: $/, answer: (out) => input.codeFor(keyOf(out)) },
      ],
    ),
  );
  const recoveryCodes = stdout.match(/^ {2}[a-z2-9]{5}-[a-z2-9]{5}$/gm) ?? [];
  return { key: keyOf(stdout), recoveryCodes: recoveryCodes.map((c) => c.trim()) };
}

/** `tribo audit verify [chain key]`: its report, or an error with it when a chain is broken. */
export async function auditVerify(chainKey?: string): Promise<string> {
  return succeeded(
    'tribo audit verify',
    await tribo(['audit', 'verify', ...(chainKey === undefined ? [] : [chainKey])]),
  );
}

/**
 * One query as tribo_app over the database container's local socket, as rows of
 * `|`-separated columns. Read-only checks only; the app's own write path does every write.
 */
export async function query(sql: string): Promise<string[]> {
  const stdout = succeeded(
    'psql',
    await composeExec('db', [
      'psql',
      '-U',
      'tribo_app',
      '-d',
      'tribo',
      '-v',
      'ON_ERROR_STOP=1',
      '-tAc',
      sql,
    ]),
  );
  return stdout.split('\n').filter((line) => line !== '');
}
