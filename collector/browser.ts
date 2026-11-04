import puppeteer from "puppeteer";
import path from "path";
import fs from "fs/promises";

async function main() {
    if (!process.env.NEWS_BRIDGE_TOKEN) throw new Error("Collector pairing token is required");
    const extension = process.env.NEWS_EXTENSION_PATH || path.join(__dirname, "extension");
    const browser = await puppeteer.launch({
        headless: false,
        executablePath: process.env.CHROME_PATH,
        userDataDir: process.env.NEWS_PROFILE_PATH || "/var/lib/centrypto-collectors/profile",
        enableExtensions: [extension],
        args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking", "--window-size=1280,900", "--renderer-process-limit=4"]
    });
    const target = await browser.waitForTarget(candidate => candidate.type() === "service_worker" && candidate.url().endsWith("/background.js"), { timeout: 30_000 });
    const worker = await target.worker();
    if (!worker) throw new Error("Collector extension failed to load");
    await worker.evaluate(async token => {
        const api = (globalThis as unknown as { chrome: { storage: { local: { set: (value: object) => Promise<void> } } } }).chrome;
        await api.storage.local.set({ bridgeToken: token });
    }, process.env.NEWS_BRIDGE_TOKEN);
    // Text-only describes extraction/analysis, not browser rendering. In particular,
    // never block login images, CAPTCHAs, fonts or media in interactive tabs.
    const version = await browser.version();
    await fs.writeFile("/var/lib/centrypto-collectors/browser-health.json", JSON.stringify({ version, startedAt: new Date().toISOString() }), { mode: 0o600 });
    console.log("Dedicated collector browser started");
    const shutdown = () => { void browser.close().finally(() => process.exit(0)); };
    process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
    browser.on("disconnected", () => process.exit(1));
}
void main().catch(error => {
    const detail = String(error instanceof Error ? error.message : "Unknown startup error").replaceAll(process.env.NEWS_BRIDGE_TOKEN || "__no_token__", "[redacted]").replace(/postgres(?:ql)?:\/\/\S+/g, "[database]").slice(0, 2000);
    console.error("Collector browser startup failed:", detail);
    process.exit(1);
});
