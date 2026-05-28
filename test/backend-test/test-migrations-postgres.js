const { describe, test } = require("node:test");
const assert = require("node:assert");
const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const knex = require("knex");
const path = require("path");

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

            // Run all migrations (this includes creating the base schema)
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
});
