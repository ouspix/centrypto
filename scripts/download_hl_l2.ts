import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";

const BUCKET_URL = "https://hyperliquid-archive.s3.amazonaws.com";
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

type ListedObject = {
    key: string;
    size: number;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const date = required(args.date, "--date YYYYMMDD is required");
    const hour = required(args.hour, "--hour H is required");
    const outRoot = args.out ?? "data/hyperliquid";
    const decompress = args.decompress !== "false";
    const concurrency = positiveInt(Number(args.concurrency ?? 6), 6);
    const prefix = `market_data/${date}/${Number(hour)}/l2Book/`;
    const selectedSymbols = parseSymbols(args.symbols);

    console.log(`[download:hl-l2] Listing s3://hyperliquid-archive/${prefix}`);
    const objects = await listObjects(prefix);
    const l2Objects = objects.filter(obj => obj.key.endsWith(".lz4") || obj.key.startsWith(prefix));
    const filtered = selectedSymbols.length
        ? l2Objects.filter(obj => selectedSymbols.includes(symbolFromKey(obj.key)))
        : l2Objects;

    if (filtered.length === 0) {
        throw new Error(`No L2 archive files found for ${prefix}${selectedSymbols.length ? ` and symbols ${selectedSymbols.join(",")}` : ""}`);
    }

    const localDir = path.join(outRoot, "market_data", date, String(Number(hour)), "l2Book");
    await fs.mkdir(localDir, { recursive: true });

    const decompressor = findLz4();
    if (decompress && !decompressor) {
        console.warn("[download:hl-l2] lz4/unlz4 not found. Downloading .lz4 files only. Install lz4 to decompress automatically.");
    }

    await runWithConcurrency(filtered, concurrency, async obj => {
        const symbol = symbolFromKey(obj.key);
        const compressedPath = path.join(localDir, `${symbol}.lz4`);
        const finalPath = path.join(localDir, symbol);
        console.log(`[download:hl-l2] Downloading ${symbol} (${formatBytes(obj.size)})`);
        await downloadObject(obj.key, compressedPath);

        if (decompress && decompressor) {
            await decompressLz4(decompressor, compressedPath, finalPath);
        }
    });

    console.log(`[download:hl-l2] Done. Files are under ${localDir}`);
}

async function listObjects(prefix: string): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    let continuation: string | null = null;

    do {
        const url = new URL(BUCKET_URL);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (continuation) url.searchParams.set("continuation-token", continuation);

        const res = await signedFetch(url);
        if (!res.ok) throw new Error(`S3 list failed: ${res.status} ${await res.text()}`);
        const xml = await res.text();
        objects.push(...parseObjectList(xml));
        continuation = parseTag(xml, "NextContinuationToken");
    } while (continuation);

    return objects;
}

function parseObjectList(xml: string): ListedObject[] {
    const result: ListedObject[] = [];
    const contentRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match: RegExpExecArray | null;
    while ((match = contentRe.exec(xml))) {
        const key = parseTag(match[1], "Key");
        const size = Number(parseTag(match[1], "Size") ?? 0);
        if (key) result.push({ key: decodeXml(key), size });
    }
    return result;
}

function parseTag(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return match?.[1] ? decodeXml(match[1]) : null;
}

async function downloadObject(key: string, localPath: string): Promise<void> {
    const url = `${BUCKET_URL}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const res = await signedFetch(url);
    if (!res.ok) throw new Error(`Download failed for ${key}: ${res.status} ${await res.text()}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(localPath, bytes);
}

function decompressLz4(decompressor: string, input: string, output: string): Promise<void> {
    const args = decompressor.includes("unlz4") ? ["-f", input, output] : ["-d", "-f", input, output];
    return new Promise((resolve, reject) => {
        const child = spawn(decompressor, args, { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to decompress ${input}`));
        });
    });
}

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>
): Promise<void> {
    if (items.length === 0) return;
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            await worker(items[index], index);
        }
    });
    await Promise.all(workers);
}

function positiveInt(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
}

function symbolFromKey(key: string): string {
    return path.basename(key).replace(/\.lz4$/, "").replace(/\.jsonl?$/i, "");
}

function parseSymbols(value: string | undefined): string[] {
    if (!value) return [];
    if (value.toLowerCase() === "all") return [];
    return value.split(",").map(v => v.trim()).filter(Boolean);
}

function findLz4(): string | null {
    for (const candidate of ["lz4", "unlz4"]) {
        const result = spawnSync("which", [candidate], { encoding: "utf8" });
        if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return null;
}

async function signedFetch(url: URL | string): Promise<Response> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
        throw new Error(
            "Hyperliquid archive is a Requester Pays S3 bucket. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, then rerun. " +
            "Your AWS account will be charged for request/data transfer costs."
        );
    }

    const requestUrl = typeof url === "string" ? new URL(url) : url;
    const headers = signS3Get(requestUrl, accessKeyId, secretAccessKey, process.env.AWS_SESSION_TOKEN);
    return fetch(requestUrl, { headers });
}

function signS3Get(
    url: URL,
    accessKeyId: string,
    secretAccessKey: string,
    sessionToken?: string
): Record<string, string> {
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const service = "s3";
    const credentialScope = `${dateStamp}/${AWS_REGION}/${service}/aws4_request`;
    const payloadHash = "UNSIGNED-PAYLOAD";
    const headers: Record<string, string> = {
        host: url.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        "x-amz-request-payer": "requester"
    };
    if (sessionToken) headers["x-amz-security-token"] = sessionToken;

    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
        .sort()
        .map(key => `${key}:${headers[key].trim()}\n`)
        .join("");
    const canonicalRequest = [
        "GET",
        canonicalUri(url.pathname),
        canonicalQuery(url.searchParams),
        canonicalHeaders,
        signedHeaders,
        payloadHash
    ].join("\n");

    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        sha256(canonicalRequest)
    ].join("\n");
    const signingKey = getSignatureKey(secretAccessKey, dateStamp, AWS_REGION, service);
    const signature = hmacHex(signingKey, stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
}

function canonicalUri(pathname: string): string {
    return pathname
        .split("/")
        .map(segment => encodeRfc3986(decodeURIComponent(segment)))
        .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
    return Array.from(params.entries())
        .sort(([aKey, aVal], [bKey, bVal]) => aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey))
        .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
        .join("&");
}

function encodeRfc3986(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function toAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
    return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: Buffer | string, value: string): string {
    return crypto.createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac(`AWS4${secret}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, "aws4_request");
}

function decodeXml(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        args[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    return args;
}

function required(value: string | undefined, message: string): string {
    if (!value) throw new Error(message);
    return value;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
