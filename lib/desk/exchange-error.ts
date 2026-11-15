/** Keep useful venue diagnostics without persisting credentials or signed payloads. */
export function exchangeHttpError(endpoint: "info" | "exchange", status: number, body: string) {
    const detail = body
        .replace(/0x[0-9a-f]{32,}/gi, "[redacted]")
        .replace(/("?(?:signature|privateKey|apiKey|secret|authorization|accessToken)"?\s*[:=]\s*)(?:\{[^}]*\}|"[^"]*"|[^,\s]+)/gi, "$1[redacted]")
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/[\x00-\x1f\x7f]+/g, " ")
        .slice(0, 600).trim();
    // HTTP errors remain uncertain after dispatch. Reconciliation, never a
    // retry or status-code-only assumption, decides whether to release risk.
    return new Error(`Exchange ${endpoint} HTTP ${status}${detail ? ": " + detail : ""}`);
}
