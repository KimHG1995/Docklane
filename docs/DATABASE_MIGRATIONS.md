# Database Migrations

Docklane API schema changes are owned by a single ordered migration runner in `apps/api/src/db/migrations.ts`.

## Startup behavior

`Database.onModuleInit()` acquires a dedicated MySQL connection, normalizes the session timezone to UTC, acquires the advisory lock `docklane:schema-migrations`, and applies pending migrations before repositories begin normal data access.

Migration metadata is stored in:

```text
schema_migrations
- version
- name
- checksum
- applied_at
```

Rules:

- versions start at 1 and must remain contiguous
- migrations are forward-only
- applied migration name/checksum must match the running build
- a database with a newer migration version than the running build is rejected at startup
- only one API instance may apply migrations at a time through MySQL `GET_LOCK`
- migration SQL must be idempotent because MySQL DDL can implicitly commit
- a failed migration is not inserted into `schema_migrations`; the next startup retries the same idempotent migration

## Baseline migration

Migration v1 is `baseline-current-schema`.

It converges both a fresh database and a pre-migration Docklane database to the baseline schema:

- `audit_events`
- `applications`
- `deployment_targets`
- `releases`
- `operations`
- `node_operations`
- `deployments`
- `bootstrap_tokens`

Historical additive columns and indexes that were previously created from repository `onModuleInit()` hooks are now handled by the migration runner.

Repositories no longer own `CREATE TABLE` or `ALTER TABLE` behavior.

## Cluster registration migration

Migration v3, `cluster-registration`, adds `cluster_registrations` with unique logical and actual Swarm identities. It does not change v1/v2, backfill registrations or rebind existing deployment targets and operations. ADMIN registration and audit behavior are described in [Cluster registration](CLUSTER_REGISTRATION.md).

After v3 is applied, a binary that knows only v2 is rejected by the existing future-schema check. Prepare database backup and binary/schema rollback plans before upgrading; deleting migration metadata is not a supported downgrade.

## Adding a migration

Append a new migration to `DATABASE_MIGRATIONS`.

Requirements:

1. use the next contiguous integer version
2. use a stable descriptive name
3. change the stable signature whenever the migration definition changes before release
4. make the migration safe to rerun after a partial MySQL DDL failure
5. do not edit metadata for an already deployed migration

The migration checksum is derived from version, name, and stable signature. Editing an applied migration causes startup to fail instead of silently accepting schema drift.

## Validation

Normal API validation includes unit tests for:

- one-time application and replay
- checksum drift rejection
- future schema rejection
- advisory lock acquisition failure
- migration catalog ordering

Database migration changes additionally run `tests/database-migration-poc.sh` against MySQL 8.4.

The PoC verifies:

- fresh schema creation
- second-run idempotency
- migration history persistence
- required current tables and additive columns
- startup rejection when the database contains a future migration version
- concurrent cluster registration, one audit, replay and identity uniqueness
- registration rollback when a server-side trigger rejects its audit insert
