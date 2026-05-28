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
});
