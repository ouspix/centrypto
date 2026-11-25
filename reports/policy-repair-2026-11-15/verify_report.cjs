const puppeteer=require('puppeteer');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
  const folder=__dirname;
  const output='C:\\Users\\melli\\.codex\\research\\centrypto\\policy-repair-2026-11-15';
  const browser=await puppeteer.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--no-first-run','--no-default-browser-check','--disable-background-networking']});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.setViewport({width:1280,height:1000});
    await page.goto('file://wsl.localhost/Ubuntu/home/mellinien/projects/centrypto/reports/policy-repair-2026-11-15/REPORT.html',{waitUntil:'load'});
    const desktop=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,images:[...document.images].map(i=>({loaded:i.complete&&i.naturalWidth>0,width:i.naturalWidth})),tables:document.querySelectorAll('table').length}));
    await page.screenshot({path:path.join(output,'report-desktop.png')});
    await page.setViewport({width:390,height:844});
    const mobile=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
    await page.screenshot({path:path.join(output,'report-mobile.png')});
    const result={desktop,mobile,errors};
    fs.writeFileSync(path.join(folder,'render-verification.json'),JSON.stringify(result,null,2));
    if(errors.length||desktop.images.some(i=>!i.loaded)||mobile.scrollWidth>mobile.width)throw new Error('Report render failed: '+JSON.stringify(result));
    console.log(JSON.stringify(result));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
