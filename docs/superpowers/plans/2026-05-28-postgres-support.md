# PostgreSQL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PostgreSQL as a first-class storage backend alongside SQLite/MariaDB, with a setup-page option, env var configuration, a runtime "Migrate to Postgres" flow in Settings, and a CLI fallback that reuses the same migration code.

**Architecture:** Extend the existing Knex-based abstraction in `server/database.js` with a `postgres` branch. Audit and normalize the ~50 Knex migrations in `db/knex_migrations/` for Postgres portability. Build a single `server/migrate-to-postgres.js` module used by both a socket handler (UI button in Settings) and a CLI script. Add a `PostgreSQL` option to `src/pages/SetupDatabase.vue` and a new `src/components/settings/Database.vue` runtime panel.

**Tech Stack:** Node.js, Knex 3 (with `pg` driver, already a dependency), RedBean (`redbean-node`), Vue 3, Socket.IO, `@testcontainers/postgresql` (already a devDependency), Playwright.

**Reference spec:** `docs/superpowers/specs/2026-05-28-postgres-support-design.md`

---

## Phase 0: Conventions

- Branch from `master` into `feat/postgres-support`. All commits land there until the phase is complete.
- Test discipline: every backend task is TDD where reasonable. Migration-audit tasks are integration-test driven (boot a real PG container, run migrations, assert).
- Commits: one per task. Conventional commit prefixes (`feat`, `fix`, `test`, `refactor`, `chore`).
- All new env vars added must also be documented in the comment block at the top of `server/setup-database.js` (which lists supported env vars today).
- For UI strings, add new keys to `src/lang/en.json` only in this plan. Other locales are out of scope here.

---

## Phase 1: Backend — `postgres` connection branch

### Task 1.1: Register `postgres` in accepted client lists

**Files:**
- Modify: `server/database.js` (search for `acceptedSqlClient` and `noSqliteClient`)

- [ ] **Step 1: Read the current declarations**

Run: `grep -n "acceptedSqlClient\|noSqliteClient" server/database.js`

- [ ] **Step 2: Add `"postgres"` to both arrays**

Example edit:

```js
static noSqliteClient = ["mariadb", "embedded-mariadb", "postgres"];
static acceptedSqlClient = ["sqlite", "mariadb", "embedded-mariadb", "postgres"];
```

(Exact names depend on what is found in step 1; keep `"postgres"` consistent — never `"postgresql"` or `"pg"` in dbConfig types.)

- [ ] **Step 3: Commit**

```bash
git add server/database.js
git commit -m "feat(db): register postgres as accepted client type"
```

### Task 1.2: Write the failing branch-selection unit test

**Files:**
- Create: `test/backend-test/test-database-config.js`

- [ ] **Step 1: Add the test file**

```js
const test = require("node:test");
const assert = require("node:assert");
const Database = require("../../server/database");

test("postgres is an accepted client", () => {
    assert.ok(Database.acceptedSqlClient.includes("postgres"));
    assert.ok(Database.noSqliteClient.includes("postgres"));
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test-backend-22 -- --test-name-pattern="postgres is an accepted client"`
Expected: PASS (task 1.1 already made the arrays correct).

- [ ] **Step 3: Commit**

```bash
git add test/backend-test/test-database-config.js
git commit -m "test(db): assert postgres is an accepted client type"
```

### Task 1.3: Add `postgres` branch to `Database.connect()`

**Files:**
- Modify: `server/database.js` (insert new branch after the `embedded-mariadb` branch around line 408, before the `else { throw }`)

- [ ] **Step 1: Add the branch**

```js
} else if (dbConfig.type === "postgres") {
    let connection;
    if (dbConfig.url) {
        connection = dbConfig.url;
    } else {
        connection = {
            host: dbConfig.hostname,
            port: dbConfig.port ? parseInt(dbConfig.port) : 5432,
            user: dbConfig.username,
            password: dbConfig.password,
            database: dbConfig.dbName,
        };
    }

    const sslMode = dbConfig.sslMode || (dbConfig.ssl ? "require" : "disable");
    if (sslMode !== "disable") {
        const ssl = {
            rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full",
        };
        if (dbConfig.ca && dbConfig.ca.trim() !== "") {
            ssl.ca = dbConfig.ca;
        }
        if (typeof connection === "string") {
            // For URL connections, pass ssl via the additional pool config
            config = {
                client: "pg",
                connection: { connectionString: connection, ssl },
            };
        } else {
            connection.ssl = ssl;
            config = { client: "pg", connection };
        }
    } else {
        config = {
            client: "pg",
            connection: typeof connection === "string"
                ? { connectionString: connection }
                : connection,
        };
    }

    config.pool = {
        min: 0,
        max: parsedMaxPoolConnections,
        idleTimeoutMillis: 30000,
    };

    if (dbConfig.schema && dbConfig.schema.trim() !== "") {
        config.searchPath = [dbConfig.schema, "public"];
    }
}
```

- [ ] **Step 2: Run the existing test suite**

Run: `npm run test-backend-22`
Expected: no regressions (no PG-specific tests yet).

- [ ] **Step 3: Commit**

```bash
git add server/database.js
git commit -m "feat(db): add postgres branch to Database.connect"
```

### Task 1.4: Write a focused config-building test

**Files:**
- Modify: `test/backend-test/test-database-config.js`

This task validates the config shape we hand to Knex without actually opening a connection. Extract the config-building into a static helper to make it testable. If you do not want to refactor, skip the helper and replace the test below with a smoke test using a stub `dbConfig` and reading `Database.dbConfig` after a mocked `connect`. The helper is preferred.

- [ ] **Step 1: Extract `Database.buildPostgresConfig(dbConfig, maxPool)` from the branch above**

Refactor the body of the new `else if (dbConfig.type === "postgres")` branch into a static method on `Database`:

