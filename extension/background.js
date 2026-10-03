// Service worker. It does the few things a content script is not allowed to do:
//   - register the "curtain" style sheet so pages are dark before their first paint;
//   - read style sheets and pictures that live on another origin than the page, when the
//     page itself is not allowed to (see "requests from content scripts" for the limits).
// It makes no other network requests and stores nothing except the settings.
importScripts('defaults.js', 'content/analyze.js');

const { merge, siteKey, DEFAULTS } = LULL;
const EARLY = 'lull-early';

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return merge(settings);
}

// ---- the curtain ------------------------------------------------------------
// Registered content scripts are injected by the browser itself at document_start, before
// Lull's own script could read any setting. That is what removes the white flash. Sites
// that are switched off are excluded here, so they never see the curtain (or hook.js).

let syncing = Promise.resolve();

function syncEarly() {
  syncing = syncing.then(doSyncEarly).catch((err) => console.warn('Lull: could not register the curtain', err));
  return syncing;
}

async function doSyncEarly() {
  const settings = await getSettings();
  const have = (await chrome.scripting.getRegisteredContentScripts({ ids: [EARLY] })).length > 0;
  if (!settings.enabled) {
    if (have) await chrome.scripting.unregisterContentScripts({ ids: [EARLY] });
    return;
  }
  const off = Object.keys(settings.sites).filter((host) => settings.sites[host].mode === 'off');
  const script = {
    id: EARLY,
    matches: ['<all_urls>'],
    excludeMatches: off.map((host) => (host === 'file' ? 'file:///*' : `*://${host}/*`)),
    css: [`content/curtain-${settings.palette}.css`],
    js: ['content/hook.js'],
    world: 'MAIN',
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  };
  if (have) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULTS });
  syncEarly();
});
chrome.runtime.onStartup.addListener(syncEarly);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncEarly();
});

// ---- requests from content scripts --------------------------------------------
// A page decides which style sheets and pictures it links to, so every address that arrives
// here has to be treated as chosen by a stranger. The worker is not bound by the rules the
// browser applies to pages (mixed content, local-network permission), so it applies its own:
//   - only content scripts in tabs may ask, and only for http(s) addresses;
//   - a secure page may only ask for secure addresses;
//   - an address on this computer or the local network is fetched only for a page that is
//     itself local;
//   - redirects are not followed, because the destination cannot be checked first;
//   - no cookies or referrer are sent, and downloads are capped in size and time;
//   - the answer is the text of a file the server labels as CSS, or a one-word verdict
//     about a picture. Pixels are never handed back.

const MAX_CSS = 4 * 1024 * 1024;
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_SVG = 400 * 1024;
const MAX_PIXELS = 16e6; // 64 MB once decoded
const TIMEOUT_MS = 10000;
const MAX_ACTIVE = 8;
const MAX_QUEUED = 200;
const NO_VERDICT = { v: 'ok' };

// Loopback, private and link-local addresses, and names that only resolve inside a network.
// A public name that points at a private address cannot be recognised from here.
function isLocalHost(host) {
  host = host.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:') || v6.startsWith('64:ff9b:');
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const a = +v4[1];
    const b = +v4[2];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!host.includes('.')) return true; // localhost, intranet, router
  return /\.(localhost|local|internal|intranet|lan|home|corp|localdomain|test|home\.arpa)$/.test(host);
}

// The page (or frame) the asking content script runs in.
function requesterOf(sender) {
  for (const candidate of [sender.origin, sender.url, sender.tab && sender.tab.url]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:') return url;
    } catch {}
  }
  return null;
}

function mayFetch(target, sender) {
  if (!sender || !sender.tab || typeof target !== 'string') return false;
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const page = requesterOf(sender);
  if (!page) return false;
  if (page.protocol === 'https:' && url.protocol !== 'https:') return false;
  const pageIsLocal = page.protocol === 'file:' || isLocalHost(page.hostname);
  return pageIsLocal || !isLocalHost(url.hostname);
}

// At most MAX_ACTIVE downloads at once; the rest wait their turn, up to a point.
let active = 0;
const queued = [];
function limited(job) {
  return new Promise((resolve) => {
    const run = () => {
      active++;
      job()
        .then(resolve, () => resolve(null))
        .finally(() => {
          active--;
          const next = queued.shift();
          if (next) next();
        });
    };
    if (active < MAX_ACTIVE) run();
    else if (queued.length < MAX_QUEUED) queued.push(run);
    else resolve(null);
  });
}

