# 0010. The dependency graph is submitted from CI

- Date: 22 Oct 2026
- Status: accepted
- Source: CI health package (branch `chore/ci-health`)

## Context

After #54 pinned vite 8.3.3 in `apps/web/package.json` and `pnpm-lock.yaml`, GitHub's SBOM
(`gh api repos/eriscs01/tribo/dependency-graph/sbom`) still listed vite 8.3.2 and the three
Dependabot alerts for vite stayed open, although Dependabot's own job reported vite no longer
vulnerable. The SBOM held 67 packages, the direct dependencies of the manifests only; the
lockfile resolves about a thousand. GitHub's parser reads `package.json` but not this
lockfile (pnpm 12: `lockfileVersion: '9.0'` with `packageManagerDependencies` and a second YAML
document), the same gap recorded in `docs/follow-ups.md` for Dependabot's lockfile updates. A
stale graph means a future vulnerable transitive dependency raises no alert.

Alternatives: pin the graph to the manifests and accept direct dependencies only (what happens
today, and stale); wait for GitHub to support the lockfile (no date); submit the graph ourselves.

## Decision

CI job "Dependency graph" runs on every push to `main`, after a frozen install, and runs
`packages/tools/src/scripts/submit-dependency-snapshot.ts`. The script reads the resolved tree from
`pnpm ls --recursive --json --depth Infinity --lockfile-only` and submits it to GitHub's
dependency submission API (`POST /repos/{repo}/dependency-graph/snapshots`) as one manifest per
workspace project, with `pkg:npm` package URLs, direct or indirect, runtime or development.

- No third-party action: a script of about a hundred lines with no dependencies, so there is
  nothing more to pin and review than the checkout and setup actions the other jobs use.
- Least privilege: the job's `permissions` is `contents: write` only, which the API requires.
- Not a required check and independent of the test jobs, so a red test run does not freeze the
  graph and a failed submission does not block a merge. The step fails loudly (HTTP status and
  body) so a broken submission shows in the run.
- `--dry-run` prints the snapshot instead of sending it.

## Consequences

The graph and Dependabot alerts follow the lockfile within minutes of a merge to main. The
script depends on `pnpm ls --lockfile-only` output; if pnpm changes it, the job fails. When
GitHub reads the lockfile itself, delete the job and the script.