```js
static buildPostgresConfig(dbConfig, maxPool) {
    // ... move the config-building logic here, return { config }
}
```

Then call it from `connect()`:

```js
} else if (dbConfig.type === "postgres") {
    config = Database.buildPostgresConfig(dbConfig, parsedMaxPoolConnections);
}
```

- [ ] **Step 2: Add the test**

```js
test("buildPostgresConfig: connection string + sslMode=require", () => {
    const cfg = Database.buildPostgresConfig({
        type: "postgres",
        url: "postgres://u:p@h:5432/d",
        sslMode: "require",
    }, 10);
    assert.equal(cfg.client, "pg");
    assert.equal(cfg.connection.connectionString, "postgres://u:p@h:5432/d");
    assert.equal(cfg.connection.ssl.rejectUnauthorized, false);
});

test("buildPostgresConfig: fields + verify-full + ca", () => {
    const cfg = Database.buildPostgresConfig({
        type: "postgres",
        hostname: "h",
        port: "5433",
        username: "u",
        password: "p",
        dbName: "kuma",
        sslMode: "verify-full",
        ca: "-----BEGIN CERTIFICATE-----\nfoo\n-----END CERTIFICATE-----",
    }, 10);
    assert.equal(cfg.connection.host, "h");
    assert.equal(cfg.connection.port, 5433);
    assert.equal(cfg.connection.ssl.rejectUnauthorized, true);
    assert.ok(cfg.connection.ssl.ca.includes("BEGIN CERTIFICATE"));
});

test("buildPostgresConfig: searchPath when schema is set", () => {
    const cfg = Database.buildPostgresConfig({
        type: "postgres",
        url: "postgres://u:p@h/d",
        schema: "kuma",
    }, 10);
    assert.deepEqual(cfg.searchPath, ["kuma", "public"]);
});
```

- [ ] **Step 3: Run**

Run: `npm run test-backend-22 -- --test-name-pattern="buildPostgresConfig"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/database.js test/backend-test/test-database-config.js
git commit -m "test(db): cover buildPostgresConfig variants"
```

---

## Phase 2: Env-driven configuration

### Task 2.1: Read the existing env-var handling

**Files:**
- Read-only: `server/setup-database.js` (the `getEnvOrFile` helper and the block that handles `UPTIME_KUMA_DB_TYPE`)

- [ ] **Step 1: Locate the env block**

Run: `grep -n "UPTIME_KUMA_DB_" server/setup-database.js`

Note the structure: each env var is read via `getEnvOrFile(name)` and assembled into a `dbConfig` object that is then passed to `Database.writeDBConfig(dbConfig)`.

### Task 2.2: Add postgres env var handling

**Files:**
- Modify: `server/setup-database.js`

- [ ] **Step 1: Extend the env-driven config block**

Inside the existing `if (process.env.UPTIME_KUMA_DB_TYPE)` branch, add support for `postgres`:

```js
if (process.env.UPTIME_KUMA_DB_TYPE === "postgres") {
    const url = getEnvOrFile("UPTIME_KUMA_DB_URL");
    if (url) {
        dbConfig = {
            type: "postgres",
            url,
            sslMode: process.env.UPTIME_KUMA_DB_SSL_MODE || undefined,
            ca: getEnvOrFile("UPTIME_KUMA_DB_SSL_CA") || undefined,
            schema: process.env.UPTIME_KUMA_DB_SCHEMA || undefined,
        };
    } else {
        dbConfig = {
            type: "postgres",
            hostname: getEnvOrFile("UPTIME_KUMA_DB_HOSTNAME"),
            port: process.env.UPTIME_KUMA_DB_PORT || "5432",
            dbName: getEnvOrFile("UPTIME_KUMA_DB_DATABASE") || "kuma",
            username: getEnvOrFile("UPTIME_KUMA_DB_USERNAME"),
            password: getEnvOrFile("UPTIME_KUMA_DB_PASSWORD"),
            sslMode: process.env.UPTIME_KUMA_DB_SSL_MODE || undefined,
            ca: getEnvOrFile("UPTIME_KUMA_DB_SSL_CA") || undefined,
            schema: process.env.UPTIME_KUMA_DB_SCHEMA || undefined,
        };
    }
    Database.writeDBConfig(dbConfig);
}
```

Place this alongside the existing MariaDB env handling (do not break the MariaDB path).

- [ ] **Step 2: Manual smoke**

Set env and start in dev:

```bash
UPTIME_KUMA_DB_TYPE=postgres UPTIME_KUMA_DB_URL=postgres://localhost/kuma npm run start-server-dev
```

Expected: server attempts to connect to PG. If PG isn't running it should fail loudly with a `pg` error, not a "Unknown Database type" error.

- [ ] **Step 3: Commit**

```bash
git add server/setup-database.js
git commit -m "feat(db): support postgres via UPTIME_KUMA_DB_* env vars"
```

---

## Phase 3: Migration audit — Knex schema portability

This phase is the largest source of risk. Each migration in `db/knex_migrations/` may use SQLite-specific features that break on PG. We will run the full set against a real PG container and fix problems one by one.

### Task 3.1: Set up the migration-portability test

**Files:**
- Create: `test/backend-test/test-migrations-postgres.js`

- [ ] **Step 1: Write the test scaffold**

```js
const test = require("node:test");
const assert = require("node:assert");
const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const knex = require("knex");
const path = require("path");

test("all knex migrations run cleanly on postgres", { timeout: 5 * 60 * 1000 }, async (t) => {
    const container = await new PostgreSqlContainer().start();
    t.after(async () => container.stop());

    const k = knex({
        client: "pg",
        connection: {
            host: container.getHost(),
            port: container.getPort(),
            user: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
        },
    });
    t.after(async () => k.destroy());

    await k.migrate.latest({
        directory: path.join(__dirname, "../../db/knex_migrations"),
    });

    const tables = await k("information_schema.tables")
        .select("table_name")
        .where({ table_schema: "public" });
    const names = tables.map(r => r.table_name);

    assert.ok(names.includes("monitor"), "monitor table should exist");
    assert.ok(names.includes("heartbeat"), "heartbeat table should exist");
    assert.ok(names.includes("user"), "user table should exist");
});
```

