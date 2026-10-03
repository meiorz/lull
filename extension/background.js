// Service worker. It does the few things a content script is not allowed to do:
//   - register the "curtain" style sheet so pages are dark before their first paint;
//   - read style sheets and pictures that live on another origin than the page.
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
// A content script can only ask for two things, and each answer is limited to what the
// theme needs: the text of a file the server labels as CSS, or a one-word verdict about a
// picture (plus the first frame of a GIF). Cookies are never sent.

const MAX_CSS = 4 * 1024 * 1024;
const MAX_IMAGE = 3 * 1024 * 1024;

function isWeb(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function fetchCss(url) {
  if (!isWeb(url)) return null;
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('text/css')) return null;
  const text = await res.text();
  return text.length > MAX_CSS ? null : text;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function analyzeImage(url, wantStill) {
  if (!isWeb(url)) return null;
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/')) return null;
  if (+res.headers.get('content-length') > MAX_IMAGE) return { v: 'ok', gif: type.includes('gif') };
  if (type.includes('svg')) return { v: LullAnalyze.classifySvg(await res.text()), gif: false };
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE) return { v: 'ok', gif: type.includes('gif') };
  const thumb = await createImageBitmap(blob, { resizeWidth: 32, resizeHeight: 32, resizeQuality: 'low' });
  const ctx = new OffscreenCanvas(32, 32).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(thumb, 0, 0);
  thumb.close();
  const out = { v: LullAnalyze.classifyPixels(ctx.getImageData(0, 0, 32, 32).data), gif: type.includes('gif') };
  if (out.gif && wantStill) {
    const frame = await createImageBitmap(blob);
    if (frame.width * frame.height <= 4e6) {
      const canvas = new OffscreenCanvas(frame.width, frame.height);
      canvas.getContext('2d').drawImage(frame, 0, 0);
      out.still = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
    }
    frame.close();
  }
  return out;
}

function setBadge(tabId, mode) {
  const text = mode === 'off' ? 'off' : mode === 'invert' ? 'inv' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4a4e57' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg) return;
  if (msg.type === 'css') {
    fetchCss(msg.url).then(reply, () => reply(null));
    return true;
  }
  if (msg.type === 'img') {
    analyzeImage(msg.url, !!msg.still).then(reply, () => reply(null));
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
