// Scratch script for poking at one page with the extension loaded:
//   node test/debug.mjs <url> [settings-json|-] [screenshot.png|-] [file-with-js-expression]
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServers } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stop = startServers();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  pipe: true,
  enableExtensions: [join(here, '..', 'extension')],
  defaultViewport: { width: 1100, height: 900 },
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const worker = await sw.worker();
  await new Promise((r) => setTimeout(r, 800));
  if (process.argv[3] && process.argv[3] !== '-') {
    await worker.evaluate((patch) => chrome.storage.local.set({ settings: { ...LULL.DEFAULTS, ...patch } }), JSON.parse(process.argv[3]));
    await new Promise((r) => setTimeout(r, 300));
  }
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[console]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  await page.goto(process.argv[2], { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-lull-ready'), { timeout: 15000 }).catch(() => console.log('never ready'));
  await new Promise((r) => setTimeout(r, 1500));
  console.log(
    await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      color: getComputedStyle(document.body).color,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      adopted: document.adoptedStyleSheets.length,
      overrides: document.querySelectorAll('.lull-x').length,
    })),
  );
  if (process.argv[4] && process.argv[4] !== '-') await page.screenshot({ path: process.argv[4] });
  if (process.argv[5]) console.log(JSON.stringify(await page.evaluate(readFileSync(process.argv[5], 'utf8')), null, 1));
} finally {
  await browser.close();
  stop();
}