- [ ] **Step 2: Run**

Run: `npm run test-backend-22 -- --test-name-pattern="all knex migrations run cleanly on postgres"`
Expected: FAIL (almost certainly — that is the point; the failure surfaces the first incompatible migration).

- [ ] **Step 3: Commit (with failing test)**

```bash
git add test/backend-test/test-migrations-postgres.js
git commit -m "test(migrations): add failing portability suite for postgres"
```

### Task 3.2: Fix migrations until the test passes

This is an iterative sub-loop. Do not estimate it as a single step — drive it from the test output.

- [ ] **Step 1: Run the test and read the error**

Run: `npm run test-backend-22 -- --test-name-pattern="all knex migrations run cleanly on postgres" 2>&1 | tail -60`

- [ ] **Step 2: For each migration that fails:**

Identify the file in `db/knex_migrations/`. Apply the smallest change that keeps SQLite + MariaDB behavior intact while working on PG. Common categories:

- **`datetime` columns** → keep `t.datetime("col")`. Knex maps to `TIMESTAMP` on PG. If a default is needed and was raw, use `t.datetime("col").defaultTo(k.fn.now())`.
- **`text` blobs vs `binary`** → `t.binary("col")` is portable; raw `BLOB` is not.
- **`.raw("ALTER TABLE ... ADD COLUMN ...")` with sqlite-only syntax** → replace with `knex.schema.alterTable(...)`; if multiple operations were chained in one `ALTER TABLE`, split them.
- **`integer().primary().autoIncrement()`** → `t.increments("id")` is portable. Replace where needed.
- **`onDelete("SET NULL")`** on columns declared `notNullable()` → drop one or the other; PG enforces both strictly while SQLite did not.
- **Case-sensitive identifiers** → if a migration referenced a table or column with mixed case (e.g. `"User"`), normalize to lowercase. Audit nearby model code too.
- **`if (knex.client.config.client === "sqlite3")` guards** → if existing code already branches, extend the branches to include `"pg"` instead of falling through to the mariadb path.

After each individual fix, re-run the test. Commit each fix as its own commit:

```bash
git add db/knex_migrations/<file>.js
git commit -m "fix(migrations): make <date>-<slug> portable to postgres"
```

- [ ] **Step 3: Final pass**

Run: `npm run test-backend-22 -- --test-name-pattern="all knex migrations run cleanly on postgres"`
Expected: PASS.

- [ ] **Step 4: Re-run the full backend suite to make sure SQLite/MariaDB did not regress**

Run: `npm run test-backend-22`
Expected: all existing tests still pass.

### Task 3.3: Verify schema parity

**Files:**
- Modify: `test/backend-test/test-migrations-postgres.js`

- [ ] **Step 1: Add a parity assertion using `information_schema`**

```js
test("postgres schema has the same tables as sqlite template", { timeout: 5 * 60 * 1000 }, async (t) => {
    // Boot a sqlite knex from the template
    const sqliteKnex = knex({
        client: "sqlite3",
        connection: { filename: path.join(__dirname, "../../db/template.db") },
        useNullAsDefault: true,
    });
    t.after(async () => sqliteKnex.destroy());

    const sqliteTables = (await sqliteKnex("sqlite_master")
        .select("name")
        .where({ type: "table" }))
        .map(r => r.name)
        .filter(n => !n.startsWith("sqlite_") && n !== "knex_migrations" && n !== "knex_migrations_lock");

    // Boot postgres container & run migrations (reuse logic from previous test)
    const container = await new PostgreSqlContainer().start();
    t.after(async () => container.stop());
    const pgKnex = knex({
        client: "pg",
        connection: {
            host: container.getHost(),
            port: container.getPort(),
            user: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
        },
    });
    t.after(async () => pgKnex.destroy());
    await pgKnex.migrate.latest({ directory: path.join(__dirname, "../../db/knex_migrations") });

    const pgTables = (await pgKnex("information_schema.tables")
        .select("table_name")
        .where({ table_schema: "public" }))
        .map(r => r.table_name)
        .filter(n => n !== "knex_migrations" && n !== "knex_migrations_lock");

    const missing = sqliteTables.filter(t => !pgTables.includes(t));
    assert.deepEqual(missing, [], `Tables missing on postgres: ${missing.join(", ")}`);
});
```

(Adjust template path if `db/template.db` is not the right name — `grep -n "templatePath" server/database.js`.)

- [ ] **Step 2: Run**

Run: `npm run test-backend-22 -- --test-name-pattern="postgres schema has the same tables"`
Expected: PASS. If it fails, drop back into Task 3.2 sub-loop.

- [ ] **Step 3: Commit**

```bash
git add test/backend-test/test-migrations-postgres.js
git commit -m "test(migrations): assert schema parity sqlite vs postgres"
```

---

## Phase 4: Migration module — `migrate-to-postgres.js`

### Task 4.1: Scaffold the module with a no-op signature

**Files:**
- Create: `server/migrate-to-postgres.js`

- [ ] **Step 1: Write the module skeleton**

```js
const knex = require("knex");
const path = require("path");
const { log } = require("../src/util");
const Database = require("./database");

/**
 * @param {object} opts
 * @param {string} opts.sqlitePath  Absolute path to the source kuma.db
 * @param {object} opts.target      dbConfig for postgres (same shape as db-config.json)
 * @param {(progress: { phase: string, table?: string, rowsCopied?: number, rowsTotal?: number }) => void} [opts.onProgress]
 * @returns {Promise<{ tables: number, rowsCopied: number }>}
 */
async function migrate({ sqlitePath, target, onProgress = () => {} }) {
    throw new Error("not implemented");
}

module.exports = { migrate };
```

