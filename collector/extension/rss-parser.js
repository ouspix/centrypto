chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.target !== "rss-parser" || message.source?.adapter !== "rss" || typeof message.source.feedXml !== "string") return false;
    // Text is parsed into detached documents only. No remote scripts, media,
    // frames, links or instructions from a feed are activated.
    globalThis.CentryptoExtract(message.source).then(respond).catch(() => respond({ status: "parser_failed", captures: [] }));
    return true;
});
