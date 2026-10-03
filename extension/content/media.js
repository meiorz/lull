// Everything that is not a colour rule: pictures and video, movement, and the reading ruler.
(() => {
  'use strict';
  const Lull = globalThis.Lull;
  const theme = Lull.theme;
  const Analyze = globalThis.LullAnalyze;

  let S = null; // settings
  let opts = null; // { mode: 'smart' | 'invert', colors: boolean, top: boolean }
  let on = false;

  const verdicts = new Map(); // picture URL -> { v, gif, still }
  const watching = new WeakSet();
  const visible = new WeakSet();
  const frozen = new WeakMap(); // <img> -> what it had before its animation was frozen
  const played = new WeakSet(); // animations the person chose to play
  const allowed = new WeakSet(); // media the person started
  const fights = new WeakMap();
  const waiting = [];
  let busy = 0;
  let io = null;
  let ruler = null;

  const GIF = /\.gif(?:[?#]|$)|^data:image\/gif/i;
  const JPEG = /\.jpe?g(?:[?#]|$)|^data:image\/jpe?g/i;
  const ARTWORK = /\.(?:png|svg|webp|gif|avif|ico)(?:[?#]|$)|^data:image\/(?:png|svg|webp|gif)/i;

  const STILL =
    '*,*::before,*::after{animation-duration:.001ms!important;animation-delay:0s!important;' +
    'animation-iteration-count:1!important;transition-duration:.001ms!important;transition-delay:0s!important;' +
    'scroll-behavior:auto!important}' +
    '::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-duration:.001ms!important}';

  // ---- style sheets ---------------------------------------------------------

  function writeSheets() {
    const dim = (100 - S.mediaDim) / 100;
    let css = '';
    if (opts.mode === 'invert') {
      // Simple invert: the whole page is flipped, then pictures and video are flipped back.
      // Frames inside the page are already flipped by the top page, so they only flip back.
      const flip = 'invert(1) hue-rotate(180deg)';
      if (opts.top) css += `:root{filter:${flip} contrast(.9)!important}:where(html){background-color:#fff}`;
      css += `img,video,svg image,object,embed{filter:${flip}!important}`;
    } else {
      if (S.mediaDim > 0) css += `:where(img,video:not(:fullscreen),svg image){filter:brightness(${dim})}`;
      if (opts.colors) {
        css +=
          `[data-lull-img="invert"]{filter:invert(1) hue-rotate(180deg) brightness(${Math.min(dim, 0.88)})!important}` +
          '[data-lull-img="plate"]{background-color:var(--lull-plate)!important;' +
          'box-shadow:0 0 0 3px var(--lull-plate)!important;border-radius:3px}' +
          `[data-lull-img="bright"]{filter:brightness(${+(dim * 0.78).toFixed(3)})!important}`;
      }
    }
    css += '[data-lull-gif]{outline:2px dashed var(--lull-bd,#777)!important;outline-offset:-2px!important;cursor:pointer}';
    theme.ownSheet('media').replaceSync(css);
    theme.ownSheet('motion').replaceSync(S.stillness ? STILL : '');
  }

  // The rule that stops transitions works by making them last a millionth of a second, on
  // every element. A side effect is that every element then counts as "transitioning"
  // whenever its colours change, and when Lull recolours a whole page that is tens of
  // thousands of transitions at once. So the rule steps aside for that moment.
  let stillTimer = 0;
  theme.hooks.bulk.push(() => {
    const sheet = theme.ownSheet('motion');
    sheet.disabled = true;
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => (sheet.disabled = false), 150);
  });

  // ---- pictures -------------------------------------------------------------

  function wantsAnalysis() {
    return opts.mode === 'smart' && (opts.colors || S.pauseMedia);
  }

  // Logos, icons and diagrams: worth asking the service worker about when the page itself
  // may not read them. Large photographs are not, so they are never downloaded twice for this.
  function isArtwork(img, url) {
    return !JPEG.test(url) && (ARTWORK.test(url) || img.clientWidth * img.clientHeight <= 350000);
  }

  // Many picture hosts allow cross-origin reads. Loading the picture again with CORS asks
  // for that permission; the browser normally answers from its cache.
  const refused = new Set(); // hosts that said no: asking again only fills the console
  function readWithCors(url, wantStill) {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return Promise.resolve(null);
    }
    if (refused.has(host)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const copy = new Image();
      copy.crossOrigin = 'anonymous';
      copy.onload = () => resolve(readDirect(copy, wantStill));
      copy.onerror = () => {
        refused.add(host);
        resolve(null);
      };
      copy.src = url;
    });
  }

  // Works for pictures the page is allowed to read; throws for the rest.
  function readDirect(img, wantStill) {
    try {
      const ctx = new OffscreenCanvas(32, 32).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 32, 32);
      const v = Analyze.classifyPixels(ctx.getImageData(0, 0, 32, 32).data);
      let still = null;
      if (wantStill && img.naturalWidth * img.naturalHeight <= 4e6) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        still = canvas.toDataURL('image/png');
      }
      return { v, gif: wantStill, still };
    } catch {
      return null;
    }
  }

  function ask(url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'img', url, still: S.pauseMedia }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function pump() {
    while (busy < 3 && waiting.length) {
      const job = waiting.shift();
      busy++;
      job().finally(() => {
        busy--;
        pump();
      });
    }
  }

  function remember(url, res) {
    if (verdicts.size > 3000) verdicts.clear();
    verdicts.set(url, res);
  }

  function applyVerdict(img, res) {
    if (opts.colors && res.v && res.v !== 'ok') img.setAttribute('data-lull-img', res.v);
    else img.removeAttribute('data-lull-img');
    if (res.still && S.pauseMedia && !played.has(img)) freeze(img, res.still);
  }

  function examine(img) {
    if (!on || !wantsAnalysis() || frozen.has(img)) return;
    if (!img.complete || !img.naturalWidth) return; // its load event will bring it back here
    const url = img.currentSrc || img.src;
    if (!url) return;
    const wantStill = S.pauseMedia && GIF.test(url) && !played.has(img);
    const wantVerdict = opts.colors && img.clientWidth >= 12 && img.clientHeight >= 12;
    const known = verdicts.get(url);
    if (known && (!wantStill || known.still || known.gif === false)) return applyVerdict(img, known);
    if (!wantStill && !wantVerdict) {
      img.removeAttribute('data-lull-img');
      return;
    }
    const direct = readDirect(img, wantStill);
    if (direct) {
      remember(url, direct);
      return applyVerdict(img, direct);
    }
    if (!/^https?:/i.test(url)) return;
    const viaWorker = wantStill || isArtwork(img, url);
    waiting.push(() =>
      readWithCors(url, wantStill)
        .then((res) => res || (viaWorker ? ask(url) : null))
        .then((res) => {
          if (!res || !on) return;
          remember(url, res);
          if ((img.currentSrc || img.src) === url) applyVerdict(img, res);
        }),
    );
    pump();
  }

  function watch(img) {
    if (watching.has(img)) return;
    watching.add(img);
    io.observe(img);
  }

  // ---- animated pictures ------------------------------------------------------

  function freeze(img, still) {
    if (frozen.has(img)) return;
    frozen.set(img, {
      still,
      src: img.getAttribute('src'),
      srcset: img.getAttribute('srcset'),
      title: img.getAttribute('title'),
    });
    if (img.hasAttribute('srcset')) img.removeAttribute('srcset');
    img.src = still;
    img.setAttribute('data-lull-gif', '');
    if (!img.title) img.title = 'Animation paused by Lull. Hold Alt and click to play it.';
  }

  function thaw(img, byPerson) {
    const was = frozen.get(img);
    if (!was) return;
    frozen.delete(img);
    if (byPerson) played.add(img);
    img.removeAttribute('data-lull-gif');
    if (was.title == null) img.removeAttribute('title');
    if (was.srcset != null) img.setAttribute('srcset', was.srcset);
    if (was.src != null) img.setAttribute('src', was.src);
  }

  function thawAll() {
    for (const root of theme.scopes) {
      for (const img of root.querySelectorAll('[data-lull-gif]')) thaw(img, false);
    }
  }

  // ---- events ---------------------------------------------------------------

  function onLoad(e) {
    const t = e.target;
    if (!on || !t || t.localName !== 'img') return;
    const was = frozen.get(t);
    if (was) {
      if (t.getAttribute('src') === was.still) return;
      // The page gave the picture a new source while it was frozen.
      frozen.delete(t);
      t.removeAttribute('data-lull-gif');
    }
    if (visible.has(t)) examine(t);
  }

  function onError(e) {
    const t = e.target;
    const was = t && t.localName === 'img' && frozen.get(t);
    // The page does not allow data: pictures, so the frozen frame cannot be shown.
    if (was && t.getAttribute('src') === was.still) thaw(t, true);
  }

  function onClick(e) {
    if (!e.altKey) return;
    const t = e.composedPath()[0];
    if (!t || t.nodeType !== 1 || !t.hasAttribute('data-lull-gif')) return;
    e.preventDefault();
    e.stopPropagation();
    thaw(t, true);
  }

  // Media that starts by itself is paused. Media the person starts is left alone for good,
  // and so are live streams such as video calls.
  function onPlay(e) {
    const m = e.target;
    if (!on || !S.pauseMedia || !(m instanceof HTMLMediaElement) || allowed.has(m)) return;
    if (m.srcObject || (navigator.userActivation && navigator.userActivation.isActive)) {
      allowed.add(m);
      return;
    }
    const n = (fights.get(m) || 0) + 1;
    fights.set(m, n);
    if (n > 4) return; // the page restarts it every time; stop fighting over it
    m.pause();
  }

  function calmDown(root) {
    if (S.pauseMedia && !(navigator.userActivation && navigator.userActivation.hasBeenActive)) {
      for (const m of root.querySelectorAll('video,audio')) {
        if (!m.paused && !m.srcObject && !allowed.has(m)) m.pause();
      }
    }
    if (S.stillness) {
      for (const el of root.querySelectorAll('marquee')) if (el.stop) el.stop();
      for (const svg of root.querySelectorAll('svg')) {
        if (!svg.ownerSVGElement && svg.querySelector('animate,animateTransform,animateMotion,set')) svg.pauseAnimations();
      }
    }
  }

  function onScope(root) {
    if (!on) return;
    root.addEventListener('load', onLoad, true);
    root.addEventListener('error', onError, true);
    root.addEventListener('play', onPlay, true);
    if (wantsAnalysis()) for (const img of root.querySelectorAll('img')) watch(img);
    calmDown(root);
  }

  function onAdded(node) {
    if (!on) return;
    if (wantsAnalysis()) {
      if (node.localName === 'img') watch(node);
      else if (node.firstElementChild) for (const img of node.querySelectorAll('img')) watch(img);
    }
    if (S.stillness && node.localName === 'marquee' && node.stop) node.stop();
  }

  theme.hooks.scope.push(onScope);
  theme.hooks.added.push(onAdded);

  // ---- reading ruler ----------------------------------------------------------
  // Two shades with a clear band between them that follows the pointer, so that only a few
  // lines of text are in view at once.

  const BAND = 120;

  function moveRuler(y) {
    ruler.top.style.height = Math.max(0, y - BAND / 2) + 'px';
    ruler.bottom.style.top = y + BAND / 2 + 'px';
  }

  function onPointer(e) {
    if (!ruler || ruler.raf) return;
    const y = e.clientY;
    ruler.raf = requestAnimationFrame(() => {
      ruler.raf = 0;
      moveRuler(y);
    });
  }

  function rulerOn() {
    if (ruler || !opts.top) return;
    const host = document.createElement('lull-ruler');
    host.className = 'lull-x';
    const shadow = host.attachShadow({ mode: 'closed' });
    const shade = 'position:fixed;left:0;right:0;background:rgba(0,0,0,.55);pointer-events:none;z-index:2147483647;';
    const top = document.createElement('div');
    const bottom = document.createElement('div');
    top.style.cssText = shade + 'top:0;height:0';
    bottom.style.cssText = shade + 'bottom:0;top:100%';
    shadow.append(top, bottom);
    ruler = { host, top, bottom, raf: 0 };
    document.documentElement.append(host);
    moveRuler(innerHeight * 0.4);
    document.addEventListener('pointermove', onPointer, { capture: true, passive: true });
  }

  function rulerOff() {
    if (!ruler) return;
    document.removeEventListener('pointermove', onPointer, { capture: true });
    cancelAnimationFrame(ruler.raf);
    ruler.host.remove();
    ruler = null;
  }

  // ---- public API -------------------------------------------------------------

  function refresh() {
    writeSheets();
    if (S.ruler) rulerOn();
    else rulerOff();
    if (!S.pauseMedia || opts.mode !== 'smart') thawAll();
    for (const root of theme.scopes) {
      calmDown(root);
      if (!wantsAnalysis()) continue;
      for (const img of root.querySelectorAll('img')) {
        watch(img);
        if (visible.has(img)) examine(img);
      }
    }
  }

  function start(settings, options) {
    S = settings;
    opts = options;
    on = true;
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          visible.add(entry.target);
          examine(entry.target);
        }
      },
      { rootMargin: '300px' },
    );
    document.addEventListener('click', onClick, true);
    for (const root of theme.scopes) onScope(root);
    refresh();
  }

  function update(settings) {
    S = settings;
    refresh();
  }

  function stop() {
    if (!on) return;
    on = false;
    thawAll();
    rulerOff();
    io.disconnect();
    waiting.length = 0;
    document.removeEventListener('click', onClick, true);
    for (const root of theme.scopes) {
      root.removeEventListener('load', onLoad, true);
      root.removeEventListener('error', onError, true);
      root.removeEventListener('play', onPlay, true);
      for (const img of root.querySelectorAll('[data-lull-img]')) img.removeAttribute('data-lull-img');
    }
  }

  Lull.media = { start, update, stop };
})();