- [ ] **Step 2: Commit**

```bash
git add server/migrate-to-postgres.js
git commit -m "feat(migrate): scaffold migrate-to-postgres module"
```

### Task 4.2: Write the failing integration test

**Files:**
- Create: `test/backend-test/test-migrate-to-postgres.js`

- [ ] **Step 1: Write a small fixture + the test**

```js
const test = require("node:test");
const assert = require("node:assert");
const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const knex = require("knex");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { migrate } = require("../../server/migrate-to-postgres");

test("migrate copies tables from sqlite to postgres", { timeout: 5 * 60 * 1000 }, async (t) => {
    // Build a tiny sqlite source by running migrations + inserting a row
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-mig-"));
    const sqlitePath = path.join(tmpDir, "kuma.db");
    const sqliteKnex = knex({
        client: "sqlite3",
        connection: { filename: sqlitePath },
        useNullAsDefault: true,
    });
    await sqliteKnex.migrate.latest({ directory: path.join(__dirname, "../../db/knex_migrations") });
    await sqliteKnex("user").insert({ username: "admin", password: "x", active: 1, timezone: "UTC", twofa_status: 0 });
    await sqliteKnex.destroy();

    const container = await new PostgreSqlContainer().start();
    t.after(async () => container.stop());

    const target = {
        type: "postgres",
        hostname: container.getHost(),
        port: String(container.getPort()),
        username: container.getUsername(),
        password: container.getPassword(),
        dbName: container.getDatabase(),
    };

    const events = [];
    await migrate({
        sqlitePath,
        target,
        onProgress: (p) => events.push(p),
    });

    const pgKnex = knex({
        client: "pg",
        connection: {
            host: container.getHost(),
            port: container.getPort(),
            user: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
        },
    });
    t.after(async () => pgKnex.destroy());

    const users = await pgKnex("user").select();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, "admin");

    assert.ok(events.some(e => e.phase === "schema"));
    assert.ok(events.some(e => e.phase === "copy" && e.table === "user"));
    assert.ok(events.some(e => e.phase === "sequences"));
});
```

- [ ] **Step 2: Run**

Run: `npm run test-backend-22 -- --test-name-pattern="migrate copies tables"`
Expected: FAIL (`not implemented`).

- [ ] **Step 3: Commit**

```bash
git add test/backend-test/test-migrate-to-postgres.js
git commit -m "test(migrate): failing integration test for sqlite→pg copy"
```

### Task 4.3: Implement the migrator

**Files:**
- Modify: `server/migrate-to-postgres.js`

- [ ] **Step 1: Implement schema + copy + sequences**

```js
const knex = require("knex");
const path = require("path");
const { log } = require("../src/util");

async function migrate({ sqlitePath, target, onProgress = () => {} }) {
    const sqlite = knex({
        client: "sqlite3",
        connection: { filename: sqlitePath },
        useNullAsDefault: true,
    });

    const pgConnection = target.url
        ? { connectionString: target.url }
        : {
            host: target.hostname,
            port: target.port ? parseInt(target.port) : 5432,
            user: target.username,
            password: target.password,
            database: target.dbName,
        };
    const pg = knex({ client: "pg", connection: pgConnection });

    try {
        // Guard: target must be empty
        const existing = await pg("information_schema.tables")
            .select("table_name")
            .where({ table_schema: "public" })
            .whereNotIn("table_name", ["knex_migrations", "knex_migrations_lock"]);
        if (existing.length > 0) {
            throw new Error(`Target postgres database is not empty (${existing.length} tables). Refusing to migrate.`);
        }

        onProgress({ phase: "schema" });
        await pg.migrate.latest({ directory: path.join(__dirname, "..", "db", "knex_migrations") });

        // Discover tables from sqlite, excluding knex internals
        const sqliteTables = (await sqlite("sqlite_master").select("name").where({ type: "table" }))
            .map(r => r.name)
            .filter(n => !n.startsWith("sqlite_") && n !== "knex_migrations" && n !== "knex_migrations_lock");

        // Order matters because of FKs. Use the order returned by sqlite_master,
        // which is creation order, which matches our migrations.
        let totalRows = 0;
        for (const table of sqliteTables) {
            const [{ count }] = await sqlite(table).count({ count: "*" });
            const rowsTotal = Number(count);
            onProgress({ phase: "copy", table, rowsCopied: 0, rowsTotal });

            if (rowsTotal === 0) continue;

            const batchSize = 500;
            let offset = 0;
            while (offset < rowsTotal) {
                const rows = await sqlite(table).select().limit(batchSize).offset(offset);
                if (rows.length === 0) break;
                await pg(table).insert(rows);
                offset += rows.length;
                onProgress({ phase: "copy", table, rowsCopied: offset, rowsTotal });
            }
            totalRows += rowsTotal;
        }

        // Reset sequences for any column with a pg sequence
        onProgress({ phase: "sequences" });
        const seqRows = await pg.raw(`
            SELECT
                t.relname AS table_name,
                a.attname AS column_name,
                pg_get_serial_sequence(quote_ident(t.relname), a.attname) AS seq
            FROM pg_class t
            JOIN pg_attribute a ON a.attrelid = t.oid
            WHERE t.relkind = 'r'
              AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
              AND pg_get_serial_sequence(quote_ident(t.relname), a.attname) IS NOT NULL
        `);
        for (const r of seqRows.rows) {
            await pg.raw(
                `SELECT setval(?, COALESCE((SELECT MAX(??) FROM ??), 1))`,
                [r.seq, r.column_name, r.table_name]
            );
        }

        onProgress({ phase: "done" });
        return { tables: sqliteTables.length, rowsCopied: totalRows };
    } finally {
        await sqlite.destroy();
        await pg.destroy();
    }
}

module.exports = { migrate };
```

