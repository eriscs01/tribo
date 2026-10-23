import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The build that is running: its release tag and commit. */
export interface Release {
  version: string;
  commit: string;
}

/** What a build that CI did not name (a local or test run) reports. */
export const DEV_RELEASE: Release = { version: 'dev', commit: 'unknown' };

const Env = z.object({
  TRIBO_PUBLIC_URL: z.url({ protocol: /^https$/ }),
  TRIBO_LISTEN_HOST: z.string().default('0.0.0.0'),
  TRIBO_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRIBO_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRIBO_DB_HOST: z.string().min(1).default('db'),
  TRIBO_DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  TRIBO_DB_NAME: z.string().min(1).default('tribo'),
  TRIBO_SECRETS_DIR: z.string().min(1).default('/run/secrets'),
  /** The upload volume (deploy/compose.yml): encrypted blobs, written by the documents module. */
  TRIBO_UPLOADS_DIR: z.string().min(1).default('/var/lib/tribo/uploads'),
  /**
   * Hops whose X-Forwarded-For and X-Request-Id the app believes: the Caddy container on the
   * private Compose network. Caddy itself decides which outer proxies (Cloudflare) to trust
   * and passes one client IP on; the app is never published directly.
   */
  TRIBO_APP_TRUSTED_PROXIES: z.string().default('loopback,uniquelocal'),
  /** Baked into the image by its build (deploy/app/Dockerfile); a local run is dev. */
  TRIBO_RELEASE_VERSION: z.string().min(1).default(DEV_RELEASE.version),
  TRIBO_RELEASE_COMMIT: z.string().min(1).default(DEV_RELEASE.commit),
});

export interface Config {
  publicUrl: URL;
  listen: { host: string; port: number };
  logLevel: z.infer<typeof Env>['TRIBO_LOG_LEVEL'];
  db: {
    host: string;
    port: number;
    database: string;
    appPassword: string;
    ownerPassword: string;
  };
  appKeyFile: string;
  uploadsDir: string;
  trustedProxies: string[];
  release: Release;
}

/** Reads one Docker secret file. Errors name the file, never its content. */
function readSecret(dir: string, name: string): string {
  let value: string;
  try {
    // eslint-disable-next-line n/no-sync -- config is read once, before the server starts
    value = readFileSync(join(dir, name), 'utf8').trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ConfigError(`secret ${name} cannot be read from ${dir} (${code})`);
  }
  if (value === '') throw new ConfigError(`secret ${name} in ${dir} is empty`);
  return value;
}

/**
 * Parses the environment once at start. A bad value fails with the variable's name and
 * what was expected, never the value itself.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message.replace(/, received .*$/, '')}`,
    );
    throw new ConfigError(`invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  return {
    publicUrl: new URL(e.TRIBO_PUBLIC_URL),
    listen: { host: e.TRIBO_LISTEN_HOST, port: e.TRIBO_PORT },
    logLevel: e.TRIBO_LOG_LEVEL,
    db: {
      host: e.TRIBO_DB_HOST,
      port: e.TRIBO_DB_PORT,
      database: e.TRIBO_DB_NAME,
      appPassword: readSecret(e.TRIBO_SECRETS_DIR, 'db_app_password'),
      ownerPassword: readSecret(e.TRIBO_SECRETS_DIR, 'db_owner_password'),
    },
    appKeyFile: join(e.TRIBO_SECRETS_DIR, 'app_key'),
    uploadsDir: e.TRIBO_UPLOADS_DIR,
    trustedProxies: e.TRIBO_APP_TRUSTED_PROXIES.split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    release: { version: e.TRIBO_RELEASE_VERSION, commit: e.TRIBO_RELEASE_COMMIT },
  };
}
