const puppeteer = require('puppeteer');

(async () => {
    // Launch the browser with necessary flags for WSL
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const page = await browser.newPage();

    // Capture console logs
    page.on('console', msg => {
        const type = msg.type().toUpperCase();
        const text = msg.text();
        console.log(`[BROWSER ${type}] ${text}`);
    });

    // Capture page errors (exceptions)
    page.on('pageerror', err => {
        console.error(`[BROWSER EXCEPTION] ${err.toString()}`);
    });

    // Capture failed requests (e.g. 404s)
    page.on('requestfailed', request => {
        console.error(`[BROWSER NETWORK ERROR] ${request.url()} ${request.failure().errorText}`);
    });

    console.log('Navigating to http://localhost:3000...');
    try {
        await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
        console.log('Page loaded successfully.');
    } catch (e) {
        console.error('Navigation failed:', e);
    }

    // Keep the script running for a bit to capture delayed logs
    // You can press Ctrl+C to exit
    await new Promise(r => setTimeout(r, 10000));

    await browser.close();
})();