- [ ] **Step 2: Run the test**

Run: `npm run test-backend-22 -- --test-name-pattern="migrate copies tables"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/migrate-to-postgres.js
git commit -m "feat(migrate): implement sqlite→postgres migrator"
```

### Task 4.4: Add the "target not empty" abort test

**Files:**
- Modify: `test/backend-test/test-migrate-to-postgres.js`

- [ ] **Step 1: Add the test**

```js
test("migrate aborts when target has tables", { timeout: 5 * 60 * 1000 }, async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-mig-"));
    const sqlitePath = path.join(tmpDir, "kuma.db");
    const sqliteKnex = knex({
        client: "sqlite3",
        connection: { filename: sqlitePath },
        useNullAsDefault: true,
    });
    await sqliteKnex.migrate.latest({ directory: path.join(__dirname, "../../db/knex_migrations") });
    await sqliteKnex.destroy();

    const container = await new PostgreSqlContainer().start();
    t.after(async () => container.stop());
    const target = {
        type: "postgres",
        hostname: container.getHost(),
        port: String(container.getPort()),
        username: container.getUsername(),
        password: container.getPassword(),
        dbName: container.getDatabase(),
    };

    // First migration to fill the DB
    await migrate({ sqlitePath, target });

    // Second should refuse
    await assert.rejects(
        migrate({ sqlitePath, target }),
        /not empty/i,
    );
});
```

- [ ] **Step 2: Run**

Run: `npm run test-backend-22 -- --test-name-pattern="migrate aborts when target"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/backend-test/test-migrate-to-postgres.js
git commit -m "test(migrate): assert target-non-empty abort"
```

### Task 4.5: CLI entry point

**Files:**
- Create: `extra/migrate-to-postgres.js`
- Modify: `package.json` (add script)

- [ ] **Step 1: Write the CLI**

```js
#!/usr/bin/env node
const path = require("path");
const Database = require("../server/database");
const { migrate } = require("../server/migrate-to-postgres");

function parseArgs(argv) {
    const args = { sqlitePath: undefined, target: {} };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--sqlite") args.sqlitePath = argv[++i];
        else if (a === "--url") args.target.url = argv[++i];
        else if (a === "--host") args.target.hostname = argv[++i];
        else if (a === "--port") args.target.port = argv[++i];
        else if (a === "--db") args.target.dbName = argv[++i];
        else if (a === "--user") args.target.username = argv[++i];
        else if (a === "--password") args.target.password = argv[++i];
        else if (a === "--ssl-mode") args.target.sslMode = argv[++i];
    }
    return args;
}

(async () => {
    const args = parseArgs(process.argv);
    if (!args.sqlitePath) {
        Database.initDataDir({});
        args.sqlitePath = path.join(Database.dataDir, "kuma.db");
    }
    args.target.type = "postgres";

    console.log(`Migrating ${args.sqlitePath} → postgres`);
    const result = await migrate({
        sqlitePath: args.sqlitePath,
        target: args.target,
        onProgress: (p) => {
            if (p.phase === "copy" && p.rowsTotal) {
                process.stdout.write(`\r[copy] ${p.table}: ${p.rowsCopied}/${p.rowsTotal}    `);
                if (p.rowsCopied === p.rowsTotal) process.stdout.write("\n");
            } else {
                console.log(`[${p.phase}]${p.table ? " " + p.table : ""}`);
            }
        },
    });
    console.log(`Done. ${result.tables} tables, ${result.rowsCopied} rows.`);
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add inside `scripts`:

```json
"migrate-to-postgres": "node extra/migrate-to-postgres.js"
```

- [ ] **Step 3: Smoke**

(Requires a running PG.)

```bash
npm run migrate-to-postgres -- --url postgres://postgres:postgres@localhost:5432/kuma
```

Expected: prints progress and exits 0. Or fails fast with a clear error if PG is unreachable.

- [ ] **Step 4: Commit**

```bash
git add extra/migrate-to-postgres.js package.json
git commit -m "feat(migrate): add CLI entry point"
```

---

## Phase 5: Setup-page UI (first-run)

### Task 5.1: Add Postgres radio + form to `SetupDatabase.vue`

**Files:**
- Modify: `src/pages/SetupDatabase.vue`
- Modify: `src/lang/en.json`

- [ ] **Step 1: Extend the data model**

In the `data()` block of `SetupDatabase.vue`, extend the default `dbConfig` shape:

```js
dbConfig: {
    type: undefined,
    port: 3306,
    hostname: "",
    username: "",
    password: "",
    dbName: "kuma",
    ssl: false,
    ca: "",
    // Postgres-specific
    url: "",
    useConnectionString: false,
    sslMode: "require",
    schema: "",
},
```

- [ ] **Step 2: Add the radio button**

After the SQLite radio block (search for `value="sqlite"`), add:

```html
<input
    id="btnradio4"
    v-model="dbConfig.type"
    type="radio"
    class="btn-check"
    autocomplete="off"
    value="postgres"
/>
<label class="btn btn-outline-primary" for="btnradio4">PostgreSQL</label>
```

And a help paragraph:

```html
<div v-if="dbConfig.type === 'postgres'" class="mt-3 short">
    {{ $t("setupDatabasePostgres") }}
