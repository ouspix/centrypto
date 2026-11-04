import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
const credentials = JSON.parse(await fs.readFile("data/deployment/vps-credentials.json", "utf8"));
function connection(role, schema) {
    const url = new URL(`postgresql://centrypto_${role}:${credentials[role]}@127.0.0.1:55432/centrypto`);
    url.searchParams.set("schema", schema); url.searchParams.set("connection_limit", "2"); url.searchParams.set("pool_timeout", "30"); url.searchParams.set("connect_timeout", "10");
    return url.toString();
}
for (const [schemaFile, variable, schema] of [["prisma/news/schema.prisma", "NEWS_DATABASE_URL", "news"], ["prisma/runtime-market/schema.prisma", "MARKET_DATABASE_URL", "mainnet"], ["prisma/runtime-market/schema.prisma", "MARKET_DATABASE_URL", "testnet"]]) {
    const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", schemaFile], { stdio: "inherit", env: { ...process.env, [variable]: connection("admin", schema), PRISMA_HIDE_UPDATE_MESSAGE: "1" } });
    if (result.status !== 0) process.exit(result.status || 1);
}
const file = path.resolve(".env.local");
let contents = await fs.readFile(file, "utf8").catch(() => "");
if (!credentials.owner_address) {
    const { PrismaClient } = await import("@prisma/client");
    const app = new PrismaClient({ datasources: { db: { url: dotenv.parse(contents).DATABASE_URL || `file:${path.resolve("prisma/backend.db")}` } } });
    try { credentials.owner_address = (await app.autoTraderSettings.findFirst({ orderBy: { updatedAt: "desc" }, select: { userAddress: true } }))?.userAddress.toLowerCase(); }
    finally { await app.$disconnect(); }
}
if (!/^0x[0-9a-f]{40}$/.test(credentials.owner_address || "")) throw new Error("Pair a verified application wallet with this browser before setup");
await fs.writeFile("data/deployment/vps-credentials.json", JSON.stringify(credentials), { mode: 0o600 });
await fs.writeFile("data/deployment/collector-owner.txt", credentials.owner_address, { mode: 0o600 });
await fs.mkdir("data/deployment", { recursive: true });
await fs.writeFile(`data/deployment/env-before-vps-${Date.now()}.bak`, contents, { mode: 0o600 });
const settings = { MARKET_DATABASE_URL: connection("app", "mainnet"), MARKET_TEST_DATABASE_URL: connection("app", "testnet"), NEWS_DATABASE_URL: connection("app", "news"), MARKET_COLLECTOR_ROLE: "client", ALLOW_API_COLLECTOR_START: "false", NEWS_TRADER_CONTEXT_ENABLED: dotenv.parse(contents).NEWS_TRADER_CONTEXT_ENABLED || "shadow", NEWS_COLLECTOR_INSTANCE_ID: "racknerd", NEWS_COLLECTOR_OWNER_ADDRESS: credentials.owner_address, CODEX_CLI_PATH: path.join(process.cwd(), "data/deployment/codex/node_modules/.bin/codex") };
for (const [key, value] of Object.entries(settings)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${JSON.stringify(value)}`;
    contents = pattern.test(contents) ? contents.replace(pattern, line) : contents.trimEnd() + "\n" + line + "\n";
}
await fs.writeFile(file, contents, { mode: 0o600 });
await fs.chmod(file, 0o600);
console.log("VPS market/news connections configured. Application/trading data and Codex inference remain local.");
