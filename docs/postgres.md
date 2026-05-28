# PostgreSQL backend

This fork supports PostgreSQL as a first-class storage backend alongside
SQLite, MariaDB/MySQL, and the embedded MariaDB.

## When to use it

- You already operate Postgres (managed RDS / Supabase / Neon / self-hosted).
- You want a single Postgres for multiple stateful services.
- You expect heartbeat / monitor volume that strains SQLite under WAL contention.

If none of these apply, the default SQLite backend is fine.

## Deploy from scratch with env vars

### Connection string

```bash
UPTIME_KUMA_DB_TYPE=postgres \
UPTIME_KUMA_DB_URL=postgres://kuma:secret@db.internal:5432/kuma?sslmode=require \
npm start
```

### Individual fields

```bash
UPTIME_KUMA_DB_TYPE=postgres \
UPTIME_KUMA_DB_HOSTNAME=db.internal \
UPTIME_KUMA_DB_PORT=5432 \
UPTIME_KUMA_DB_NAME=kuma \
UPTIME_KUMA_DB_USERNAME=kuma \
UPTIME_KUMA_DB_PASSWORD=secret \
UPTIME_KUMA_DB_SSL_MODE=require \
npm start
```

On first boot the server creates the base schema in the target database
(via `db/knex_init_db.js`) and runs all incremental Knex migrations.

### Docker secrets

Every `UPTIME_KUMA_DB_*` variable also accepts a `_FILE` suffix that
points to a file on disk; the contents are read once at startup.

```yaml
environment:
  UPTIME_KUMA_DB_TYPE: postgres
  UPTIME_KUMA_DB_HOSTNAME: db
  UPTIME_KUMA_DB_NAME: kuma
  UPTIME_KUMA_DB_USERNAME: kuma
  UPTIME_KUMA_DB_PASSWORD_FILE: /run/secrets/pg_password
  UPTIME_KUMA_DB_SSL_MODE: verify-full
  UPTIME_KUMA_DB_SSL_CA_FILE: /run/secrets/pg_ca
```

## SSL / TLS

The `UPTIME_KUMA_DB_SSL_MODE` variable mirrors the libpq sslmode contract:

| Mode | Behavior |
|------|----------|
| `disable` | Plain TCP. Local development only. |
| `require` | TLS, no certificate verification. Default if `UPTIME_KUMA_DB_SSL=true`. |
| `verify-ca` | TLS + the server certificate must chain to a trusted CA. |
| `verify-full` | TLS + chain + hostname must match. Recommended for production. |

For `verify-ca` and `verify-full`, supply the CA PEM via
`UPTIME_KUMA_DB_SSL_CA` (or its `_FILE` variant).

## Migrating an existing SQLite install

Two paths, same migrator behind the scenes.

### From the UI

1. Make sure the target Postgres database is **empty** (no tables).
2. In the running app go to **Settings → Database**.
3. Fill in the connection details, click **Test connection**.
4. Click **Begin migration**. The page streams progress per phase
   (`schema → copy → sequences → done`) with per-table row counts.
5. On success the server writes a new `db-config.json` and exits. The
   process supervisor (Docker / PM2 / systemd) restarts it on the new
   backend.
6. The original `kuma.db` file is **left on disk** so you can roll back
   by editing `db-config.json` and restarting.

### From the CLI

```bash
npm run migrate-to-postgres -- \
  --sqlite /path/to/kuma.db \
  --url postgres://kuma:secret@db.internal:5432/kuma
```

Or with discrete fields:

```bash
npm run migrate-to-postgres -- \
  --host db.internal --port 5432 --db kuma --user kuma --password secret
```

The target must be empty; the script aborts if any user tables are
present, to avoid silent merges.

## Rollback

If something goes wrong after migration:

1. Stop the server.
2. Edit `<data>/db-config.json` and set `{ "type": "sqlite" }`.
3. Restart.

The original `kuma.db` is still there. Anything written to Postgres
after the migration is lost in that direction — manual rollback assumes
no production traffic landed on the new backend.

## Limits

- Online (no-restart) migration is not supported.
- Reverse migration (Postgres → SQLite) is not implemented.
- The migrator copies in dependency order discovered from
  `sqlite_master`. If you have hand-crafted tables outside the standard
  Kuma schema they may not be copied.
