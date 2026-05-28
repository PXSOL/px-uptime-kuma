const { describe, test } = require("node:test");
const assert = require("node:assert");
const Database = require("../../server/database");

describe("Database Configuration", () => {
    test("postgres is an accepted SQL client", () => {
        assert.ok(
            Database.acceptedSqlClient.includes("postgres"),
            "postgres should be included in acceptedSqlClient array"
        );
    });

    test("postgres is in the non-SQLite client list", () => {
        assert.ok(
            Database.noSqliteClient.includes("postgres"),
            "postgres should be included in noSqliteClient array"
        );
    });

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
});
