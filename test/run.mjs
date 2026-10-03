// End-to-end tests: loads the unpacked extension into the installed Chrome and checks what
// real pages look like afterwards. Run with `npm test`. Set CHROME to use another browser.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServers, SITE } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, '..', 'extension');
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].find(existsSync);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : '  ->  ' + detail}`);
}

function rgb(text) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(text || '');
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
}
function lum(text) {
  const c = rgb(text);
  if (!c) return NaN;
  const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
const isDark = (text) => lum(text) < 0.09;
const isLight = (text) => lum(text) > 0.3;

// Mean brightness (0-1) of a PNG, used to look for white flashes in recorded frames.
function pngBrightness(buf) {
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
    if (y % 6 === 0) {
      for (let x = 0; x < w; x += 6) {
        sum += (0.2126 * cur[x * bpp] + 0.7152 * cur[x * bpp + 1] + 0.0722 * cur[x * bpp + 2]) / 255;
        count++;
      }
    }
    cur.copy(prev);
  }
  return sum / count;
}

const stopServers = startServers();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1100,900'],
  defaultViewport: { width: 1100, height: 900 },
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const worker = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  for (let i = 0; i < 50; i++) {
    if (await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)) break;
    await sleep(100);
  }
  const defaults = await worker.evaluate(() => LULL.DEFAULTS);
  const setSettings = async (patch) => {
    await worker.evaluate((s) => chrome.storage.local.set({ settings: s }), { ...defaults, ...patch });
    await sleep(350);
  };

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const ready = () => page.waitForFunction(() => document.documentElement.hasAttribute('data-lull-ready'), { timeout: 10000 });
  const style = (sel, prop = 'backgroundColor') =>
    page.evaluate(
      (sel, prop) => {
        const parts = sel.split('>>>');
        let el = document.querySelector(parts[0]);
        for (const part of parts.slice(1)) el = el.shadowRoot.querySelector(part);
        return getComputedStyle(el)[prop];
      },
      sel,
      prop,
    );
  const attr = (sel, name) => page.evaluate((sel, name) => document.querySelector(sel).getAttribute(name), sel, name);

  // ---- a light page -------------------------------------------------------------
  console.log('\nLight page');
  await page.goto(`http://localhost:${SITE}/light.html`);
  await ready();
  await page.waitForFunction(() => document.querySelector('#img-gif').hasAttribute('data-lull-gif'), { timeout: 8000 }).catch(() => {});
  await sleep(300);

  check('page background is dark', isDark(await style('html')) && isDark(await style('body')), await style('body'));
  const bodyText = rgb(await style('body', 'color'));
  check('body text is light but not pure white', isLight(await style('body', 'color')) && Math.max(bodyText.r, bodyText.g, bodyText.b) < 245, await style('body', 'color'));
  const base = rgb(await style('body'));
  check('background is not pure black', base.r + base.g + base.b > 40, await style('body'));

  for (const id of ['site-card', 'cdn-card', 'cdn-var', 'cdn-mq', 'cdn-layer', 'cdn-pic', 'var', 'hsl', 'tw', 'short', 'oklch', 'layered', 'mq', 'nest', 'vivid', 'darkpart', 'inline', 'inlinevar', 'bgcolor']) {
    const bg = await style('#' + id);
    check(`#${id} background is dark`, isDark(bg), bg);
  }
  for (const id of ['plain', 'site-card', 'cdn-card', 'cdn-var', 'var', 'hsl', 'oklch', 'inline', 'font', 'link', 'vivid', 'cdn-btn']) {
    const fg = await style('#' + id, 'color');
    check(`#${id} text is light`, isLight(fg), fg);
  }
  const grad = await style('#grad', 'backgroundImage');
  check('gradient stops are dark', /gradient/.test(grad) && !/255, 255, 255|238, 238, 238/.test(grad), grad);
  const btn = rgb(await style('#cdn-btn'));
  check('button keeps its hue but is muted', btn.b > btn.r && btn.b < 180, JSON.stringify(btn));
  const brand = rgb(await style('#brand'));
  check('rgb(var(--triplet)) is themed', brand.b > brand.r && brand.b < 180, JSON.stringify(brand));
  const order = rgb(await style('#cdn-order', 'color'));
  check('cross-origin rule order is kept (inherit wins over earlier red)', order.g > order.r, JSON.stringify(order));
  const vivid = rgb(await style('#vivid'));
  check('vivid yellow is muted', Math.max(vivid.r, vivid.g, vivid.b) - Math.min(vivid.r, vivid.g, vivid.b) < 70, JSON.stringify(vivid));
  check('border from var() shorthand is themed', lum(await style('#short', 'borderTopColor')) < 0.2, await style('#short', 'borderTopColor'));
  check('spacing variable still works', (await style('#var', 'paddingTop')) === '8px', await style('#var', 'paddingTop'));
  check('cross-origin url() still resolves against the CDN', /localhost:8932\/photo\.png/.test(await style('#cdn-pic', 'backgroundImage')), await style('#cdn-pic', 'backgroundImage'));

  for (const id of ['broken', 'site-broken']) {
    const bi = await style('#' + id, 'backgroundImage');
    check(`#${id}: shorthand split by a later longhand is themed`, /gradient/.test(bi) && !/255, 255, 255/.test(bi) && (await style('#' + id, 'backgroundRepeat')) === 'no-repeat', bi + ' ' + (await style('#' + id, 'backgroundRepeat')));
  }
  check('#cdn-broken: split shorthand in a cross-origin sheet is themed', isDark(await style('#cdn-broken')) && (await style('#cdn-broken', 'backgroundRepeat')) === 'repeat-x' && /localhost:8932.photo/.test(await style('#cdn-broken', 'backgroundImage')), `${await style('#cdn-broken')} ${await style('#cdn-broken', 'backgroundRepeat')} ${await style('#cdn-broken', 'backgroundImage')}`);
  check('#cdn-broken: split border keeps its later longhand', (await style('#cdn-broken', 'borderTopWidth')) === '0px' && (await style('#cdn-broken', 'borderBottomWidth')) === '2px' && lum(await style('#cdn-broken', 'borderBottomColor')) > 0.1, `${await style('#cdn-broken', 'borderTopWidth')} ${await style('#cdn-broken', 'borderBottomColor')}`);
  check('#broken-border: split border is themed', (await style('#broken-border', 'borderTopWidth')) === '0px' && lum(await style('#broken-border', 'borderBottomColor')) < 0.2, `${await style('#broken-border', 'borderTopWidth')} ${await style('#broken-border', 'borderBottomColor')}`);
  check('multiply blend mode is neutralised', (await style('#img-product', 'mixBlendMode')) === 'normal', await style('#img-product', 'mixBlendMode'));

  check('open shadow root is themed', isDark(await style('#open>>>#in')), await style('#open>>>#in'));
  check('inline style inside a shadow root is themed', isDark(await style('#open>>>#in-inline')), await style('#open>>>#in-inline'));
  check('closed shadow root is themed', isDark(await page.evaluate(() => window.closedProbe())), await page.evaluate(() => window.closedProbe()));
  check('adopted style sheet is themed', isDark(await style('#adopted>>>#in')), await style('#adopted>>>#in'));

  check('SVG with default fill becomes light', isLight(await style('#svg-default path', 'fill')), await style('#svg-default path', 'fill'));
  check('outline SVG keeps fill none', (await style('#svg-outline-path', 'fill')) === 'none', await style('#svg-outline-path', 'fill'));
  check('outline SVG stroke becomes light', isLight(await style('#svg-outline-path', 'stroke')), await style('#svg-outline-path', 'stroke'));
  check('dark disc becomes light', isLight(await style('#svg-disc', 'fill')), await style('#svg-disc', 'fill'));
  check('white tick on the disc becomes dark', isDark(await style('#svg-tick', 'stroke')), await style('#svg-tick', 'stroke'));
  check('SVG fill written with var() becomes light', isLight(await style('#svg-var-path', 'fill')), await style('#svg-var-path', 'fill'));
  check('lone white glyph stays light', isLight(await style('#svg-white', 'fill')), await style('#svg-white', 'fill'));

  check('dark logo on another origin is inverted', (await attr('#img-logo-x', 'data-lull-img')) === 'invert', await attr('#img-logo-x', 'data-lull-img'));
  check('dark logo on the same origin is inverted', (await attr('#img-logo', 'data-lull-img')) === 'invert', await attr('#img-logo', 'data-lull-img'));
  check('colourful dark logo gets a plate', (await attr('#img-color', 'data-lull-img')) === 'plate', await attr('#img-color', 'data-lull-img'));
  check('white diagram is dimmed more', (await attr('#img-bright', 'data-lull-img')) === 'bright', await attr('#img-bright', 'data-lull-img'));
  check('ordinary picture is left alone', (await attr('#img-photo', 'data-lull-img')) === null, await attr('#img-photo', 'data-lull-img'));
  check('black SVG picture is inverted', (await attr('#img-svg', 'data-lull-img')) === 'invert', await attr('#img-svg', 'data-lull-img'));
  check('white photo on a host that allows reads is dimmed more', (await attr('#img-product', 'data-lull-img')) === 'bright', await attr('#img-product', 'data-lull-img'));
  check('large photo on a host that forbids reads is left alone', (await attr('#img-private', 'data-lull-img')) === null, await attr('#img-private', 'data-lull-img'));
  check('GIF is frozen', (await attr('#img-gif', 'data-lull-gif')) === '' && /^data:image\/png/.test(await attr('#img-gif', 'src')), await attr('#img-gif', 'src'));
  check('pictures are dimmed', /brightness/.test(await style('#img-photo', 'filter')), await style('#img-photo', 'filter'));

  check('animations are stopped', parseFloat(await style('#spin', 'animationDuration')) < 0.001, await style('#spin', 'animationDuration'));
  check('transitions are stopped', parseFloat(await style('#spin', 'transitionDuration')) < 0.001, await style('#spin', 'transitionDuration'));
  check('audio that starts by itself is paused', await page.evaluate(() => document.querySelector('#audio').paused));
  const frame = () => page.frames().find((f) => f.url().includes('frame.html'));
  const frameBg = () => frame().evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('frame from another site is themed', isDark(await frameBg()), await frameBg());
  const status = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost/*' });
      return chrome.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 });
    });
  const st = await status();
  check('page reports its state to the popup', st && st.mode === 'smart' && st.dark === false && st.host === 'localhost', JSON.stringify(st));
  await setSettings({ ruler: true });
  check('reading ruler appears when switched on', (await page.evaluate(() => document.querySelectorAll('lull-ruler').length)) === 1);
  await setSettings({});
  check('reading ruler goes away when switched off', (await page.evaluate(() => document.querySelectorAll('lull-ruler').length)) === 0);
  await page.screenshot({ path: join(OUT, 'light.png'), fullPage: true });

  // Content added by script must be themed before it is painted: read it in the same task.
  const late = await page.evaluate(async () => {
    window.addLate();
    await new Promise((r) => requestAnimationFrame(r));
    const bg = (el) => getComputedStyle(el).backgroundColor;
    return {
      rule: bg(document.querySelector('#late')),
      inline: bg(document.querySelector('#late-inline')),
      shadow: bg(document.querySelector('#late-box').shadowRoot.querySelector('#in')),
    };
  });
  check('rule inserted by script is themed by the next frame', isDark(late.rule), late.rule);
  check('late inline style is themed by the next frame', isDark(late.inline), late.inline);
  check('late shadow root is themed by the next frame', isDark(late.shadow), late.shadow);

  await setSettings({ palette: 'warm', contrast: 100 });
  const warm = rgb(await style('body'));
  check('changing the palette re-themes the open page', warm.r > warm.b && isDark(await style('body')), JSON.stringify(warm));
  check('re-themed cross-origin sheet', rgb(await style('#cdn-card')).r > rgb(await style('#cdn-card')).b, await style('#cdn-card'));
  check('re-themed inline style', rgb(await style('#inline')).r > rgb(await style('#inline')).b, await style('#inline'));

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  check('printing uses the original colours', lum(await style('#site-card')) > 0.9 && lum(await style('#cdn-card')) > 0.9, `${await style('#site-card')} ${await style('#cdn-card')}`);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check('theme returns after printing', isDark(await style('#site-card')) && isDark(await style('#cdn-card')), await style('#site-card'));

  await setSettings({ sites: { localhost: { mode: 'off' } } });
  check('switching the site off restores every colour', lum(await style('#site-card')) > 0.9 && lum(await style('#cdn-card')) > 0.9 && lum(await style('#inline')) > 0.9 && lum(await style('#var')) > 0.9 && lum(await style('#open>>>#in')) > 0.9, `${await style('#site-card')} ${await style('#cdn-card')} ${await style('#inline')} ${await style('#var')}`);
  check('switching off restores a split shorthand exactly', /255, 255, 255/.test(await style('#broken', 'backgroundImage')) && (await style('#broken', 'backgroundRepeat')) === 'no-repeat' && (await style('#broken-border', 'borderTopWidth')) === '0px', `${await style('#broken', 'backgroundImage')} ${await style('#broken', 'backgroundRepeat')}`);
  check('switching off removes Lull attributes', (await page.evaluate(() => document.querySelectorAll('[data-lull-s],[data-lull-p],[data-lull-img],[data-lull-gif],.lull-x').length)) === 0);
  check('switching the top site off also switches off its frames', lum(await frameBg()) > 0.9, await frameBg());
  check('switching off unfreezes the GIF', /anim\.gif$/.test(await attr('#img-gif', 'src')), await attr('#img-gif', 'src'));

  await page.reload();
  await sleep(800);
  check('control: with Lull off the same audio plays', await page.evaluate(() => !document.querySelector('#audio').paused));
  check('a site that is switched off never sees the curtain', lum(await style('body')) > 0.9 && !(await page.evaluate(() => document.documentElement.hasAttribute('data-lull-ready') && getComputedStyle(document.documentElement).colorScheme === 'dark')), await style('body'));

  await setSettings({});
  await sleep(500);
  check('switching the site back on themes it without a reload', isDark(await style('#site-card')) && isDark(await style('#cdn-card')) && isDark(await style('#inline')), `${await style('#site-card')} ${await style('#cdn-card')}`);

  // ---- no white flash -------------------------------------------------------------
  console.log('\nFlash test (every painted frame is recorded)');
  async function record(url) {
    const cdp = await page.createCDPSession();
    const frames = [];
    cdp.on('Page.screencastFrame', (f) => {
      frames.push(f.data);
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await page.goto(url);
    await sleep(2600);
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
    return frames.map((data) => pngBrightness(Buffer.from(data, 'base64')));
  }
  const withLull = await record(`http://localhost:${SITE}/slow.html`);
  const brightest = Math.max(...withLull);
  check(`no bright frame while a slow white page loads (${withLull.length} frames, brightest ${brightest.toFixed(2)})`, withLull.length > 1 && brightest < 0.3, withLull.map((v) => v.toFixed(2)).join(' '));
  await setSettings({ sites: { localhost: { mode: 'off' } } });
  const without = await record(`http://localhost:${SITE}/slow.html`);
  check(`control: the same page without Lull is bright (brightest ${Math.max(...without).toFixed(2)})`, Math.max(...without) > 0.8);
  await setSettings({});

  // ---- a page that is already dark ---------------------------------------------------
  console.log('\nDark page');
  await page.goto(`http://localhost:${SITE}/dark.html`);
  await ready();
  await sleep(200);
  const dbg = rgb(await style('body'));
  check('pure black is lifted to a soft dark', isDark(await style('body')) && dbg.r + dbg.g + dbg.b > 40, await style('body'));
  const dfg = rgb(await style('body', 'color'));
  check('pure white text is softened', isLight(await style('body', 'color')) && Math.max(dfg.r, dfg.g, dfg.b) < 245, await style('body', 'color'));
  const neon = rgb(await style('#link', 'color'));
  check('neon link is muted', Math.max(neon.r, neon.g, neon.b) - Math.min(neon.r, neon.g, neon.b) < 120, JSON.stringify(neon));
  const alert = rgb(await style('#alert'));
  check('vivid red block is muted', alert.r < 200, JSON.stringify(alert));
  await page.screenshot({ path: join(OUT, 'dark.png') });
  await setSettings({ darkSites: 'leave' });
  await page.reload();
  await ready();
  await sleep(200);
  check('"leave alone" keeps a dark site exactly as it was', (await style('body')) === 'rgb(0, 0, 0)' && (await style('body', 'color')) === 'rgb(255, 255, 255)', `${await style('body')} ${await style('body', 'color')}`);
  await setSettings({});

  // ---- strict Content-Security-Policy -------------------------------------------------
  console.log('\nStrict CSP page');
  await page.goto(`http://localhost:${SITE}/csp.html`);
  await ready();
  await sleep(600);
  check('same-origin sheet is themed under CSP', isDark(await style('#site-card')), await style('#site-card'));
  check('cross-origin sheet is themed under CSP', isDark(await style('#cdn-card')), await style('#cdn-card'));
  check('page background is dark under CSP', isDark(await style('html')), await style('html'));

  // ---- simple invert --------------------------------------------------------------------
  console.log('\nSimple invert');
  await setSettings({ sites: { localhost: { mode: 'invert' } } });
  await page.goto(`http://localhost:${SITE}/light.html`);
  await ready();
  await sleep(300);
  check('invert mode flips the page', /invert/.test(await style('html', 'filter')), await style('html', 'filter'));
  check('invert mode flips pictures back', /invert/.test(await style('#img-photo', 'filter')), await style('#img-photo', 'filter'));
  check('invert mode leaves the page rules alone', (await style('#site-card')) === 'rgb(255, 255, 255)', await style('#site-card'));
  await page.screenshot({ path: join(OUT, 'invert.png') });
  await setSettings({});

  // ---- popup and options pages -------------------------------------------------------------
  console.log('\nPopup and options');
  const popup = await browser.newPage();
  await popup.setViewport({ width: 352, height: 760 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(300);
  check('popup renders its controls', (await popup.evaluate(() => document.querySelectorAll('input').length)) >= 12);
  await popup.evaluate(() => (document.querySelector('details').open = true));
  await popup.screenshot({ path: join(OUT, 'popup.png'), fullPage: true });
  await popup.goto(`chrome-extension://${extId}/options/options.html`);
  await sleep(200);
  await popup.screenshot({ path: join(OUT, 'options.png'), fullPage: true });
  await popup.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('test run completed', false, err && err.stack ? err.stack : String(err));
} finally {
  await browser.close();
  stopServers();
}

const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
