import "server-only";

export class InternalAuthError extends Error {
    public readonly status: number;

    constructor(message: string, status = 401) {
        super(message);
        this.name = "InternalAuthError";
        this.status = status;
    }
}

export function requireInternalRequest(request: Request): void {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) {
        if (process.env.NODE_ENV === "production") {
            throw new InternalAuthError("INTERNAL_API_TOKEN is required in production", 503);
        }
        return;
    }

    const authorization = request.headers.get("authorization");
    const headerToken = request.headers.get("x-internal-api-token");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
    const provided = bearer || headerToken;

    if (!provided || provided !== expected) {
        throw new InternalAuthError("Internal API token required");
    }
}
