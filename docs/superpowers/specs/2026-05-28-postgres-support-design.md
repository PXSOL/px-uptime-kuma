# PostgreSQL support for px-uptime-kuma

Date: 2026-05-28
Status: Draft, pending implementation plan

## 1. Goal

Add PostgreSQL as a first-class storage backend for the Uptime Kuma fork, alongside the existing SQLite, MariaDB/MySQL, and Embedded MariaDB options. Provide a path for users running on SQLite to migrate their existing `kuma.db` to a configured PostgreSQL instance from the running app, without losing data, and to switch the active backend after a successful migration.

ClickHouse was considered and rejected: the schema is OLTP-relational with frequent UPDATEs and foreign keys, Knex has no production-grade ClickHouse dialect, and current heartbeat volumes do not justify columnar storage. If analytics scale becomes a real need later, the right move is "Postgres for everything + ClickHouse only for heartbeats/stats" as a separate project.

## 2. Non-goals

- Removing or deprecating SQLite or MariaDB backends.
- Supporting Postgres as a *monitor* target beyond what already exists in `server/monitor-types/postgres.js`. That feature is unrelated.
- Multi-tenant or multi-schema runtime switching. Schema is chosen once at setup.
- Online (zero-downtime) migration. The migration restarts the server.

## 3. Scope

### 3.1 Backend

1. **`server/database.js`** — add `else if (dbConfig.type === "postgres")` branch parallel to existing `sqlite` / `mariadb` / `embedded-mariadb` branches:
   - Knex client `pg`.
   - If `dbConfig.url` is present, pass it directly to `connection`.
   - Else build `{ host, port, user, password, database }` from individual fields.
   - SSL: object `{ rejectUnauthorized, ca }` derived from `sslMode` (`disable` | `require` | `verify-ca` | `verify-full`) and an optional pasted CA cert.
   - Optional schema via `searchPath: [schema, "public"]`.
   - Pool: Knex defaults, no extra knobs in v1.
2. **`Database.acceptedSqlClient`** and `noSqliteClient` arrays — register `"postgres"`.
3. **`server/setup-database.js`** — extend env var reading to support:
   - `UPTIME_KUMA_DB_TYPE=postgres`
   - `UPTIME_KUMA_DB_URL` (takes precedence over fields)
   - `UPTIME_KUMA_DB_HOSTNAME`, `_PORT`, `_DATABASE`, `_USERNAME`, `_PASSWORD`
   - `UPTIME_KUMA_DB_SSL` (boolean), `UPTIME_KUMA_DB_SSL_MODE`, `UPTIME_KUMA_DB_SSL_CA`
   - All with `_FILE` variants for Docker secrets (same pattern as existing MariaDB code).
4. **`db-config.json`** — extend persisted shape with `type: "postgres"`, optional `url`, `sslMode`, `ca`, `schema`. Backward-compatible: existing configs untouched.
5. **Migrations audit** (`db/knex_migrations/`) — full pass through every migration file:
   - Replace SQLite-isms with portable Knex schema builder calls.
   - Verify column types: `datetime` → `timestamp` (portable), large text, blob/binary, integer auto-increment.
   - Identify any raw SQL (`.raw("…")`) and either make it dialect-agnostic or fork it per dialect.
   - Verify defaults (`CURRENT_TIMESTAMP` etc.) work on PG.
   - Verify `onDelete` / `onUpdate` cascade behavior.
6. **`server/migrate-to-postgres.js`** — new module exposing `migrate({ source: sqlitePath, target: pgConfig, onProgress })`:
   - Open SQLite read-only.
   - Open PG, run Knex migrations to create schema clean.
   - Copy tables in topological order of foreign keys, batched (~500 rows/batch).
   - Wrap each table in a transaction.
   - After all copies, reset PG sequences (`SELECT setval(pg_get_serial_sequence(...))`) so subsequent inserts don't collide.
   - Emit progress events `{ phase, table, rowsCopied, rowsTotal }`.
   - Idempotent: target must be empty (fresh schema) at start; abort otherwise.
7. **Socket handlers** — new file `server/socket-handlers/database-socket-handler.js` (admin-only):
   - `getDbStatus()` → `{ type, host, sizeBytes, schemaVersion }`.
   - `testDbConnection(config)` → opens connection, `SELECT 1`, closes, returns `{ ok, error? }`. Used by both setup and runtime UI.
   - `migrateToPostgres(config)` → runs the migrator, streams progress via `dbMigrationProgress` event, on success writes new `db-config.json` and triggers graceful restart.
8. **CLI** — `extra/migrate-to-postgres.js` and `package.json` script `"migrate-to-postgres"`, reusing the same module. Accepts target config from env or `--url` flag.

### 3.2 Frontend

