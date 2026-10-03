// Makes the Chrome Web Store pictures in ./store: five 1280 x 800 screenshots and the
// 440 x 280 promo image. The screenshots are real: the demo site in tools/store-demo is
// loaded in Chrome with the extension installed, captured, and given a caption.
// Run with `node tools/make-store.mjs` (needs `npm install` first).
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(root, 'extension');
const DEMO = join(root, 'tools', 'store-demo');
const OUT = join(root, 'store');
mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(existsSync);
const HOST = 'harbournotes.example'; // a reserved name; it is pointed at this computer below
const PORT = 8950;
const SITE = `http://${HOST}:${PORT}/`;
const W = 1280;
const H = 800;
const BAND = 96; // caption strip under each capture
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.slice(1).replace(/[^a-z0-9.-]/gi, '');
  let body = null;
  try {
    body = readFileSync(join(DEMO, name));
  } catch {}
  res.writeHead(body ? 200 : 404, { 'content-type': TYPES[extname(name)] || 'application/octet-stream' });
  res.end(body || '');
}).listen(PORT, '127.0.0.1');

const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
const icon = dataUrl(readFileSync(join(EXT, 'icons', 'icon48.png')));

// ---- captures: the demo site in Chrome with Lull installed ------------------------

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
  defaultViewport: { width: W, height: H - BAND },
});
const shots = {};
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;
  for (let i = 0; i < 50 && !(await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)); i++) await sleep(100);
  const settings = async (patch) => {
    await worker.evaluate((p) => chrome.storage.local.set({ settings: { ...LULL.DEFAULTS, ...p } }), patch);
    await sleep(400);
  };

  const page = await browser.newPage();
  // Loads the demo site and scrolls so that `anchor` sits `offset` pixels below the top.
  const open = async ({ lull = true, anchor = null, offset = 0, width = W, height = H - BAND }) => {
    await page.setViewport({ width, height });
    await page.goto(SITE, { waitUntil: 'load' });
    if (lull) await page.waitForFunction(() => document.documentElement.hasAttribute('data-lull-ready'));
    if (anchor) await page.evaluate((sel, off) => scrollTo(0, document.querySelector(sel).getBoundingClientRect().top + scrollY - off), anchor, offset);
    await sleep(900); // pictures are analysed after they come into view
  };

  const detail = { anchor: '.note', offset: 130, width: W / 2 }; // the note, the diagram and the table

  await settings({ enabled: false });
  await open({ lull: false });
  shots.before = await page.screenshot();
  await open({ lull: false, ...detail });
  shots.coloursBefore = await page.screenshot();

  await settings({});
  await open({});
  shots.after = await page.screenshot();
  await open(detail);
  shots.colours = await page.screenshot();

  // Each palette is captured a little larger than its cell and shown at 80 %.
  for (const palette of ['slate', 'warm', 'dusk', 'moss']) {
    await settings({ palette });
    await open({ width: (W / 2) * 1.25, height: ((H - BAND) / 2) * 1.25 });
    shots[palette] = await page.screenshot();
  }

  await settings({ ruler: true });
  await open({ anchor: 'article p:nth-of-type(4)', offset: 250 });
  await page.mouse.move(520, 330);
  await sleep(300);
  shots.ruler = await page.screenshot();

  // The popup, opened as a page. It asks Chrome for "the active tab", which would be
  // itself, so that one question is answered with the demo site's tab instead.
  await settings({});
  await open({});
  const popup = await browser.newPage();
  await popup.setViewport({ width: 320, height: 600 });
  await popup.evaluateOnNewDocument((host) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = () => query({ url: `*://${host}/*` });
  }, HOST);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(500);
  const shown = await popup.evaluate(() => document.getElementById('host').textContent);
  if (shown !== HOST) throw new Error(`popup shows "${shown}", expected the demo site`);
  shots.popup = await popup.screenshot({ fullPage: true });
} finally {
  await browser.close();
}

