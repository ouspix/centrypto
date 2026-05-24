function traderTimestamp(): string {
    return new Date().toISOString();
}

function prefix(scope?: string): string {
    return scope
        ? `[${traderTimestamp()}] [Trader ${scope}]`
        : `[${traderTimestamp()}] [Trader]`;
}

export function traderLog(message: string, scope?: string, ...details: unknown[]): void {
    console.log(prefix(scope), message, ...details);
}

export function traderWarn(message: string, scope?: string, ...details: unknown[]): void {
    console.warn(prefix(scope), message, ...details);
}

export function traderError(message: string, scope?: string, ...details: unknown[]): void {
    console.error(prefix(scope), message, ...details);
}
