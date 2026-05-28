const test = require("node:test");
const assert = require("node:assert");
const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const knex = require("knex");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createTables } = require("../../db/knex_init_db");
const { migrate } = require("../../server/migrate-to-postgres");

// Patch knex's sqlite3 dialect to use the project's custom sqlite3 fork
const Dialect = require("knex/lib/dialects/sqlite3/index.js");
Dialect.prototype._driver = () => require("@louislam/sqlite3");

test("migrate copies tables from sqlite to postgres", { timeout: 5 * 60 * 1000 }, async (t) => {
    // Build a tiny sqlite source: base schema + migrations + one user row
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-mig-"));
    const sqlitePath = path.join(tmpDir, "kuma.db");
    const sqliteKnex = knex({
        client: "sqlite3",
        connection: { filename: sqlitePath },
        useNullAsDefault: true,
    });
    await createTables(sqliteKnex);
    await sqliteKnex.migrate.latest({
        directory: path.join(__dirname, "../../db/knex_migrations"),
    });
    await sqliteKnex("user").insert({
        username: "admin",
        password: "x",
        active: 1,
        timezone: "UTC",
        twofa_status: 0,
    });
    await sqliteKnex.destroy();

    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
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
