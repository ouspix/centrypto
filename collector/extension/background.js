const BRIDGE = "http://127.0.0.1:4318";
let polling = false;
let initializing = false;
let foregroundQueue = Promise.resolve();
let creatingFeedParser = null;
async function request(route, method = "GET", body) {
    const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
    if (!bridgeToken) throw new Error("Collector is not paired");
    const response = await fetch(BRIDGE + route, { method, headers: { Authorization: `Bearer ${bridgeToken}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Bridge ${response.status}`);
    return response.json();
}
async function collect(task) {
    if (task.source.adapter === "rss") return collectFeed(task);
    const foreground = task.source.adapter === "telegram" && new URL(task.source.url).hostname === "web.telegram.org";
    if (!foreground) return collectSource(task, false);
    const pending = foregroundQueue.then(() => collectSource(task, true));
    foregroundQueue = pending.catch(() => {});
    return pending;
}
async function collectFeed(task) {
    let stage = "extract";
    try {
        const url = new URL(task.source.url);
        if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Invalid feed URL");
        if (!(await chrome.permissions.contains({ origins: [url.origin + "/*"] }))) return await request("/v1/captures", "POST", { taskId: task.id, status: "permission_required", captures: [] });
        const response = await fetch(url.href, { credentials: "omit", redirect: "error", headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(15000) });
        if ([401, 403].includes(response.status)) return await request("/v1/captures", "POST", { taskId: task.id, status: "inaccessible", captures: [] });
        if (!response.ok) throw new Error("Feed unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let feedXml = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > 5_000_000) throw new Error("Feed too large");
                feedXml += decoder.decode(value, { stream: true });
            }
            feedXml += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); }
        const parserUrl = chrome.runtime.getURL("rss-parser.html");
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [parserUrl] });
        if (!contexts.length) {
            if (!creatingFeedParser) creatingFeedParser = chrome.offscreen.createDocument({ url: "rss-parser.html", reasons: ["DOM_PARSER"], justification: "Parse registered public RSS text without download tabs or media." }).finally(() => { creatingFeedParser = null; });
            await creatingFeedParser;
        }
        const result = await chrome.runtime.sendMessage({ target: "rss-parser", source: { ...task.source, feedXml, seenIds: task.seenIds || [] } });
        if (!result) throw new Error("Feed parser unavailable");
        stage = "submit";
        await request("/v1/captures", "POST", { taskId: task.id, ...result });
    } catch (error) {
        await request("/v1/captures", "POST", { taskId: task.id, status: "parser_failed", captures: [], failureStage: stage, errorName: error?.name || "Error" }).catch(() => {});
    }
}
async function collectSource(task, foreground) {
    let tab;
    let previousTabId;
    let stage = "navigation";
    try {
        const permitted = await chrome.permissions.contains({ origins: [new URL(task.source.url).origin + "/*"] });
        if (!permitted) return await request("/v1/captures", "POST", { taskId: task.id, status: "permission_required", captures: [] });
        if (foreground) previousTabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
        tab = await chrome.tabs.create({ url: "about:blank", active: false });
        await chrome.storage.session.set({ [`collectorTab:${tab.id}`]: task.id });
        // Telegram intentionally opens unread history in background tabs. Briefly
        // foreground the selected group so its normal client loads the live end.
        await chrome.tabs.update(tab.id, { url: task.source.url, ...(foreground ? { active: true } : {}) });
        for (let attempt = 0; attempt < 40; attempt++) {
            const state = await chrome.tabs.get(tab.id);
            if (state.status === "complete") break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        // Every capture is initiated by a leased, allowlisted source task. Normal browsing is never captured.
        stage = "inject";
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["extractor.js"] });
        stage = "extract";
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async source => globalThis.CentryptoExtract(source), args: [{ ...task.source, seenIds: task.seenIds || [] }] });
        const result = results[0]?.result;
        if (!result) throw new Error("No extraction result");
        stage = "submit";
        await request("/v1/captures", "POST", { taskId: task.id, ...result });
    } catch (error) {
        // No page contents, account details, or tokens enter diagnostic logs.
        await request("/v1/captures", "POST", { taskId: task.id, status: "parser_failed", captures: [], failureStage: stage, errorName: error?.name || "Error" }).catch(() => {});
    } finally { if (tab?.id) {
        if (foreground && previousTabId) {
            const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0]?.id;
            if (active === tab.id) await chrome.tabs.update(previousTabId, { active: true }).catch(() => {});
        }
        await chrome.tabs.remove(tab.id).catch(() => {});
        await chrome.storage.session.remove(`collectorTab:${tab.id}`);
    } }
}
async function poll() {
    if (polling) return;
    polling = true;
    try {
        // Drain overdue work in bounded batches without exceeding two tabs.
        // Waiting for the next 30-second alarm after every pair otherwise caps
        // throughput below the configured one-/five-minute registry cadence.
        for (let batch = 0; batch < 6; batch++) {
            const { tasks } = await request("/v1/tasks");
            if (!tasks.length) break;
            await Promise.all(tasks.slice(0, 2).map(collect));
        }
        await chrome.storage.local.set({ lastBridgeSuccess: new Date().toISOString() });
    } catch { /* Durable leases expire on the bridge; a later alarm resumes collection. */ }
    finally { polling = false; }
}
async function initialize() {
    if (initializing) return;
    initializing = true;
    const stored = await chrome.storage.local.get(null);
    // Tab IDs are only valid for one browser session. Discard old local markers
    // without closing tabs that may now belong to a human sign-in session.
    for (const key of Object.keys(stored).filter(key => key.startsWith("collectorTab:"))) {
        await chrome.storage.local.remove(key);
    }
    const currentSession = await chrome.storage.session.get(null);
    for (const key of Object.keys(currentSession).filter(key => key.startsWith("collectorTab:"))) {
        await chrome.tabs.remove(Number(key.split(":")[1])).catch(() => {});
        await chrome.storage.session.remove(key);
    }
    if (!(await chrome.alarms.get("collector"))) await chrome.alarms.create("collector", { periodInMinutes: 0.5 });
    initializing = false;
    await poll();
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "collector") void poll(); });
chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
void initialize();