</div>
```

- [ ] **Step 3: Add the Postgres form block**

After the MariaDB `<template>` block (closes around line 168), add:

```html
<template v-if="dbConfig.type === 'postgres'">
    <div class="mt-3 short text-start">
        <div class="form-check form-switch ps-0">
            <input
                id="useConnStringCheck"
                v-model="dbConfig.useConnectionString"
                type="checkbox"
                role="switch"
                class="form-check-input ms-0 me-2"
            />
            <label class="form-check-label fw-bold" for="useConnStringCheck">
                {{ $t("postgresUseConnectionString") }}
            </label>
        </div>
    </div>

    <div v-if="dbConfig.useConnectionString" class="form-floating mt-3 short">
        <textarea
            id="pgUrl"
            v-model="dbConfig.url"
            class="form-control"
            style="height: 90px"
            placeholder="postgres://user:pass@host:5432/db"
            required
        />
        <label for="pgUrl">Connection String</label>
    </div>

    <template v-else>
        <div class="form-floating mt-3 short">
            <input v-model="dbConfig.hostname" type="text" class="form-control" required />
            <label>{{ $t("Hostname") }}</label>
        </div>
        <div class="form-floating mt-3 short">
            <input v-model="dbConfig.port" type="text" class="form-control" required placeholder="5432" />
            <label>{{ $t("Port") }}</label>
        </div>
        <div class="form-floating mt-3 short">
            <input v-model="dbConfig.username" type="text" class="form-control" required />
            <label>{{ $t("Username") }}</label>
        </div>
        <div class="form-floating mt-3 short">
            <input v-model="dbConfig.password" type="password" class="form-control" required />
            <label>{{ $t("Password") }}</label>
        </div>
        <div class="form-floating mt-3 short">
            <input v-model="dbConfig.dbName" type="text" class="form-control" required />
            <label>{{ $t("dbName") }}</label>
        </div>
    </template>

    <div class="form-floating mt-3 short">
        <select id="pgSslMode" v-model="dbConfig.sslMode" class="form-select">
            <option value="disable">disable</option>
            <option value="require">require</option>
            <option value="verify-ca">verify-ca</option>
            <option value="verify-full">verify-full</option>
        </select>
        <label for="pgSslMode">{{ $t("postgresSslMode") }}</label>
    </div>

    <div v-if="dbConfig.sslMode === 'verify-ca' || dbConfig.sslMode === 'verify-full'" class="form-floating mt-3 short">
        <textarea
            v-model="dbConfig.ca"
            class="form-control"
            placeholder="-----BEGIN CERTIFICATE-----"
            style="height: 120px"
        />
        <label>{{ $t("postgresCaCertificateLabel") }}</label>
        <div class="form-text">{{ $t("postgresCaCertificateHelptext") }}</div>
    </div>
