// Which pull requests CI can take the quick path for (decision 0013): the ones that touch
// documentation only. The rule fails towards running everything: a path is documentation only
// when a pattern below says so, and nothing else is.
const DOCS = [
  // Prose under docs/, except docs/backlog.md, which backlog.test.ts compares with the registry.
  /^docs\/(?!backlog\.md$)[\w./-]+\.md$/,
  /^(CLAUDE|CONTRIBUTING|SECURITY)\.md$/,
  /^LICENSE$/,
  /^packages\/[\w-]+\/README\.md$/,
  /^\.claude\/skills\/[\w./-]+\.md$/,
];

export function isDocsPath(path: string): boolean {
  return !path.split('/').includes('..') && DOCS.some((pattern) => pattern.test(path));
}

/** An empty change touches no code; one path outside the documentation is enough to run all. */
export function affectsCode(paths: readonly string[]): boolean {
  return paths.some((path) => !isDocsPath(path));
}
