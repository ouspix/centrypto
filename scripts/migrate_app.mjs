import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();
const postgres = /^postgres(?:ql)?:/.test(process.env.DATABASE_URL ?? "");
if (postgres) await import("./prepare_app_postgres.mjs");
const schema = postgres ? "prisma/app-postgres/schema.prisma" : "prisma/schema.prisma";
const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", postgres ? "deploy" : "dev", "--schema", schema, ...process.argv.slice(2)], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