</template>
```

- [ ] **Step 4: Strip empty optional fields on submit**

Find the `submit()` method. Before sending, normalize the Postgres payload:

```js
if (this.dbConfig.type === "postgres") {
    if (!this.dbConfig.useConnectionString) {
        delete this.dbConfig.url;
    } else {
        delete this.dbConfig.hostname;
        delete this.dbConfig.port;
        delete this.dbConfig.username;
        delete this.dbConfig.password;
        delete this.dbConfig.dbName;
    }
    if (this.dbConfig.sslMode === "disable" || (this.dbConfig.sslMode !== "verify-ca" && this.dbConfig.sslMode !== "verify-full")) {
        delete this.dbConfig.ca;
    }
    if (this.dbConfig.schema === "") delete this.dbConfig.schema;
}
```

- [ ] **Step 5: Add the i18n keys**

In `src/lang/en.json`, add:

```json
"setupDatabasePostgres": "PostgreSQL is a robust open-source relational database. Recommended for production deployments where you already operate Postgres.",
"postgresUseConnectionString": "Use connection string (DATABASE_URL)",
"postgresSslMode": "SSL mode",
"postgresCaCertificateLabel": "CA Certificate",
"postgresCaCertificateHelptext": "Optional. Paste the PEM-encoded CA certificate used to verify the server. Required for verify-ca and verify-full."
```

- [ ] **Step 6: Manual check**

Run: `npm run dev`
Delete or rename `data/db-config.json` if it exists, then visit the setup page and verify the Postgres option renders and toggles correctly.

- [ ] **Step 7: Commit**

```bash
git add src/pages/SetupDatabase.vue src/lang/en.json
git commit -m "feat(ui): add PostgreSQL option to setup page"
```

---

## Phase 6: Runtime Settings panel

### Task 6.1: Create `Database.vue` settings panel

**Files:**
- Create: `src/components/settings/Database.vue`

- [ ] **Step 1: Write the component**

```html
<template>
    <div>
        <h4>{{ $t("Database") }}</h4>
        <div class="my-3">
            <strong>{{ $t("Current type") }}:</strong> {{ $root.info.dbType }}
        </div>

        <div v-if="$root.info.dbType === 'sqlite'" class="card">
            <div class="card-body">
                <h5 class="card-title">{{ $t("Migrate to PostgreSQL") }}</h5>
                <p class="card-text text-muted">
                    {{ $t("migrateToPostgresIntro") }}
                </p>

                <div class="form-check form-switch ps-0 mb-2">
                    <input id="useUrl" v-model="form.useConnectionString" type="checkbox" role="switch" class="form-check-input ms-0 me-2" />
                    <label class="form-check-label" for="useUrl">{{ $t("postgresUseConnectionString") }}</label>
                </div>

                <div v-if="form.useConnectionString" class="mb-2">
                    <textarea v-model="form.url" class="form-control" placeholder="postgres://user:pass@host/db" rows="2" />
                </div>
                <template v-else>
                    <input v-model="form.hostname" class="form-control mb-2" :placeholder="$t('Hostname')" />
                    <input v-model="form.port" class="form-control mb-2" placeholder="5432" />
                    <input v-model="form.username" class="form-control mb-2" :placeholder="$t('Username')" />
                    <input v-model="form.password" type="password" class="form-control mb-2" :placeholder="$t('Password')" />
                    <input v-model="form.dbName" class="form-control mb-2" :placeholder="$t('dbName')" />
                </template>

                <select v-model="form.sslMode" class="form-select mb-2">
                    <option value="disable">disable</option>
                    <option value="require">require</option>
                    <option value="verify-ca">verify-ca</option>
                    <option value="verify-full">verify-full</option>
                </select>

                <div class="d-flex gap-2 mt-3">
                    <button class="btn btn-outline-secondary" :disabled="busy" @click="testConnection">
                        {{ $t("Test connection") }}
                    </button>
                    <button class="btn btn-primary" :disabled="busy || !canMigrate" @click="confirmMigrate">
                        {{ $t("Start migration") }}
                    </button>
                </div>

                <div v-if="progress" class="mt-3">
                    <div><strong>{{ $t("Progress") }}:</strong> {{ progress.phase }}{{ progress.table ? " — " + progress.table : "" }}</div>
                    <div v-if="progress.rowsTotal" class="progress mt-1">
                        <div
                            class="progress-bar"
                            role="progressbar"
                            :style="{ width: ((progress.rowsCopied / progress.rowsTotal) * 100) + '%' }"
                        />
                    </div>
                </div>
            </div>
        </div>

        <div v-else class="alert alert-info">
            {{ $t("currentDbNotSqliteMigrationHidden") }}
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            form: {
                useConnectionString: false,
                url: "",
                hostname: "",
                port: "5432",
                username: "",
                password: "",
                dbName: "kuma",
                sslMode: "require",
                ca: "",
            },
            busy: false,
            progress: null,
            testResult: null,
        };
    },
    computed: {
        canMigrate() {
            if (this.form.useConnectionString) return !!this.form.url.trim();
            return !!(this.form.hostname && this.form.username && this.form.dbName);
        },
    },
    mounted() {
        this.$root.socket.socket.on("dbMigrationProgress", this.onProgress);
    },
    beforeUnmount() {
        this.$root.socket.socket.off("dbMigrationProgress", this.onProgress);
    },
    methods: {
        buildConfig() {
            const cfg = { type: "postgres", sslMode: this.form.sslMode };
            if (this.form.useConnectionString) cfg.url = this.form.url;
            else {
                cfg.hostname = this.form.hostname;
                cfg.port = this.form.port;
                cfg.username = this.form.username;
                cfg.password = this.form.password;
                cfg.dbName = this.form.dbName;
            }
            if (cfg.sslMode === "verify-ca" || cfg.sslMode === "verify-full") cfg.ca = this.form.ca;
            return cfg;
        },
        testConnection() {
            this.busy = true;
            this.$root.getSocket().emit("testDbConnection", this.buildConfig(), (res) => {
                this.busy = false;
                if (res.ok) this.$root.toastSuccess(this.$t("Connection OK"));
                else this.$root.toastError(this.$t("Connection failed") + ": " + res.error);
            });
        },
        confirmMigrate() {
            if (!confirm(this.$t("Migration will restart the server. Continue?"))) return;
            this.busy = true;
            this.progress = { phase: "starting" };
            this.$root.getSocket().emit("migrateToPostgres", this.buildConfig(), (res) => {
                this.busy = false;
                if (!res.ok) this.$root.toastError(this.$t("Migration failed") + ": " + res.error);
            });
        },
        onProgress(p) {
            this.progress = p;
        },
    },
};
</script>
```

- [ ] **Step 2: Add i18n keys**

In `src/lang/en.json`:

```json
"Current type": "Current type",
"Migrate to PostgreSQL": "Migrate to PostgreSQL",
"migrateToPostgresIntro": "Copies all data from the local SQLite database into the target PostgreSQL database, then switches the active backend. The kuma.db file is left on disk as a backup.",
"Test connection": "Test connection",
"Start migration": "Start migration",
"Progress": "Progress",
"Connection OK": "Connection OK",
"Connection failed": "Connection failed",
"Migration failed": "Migration failed",
"Migration will restart the server. Continue?": "Migration will restart the server. Continue?",
"currentDbNotSqliteMigrationHidden": "Migration is only available when the current backend is SQLite."
```

- [ ] **Step 3: Register the route**

In `src/router.js`, import and add the route. Inside the existing settings children block:

```js
import Database from "./components/settings/Database.vue";
// ...
{ path: "database", component: Database },
```

- [ ] **Step 4: Add sidebar nav entry**

In `src/pages/Settings.vue` (or wherever the settings sidebar is rendered — `grep -n "settings/general\|settings/notifications" src/pages/Settings.vue`), add:

```html
<router-link to="/settings/database" class="nav-link">
    {{ $t("Database") }}
</router-link>
```

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/Database.vue src/router.js src/pages/Settings.vue src/lang/en.json
git commit -m "feat(ui): add Database settings panel with migrate-to-postgres"
```

---

## Phase 7: Socket handlers + server `info`

### Task 7.1: Extend `info` payload with `dbType`

**Files:**
- Modify: `server/uptime-kuma-server.js` (search for `getServerInfo` or where `info` is broadcast on `connect`)

- [ ] **Step 1: Locate where the `info` object is built**

Run: `grep -n "isEnabledEmbeddedMariaDB\|serverInfo\|emit.*info" server/uptime-kuma-server.js`

- [ ] **Step 2: Add `dbType` field**

In the object handed to the client:

```js
{
    // ...existing fields...
    dbType: Database.dbConfig?.type ?? "sqlite",
}
```

- [ ] **Step 3: Commit**

```bash
git add server/uptime-kuma-server.js
git commit -m "feat(server): expose current dbType in info payload"
```

### Task 7.2: Add `testDbConnection` handler

**Files:**
- Modify: `server/socket-handlers/database-socket-handler.js`

- [ ] **Step 1: Read the existing handler file**

Open the file. Identify the exported function (likely `databaseSocketHandler(socket)`).

- [ ] **Step 2: Add the handler**

