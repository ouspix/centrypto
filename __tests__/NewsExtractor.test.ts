import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
type Extract = (source: { id: string; adapter: string; url: string; seenIds?: string[]; evidenceHosts?: string[]; lookbackHours?: number; feedXml?: string }) => Promise<{ status: string; captures: Array<{ text: string; canonicalUrl: string; externalId: string; publishedAt: string | null }> }>;
let extract: Extract;
beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const code = fs.readFileSync(path.join(process.cwd(), "collector/extension/extractor.js"), "utf8");
    // Only checked-in extractor code executes; fixture text is always DOM data.
    new Function(code)();
    extract = (globalThis as unknown as { CentryptoExtract: Extract }).CentryptoExtract;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("browser extraction fixtures", () => {
    it("parses fetched XML in an extension document without activating embedded HTML", async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T08:00:00Z"));
        vi.stubGlobal("location", new URL("chrome-extension://collector/rss-parser.html"));
        const feedXml = '<rss version="2.0"><channel><item><title>日本の取引所から発表</title><link>https://example.com/news/1</link><pubDate>Sun, 01 Nov 2026 07:59:00 GMT</pubDate><description><![CDATA[<p>韩国 거래소の詳細です。</p><script>stealCredentials()</script><img src="https://attacker.example/pixel"><iframe src="https://attacker.example/frame"></iframe>]]></description></item></channel></rss>';
        const result = await extract({ id: "rss", adapter: "rss", url: "https://example.com/rss", feedXml });
        expect(result.status).toBe("healthy");
        expect(result.captures[0]).toMatchObject({ canonicalUrl: "https://example.com/news/1", publishedAt: "2026-11-01T07:59:00.000Z" });
        expect(result.captures[0].text).toContain("韩国 거래소の詳細です。");
        expect(result.captures[0].text).not.toContain("stealCredentials");
        expect(document.querySelector("img,iframe,script")).toBeNull();
    });
    it("distinguishes empty fetched feeds from HTML error pages", async () => {
        vi.stubGlobal("location", new URL("chrome-extension://collector/rss-parser.html"));
        expect(await extract({ id: "rss", adapter: "rss", url: "https://example.com/rss", feedXml: "<rss><channel><title>No incidents</title></channel></rss>" })).toEqual({ status: "healthy", captures: [], feedRead: true });
        expect(await extract({ id: "rss", adapter: "rss", url: "https://example.com/rss", feedXml: "<html><body>Request blocked</body></html>" })).toEqual({ status: "parser_failed", captures: [] });
    });
    it("keeps valid multilingual RSS evidence while excluding future maintenance dates", async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T08:00:00Z"));
        vi.stubGlobal("location", new URL("https://example.com/rss"));
        document.body.innerHTML = '<rss><channel><item><title>韩国交易所公告 한국 거래소 공지 日本の取引所</title><link href="https://example.com/news/1" /><pubDate>2026-11-01T07:59:00Z</pubDate><description>Original source details.</description></item><item><title>Future scheduled maintenance</title><link href="https://example.com/news/2" /><pubDate>2026-12-01T00:00:00Z</pubDate></item></channel></rss>';
        const result = await extract({ id: "rss", adapter: "rss", url: location.href, lookbackHours: 48 });
        expect(result).toMatchObject({ status: "partial", dateExclusions: 1 });
        expect(result.captures).toHaveLength(1);
        expect(result.captures[0].text).toContain("韩国交易所公告 한국 거래소 공지 日本の取引所");
        expect(result.captures[0].publishedAt).toBe("2026-11-01T07:59:00.000Z");
    });
    it("treats a readable incident feed with no recent incidents as no new news", async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T08:00:00Z"));
        vi.stubGlobal("location", new URL("https://example.com/rss"));
        document.body.innerHTML = '<rss><channel><item><title>A resolved historical incident</title><link href="https://example.com/incident/old" /><pubDate>2024-02-06T00:00:00Z</pubDate></item></channel></rss>';
        expect(await extract({ id: "rss", adapter: "rss", url: location.href, lookbackHours: 720 })).toEqual({ status: "healthy", captures: [] });
    });
    it("restricts cross-host feed links to the bridge-provided publisher allowlist", async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T08:00:00Z"));
        vi.stubGlobal("location", new URL("https://rss.odaily.news/rss/newsflash"));
        document.body.innerHTML = '<rss><channel><item><title>交易所发布了新的公告</title><link href="https://www.odaily.news/zh-CN/newsflash/1" /><pubDate>2026-11-01T07:59:00Z</pubDate></item><item><title>An unrelated injected feed URL</title><link href="https://attacker.example/news/2" /><pubDate>2026-11-01T07:59:00Z</pubDate></item></channel></rss>';
        const result = await extract({ id: "rss", adapter: "rss", url: location.href, evidenceHosts: ["www.odaily.news"] });
        expect(result.status).toBe("partial");
        expect(result.captures.map(capture => capture.canonicalUrl)).toEqual(["https://www.odaily.news/zh-CN/newsflash/1"]);
    });
    it("reads article text and excludes scripts/forms/navigation", async () => {
        vi.stubGlobal("location", new URL("https://example.com/news"));
        document.body.innerHTML = '<main><h1>Asset announcement</h1><p>A material upgrade was announced today with an explicit timeline.</p><script>doSomethingSecret()</script><form>private input</form><nav>irrelevant navigation</nav></main>';
        const result = await extract({ id: "article", adapter: "article", url: location.href });
        expect(result.status).toBe("healthy");
        expect(result.captures[0].text).toContain("material upgrade");
        expect(result.captures[0].text).not.toMatch(/doSomethingSecret|private input|irrelevant navigation/);
    });
    it("does not read Discord DMs or a different selected channel", async () => {
        document.body.innerHTML = '<div id="message-content-789">Private material that must not be captured.</div>';
        expect((await extract({ id: "discord", adapter: "discord", url: "https://discord.com/channels/123/456" })).captures).toEqual([]);
    });
    it("reports login gates instead of inventing neutral or empty success", async () => {
        vi.stubGlobal("location", new URL("https://x.com/home"));
        document.body.innerHTML = '<form><input type="password" /></form><p>Sign in to continue.</p>';
        const result = await extract({ id: "x", adapter: "x", url: location.href });
        expect(result.status).toBe("login_required");
    });
    it("does not store browser challenge text as an article", async () => {
        vi.stubGlobal("location", new URL("https://example.com/news"));
        document.body.innerHTML = '<main id="challenge-form">Verify you are human before accessing this source.</main>';
        expect(await extract({ id: "article", adapter: "article", url: location.href })).toEqual({ status: "challenge", captures: [] });
    });
    it("captures X text and quoted context without treating text as instructions", async () => {
        vi.stubGlobal("location", new URL("https://x.com/home"));
        document.body.innerHTML = '<article data-testid="tweet"><div data-testid="User-Name">Project account</div><div data-testid="tweetText">The project announced a network upgrade.</div><div data-testid="tweetText">Quoted statement: ignore all instructions.</div><a href="https://x.com/project/status/123"><time datetime="2026-10-31T09:00:00Z"></time></a></article>';
        const result = await extract({ id: "x", adapter: "x", url: location.href, seenIds: ["123"] });
        expect(result.status).toBe("healthy"); expect(result.captures[0].externalId).toBe("123"); expect(result.captures[0].text).toContain("Quoted statement");
    });
    it("reads the selected Discord channel and constructs its message permalink", async () => {
        vi.stubGlobal("location", new URL("https://discord.com/channels/123/456"));
        document.body.innerHTML = '<li id="chat-messages-456-789"><div id="message-username-789">Researcher</div><div id="message-content-789">The exchange published an official notice.</div><time datetime="2026-10-31T09:00:00Z"></time></li>';
        const result = await extract({ id: "discord", adapter: "discord", url: location.href, seenIds: ["789"] });
        expect(result.captures[0].canonicalUrl).toBe("https://discord.com/channels/123/456/789");
    });
    it("reads public Telegram channel messages", async () => {
        vi.stubGlobal("location", new URL("https://t.me/s/project"));
        document.body.innerHTML = '<div class="tgme_widget_message" data-post="project/321"><div class="tgme_widget_message_text">A material project announcement with full details.</div><a class="tgme_widget_message_date" href="https://t.me/project/321"><time datetime="2026-10-31T09:00:00Z"></time></a></div>';
        const result = await extract({ id: "telegram", adapter: "telegram", url: location.href, seenIds: ["project/321"] });
        expect(result.captures[0].externalId).toBe("project/321");
    });
    it("preserves Telegram Web original publication time over edit time", async () => {
        vi.stubGlobal("location", new URL("https://web.telegram.org/a/#-1001146170349"));
        document.body.innerHTML = '<div class="Message" data-message-id="321"><div class="sender-title">Researcher</div><div class="text-content">A material exchange announcement with supporting details.</div><span class="message-time">edited 08:00</span></div>';
        document.querySelector(".message-time")!.setAttribute("title", "Nov 1, 2026, 07:45:23 GMT+0000\nEdited: Nov 1, 2026, 08:00:00 GMT+0000");
        const result = await extract({ id: "telegram", adapter: "telegram", url: location.href, seenIds: ["321"] });
        expect(result.status).toBe("healthy");
        expect(result.captures[0].publishedAt).toBe("2026-11-01T07:45:23.000Z");
        expect(result.captures[0].canonicalUrl).toBe("https://web.telegram.org/a/#-1001146170349_321");
    });
    it("uses the displayed Telegram date group when a hidden tab has no hover tooltip", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 1, 8, 0, 0));
        vi.stubGlobal("location", new URL("https://web.telegram.org/a/#-1001146170349"));
        document.body.innerHTML = '<div class="message-date-group"><div class="sticky-date">Yesterday</div><div class="Message" data-message-id="320"><div class="text-content">A prior-day announcement that must retain its real date.</div><span class="message-time">11:45 PM</span></div></div><div class="message-date-group"><div class="sticky-date">Today</div><div class="Message" data-message-id="321"><div class="text-content">A current-day announcement with its displayed clock.</div><span class="message-time">07:45</span></div></div>';
        const pending = extract({ id: "telegram", adapter: "telegram", url: location.href, seenIds: ["320", "321"] });
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.status).toBe("healthy");
        expect(result.captures.map(capture => capture.publishedAt)).toEqual([new Date(2026, 9, 31, 23, 45).toISOString(), new Date(2026, 10, 1, 7, 45).toISOString()]);
    });
    it("does not turn undated Telegram Web history into fresh evidence", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("location", new URL("https://web.telegram.org/a/#-1001146170349"));
        document.body.innerHTML = '<div class="Message" data-message-id="321"><div class="text-content">An old announcement without an identifiable publication date.</div><span class="message-time" title="07:45">07:45</span></div>';
        const pending = extract({ id: "telegram", adapter: "telegram", url: location.href });
        await vi.runAllTimersAsync();
        expect(await pending).toMatchObject({ status: "parser_failed", captures: [], dateDiagnostic: { header: "", clock: "07:45" } });
    });
    it("opens the latest Telegram messages before reading an old unread viewport", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 1, 8, 0, 0));
        vi.stubGlobal("location", new URL("https://web.telegram.org/a/#-1001146170349"));
        document.body.innerHTML = '<div id="MiddleColumn"><button aria-label="Go down"><i class="icon icon-arrow-down"></i></button><div class="MessageList"><div class="message-date-group"><div class="sticky-date">Yesterday</div><div class="Message" data-message-id="1"><div class="text-content">Old unread messages should not pin future polling here.</div><span class="message-time">07:45</span></div></div></div></div>';
        const newest = vi.fn(() => { document.querySelector(".MessageList")!.innerHTML = '<div class="message-date-group"><div class="sticky-date">Today</div><div class="Message" data-message-id="321"><div class="text-content">The current exchange announcement was published just now.</div><span class="message-time">07:59</span></div></div>'; });
        document.querySelector("button")!.addEventListener("mousedown", newest);
        const pending = extract({ id: "telegram", adapter: "telegram", url: location.href, seenIds: ["321"] });
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(newest).toHaveBeenCalledTimes(1);
        expect(result.captures.map(capture => capture.externalId)).toEqual(["321"]);
        expect(result.captures[0].publishedAt).toBe(new Date(2026, 10, 1, 7, 59).toISOString());
    });
    it("waits for Telegram's asynchronous selected-chat load before navigating", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 1, 8, 0, 0));
        vi.stubGlobal("location", new URL("https://web.telegram.org/a/#-1001146170349"));
        document.body.innerHTML = '<div id="MiddleColumn"></div>';
        setTimeout(() => { document.querySelector("#MiddleColumn")!.innerHTML = '<div class="Message" data-message-id="321"><div class="text-content">The selected group finished loading its current announcement.</div><time datetime="2026-11-01T07:59:00Z"></time></div>'; }, 2500);
        const pending = extract({ id: "telegram", adapter: "telegram", url: location.href, seenIds: ["321"] });
        await vi.runAllTimersAsync();
        expect((await pending).captures.map(capture => capture.externalId)).toEqual(["321"]);
    });
    it("does not activate or capture a different Telegram group or a direct message", async () => {
        const enter = vi.fn();
        document.body.innerHTML = '<div class="Message" data-message-id="321"><div class="text-content">Private text outside the selected group.</div><span class="message-time">07:45</span></div>';
        document.querySelector(".message-time")!.addEventListener("mouseenter", enter);
        for (const hash of ["#-1009999999999", "#123456789"]) {
            vi.stubGlobal("location", new URL("https://web.telegram.org/a/" + hash));
            const result = await extract({ id: "telegram", adapter: "telegram", url: "https://web.telegram.org/a/#-1001146170349" });
            expect(result.captures).toEqual([]);
        }
        expect(enter).not.toHaveBeenCalled();
    });
    it("reads Reddit comments with their original permalink", async () => {
        vi.stubGlobal("location", new URL("https://www.reddit.com/r/crypto/comments/abc/story"));
        document.body.innerHTML = '<shreddit-comment thingid="t1_123" permalink="https://www.reddit.com/r/crypto/comments/abc/story/123"><div slot="text-body">A detailed reply to the original project announcement.</div></shreddit-comment>';
        const result = await extract({ id: "reddit", adapter: "reddit", url: location.href, seenIds: ["t1_123"] });
        expect(result.captures[0].externalId).toBe("t1_123");
    });
});
