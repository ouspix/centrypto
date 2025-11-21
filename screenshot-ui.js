const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    console.log('Navigating to http://localhost:3000...');
    try {
        await page.goto('http://localhost:3000', { waitUntil: 'networkidle0', timeout: 30000 });
        console.log('Page loaded successfully.');

        // Take screenshot
        await page.screenshot({ path: 'ui-screenshot.png', fullPage: true });
        console.log('Screenshot saved to ui-screenshot.png');
    } catch (e) {
        console.error('Navigation failed:', e);
    }

    await browser.close();
})();