```js
const { checkLogin } = require("../util-server");
const knex = require("knex");

// ... inside databaseSocketHandler(socket):
socket.on("testDbConnection", async (config, cb) => {
    try {
        checkLogin(socket);
        const connection = config.url
            ? { connectionString: config.url }
            : {
                host: config.hostname,
                port: config.port ? parseInt(config.port) : 5432,
                user: config.username,
                password: config.password,
                database: config.dbName,
            };
        if (config.sslMode && config.sslMode !== "disable") {
            connection.ssl = {
                rejectUnauthorized: config.sslMode === "verify-ca" || config.sslMode === "verify-full",
                ca: config.ca && config.ca.trim() !== "" ? config.ca : undefined,
            };
        }
        if (typeof connection === "object" && "ssl" in connection && !connection.ssl.ca) delete connection.ssl.ca;

        const k = knex({ client: "pg", connection });
        try {
            await k.raw("SELECT 1");
            cb({ ok: true });
        } finally {
            await k.destroy();
        }
    } catch (e) {
        cb({ ok: false, error: e.message });
    }
});
```

- [ ] **Step 3: Commit**

```bash
git add server/socket-handlers/database-socket-handler.js
git commit -m "feat(socket): add testDbConnection handler for postgres"
```

### Task 7.3: Add `migrateToPostgres` handler

**Files:**
- Modify: `server/socket-handlers/database-socket-handler.js`

- [ ] **Step 1: Add the handler**

```js
const path = require("path");
const Database = require("../database");
const { migrate } = require("../migrate-to-postgres");
const fs = require("fs");

// ... inside databaseSocketHandler(socket):
socket.on("migrateToPostgres", async (config, cb) => {
    try {
        checkLogin(socket);
        if (Database.dbConfig?.type !== "sqlite") {
            return cb({ ok: false, error: "Current backend is not SQLite" });
        }
        const sqlitePath = Database.sqlitePath;
        if (!fs.existsSync(sqlitePath)) {
            return cb({ ok: false, error: "kuma.db not found" });
        }

        const target = { ...config, type: "postgres" };

        await migrate({
            sqlitePath,
            target,
            onProgress: (p) => socket.emit("dbMigrationProgress", p),
        });

        // Persist new config and exit so the supervisor restarts us on PG
        Database.writeDBConfig(target);
        cb({ ok: true });
        setTimeout(() => process.exit(0), 500);
    } catch (e) {
        cb({ ok: false, error: e.message });
    }
});
```

- [ ] **Step 2: Manual smoke**

Run dev with sqlite, open settings panel, fill PG config pointing to a docker-compose Postgres, hit "Test connection" → OK, hit "Start migration" → progress visible. Confirm server exits and the supervisor restarts (or restart manually). Confirm `db-config.json` now has `type: "postgres"`, and `kuma.db` is untouched.

- [ ] **Step 3: Commit**

```bash
git add server/socket-handlers/database-socket-handler.js
git commit -m "feat(socket): add migrateToPostgres handler"
```

---

## Phase 8: E2E + final verification

### Task 8.1: Playwright setup-page test for Postgres

**Files:**
- Create: `test/e2e/specs/setup-postgres.spec.js`

- [ ] **Step 1: Write the test**

(Pattern after existing setup specs in `test/e2e/specs/`. If there are none, defer to a manual checklist below and skip the file creation.)

```js
const { test, expect } = require("@playwright/test");
// Boot the app pointing at an empty data dir, drive the setup page,
// pick Postgres, fill connection string for a CI-provided PG,
// expect successful navigation to login.
```

- [ ] **Step 2: Run**

Run: `npm run test-e2e -- --grep "setup-postgres"`
Expected: PASS, or PENDING if no PG is configured in CI. If pending, leave a comment in the file explaining how to run it.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/specs/setup-postgres.spec.js
git commit -m "test(e2e): postgres setup flow"
```

### Task 8.2: Update README / docs

**Files:**
- Modify: `README.md` (only if it lists supported backends explicitly; otherwise skip)

- [ ] **Step 1: Search the README for "SQLite" / "MariaDB"**

Run: `grep -n "SQLite\|MariaDB" README.md`

If there is a list of supported backends, add Postgres alongside with the relevant env vars:

```markdown
- PostgreSQL (`UPTIME_KUMA_DB_TYPE=postgres`, `UPTIME_KUMA_DB_URL=postgres://...`)
```

- [ ] **Step 2: Commit if changed**

```bash
git add README.md
git commit -m "docs: mention postgres backend"
```

### Task 8.3: Manual verification checklist

Perform each item and tick when verified. Treat any unchecked item as a release blocker.

- [ ] Fresh install: env-driven setup with PG (`UPTIME_KUMA_DB_TYPE=postgres`, `UPTIME_KUMA_DB_URL=...`). Server boots, monitor can be created, heartbeat lands.
- [ ] Fresh install: UI setup. Pick Postgres, fill fields, submit. Server boots.
- [ ] Migration: SQLite → PG via Settings panel. `kuma.db` untouched on disk after migration. PG has all monitors, heartbeats, notifications, users.
- [ ] Migration: CLI path. `npm run migrate-to-postgres -- --url ...`. Same result.
- [ ] Re-run migration against a non-empty PG: aborts with clear error.
- [ ] SSL: connect to a PG instance that requires TLS (RDS, Supabase, or a docker-compose with self-signed). `verify-full` with pasted CA succeeds; `verify-full` with wrong CA fails clearly.
- [ ] Rollback: edit `db-config.json` back to sqlite. Server boots on the original `kuma.db`.
- [ ] No regressions: run `npm run test-backend` and `npm run test-e2e` with default config. All green.

---

## Out of scope (parked for follow-ups)

- ClickHouse as a heartbeat/stats sink.
- Postgres → SQLite reverse migration.
- Multi-schema multi-tenant.
- Online (no-restart) migration.
- Pool tuning UI.
- Locales other than `en.json`.
