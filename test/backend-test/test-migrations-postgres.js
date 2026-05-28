const { describe, test } = require("node:test");
const assert = require("node:assert");
const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const knex = require("knex");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createTables } = require("../../db/knex_init_db");

describe("PostgreSQL Migration Portability", () => {
    test(
        "all knex migrations run cleanly on postgres",
        { timeout: 5 * 60 * 1000 },
        async (t) => {
            const container = await new PostgreSqlContainer("postgres:16-alpine").start();
            t.after(async () => {
                try {
                    await container.stop();
                } catch (e) {
                    // Ignore cleanup errors
                }
            });

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
            t.after(async () => {
                try {
                    await k.destroy();
                } catch (e) {
                    // Ignore cleanup errors
                }
            });

            // Bootstrap the base schema (tables that knex migrations depend on)
            await createTables(k);

            // Run all migrations on top of the base schema
            await k.migrate.latest({
                directory: path.join(__dirname, "../../db/knex_migrations"),
            });

            const tables = await k("information_schema.tables")
                .select("table_name")
                .where({ table_schema: "public" });
            const names = tables.map((r) => r.table_name);

            assert.ok(names.includes("monitor"), "monitor table should exist");
            assert.ok(names.includes("heartbeat"), "heartbeat table should exist");
            assert.ok(names.includes("user"), "user table should exist");
        }
    );

    test("postgres and sqlite end up with the same set of tables", { timeout: 5 * 60 * 1000 }, async (t) => {
        // --- sqlite side ---
        // Patch knex's sqlite3 dialect to use @louislam/sqlite3 (the fork this project uses)
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-parity-"));
        const sqlitePath = path.join(tmpDir, "kuma.db");

        const sqliteKnex = knex({
            client: "sqlite3",
            connection: { filename: sqlitePath },
            useNullAsDefault: true,
        });
        t.after(async () => sqliteKnex.destroy());

        // Bootstrap the base schema on SQLite using the same createTables as Postgres
        await createTables(sqliteKnex);

        await sqliteKnex.migrate.latest({
            directory: path.join(__dirname, "../../db/knex_migrations"),
        });

        const sqliteTables = (await sqliteKnex("sqlite_master")
            .select("name")
            .where({ type: "table" }))
            .map(r => r.name)
            .filter(n => !n.startsWith("sqlite_")
                && n !== "knex_migrations"
                && n !== "knex_migrations_lock")
            .sort();

        // --- postgres side ---
        const container = await new PostgreSqlContainer("postgres:16-alpine").start();
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

        await createTables(pgKnex);
        await pgKnex.migrate.latest({
            directory: path.join(__dirname, "../../db/knex_migrations"),
        });

        const pgTables = (await pgKnex("information_schema.tables")
            .select("table_name")
            .where({ table_schema: "public" }))
            .map(r => r.table_name)
            .filter(n => n !== "knex_migrations" && n !== "knex_migrations_lock")
            .sort();

        const missing = sqliteTables.filter(t => !pgTables.includes(t));
        const extra = pgTables.filter(t => !sqliteTables.includes(t));

        assert.deepEqual(missing, [], `Tables missing on postgres: ${missing.join(", ")}`);
        assert.deepEqual(extra, [], `Tables extra on postgres: ${extra.join(", ")}`);
    });
});
