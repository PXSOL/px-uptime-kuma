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
