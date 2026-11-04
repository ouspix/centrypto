// Limit installation to the added desk migrations. Never switch a book or start a trading process.
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const { PrismaClient: AppClient } = await import("@prisma/client");
const { PrismaClient: NewsClient } = await import("@prisma/news-client");
const apply = process.argv.includes("--apply");
const scopes = [
    {
        name: "application",
        Client: AppClient,
        variable: "DATABASE_URL",
        schema: "prisma/schema.prisma",
        folder: "prisma/migrations",
        allowed: ["20261102000000_desk_books", "20261102010000_desk_execution", "20261103000000_desk_token_usage", "20261103010000_desk_public_cache"],
    },
    {
        name: "news",
        Client: NewsClient,
        variable: "NEWS_DATABASE_URL",
        schema: "prisma/news/schema.prisma",
        folder: "prisma/news/migrations",
        allowed: ["20261102000000_desk_event_revisions"],
    },
];
async function migrationUrl(scope) {
    const configured = process.env[scope.variable];
    if (!configured) throw new Error("Missing " + scope.variable);
    if (scope.name === "application") return configured;
    if (process.env.NEWS_MIGRATION_DATABASE_URL) return process.env.NEWS_MIGRATION_DATABASE_URL;
    const url = new URL(configured);
    // Only use bundled admin credentials for the same local project tunnel known to configure_vps.
    if (
        url.hostname === "127.0.0.1" &&
        url.port === "55432" &&
        url.pathname === "/centrypto" &&
        url.searchParams.get("schema") === "news" &&
        url.username === "centrypto_app"
    ) {
        const credentials = JSON.parse(await fs.readFile("data/deployment/vps-credentials.json", "utf8"));
        if (!credentials.admin) throw new Error("Set NEWS_MIGRATION_DATABASE_URL.");
        url.username = "centrypto_admin";
        url.password = credentials.admin;
        return url.toString();
    }
    return configured;
}
async function main() {
    const pending = [];
    for (const s of scopes) {
        const url = await migrationUrl(s),
            client = new s.Client({ datasources: { db: { url } } });
        try {
            const rows = await client.$queryRawUnsafe(
                'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"',
            );
            if (rows.some((r) => !r.finished_at && !r.rolled_back_at))
                throw new Error(s.name + " has an unfinished migration. Resolve it before installing the desk.");
            const done = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
            const missing = (await fs.readdir(s.folder, { withFileTypes: true }))
                .filter((f) => f.isDirectory() && !done.has(f.name))
                .map((f) => f.name);
            if (missing.some((m) => !s.allowed.includes(m)))
                throw new Error(
                    "Install the existing " +
                        s.name +
                        " schema first. Unexpected pending migrations: " +
                        missing.join(", "),
                );
            console.log(s.name + ": " + (missing.join(", ") || "up to date"));
            if (missing.length) pending.push({ s, url });
        } finally {
            await client.$disconnect();
        }
    }
    if (!apply) {
        console.log("Read-only check. Use --apply to install the listed desk migrations.");
        return;
    }
    for (const { s, url } of pending) {
        const run = spawnSync(
            process.execPath,
            ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", s.schema],
            { env: { ...process.env, [s.variable]: url }, stdio: "inherit" },
        );
        if (run.status !== 0) throw new Error("Could not deploy the " + s.name + " migrations.");
    }
}
main().catch((e) => {
    console.error(
        "Desk installation:",
        e?.code || (e?.name === "Error" ? e.message : "Connection or schema unavailable."),
    );
    process.exitCode = 1;
});
