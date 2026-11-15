import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
const output = path.resolve(process.argv[2] || "data/deployment/market-provenance");
await fs.mkdir(output, { recursive: true });
await build({
  entryPoints: ["scripts/start_collector.ts"], outfile: path.join(output, "market-provenance.js"),
  bundle: true, platform: "node", target: "node22", format: "cjs",
  plugins: [{ name: "isolated-market-client", setup(builder) {
    builder.onResolve({ filter: /^@prisma\/market-client$/ }, () => ({ path: "./generated/market-client-provenance/index.js", external: true }));
  } }], external: ["bufferutil", "utf-8-validate"], logLevel: "warning"
});
await fs.cp("node_modules/@prisma/market-client", path.join(output, "generated/market-client-provenance"), { recursive: true });
const code = await fs.readFile(path.join(output, "market-provenance.js"));
await fs.writeFile(path.join(output, "provenance-release.json"), JSON.stringify({ version: "20261115", sha256: crypto.createHash("sha256").update(code).digest("hex"), scope: "market collector only; no trading services" }));
await fs.copyFile("scripts/activate_market_provenance.py", path.join(output, "activate_market_provenance.py"));
console.log(JSON.stringify({ output, bytes: code.length }));
