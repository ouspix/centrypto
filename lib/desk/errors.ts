export function isDeskStorageCorruption(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /database disk image is malformed|SQLITE_CORRUPT|database corruption/i.test(message);
}

export function isDeskDatabaseBusy(error: unknown): boolean {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    // Older persisted Prisma messages were truncated in the middle of "timed out".
    return code === "P1008" || /SQLITE_BUSY|database is (?:locked|busy)|Operations timed o|Desk database is busy/i.test(message);
}

export function deskErrorMessage(error: unknown): string {
    if (isDeskDatabaseBusy(error)) return "Desk database is busy. The worker will retry after the lock clears.";
    return error instanceof Error ? error.message.slice(0, 400) : "Desk work failed";
}
