type Fields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

/**
 * One JSON line per call: a fixed message, the run id that names this watcher run, and named
 * fields. Every secret (the GitHub token) is replaced wherever it appears in the finished line,
 * so a value quoted by an error or a library can never reach the log.
 */
export function createLogger({
  write,
  run,
  secrets,
  now = () => new Date(),
}: {
  write: (line: string) => void;
  run: string;
  secrets: readonly string[];
  now?: () => Date;
}): Logger {
  const emit =
    (level: string) =>
    (msg: string, fields: Fields = {}) => {
      let line = JSON.stringify({ time: now().toISOString(), level, msg, run, ...fields });
      for (const secret of secrets) if (secret) line = line.replaceAll(secret, '[redacted]');
      write(`${line}\n`);
    };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
