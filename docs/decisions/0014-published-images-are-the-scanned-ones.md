# 0014. Published images are the scanned ones

- Date: 23 Oct 2026
- Status: accepted
- Source: v0.3.0 release review (orchestrator), pull request `ci/publish-scanned-images`

## Context

Job 6 builds both images, Trivy scans them, and End to end runs them from the same artifacts
(decision 0013). Publish, on a release tag, built both images again from source with the tag
as the app's release version, reusing only the layer cache. The images on GHCR were therefore
never the ones Trivy scanned or the walking skeleton tested: the app's release layer always
differed, and any layer the cache missed was rebuilt unscanned. Signing or attesting the
rebuilt images would not close that gap; pushing the scanned artifacts does.

## Decision

On a `v*` tag, job 6 builds the app with the tag as `TRIBO_RELEASE_VERSION` (everywhere else
`ci`); the local image tag stays `:ci`, so End to end runs unchanged and checks that the app
names the tag. Publish downloads the two scanned artifacts, loads them, retags them with the
release tag and pushes them; it never builds. Job 6 writes each scanned image's id to the run
summary, and Publish writes the id and the pushed digest of each image it pushes, so the two
can be compared in one run.

## Consequences

What reaches GHCR is byte for byte what Trivy passed and End to end ran. Publish needs no
checkout, Buildx or layer cache. The image artifacts are kept one day, so a Publish that fails
is re-run within a day, or the whole run is re-run, which rebuilds and rescans. Images are
pushed with plain `docker push`, as single linux/amd64 manifests without Buildx's provenance
attestation.
