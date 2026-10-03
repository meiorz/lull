// Loads real websites with the extension and reports, for each: how long the curtain stayed
// up after the page's own DOMContentLoaded, how bright the result is, and any script errors.
// Screenshots go to test/out/sites. Usage: node test/sites.mjs [--off] [url ...]
// --off loads the same pages with Lull paused, to compare how much work Lull adds.
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out', 'sites');
mkdirSync(OUT, { recursive: true });

const OFF = process.argv.includes('--off');
const args = process.argv.slice(2).filter((a) => a !== '--off');
const SITES = args.length ? args : [
  'https://en.wikipedia.org/wiki/Autism',
  'https://news.ycombinator.com/',
  'https://github.com/darkreader/darkreader',
  'https://www.bbc.com/news',
  'https://stackoverflow.com/questions/11227809',
  'https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme',
  'https://tailwindcss.com/',
  'https://www.theguardian.com/international',
  'https://old.reddit.com/r/programming/',
  'https://docs.python.org/3/tutorial/index.html',
  'https://www.amazon.com/',
  'https://www.nytimes.com/',
];

function brightness(file) {
  const buf = readFileSync(file);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const bpp = buf[25] === 6 ? 4 : 3;
  const parts = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    if (buf.toString('latin1', p + 4, p + 8) === 'IDAT') parts.push(buf.subarray(p + 8, p + 8 + len));
    p += len + 12;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = w * bpp;
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let sum = 0;
  let bright = 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    const type = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    if (y % 4 === 0) {
      for (let x = 0; x < w; x += 4) {
        const l = (0.2126 * cur[x * bpp] + 0.7152 * cur[x * bpp + 1] + 0.0722 * cur[x * bpp + 2]) / 255;
        sum += l;
        if (l > 0.8) bright++;
        count++;
      }
    }
    cur.copy(prev);
  }
  return { mean: sum / count, brightShare: bright / count };
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  pipe: true,
  enableExtensions: [join(here, '..', 'extension')],
  defaultViewport: { width: 1280, height: 900 },
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker');
  await new Promise((r) => setTimeout(r, 1000));
  // LULL_SETTINGS='{"stillness":false}' overrides individual settings for a run.
  const patch = OFF ? { enabled: false } : process.env.LULL_SETTINGS ? JSON.parse(process.env.LULL_SETTINGS) : null;
  if (patch) {
    const worker = await sw.worker();
    await worker.evaluate((p) => chrome.storage.local.set({ settings: { ...LULL.DEFAULTS, ...p } }), patch);
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const url of SITES) {
    const name = new URL(url).hostname.replace(/^www\./, '');
    const page = await browser.newPage();
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    const errors = [];
    page.on('pageerror', (e) => {
      if (/chrome-extension:/.test(e.stack || '')) errors.push(String(e.stack).split('\n').slice(0, 3).join(' '));
    });
    await page.evaluateOnNewDocument(() => {
      window.__lull = { long: 0 };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__lull.long += e.duration;
      }).observe({ type: 'longtask', buffered: true });
      const note = () => {
        if (document.documentElement && document.documentElement.hasAttribute('data-lull-ready') && !window.__lull.ready) window.__lull.ready = performance.now();
      };
      new MutationObserver(note).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-lull-ready'] });
    });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForFunction(() => window.__lull && window.__lull.ready, { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      const info = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return {
          dcl: Math.round(nav.domContentLoadedEventEnd),
          ready: window.__lull.ready ? Math.round(window.__lull.ready) : null,
          long: Math.round(window.__lull.long),
          rules: [...document.styleSheets].reduce((n, s) => { try { return n + s.cssRules.length; } catch { return n; } }, 0),
          overrides: document.querySelectorAll('style.lull-x').length,
          nodes: document.querySelectorAll('*').length,
        };
      });
      const file = join(OUT, `${name}${OFF ? '.off' : ''}.png`);
      await page.screenshot({ path: file });
      const b = brightness(file);
      console.log(
        `${name.padEnd(26)} ready ${info.ready === null ? 'NEVER' : String(info.ready - info.dcl).padStart(5) + 'ms after DCL'}  long tasks ${String(info.long).padStart(5)}ms  ` +
          `rules ${String(info.rules).padStart(6)}  foreign sheets ${String(info.overrides).padStart(2)}  nodes ${String(info.nodes).padStart(5)}  ` +
          `mean brightness ${b.mean.toFixed(2)}  bright area ${(b.brightShare * 100).toFixed(1)}%` +
          (errors.length ? `\n    ERRORS: ${errors.join(' | ')}` : ''),
      );
    } catch (err) {
      console.log(`${name.padEnd(26)} could not load: ${String(err).split('\n')[0]}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
