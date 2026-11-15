export function isDeskStorageCorruption(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /database disk image is malformed|SQLITE_CORRUPT|database corruption|XX00[12]|invalid page in block|page verification failed/i.test(message);
}

export function isDeskDatabaseBusy(error: unknown): boolean {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    // Older persisted Prisma messages were truncated in the middle of "timed out".
    return code === "P1008" || code === "P2024" || code === "P2034" ||
        /SQLITE_BUSY|database is (?:locked|busy)|Operations timed o|Desk database is busy|Unable to start a transaction in the given time|expired transaction|Transaction already closed|Transaction API error: Transaction already|deadlock detected|could not serialize access/i.test(message);
}

export function deskErrorMessage(error: unknown): string {
    if (isDeskDatabaseBusy(error)) return "Desk database is busy. The worker will retry after the lock clears.";
    return error instanceof Error ? error.message.slice(0, 400) : "Desk work failed";
}
