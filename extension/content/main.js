// Starts and stops Lull in one frame, following the stored settings.
//
// Before this script has read anything, curtain-*.css (registered by the service worker for
// document_start) already paints the page dark, so there is no white flash. When the real
// theme is in place this script sets data-lull-ready on <html>, which switches the curtain off.
(() => {
  'use strict';
  const Lull = globalThis.Lull;
  const { merge, siteMode, siteKey } = globalThis.LULL;
  const READY = 'data-lull-ready';
  const isTop = window.top === window;

  // Frames follow the site the person is actually on, not the site the frame comes from.
  function topHost() {
    if (isTop) return siteKey(location.href);
    const chain = location.ancestorOrigins;
    const origin = chain && chain.length ? chain[chain.length - 1] : document.referrer || location.href;
    return siteKey(origin);
  }

  const host = topHost();
  let settings = null;
  let active = null; // { mode, colors, dark, look } while Lull is running in this frame
  let chain = Promise.resolve();
  let ready = false;

  function markReady() {
    ready = true;
    const root = document.documentElement;
    if (root && !root.hasAttribute(READY)) root.setAttribute(READY, '');
  }

  // The settings that change colours. Re-theming a page is work, so it is only done when
  // one of these is different.
  const lookOf = (s) => `${s.palette}/${s.contrast}/${s.saturation}`;

  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  // Wait for style sheets that are still downloading, but never for long and never for
  // ones that have already failed.
  function sheetsSettled() {
    const loading = [];
    for (const link of document.querySelectorAll('link[rel~="stylesheet" i]')) {
      if (link.sheet || link.disabled || !link.href || link.media === 'print') continue;
      if (performance.getEntriesByName(link.href).length) continue;
      loading.push(
        new Promise((resolve) => {
          link.addEventListener('load', resolve, { once: true });
          link.addEventListener('error', resolve, { once: true });
        }),
      );
    }
    if (!loading.length) return Promise.resolve();
    return Promise.race([Promise.all(loading), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  // Is the page, as its author made it, already dark? Sampled from what is actually on
  // screen, which means the curtain has to be lifted first. It stays lifted: the caller
  // themes the page in the same task, so the unthemed page is never painted.
  function detectDark() {
    const root = document.documentElement;
    root.setAttribute(READY, '');
    if (!document.body || !innerWidth || !innerHeight) return false;
    let dark = 0;
    let total = 0;
    try {
      const solid = (el) => {
        const col = Lull.color.parse(getComputedStyle(el).backgroundColor);
        return col && col.a > 0.5 ? col : null;
      };
      // Where nothing has a background, the browser shows <html>'s, or else <body>'s, or
      // else its default white.
      const canvas = solid(root) || solid(document.body);
      for (let ix = 1; ix <= 4; ix++) {
        for (let iy = 1; iy <= 4; iy++) {
          let el = document.elementFromPoint((innerWidth * ix) / 5, (innerHeight * iy) / 5);
          let seen = null;
          while (el && el !== root && !seen) {
            seen = solid(el);
            el = el.parentElement;
          }
          seen ||= canvas;
          total++;
          if (seen && Lull.color.lightness(seen) < 0.45) dark++;
        }
      }
    } catch {}
    return total > 0 && dark / total >= 0.7;
  }

  function report() {
    if (!isTop) return;
    try {
      chrome.runtime.sendMessage({ type: 'state', mode: active ? active.mode : 'off' }, () => void chrome.runtime.lastError);
    } catch {}
  }

  function teardown() {
    if (!active) return;
    Lull.media.stop();
    Lull.theme.stop();
    active = null;
  }

  async function apply(next) {
    settings = next;
    const mode = siteMode(settings, host);
    if (mode === 'off') {
      teardown();
      markReady();
      report();
      return;
    }
    if (active) {
      const colors = mode === 'smart' && !(active.dark && settings.darkSites === 'leave');
      if (mode === active.mode && colors === active.colors) {
        if (active.look !== lookOf(settings)) {
          active.look = lookOf(settings);
          Lull.theme.update(Lull.color.makeTheme(settings, active.dark));
        }
        Lull.media.update(settings);
        return;
      }
      teardown();
    }
    let dark = false;
    if (mode === 'smart') {
      await domReady();
      await sheetsSettled();
      Lull.color.setTheme(Lull.color.makeTheme(settings, false));
      await Lull.theme.prepare();
      // From here to the end of settle() nothing is awaited that lets the browser paint.
      dark = detectDark();
    }
    const colors = mode === 'smart' && !(dark && settings.darkSites === 'leave');
    active = { mode, colors, dark, look: lookOf(settings) };
    try {
      Lull.theme.start(Lull.color.makeTheme(settings, dark), { colors });
      Lull.media.start(settings, { mode, colors, top: isTop });
      if (colors && (await Lull.theme.settle())) {
        // A style sheet on another origin is still downloading. Lower the curtain again
        // rather than show its colours unthemed.
        document.documentElement.removeAttribute(READY);
        await Lull.theme.whenIdle();
      }
    } finally {
      markReady();
    }
    report();
  }

  function queue(next) {
    chain = chain.then(() => apply(next)).catch(() => markReady());
    return chain;
  }

  chrome.storage.local.get('settings', (stored) => {
    if (chrome.runtime.lastError) return markReady();
    queue(merge(stored.settings));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) queue(merge(changes.settings.newValue));
  });

  // The popup asks the top frame what Lull is doing on this page.
  if (isTop) {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg && msg.type === 'status') {
        reply({ host, mode: active ? active.mode : 'off', dark: !!(active && active.dark), colors: !!(active && active.colors) });
      }
    });
  }

  // Print with the page's own colours.
  addEventListener('beforeprint', () => Lull.theme.pause());
  addEventListener('afterprint', () => Lull.theme.resume());

  // If the page replaces its <html> element, the new one must not fall back under the curtain.
  new MutationObserver(() => {
    if (ready) markReady();
  }).observe(document, { childList: true });
})();
