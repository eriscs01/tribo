# @tribo/db

Migrations, the migration runner and the generated Kysely types.

- `migrations/0000_bootstrap.sql` runs once per instance as superuser (roles only). In Docker,
  `bootstrap/10-tribo-init.sh` runs it from `/docker-entrypoint-initdb.d`, sets both role
  passwords from `/run/secrets/db_owner_password` and `db_app_password`, and creates the
  `tribo` database. Mount `0000_bootstrap.sql` at `/docker-entrypoint-initdb.d/tribo/`.
- Numbered files from `0001` on are applied by `migrate()` as `tribo_owner`, each in one
  transaction with its `public.schema_migrations` row, under a session advisory lock. Files
  carry no `BEGIN`/`COMMIT`. The runner refuses to start if an applied file changed: never
  edit a merged migration, add a new numbered file.
- `DATABASE_URL=postgres://tribo_owner:…@host/tribo pnpm --filter @tribo/db migrate` applies
  pending migrations from the command line.
- After adding a migration, regenerate and commit the types:
  `DATABASE_URL=… pnpm --filter @tribo/db codegen` (writes `src/generated/db.ts`).