// Returns { type, bytes }, or null if the file is refused, too large or too slow. Reading
// stops the moment the limit is passed, whatever the server claimed the length to be.
async function download(url, max, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      cache: 'force-cache',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal,
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !res.body || !accept(type) || +res.headers.get('content-length') > max) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return { type, bytes };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctl.abort(); // drops whatever is still arriving after an early return
  }
}

async function fetchCss(url) {
  const file = await download(url, MAX_CSS, (type) => type.includes('text/css'));
  return file ? new TextDecoder().decode(file.bytes) : null;
}

// Width and height as written in the file's header, so that a small file which unpacks
// into an enormous picture is turned away before anything is decoded.
function imageSize(b) {
  if (b.length < 30) return null;
  const be16 = (i) => (b[i] << 8) | b[i + 1];
  const le16 = (i) => b[i] | (b[i + 1] << 8);
  const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return [be32(16), be32(20)]; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    // GIF: the screen size, or the first frame if that claims to be larger.
    let w = le16(6);
    let h = le16(8);
    let i = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0);
    while (i + 9 < b.length) {
      if (b[i] === 0x21) {
        i += 2;
        while (i < b.length && b[i]) i += b[i] + 1;
        i++;
      } else {
        if (b[i] === 0x2c) {
          w = Math.max(w, le16(i + 1) + le16(i + 5));
          h = Math.max(h, le16(i + 3) + le16(i + 7));
        }
        break;
      }
    }
    return [w, h];
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]); // WebP
    if (kind === 'VP8X') return [1 + (le16(24) | (b[26] << 16)), 1 + (le16(27) | (b[29] << 16))];
    if (kind === 'VP8L') {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    if (kind === 'VP8 ') return [le16(26) & 0x3fff, le16(28) & 0x3fff];
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the frame header.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff || b[i + 1] === 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [be16(i + 7), be16(i + 5)];
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) i += 2;
      else i += 2 + be16(i + 2);
    }
  }
  return null; // a format this function cannot measure is not decoded
}

async function analyzeImage(url) {
  const file = await download(url, MAX_IMAGE, (type) => type.startsWith('image/'));
  if (!file) return NO_VERDICT;
  if (file.type.includes('svg')) {
    if (file.bytes.length > MAX_SVG) return NO_VERDICT;
    return { v: LullAnalyze.classifySvg(new TextDecoder().decode(file.bytes)), gif: false };
  }
  const gif = file.type.includes('gif');
  const size = imageSize(file.bytes);
  if (!size || !size[0] || !size[1] || size[0] * size[1] > MAX_PIXELS) return { v: 'ok', gif };
  const blob = new Blob([file.bytes], { type: file.type });
  const thumb = await createImageBitmap(blob, { resizeWidth: 32, resizeHeight: 32, resizeQuality: 'low' });
  const ctx = new OffscreenCanvas(32, 32).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(thumb, 0, 0);
  thumb.close();
  return { v: LullAnalyze.classifyPixels(ctx.getImageData(0, 0, 32, 32).data), gif };
}

function setBadge(tabId, mode) {
  const text = mode === 'off' ? 'off' : mode === 'invert' ? 'inv' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4a4e57' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg) return;
  if (msg.type === 'css') {
    if (!mayFetch(msg.url, sender)) return void reply(null);
    limited(() => fetchCss(msg.url)).then(reply);
    return true;
  }
  if (msg.type === 'img') {
    if (!mayFetch(msg.url, sender)) return void reply(NO_VERDICT);
    limited(() => analyzeImage(msg.url)).then((res) => reply(res || NO_VERDICT));
    return true;
  }
  if (msg.type === 'state' && sender.tab) setBadge(sender.tab.id, msg.mode);
});

// ---- keyboard shortcut ----------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-site') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const host = tab && tab.url && siteKey(tab.url);
  if (!host) return;
  const settings = await getSettings();
  if (settings.sites[host] && settings.sites[host].mode === 'off') delete settings.sites[host];
  else settings.sites[host] = { mode: 'off' };
  await chrome.storage.local.set({ settings });
});
