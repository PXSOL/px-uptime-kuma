const knex = require("knex");
const path = require("path");
const { log } = require("../src/util");
const Database = require("./database");

/**
 * Copy data from a SQLite kuma.db into a Postgres target. Used by the
 * Settings → Database migration button and the migrate-to-postgres CLI.
 *
 * @param {object} opts
 * @param {string} opts.sqlitePath  Absolute path to the source kuma.db.
 * @param {object} opts.target      dbConfig for postgres (same shape as db-config.json).
 * @param {(progress: { phase: string, table?: string, rowsCopied?: number, rowsTotal?: number }) => void} [opts.onProgress]
 * @returns {Promise<{ tables: number, rowsCopied: number }>}
 */
async function migrate({ sqlitePath, target, onProgress = () => {} }) {
    throw new Error("not implemented");
}

module.exports = { migrate };
