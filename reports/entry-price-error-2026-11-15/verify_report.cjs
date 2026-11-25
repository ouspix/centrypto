const puppeteer = require('puppeteer');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const output = 'C:\\Users\\melli\\.codex\\research\\centrypto\\entry-price-error-2026-11-15';
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const captures = [];
    for (const [name, width, height] of [['desktop', 1280, 1100], ['mobile', 390, 844]]) {
      await page.setViewport({width, height});
      await page.goto('file://wsl.localhost/Ubuntu/home/mellinien/projects/centrypto/reports/entry-price-error-2026-11-15/REPORT.html', {waitUntil: 'load'});
      const info = await page.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, tables: document.querySelectorAll('table').length, title: document.querySelector('h1').textContent}));
      await page.screenshot({path: path.join(output, `report-${name}.png`)});
      captures.push({name, ...info});
      if (info.scrollWidth > info.width || info.tables !== 2) throw new Error('Report layout failed');
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const result = {status: 'passed', captures, errors};
    fs.writeFileSync(path.join(__dirname, 'render-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode = 1;});
