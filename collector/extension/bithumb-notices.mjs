export function parseBithumbNotices(source, body, now = new Date()) {
    const notices = JSON.parse(body);
    if (!Array.isArray(notices) || notices.length > 20) return { status: "parser_failed", captures: [] };

    const captures = new Map();
    let invalidItems = 0;
    let dateExclusions = 0;
    for (const item of notices) {
        const externalId = typeof item?.pc_url === "string" && /^https:\/\/feed\.bithumb\.com\/notice\/(\d+)$/.exec(item.pc_url)?.[1];
        const text = typeof item?.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
        if (!externalId || text.length < 10 || text.length > 100_000) { invalidItems++; continue; }

        // The official API supplies Korean local time without an offset.
        const stamp = typeof item.published_at === "string" && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(item.published_at);
        const published = stamp ? Date.parse(`${stamp[1]}T${stamp[2]}+09:00`) : NaN;
        if (!Number.isFinite(published) || new Date(published + 9 * 3600_000).toISOString().slice(0, 19) !== `${stamp[1]}T${stamp[2]}`) {
            dateExclusions++;
            continue;
        }
        if (published > now.getTime()) continue;
        if (source.lookbackHours && published < now.getTime() - source.lookbackHours * 3600_000) continue;
        captures.set(externalId, {
            sourceId: source.id, externalId, canonicalUrl: item.pc_url, author: "Bithumb", text,
            publishedAt: new Date(published).toISOString(), collectedAt: now.toISOString(),
            completeness: "complete", mediaLinks: [],
        });
    }
    return {
        status: invalidItems || dateExclusions ? "partial" : "healthy",
        captures: [...captures.values()], feedRead: true, dateExclusions,
    };
}