// ---- slides: capture + caption, rendered in a browser without the extension ----------

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #15181c; font-family: 'Segoe UI', system-ui, sans-serif; }
  .shot { position: relative; width: ${W}px; height: ${H - BAND}px; overflow: hidden; }
  .shot img.full { display: block; width: ${W}px; height: ${H - BAND}px; }
  .band { display: flex; align-items: center; gap: 18px; height: ${BAND}px; padding: 0 36px; border-top: 1px solid #2c3037; background: #15181c; }
  .band img { width: 44px; height: 44px; }
  .band h1 { margin: 0 0 3px; color: #dfe4ea; font-size: 25px; font-weight: 600; }
  .band p { margin: 0; color: #9da2a8; font-size: 16px; }
  .half { position: absolute; top: 0; bottom: 0; left: 50%; right: 0; overflow: hidden; border-left: 3px solid #87aae7; }
  .half img { position: absolute; top: 0; left: -${W / 2 + 3}px; width: ${W}px; height: ${H - BAND}px; }
  .pill { position: absolute; top: 80px; padding: 6px 16px; border-radius: 16px; font-size: 15px; font-weight: 600; }
  .pill.left { right: calc(50% + 18px); background: #ffffff; color: #1c2530; border: 1px solid #c6ced8; }
  .pill.right { left: calc(50% + 21px); background: #24282e; color: #d1d6dc; border: 1px solid #3a3f47; }
  .pair { display: flex; width: ${W}px; height: ${H - BAND}px; }
  .pair div { position: relative; width: ${W / 2}px; overflow: hidden; }
  .pair div + div { border-left: 3px solid #87aae7; }
  .pair img { display: block; width: ${W / 2}px; height: ${H - BAND}px; }
  .pair .pill { top: 246px; right: 24px; left: auto; } /* beside the short heading, over no text */
  .popup { position: absolute; top: 12px; right: 28px; border: 1px solid #3a3f47; border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; width: ${W}px; height: ${H - BAND}px; }
  .grid div { position: relative; overflow: hidden; }
  .grid img { display: block; width: ${W / 2}px; height: ${(H - BAND) / 2}px; }
  .grid div:nth-child(odd) { border-right: 2px solid #15181c; }
  .grid div:nth-child(-n + 2) { border-bottom: 2px solid #15181c; }
  .grid span { position: absolute; left: 14px; bottom: 12px; padding: 4px 12px; border-radius: 13px; background: rgba(21, 24, 28, 0.88); border: 1px solid #3a3f47; color: #d1d6dc; font-size: 14px; font-weight: 600; }
`;
const band = (title, text) => `<div class="band"><img src="${icon}" alt=""><div><h1>${title}</h1><p>${text}</p></div></div>`;
const full = (buf) => `<img class="full" src="${dataUrl(buf)}" alt="">`;

// The popup is shown whole: at its own size if it fits above the caption, slightly smaller if not.
const popupHeight = Math.min(shots.popup.readUInt32BE(20), H - BAND - 26);

const slides = {
  'screenshot-1-before-after': `<div class="shot">${full(shots.before)}<div class="half"><img src="${dataUrl(shots.after)}" alt=""></div>
      <span class="pill left">Before</span><span class="pill right">With Lull</span></div>
    ${band('A soft dark theme for every website', 'No white flash while a page loads. No pure black, no pure white, no glaring colour.')}`,
  'screenshot-2-colours': `<div class="pair"><div><img src="${dataUrl(shots.coloursBefore)}" alt=""><span class="pill left">Before</span></div>
      <div><img src="${dataUrl(shots.colours)}" alt=""><span class="pill right">With Lull</span></div></div>
    ${band('Colours keep their meaning and lose their glare', 'Notes stay yellowish and links stay bluish. White diagrams are dimmed. Dark logos are flipped so they stay readable.')}`,
  'screenshot-3-settings': `<div class="shot">${full(shots.after)}<img class="popup" style="height:${popupHeight}px" src="${dataUrl(shots.popup)}" alt=""></div>
    ${band('Few settings, in plain words', 'Three sliders, three switches, four palettes. One switch turns Lull off for a site.')}`,
  'screenshot-4-palettes': `<div class="grid">${['slate', 'warm', 'dusk', 'moss']
    .map((p) => `<div><img src="${dataUrl(shots[p])}" alt=""><span>${p[0].toUpperCase() + p.slice(1)}</span></div>`)
    .join('')}</div>
    ${band('Four palettes, the same on every site', 'Slate, Warm, Dusk and Moss. Each keeps the same soft contrast.')}`,
  'screenshot-5-calm': `<div class="shot">${full(shots.ruler)}</div>
    ${band('Less movement, easier reading', 'Stops style-sheet animations, pauses video that starts by itself and freezes GIFs. The optional reading ruler keeps a few lines in view.')}`,
};

const moon = `<svg viewBox="0 0 100 100" width="92" height="92"><defs><mask id="m"><rect width="100" height="100" fill="#000"/><circle cx="47" cy="52" r="30" fill="#fff"/><circle cx="60" cy="41" r="25" fill="#000"/></mask></defs>
  <rect width="100" height="100" rx="22" fill="#2a2e36"/><rect width="100" height="100" fill="#d9d4c7" mask="url(#m)"/></svg>`;
const promo = `<!doctype html><style>
  body { margin: 0; width: 440px; height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    background: linear-gradient(160deg, #20242b, #171a1e); font-family: 'Segoe UI', system-ui, sans-serif; }
  .row { display: flex; align-items: center; gap: 22px; }
  h1 { margin: 0; color: #e1e6ed; font-size: 76px; font-weight: 600; letter-spacing: 0.01em; line-height: 1; }
  p { margin: 0; color: #a9aeb5; font-size: 23px; }
  .dots { display: flex; gap: 10px; margin-top: 6px; }
  .dots i { width: 34px; height: 8px; border-radius: 4px; }
</style><div class="row">${moon}<h1>Lull</h1></div><p>calm dark mode for every site</p>
<div class="dots"><i style="background:#5b6f8f"></i><i style="background:#8a7558"></i><i style="background:#74699a"></i><i style="background:#5f8068"></i></div>`;

const plain = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await plain.newPage();
  await page.setViewport({ width: W, height: H });
  for (const [name, body] of Object.entries(slides)) {
    await page.setContent(`<!doctype html><style>${css}</style>${body}`, { waitUntil: 'load' });
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`store/${name}.png`);
  }
  await page.setViewport({ width: 440, height: 280 });
  await page.setContent(promo, { waitUntil: 'load' });
  await page.screenshot({ path: join(OUT, 'promo-440x280.png') });
  console.log('store/promo-440x280.png');
} finally {
  await plain.close();
  server.close();
}
