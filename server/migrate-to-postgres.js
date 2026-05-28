const knex = require("knex");
const path = require("path");
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
    // --- Open SQLite source ---
    const SqliteDialect = require("knex/lib/dialects/sqlite3/index.js");
    SqliteDialect.prototype._driver = () => require("@louislam/sqlite3");
    const sqlite = knex({
        client: SqliteDialect,
        connection: { filename: sqlitePath },
        useNullAsDefault: true,
    });

    // --- Open Postgres target ---
    const pgConfig = Database.buildPostgresConfig(target, 10);
    const pg = knex(pgConfig);

    try {
        onProgress({ phase: "start" });

        // Guard: target must be empty (allow knex_migrations* tables)
        const tablesResult = await pg.raw(`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename NOT LIKE 'knex_migrations%'
        `);
        const existingTables = tablesResult.rows.map(r => r.tablename);
        if (existingTables.length > 0) {
            throw new Error(
                `Target postgres database is not empty (${existingTables.length} tables). Refusing to migrate.`
            );
        }

        // --- Bootstrap schema ---
        onProgress({ phase: "schema" });
        const { createTables } = require("../db/knex_init_db");
        await createTables(pg);
        await pg.migrate.latest({ directory: path.join(__dirname, "..", "db", "knex_migrations") });

        // --- Discover tables from sqlite_master (preserve creation order) ---
        const masterRows = await sqlite.raw(`
            SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
              AND name NOT LIKE 'knex_migrations%'
            ORDER BY rowid
        `);
        const tables = masterRows.map(r => r.name);

        // --- Copy data table by table ---
        let totalRowsCopied = 0;
        for (const table of tables) {
            const [{ count }] = await sqlite(table).count({ count: "*" });
            const rowsTotal = Number(count);

            if (rowsTotal === 0) {
                onProgress({ phase: "copy", table, rowsCopied: 0, rowsTotal: 0 });
                continue;
            }

            onProgress({ phase: "copy", table, rowsCopied: 0, rowsTotal });

            const batchSize = 500;
            let offset = 0;
            while (offset < rowsTotal) {
                const rows = await sqlite(table).select().limit(batchSize).offset(offset);
                if (rows.length === 0) break;
                await pg(table).insert(rows);
                offset += rows.length;
                onProgress({ phase: "copy", table, rowsCopied: offset, rowsTotal });
            }
            totalRowsCopied += offset;
        }

        // --- Reset Postgres sequences ---
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

        return { tables: tables.length, rowsCopied: totalRowsCopied };
    } finally {
        await sqlite.destroy();
        await pg.destroy();
    }
}

module.exports = { migrate };
