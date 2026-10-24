// Submits the dependency graph resolved in pnpm-lock.yaml to GitHub's dependency submission
// API (CI job "Dependency graph"). GitHub's own lockfile parser does not read pnpm 12's
// lockfile, so the graph, and Dependabot alerts with it, would stay on old versions.
//
//   pnpm submit:deps            submit (needs GITHUB_TOKEN)
//   pnpm submit:deps --dry-run  print the snapshot instead
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

interface TreeNode {
  version: string;
  dependencies?: Record<string, TreeNode>;
}
interface Project {
  name?: string;
  dependencies?: Record<string, TreeNode>;
  devDependencies?: Record<string, TreeNode>;
}
interface Resolved {
  package_url: string;
  relationship: 'direct' | 'indirect';
  scope: 'runtime' | 'development';
  dependencies: string[];
}

const purl = (name: string, version: string) => `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;

/** One manifest per workspace project: every resolved package, direct or not, with its edges. */
function manifestOf(project: Project) {
  const resolved: Record<string, Resolved> = {};
  const add = (
    name: string,
    node: TreeNode,
    relationship: Resolved['relationship'],
    scope: Resolved['scope'],
  ): void => {
    // A link to another workspace project is not a package of its own.
    if (node.version.startsWith('link:')) return;
    const id = purl(name, node.version);
    const known = resolved[id];
    if (known) {
      if (relationship === 'direct') known.relationship = 'direct';
      if (scope === 'runtime') known.scope = 'runtime';
      return;
    }
    const children = Object.entries(node.dependencies ?? {}).filter(
      ([, child]) => !child.version.startsWith('link:'),
    );
    resolved[id] = {
      package_url: id,
      relationship,
      scope,
      dependencies: children.map(([childName, child]) => purl(childName, child.version)),
    };
    for (const [childName, child] of children) add(childName, child, 'indirect', scope);
  };
  for (const [name, node] of Object.entries(project.dependencies ?? {})) {
    add(name, node, 'direct', 'runtime');
  }
  for (const [name, node] of Object.entries(project.devDependencies ?? {})) {
    add(name, node, 'direct', 'development');
  }
  return {
    name: project.name ?? 'tribo',
    file: { source_location: 'pnpm-lock.yaml' },
    resolved,
  };
}

/** The Actions environment the submission names: where the graph belongs and which run sent it. */
function actionsEnv(env: NodeJS.ProcessEnv) {
  const read = (key: string) => env[key] ?? '';
  return {
    sha: read('GITHUB_SHA'),
    ref: read('GITHUB_REF'),
    workflow: read('GITHUB_WORKFLOW'),
    job: read('GITHUB_JOB'),
    runId: read('GITHUB_RUN_ID'),
    repoUrl: `${read('GITHUB_SERVER_URL')}/${read('GITHUB_REPOSITORY')}`,
  };
}

function snapshot(projects: Project[], env: NodeJS.ProcessEnv) {
  const run = actionsEnv(env);
  return {
    version: 0,
    sha: run.sha,
    ref: run.ref,
    job: { correlator: `${run.workflow}_${run.job}`, id: run.runId },
    detector: {
      name: 'tribo-pnpm-lockfile',
      version: '1.0.0',
      url: run.repoUrl,
    },
    scanned: new Date().toISOString(),
    manifests: Object.fromEntries(
      projects.map((project) => {
        const manifest = manifestOf(project);
        return [manifest.name, manifest];
      }),
    ),
  };
}

const { stdout } = await promisify(execFile)(
  'pnpm',
  ['ls', '--recursive', '--json', '--depth', 'Infinity', '--lockfile-only'],
  { maxBuffer: 256 * 1024 * 1024 },
);
const projects = JSON.parse(stdout) as Project[];
const body = snapshot(projects, process.env);
const packages = new Set(Object.values(body.manifests).flatMap((m) => Object.keys(m.resolved)));

if (process.argv.includes('--dry-run')) {
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
} else {
  const { GITHUB_API_URL = '', GITHUB_REPOSITORY = '', GITHUB_TOKEN = '' } = process.env;
  const response = await fetch(
    `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/dependency-graph/snapshots`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${GITHUB_TOKEN}`,
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    process.stderr.write(`dependency submission refused: ${String(response.status)} ${text}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `submitted ${String(packages.size)} packages from ${String(projects.length)} projects: ${text}\n`,
  );
}
