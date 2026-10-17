# @tribo/testkit

Test infrastructure for the `integration` and `leak` Vitest projects.

- `global-setup.ts` starts one `postgres:18` container per run with the real bootstrap
  (`10-tribo-init.sh` → `0000_bootstrap.sql`, role passwords from `/run/secrets`), then applies
  the migrations as `tribo_owner`. The migrated `tribo` database is the template.
- `createTestDatabase()` clones a fresh database from it (well under a second) and connects as
  `tribo_app`. Call `destroy()` when done.
- Factories (`createUser`, `createPlaceholder`, `createTrip`, `addMember`, `createItem`,
  `softDelete`) insert rows directly. They skip the services, so no audit rows: use them to set
  up a world, never to test a write path.
- `visibilityProperty()` is the leak harness: fast-check worlds checked against an independent
  oracle for `tribo.item_visible` and `tribo.person_visible`. The seed is fixed by default
  (`TRIBO_LEAK_SEED`, `TRIBO_LEAK_RUNS` override it); the nightly CI job sets a random seed.

On macOS with Colima, Testcontainers needs:

```sh
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```
