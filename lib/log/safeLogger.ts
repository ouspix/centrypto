const SENSITIVE_KEYS = [
    "authorization",
    "apiKey",
    "api_key",
    "cookie",
    "databaseUrl",
    "DATABASE_URL",
    "password",
    "privateKey",
    "private_key",
    "prompt",
    "rawOutput",
    "response",
    "secret",
    "signature",
    "token"
];

const HEX_SECRET_RE = /0x[a-fA-F0-9]{64,}/g;
const WALLET_ADDRESS_RE = /0x[a-fA-F0-9]{40}\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

export function redactSensitive(value: unknown): unknown {
    if (typeof value === "string") {
        return value
            .replace(HEX_SECRET_RE, "0x[redacted]")
            .replace(WALLET_ADDRESS_RE, "0x[address-redacted]")
            .replace(BEARER_RE, "Bearer [redacted]");
    }

    if (Array.isArray(value)) {
        return value.map(redactSensitive);
    }

    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
            if (isSensitiveKey(key)) {
                out[key] = "[redacted]";
            } else {
                out[key] = redactSensitive(nested);
            }
        }
        return out;
    }

    return value;
}

export function safeLog(message: string, details?: unknown): void {
    if (details === undefined) {
        console.log(message);
        return;
    }
    console.log(message, redactSensitive(details));
}

export function safeWarn(message: string, details?: unknown): void {
    if (details === undefined) {
        console.warn(message);
        return;
    }
    console.warn(message, redactSensitive(details));
}

export function safeError(message: string, details?: unknown): void {
    if (details === undefined) {
        console.error(message);
        return;
    }
    console.error(message, redactSensitive(details));
}

export function debugLog(message: string, details?: unknown): void {
    if (process.env.CENTRYPT_DEBUG_LOGS !== "true") return;
    safeLog(message, details);
}

function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return SENSITIVE_KEYS.some(sensitive => normalized.includes(sensitive.toLowerCase()));
}