1. **`src/pages/SetupDatabase.vue`** — add a "PostgreSQL" radio next to existing options:
   - Toggle "Use connection string". When on, shows a single textarea for `postgres://...`. When off, shows host / port / database / username / password fields (same visual pattern as MariaDB block).
   - SSL block (same pattern as MariaDB): switch `enableSSL`, select `sslMode`, optional CA cert textarea.
   - "Test connection" button placed before "Next" — calls the socket handler and shows a toast.
   - Submit posts the config to the existing setup endpoint, which writes `db-config.json` and starts the main server.
   - i18n keys: `setupDatabasePostgres`, `postgresUseConnectionString`, `postgresCaCertificateLabel`, `postgresCaCertificateHelptext`, `postgresSslMode`.
2. **`src/components/settings/Database.vue`** — new runtime panel:
   - Shows active DB type, host, schema version, approximate size.
   - "Migrate to PostgreSQL" section visible only when current type is `sqlite`:
     - Same input shape as setup page (connection string OR fields, plus SSL).
     - "Test connection" button.
     - "Start migration" button → confirmation modal listing what will happen (server restart, point of no return for current SQLite once we switch config).
     - Live progress UI bound to `dbMigrationProgress`.
     - On success: notice that the server is restarting and will come back on Postgres.
3. **`src/router.js`** — add route `/settings/database` pointing at the new panel.
4. **`src/pages/Settings.vue`** — add "Database" entry in the sidebar nav.
5. **`src/components/settings/MonitorHistory.vue`** — audit the existing `$root.info.dbType === 'sqlite'` branch and any implicit "not sqlite means mariadb" assumptions. Add a `postgres` branch where behavior diverges.
6. **`info` payload** (sent from server, consumed via `$root.info`) — include current `dbType` so the UI updates after a migration without a hard refresh.

## 4. Migration flow (step by step)

The runtime SQLite→Postgres migration is the most user-facing flow. Concrete sequence:

1. User opens Settings → Database while running on SQLite.
2. User fills target PG config (connection string or fields + SSL).
3. User clicks "Test connection". Server opens a temporary PG connection, runs `SELECT version()`, closes. UI shows ok/error.
4. User clicks "Start migration". Confirmation modal explains: target DB must be empty, server will restart on success, current `kuma.db` is left on disk untouched as a backup.
5. Server: validates target is empty (no `monitor` table or no rows in any user table — exact check defined in the plan). Aborts with clear error if not.
6. Server: runs Knex migrations against PG to create fresh schema.
7. Server: copies tables in FK-topological order (e.g. `user` → `monitor_group` → `tag` → `monitor` → `heartbeat` → …). Emits progress per table.
8. Server: resets PG sequences from max(id) per table.
9. Server: writes new `db-config.json` with `type: "postgres"` and the target config.
10. Server: emits `dbMigrationDone`, then triggers graceful shutdown.
11. Process supervisor (Docker / PM2 / systemd) restarts the server, which now boots on PG. SQLite file remains in the data dir as `kuma.db` (un-renamed, just unused) for manual rollback.

Rollback: stop server, edit `db-config.json` back to `{ "type": "sqlite" }`, restart. Heartbeats that happened after the migration on PG are lost in that direction, which is acceptable for a manual rollback.

## 5. Testing

1. **Backend unit tests** (`test/backend-test/`):
   - DB connection branch selects the right Knex client based on `type`.
   - SSL config object is built correctly from each `sslMode`.
   - Connection-string mode and fields mode are mutually exclusive in env parsing.
2. **Integration tests** using `@testcontainers/postgresql` (already a devDependency):
   - Boot a PG container, run Knex migrations, assert schema matches.
   - Run migrator with a small synthetic SQLite source (~5 tables, ~100 rows), assert row counts and sequence values on the PG side.
   - Run migrator twice; second run must abort (non-empty target).
3. **Migrations portability**: a single test that boots both SQLite and PG and runs the full migration set against each, asserting both succeed and produce the expected tables/columns.
4. **E2E (Playwright)**: setup flow against a PG container — choose Postgres, fill fields, complete setup, log in, create a monitor, see a heartbeat persisted.
5. **Manual checklist** for the migration flow: documented in the plan, including verifying that monitors, heartbeats, notifications, and incidents survive the migration.

## 6. Risks

- **Migration portability is the real cost.** SQLite is permissive; PG is strict. Expect breakage in: NULL constraints, default values, boolean storage, blob/binary columns, raw SQL strings, identifier casing. Each migration must be tested on PG before merging.
- **Heartbeat table is large.** Copy must be batched. A naive `SELECT * → INSERT INTO` will OOM. Plan uses batched cursor reads.
- **Sequence drift.** If sequences aren't reset after the copy, the first insert on PG collides with copied IDs. Mitigated by explicit `setval()` step at the end.
- **Settings panel is sensitive.** A wrong PG config can write a `db-config.json` that makes the app unbootable. Mitigation: only persist the new config *after* a successful test connection and a successful migration. Keep `kuma.db` untouched as physical rollback path.

## 7. Out of scope (parking lot)

- ClickHouse as a heartbeat/stats sink.
- Multi-tenant schemas.
- Online migration without restart.
- Postgres → SQLite reverse migration (rare need; can be added later).
- Pool tuning UI.
