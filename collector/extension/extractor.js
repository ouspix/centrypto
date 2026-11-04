/* Runs in the extension's isolated world. Exported global also supports DOM fixture tests. */
globalThis.CentryptoExtract = async function (source) {
    const clean = text => String(text || "").replace(/\s+/g, " ").trim();
    const text = node => clean(node?.textContent);
    const iso = value => { const date = new Date(value || ""); return Number.isFinite(date.getTime()) ? date.toISOString() : null; };
    const fetchedFeed = source.adapter === "rss" && typeof source.feedXml === "string";
    const feedDocument = fetchedFeed ? new DOMParser().parseFromString(source.feedXml, "application/xml") : document;
    if (fetchedFeed && (feedDocument.querySelector("parsererror") || !["rss", "feed"].includes(feedDocument.documentElement?.localName))) return { status: "parser_failed", captures: [] };
    const current = new URL(fetchedFeed ? source.url : location.href);
    const selected = new URL(source.url);
    const base = { sourceId: source.id, author: null, publishedAt: null, collectedAt: new Date().toISOString(), completeness: "complete", mediaLinks: [] };
    if (document.querySelector('#challenge-form,[id^="cf-chl-"],iframe[src*="captcha"]') || /^(?:just a moment|access denied|attention required)/i.test(document.title)) return { status: "challenge", captures: [] };
    if (current.hostname !== selected.hostname) return { status: "login_required", captures: [] };
    if (source.adapter === "discord" && (!/^\/channels\/\d+\/\d+/.test(current.pathname) || !current.pathname.startsWith(selected.pathname.replace(/\/$/, "")))) return { status: "inaccessible", captures: [] };
    if (source.adapter === "telegram" && selected.hostname === "web.telegram.org" && current.hash.split("_")[0] !== selected.hash.split("_")[0]) return { status: "inaccessible", captures: [] };
    if (source.adapter === "x" && /^\/(?:messages|i\/chat)(?:\/|$)/.test(current.pathname)) return { status: "inaccessible", captures: [] };
    const captures = new Map();
    const missingTelegramDates = new Set();
    let rssItems = 0;
    let dateExclusions = 0;
    let invalidFeedLinks = 0;
    let dateDiagnostic = null;
    const authenticatedTelegram = source.adapter === "telegram" && selected.hostname === "web.telegram.org";
    const telegramPublicationTime = node => {
        const dateTitle = node.querySelector(".message-time[title]")?.getAttribute("title")?.split(/\r?\n/)[0] || "";
        const explicit = iso(node.querySelector("time")?.dateTime) || (/\b\d{4}\b/.test(dateTitle) ? iso(dateTitle) : null);
        if (explicit) return explicit;
        // Web A renders tooltip titles lazily, and hidden collection tabs may
        // not paint them. Its displayed date group and unedited clock still
        // identify publication time to the minute, without activating page UI.
        const header = text(node.closest(".message-date-group")?.querySelector(".sticky-date"));
        const clockText = text(node.querySelector(".message-time"));
        dateDiagnostic = { header: header.slice(0, 60), clock: clockText.slice(0, 30) };
        const clock = clockText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
        if (!clock) return null;
        const date = new Date(base.collectedAt);
        if (header === "Yesterday") date.setDate(date.getDate() - 1);
        else if (header !== "Today") {
            const absolute = /\b\d{4}\b/.test(header) ? iso(header) : null;
            if (!absolute) return null;
            date.setTime(new Date(absolute).getTime());
        }
        let hour = Number(clock[1]);
        if (clock[4]) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (clock[4].toUpperCase() === "PM" ? 12 : 0); }
        if (hour > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59) return null;
        date.setHours(hour, Number(clock[2]), Number(clock[3] || 0), 0);
        return date.getTime() <= new Date(base.collectedAt).getTime() + 60_000 ? date.toISOString() : null;
    };
    const failureStatus = () => {
        const body = text(document.body).slice(0, 8000);
        if (/captcha|verify you are human|unusual traffic|security verification|blocked by network security/i.test(body)) return "challenge";
        if (/\/login|\/i\/flow\/(?:login|onboarding)/.test(location.pathname) || document.querySelector('input[type="password"]') || (source.adapter === "x" && /(?:email or username|sign in to x|continue with google)/i.test(body))) return "login_required";
        return /access denied|channel.*(?:not found|unavailable)|you do not have permission/i.test(body) ? "inaccessible" : "parser_failed";
    };
    const add = capture => {
        if (capture.text.length < 10 || !capture.externalId) return;
        try {
            const url = new URL(capture.canonicalUrl, selected.href);
            const allowedHost = url.hostname === selected.hostname || (source.adapter === "rss" && (source.evidenceHosts || []).includes(url.hostname));
            if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHost) return;
            captures.set(capture.externalId, { ...base, ...capture, canonicalUrl: url.toString(), text: capture.text.slice(0, 100000), completeness: capture.text.length > 100000 ? "partial" : "complete" });
            return true;
        } catch { /* Ignore malformed evidence links. */ }
    };
    const read = () => {
        if (source.adapter === "x") {
            for (const node of document.querySelectorAll('[data-testid="tweet"]')) {
                const anchors = [...node.querySelectorAll('a[href*="/status/"]')];
                const link = anchors.find(a => a.querySelector("time")) || anchors[0];
                const id = link?.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1];
                add({ externalId: id, canonicalUrl: link?.href, author: text(node.querySelector('[data-testid="User-Name"]')), publishedAt: iso(node.querySelector("time")?.dateTime), text: [...node.querySelectorAll('[data-testid="tweetText"]')].map(text).join(" Quoted text: "), mediaLinks: [...node.querySelectorAll('a[href*="/photo/"],a[href*="/video/"]')].map(a => a.href) });
            }
        } else if (source.adapter === "reddit") {
            for (const node of document.querySelectorAll('shreddit-post,shreddit-comment,[data-testid="post-container"],[data-testid="comment"],.thing.link,.thing.comment')) {
                const path = node.getAttribute("permalink") || node.querySelector('a[data-testid="post-title"],a.title,a[href*="/comments/"]')?.getAttribute("href");
                const id = node.getAttribute("thingid") || node.getAttribute("id") || path;
                const content = node.querySelector('[slot="text-body"],.usertext-body,[data-testid="comment-content"]') || node;
                add({ externalId: id, canonicalUrl: path, author: node.getAttribute("author") || text(node.querySelector(".author")), publishedAt: iso(node.getAttribute("created-timestamp") || node.querySelector("time")?.dateTime), text: clean((node.getAttribute("post-title") || "") + " " + text(content)) });
            }
        } else if (source.adapter === "discord") {
            for (const node of document.querySelectorAll('[id^="chat-messages-"],[data-list-item-id^="chat-messages___"]')) {
                const content = node.querySelector('[id^="message-content-"]');
                const id = content?.id?.replace("message-content-", "") || node.id?.split("-").pop();
                add({ externalId: id, canonicalUrl: selected.origin + selected.pathname.replace(/\/$/, "") + "/" + id, author: text(node.querySelector('[id^="message-username-"]')), publishedAt: iso(node.querySelector("time")?.dateTime), text: text(content) + " " + [...node.querySelectorAll('[class*="embedDescription"],[class*="repliedTextContent"]')].map(text).join(" "), mediaLinks: [...node.querySelectorAll('a[href*="cdn.discordapp"],a[href*="media.discordapp"]')].map(a => a.href) });
            }
        } else if (source.adapter === "telegram") {
            for (const node of document.querySelectorAll('.tgme_widget_message,.Message[data-message-id],.message[data-mid],.bubble[data-mid],[data-message-id].message')) {
                const id = node.getAttribute("data-post") || node.getAttribute("data-message-id") || node.getAttribute("data-mid");
                const link = node.querySelector(".tgme_widget_message_date")?.href || selected.href.split("_")[0] + "_" + id;
                const publishedAt = telegramPublicationTime(node);
                const content = text(node.querySelector(".tgme_widget_message_text,.text-content,.message-content,.message"));
                if (authenticatedTelegram && content.length >= 10 && !publishedAt) { missingTelegramDates.add(id); continue; }
                missingTelegramDates.delete(id);
                add({ externalId: id, canonicalUrl: link, author: text(node.querySelector(".tgme_widget_message_author,.sender-title")), publishedAt, text: content, mediaLinks: [...node.querySelectorAll('a[href*="video"],a[href*="photo"]')].map(a => a.href) });
            }
        } else if (source.adapter === "rss") {
            // Chrome may display feeds as an XML tree; XML source remains available through the DOM.
            for (const node of feedDocument.querySelectorAll("item,entry")) {
                rssItems++;
                const link = node.querySelector("link")?.getAttribute("href") || text(node.querySelector("link"));
                const body = node.querySelector("description,summary,content")?.textContent || "";
                const html = document.createElement("template");
                html.innerHTML = body;
                for (const element of html.content.querySelectorAll("script,style,iframe,object")) element.remove();
                const publishedAt = iso(text(node.querySelector("pubDate,published,updated")));
                // Status feeds may contain future scheduled-maintenance dates.
                // Exclude these entries rather than rejecting all valid items or
                // inventing a publication date that could leak future evidence.
                if (!publishedAt || new Date(publishedAt).getTime() > new Date(base.collectedAt).getTime() + 60_000) { dateExclusions++; continue; }
                if (source.lookbackHours && new Date(publishedAt).getTime() < new Date(base.collectedAt).getTime() - source.lookbackHours * 3600_000) continue;
                if (!add({ externalId: text(node.querySelector("guid,id")) || link, canonicalUrl: link, author: text(node.querySelector("author")), publishedAt, text: text(node.querySelector("title")) + " " + text(html.content) })) invalidFeedLinks++;
            }
        } else {
            const article = (document.querySelector("article,[role=main],main") || document.body).cloneNode(true);
            for (const node of article.querySelectorAll("script,style,nav,footer,header,form,button,aside")) node.remove();
            const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
            add({ externalId: canonical, canonicalUrl: canonical, author: document.querySelector('meta[name="author"]')?.content || null, publishedAt: iso(document.querySelector('meta[property="article:published_time"]')?.content || document.querySelector("time")?.dateTime), text: text(document.querySelector("h1")) + " " + text(article) });
        }
    };
    let previous = 0;
    let partial = false;
    let openedNewest = false;
    if (authenticatedTelegram) {
        // The document load event precedes Telegram's asynchronous chat load.
        for (let attempt = 0; attempt < 40 && !document.querySelector('.Message[data-message-id],.message[data-mid],.bubble[data-mid]'); attempt++) {
            if (location.hash.split("_")[0] !== selected.hash.split("_")[0]) return { status: "inaccessible", captures: [] };
            const status = failureStatus();
            if (status !== "parser_failed") return { status, captures: [] };
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    for (let step = 0; step < 8; step++) {
        if (authenticatedTelegram && location.hash.split("_")[0] !== selected.hash.split("_")[0]) return { status: "inaccessible", captures: [] };
        if (authenticatedTelegram && !openedNewest) {
            const newest = document.querySelector("#MiddleColumn button .icon-arrow-down")?.closest("button");
            if (newest && !newest.disabled) {
                // Web A's desktop Button invokes its handler on mousedown;
                // HTMLElement.click() alone never opens the live message range.
                newest.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
                newest.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
                newest.click();
                openedNewest = true;
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
        }
        read();
        if (!captures.size && failureStatus() !== "parser_failed") return { status: failureStatus(), captures: [] };
        const known = [...captures.keys()].filter(id => (source.seenIds || []).includes(id)).length;
        if (known >= 3 || (step > 0 && known > 0 && known === captures.size)) break;
        if (["article", "rss"].includes(source.adapter)) break;
        if (step > 1 && captures.size > 0 && captures.size === previous) { partial = (source.seenIds || []).length > 0 && known === 0; break; }
        previous = captures.size;
        const telegramList = source.adapter === "telegram" ? document.querySelector("#MiddleColumn .MessageList,.MessageList,.bubbles-inner") : null;
        const scrollable = source.adapter === "discord" ? document.querySelector('[data-list-id="chat-messages"]')?.parentElement : telegramList ? telegramList.scrollHeight > telegramList.clientHeight ? telegramList : telegramList.parentElement : null;
        if (scrollable) scrollable.scrollTop = 0;
        else window.scrollBy(0, Math.max(window.innerHeight, 800));
        if (step === 7) partial = true;
        await new Promise(resolve => setTimeout(resolve, 900));
    }
    partial ||= missingTelegramDates.size > 0 || captures.size > 200 || dateExclusions > 0 || invalidFeedLinks > 0;
    if (captures.size || (source.adapter === "rss" && (rssItems > 0 || fetchedFeed))) return { status: partial ? "partial" : "healthy", captures: [...captures.values()].slice(0, 200).map(item => ({ ...item, completeness: partial ? "partial" : item.completeness })), ...(fetchedFeed ? { feedRead: true } : {}), ...(dateExclusions ? { dateExclusions } : {}) };
    return { status: failureStatus(), captures: [], ...(authenticatedTelegram ? { dateDiagnostic: dateDiagnostic || { header: "[no message dates read]", clock: "" } } : {}) };
};
