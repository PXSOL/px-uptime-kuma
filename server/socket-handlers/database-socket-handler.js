const path = require("path");
const fs = require("fs");
const { checkLogin } = require("../util-server");
const Database = require("../database");
const knex = require("knex");
const { migrate } = require("../migrate-to-postgres");

/**
 * Handlers for database
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.databaseSocketHandler = (socket) => {
    // Post or edit incident
    socket.on("getDatabaseSize", async (callback) => {
        try {
            checkLogin(socket);
            callback({
                ok: true,
                size: await Database.getSize(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("shrinkDatabase", async (callback) => {
        try {
            checkLogin(socket);
            await Database.shrink();
            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("testDbConnection", async (config, callback) => {
        let k;
        try {
            checkLogin(socket);
            const pgConfig = Database.buildPostgresConfig({ ...config, type: "postgres" }, 1);
            k = knex(pgConfig);
            await k.raw("SELECT 1");
            callback({ ok: true });
        } catch (e) {
            callback({ ok: false, error: e.message });
        } finally {
            if (k) await k.destroy().catch(() => {});
        }
    });

    socket.on("migrateToPostgres", async (config, callback) => {
        try {
            checkLogin(socket);

            if (Database.dbConfig?.type !== "sqlite") {
                return callback({ ok: false, error: "Current backend is not SQLite" });
            }
            const sqlitePath = Database.sqlitePath;
            if (!fs.existsSync(sqlitePath)) {
                return callback({ ok: false, error: "kuma.db not found at " + sqlitePath });
            }

            const target = { ...config, type: "postgres" };

            await migrate({
                sqlitePath,
                target,
                onProgress: (p) => socket.emit("dbMigrationProgress", p),
            });

            // Persist new config and exit so the supervisor restarts us on PG
            Database.writeDBConfig(target);
            callback({ ok: true });
            setTimeout(() => process.exit(0), 500);
        } catch (e) {
            callback({ ok: false, error: e.message });
        }
    });
};
