// The theme engine. It rewrites the colours in the page's own style rules instead of
// inverting the screen or walking every element:
//   - style sheets Lull may edit are changed in place, so the cascade stays exactly as the
//     site wrote it (same selectors, order, layers, !important);
//   - style sheets on other origins cannot be read by a page, so the service worker fetches
//     their text and Lull places a small override sheet directly after the original;
//   - inline styles and old-style colour attributes get an attribute that points at a
//     generated rule, so the site's own markup is left as it was.
(() => {
  'use strict';
  const Lull = globalThis.Lull;
  const C = Lull.color;

  const ATTR_S = 'data-lull-s'; // rule that must beat an inline style (!important)
  const ATTR_P = 'data-lull-p'; // rule that replaces a presentational attribute (zero specificity)
  const OWN_CLASS = 'lull-x';
  const VARIANTS = ['bg', 'fg', 'bd'];

  // Which mapping each colour property uses.
  const CTX = {
    color: 'fg',
    '-webkit-text-fill-color': 'fg',
    'caret-color': 'fg',
    'text-decoration-color': 'fg',
    '-webkit-text-stroke-color': 'fg',
    'text-emphasis-color': 'fg',
    fill: 'fg',
    stroke: 'fg',
    'stop-color': 'fg',
    'flood-color': 'fg',
    'accent-color': 'fg',
    'background-color': 'bg',
    'background-image': 'bg',
    'box-shadow': 'bg',
    'text-shadow': 'bg',
    'outline-color': 'bd',
    'column-rule-color': 'bd',
    // Not colours, but "multiply" is how sites hide a picture's white background on a light
    // page; on a dark page it turns the whole picture black.
    'mix-blend-mode': 'blend',
    'background-blend-mode': 'blend',
  };
  // A shorthand written with var() cannot be split by the browser: its longhands read as
  // empty and the value has to be taken from the shorthand itself.
  const SHORTHANDS = {
    'background-color': ['background'],
    'background-image': ['background'],
    'outline-color': ['outline'],
    'column-rule-color': ['column-rule'],
    'text-decoration-color': ['text-decoration'],
    '-webkit-text-stroke-color': ['-webkit-text-stroke'],
  };
  for (const side of ['top', 'right', 'bottom', 'left']) {
    CTX[`border-${side}-color`] = 'bd';
    SHORTHANDS[`border-${side}-color`] = ['border', `border-${side}`, 'border-color'];
  }
  for (const axis of ['block', 'inline']) {
    for (const edge of ['start', 'end']) {
      CTX[`border-${axis}-${edge}-color`] = 'bd';
      SHORTHANDS[`border-${axis}-${edge}-color`] = [`border-${axis}-${edge}`, `border-${axis}`, `border-${axis}-color`];
    }
  }

  const state = { on: false, colors: false, paused: false, hook: false, gen: 0 };
  const hooks = { scope: [], added: [], bulk: [] };
  // Called before Lull changes the colours of the whole page at once.
  const bulk = () => hooks.bulk.forEach((fn) => fn());
  const scopes = new Set(); // the document and every shadow root Lull has found
  const own = new Map(); // name -> constructed sheet adopted into every scope
  const ownSet = new Set();
  const sheets = new Map(); // CSSStyleSheet -> Map(rule -> records)
  const foreign = new Map(); // owner element or scope -> Map(href -> override state)
  const cssCache = new Map(); // href -> Promise<text | null>, fetched by the service worker
  const srcCache = new Map(); // href -> Promise<text | null>, same-origin sheets read by the page
  let staged = new WeakMap(); // rule -> records read ahead of time by prepare()
  const pending = new Set(); // override sheets still being fetched
  const ownerSheet = new WeakMap();
  const watched = new WeakSet();
  let sigs = new WeakMap();
  const keys = new Map();
  let pollTimer = 0;

  // ---- Lull's own style sheets -------------------------------------------

  function ownSheet(name) {
    let sheet = own.get(name);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      own.set(name, sheet);
      ownSet.add(sheet);
      for (const root of scopes) adopt(root);
    }
    return sheet;
  }

  function adopt(root) {
    const have = root.adoptedStyleSheets;
    for (const sheet of ownSet) {
      if (!have.includes(sheet)) {
        root.adoptedStyleSheets = [...have.filter((s) => !ownSet.has(s)), ...ownSet];
        return;
      }
    }
  }

  function unadopt(root) {
    const have = root.adoptedStyleSheets;
    if (have.some((s) => ownSet.has(s))) root.adoptedStyleSheets = have.filter((s) => !ownSet.has(s));
  }

  function writeBase() {
    const t = C.theme.css;
    const vars = `--lull-bg:${t.bg};--lull-fg:${t.fg};--lull-bd:${t.border};--lull-link:${t.link};--lull-plate:${t.plate}`;
    ownSheet('base').replaceSync(
      state.colors
        ? `:root{color-scheme:dark!important;${vars}}
:where(html){background-color:${t.bg};color:${t.fg}}
:where(:any-link){color:${t.link}}
:where(:visited){color:${t.visited}}
:where(svg:not([fill])){fill:currentColor}
:where(mark){background-color:${t.markBg};color:${t.fg}}
:where(hr,table,td,th,fieldset){border-color:${t.border}}
::selection{background-color:${t.selBg}!important;color:${t.selFg}!important}`
        : `:root{${vars}}`,
    );
  }

  // ---- reading and rewriting one declaration block ------------------------

  // A record remembers the value the site wrote, so the theme can be re-applied with other
  // settings or removed completely without reloading the page.
  function collect(style) {
    const recs = [];
    let done = null;
    for (let i = 0, n = style.length; i < n; i++) {
      const p = style[i];
      if (p.charCodeAt(0) === 45 && p.charCodeAt(1) === 45) {
        if (p.startsWith('--lull-')) continue;
        const v = style.getPropertyValue(p);
        if (C.isColorish(v)) recs.push({ p, v, pr: style.getPropertyPriority(p), custom: true });
        continue;
      }
      const ctx = CTX[p];
      if (!ctx) continue;
      const v = style.getPropertyValue(p);
      if (v) {
        recs.push({ p, v, pr: style.getPropertyPriority(p), ctx });
        continue;
      }
      const shs = SHORTHANDS[p];
      if (!shs) continue;
      let found = false;
      for (const sh of shs) {
        if (done && done.has(sh)) {
          found = true;
          break;
        }
        const sv = style.getPropertyValue(sh);
        if (!sv) continue;
        (done ||= new Set()).add(sh);
        recs.push({ p: sh, v: sv, pr: style.getPropertyPriority(sh), ctx });
        found = true;
        break;
      }
      // "background: var(--x); background-repeat: no-repeat": once a later longhand splits
      // the shorthand, the browser cannot return the shorthand's text at all. It is
      // recovered from the style sheet's source instead (see rescue()).
      if (!found) (recs.lost ||= new Map()).set(shs[0], { shs, ctx });
    }
    return recs;
  }

  function rewriteDecl(rec) {
    if (rec.ctx === 'blend') return rec.v.replace(/\b(multiply|darken|color-burn)\b/g, 'normal');
    return C.rewrite(rec.v, rec.ctx);
  }

  function variantValue(rec, variant) {
    const tri = C.triplet(rec.v);
    return tri ? C.rewriteTriplet(tri, variant) : C.rewrite(rec.v, variant);
  }

  function applyRecs(style, recs) {
    for (const rec of recs) {
      if (rec.custom) {
        const name = rec.p.slice(2);
        for (const v of VARIANTS) style.setProperty(`--lull-${v}-${name}`, variantValue(rec, v), rec.pr);
      } else if (rec.raw) {
        style.setProperty(rec.p, C.rewrite(rec.v, rec.ctx), rec.pr);
        for (const [p, v, pr] of rec.keep) style.setProperty(p, v, pr);
      } else {
        const next = rewriteDecl(rec);
        if (next !== rec.v) {
          style.setProperty(rec.p, next, rec.pr);
          rec.changed = true;
        }
      }
    }
  }

  function restoreRecs(style, recs) {
    for (const rec of recs) {
      if (rec.custom) {
        const name = rec.p.slice(2);
        for (const v of VARIANTS) style.removeProperty(`--lull-${v}-${name}`);
      } else if (rec.raw) {
        style.setProperty(rec.p, rec.v, rec.pr);
        for (const [p, v, pr] of rec.keep) style.setProperty(p, v, pr);
      } else if (rec.changed) {
        style.setProperty(rec.p, rec.v, rec.pr);
      }
    }
  }

  // ---- recovering shorthand text from the source ---------------------------
  // The source is parsed a second time, privately, with every colour shorthand renamed to a
  // custom property. Custom properties keep their text exactly as written, so the private
  // copy can be asked for what the real rule can no longer say.

  const RAW = /([;{]\s*)(background|border[a-z-]*|outline|column-rule|text-decoration|-webkit-text-stroke)(\s*:)/gi;

  function mirrorOf(text) {
    const mirror = new CSSStyleSheet();
    mirror.replaceSync(text.replace(RAW, (all, lead, name, colon) => `${lead}--lull-raw-${name.toLowerCase()}${colon}`));
    return mirror;
  }

  // The rule at the same position in the private copy.
  function twinOf(rule, mirror) {
    const path = [];
    for (let r = rule; r; r = r.parentRule) {
      const list = r.parentRule ? r.parentRule.cssRules : r.parentStyleSheet && r.parentStyleSheet.cssRules;
      if (!list) return null;
      let i = 0;
      let imports = 0; // @import is dropped from the private copy
      while (i < list.length && list[i] !== r) {
        if (list[i] instanceof CSSImportRule) imports++;
        i++;
      }
      if (i === list.length) return null;
      path.unshift(i - imports);
    }
    let list = mirror.cssRules;
    let twin = null;
    for (const i of path) {
      twin = list && list[i];
      if (!twin) return null;
      list = twin.cssRules;
    }
    return twin && twin.selectorText === rule.selectorText && twin.style ? twin : null;
  }

  // The longhands that the site set after the shorthand, with the values the site wrote.
  function keepOf(style, sh, recs) {
    const keep = [];
    const prefix = sh + '-';
    const colours = sh.endsWith('-color') ? new RegExp('^' + sh.replace(/-color$/, '-[a-z]+-color') + '$') : null;
    for (let i = 0; i < style.length; i++) {
      const p = style[i];
      if (!(p.startsWith(prefix) || (colours && colours.test(p)))) continue;
      const own = recs.find((rec) => rec.p === p && !rec.custom);
      const v = own ? own.v : style.getPropertyValue(p);
      if (v) keep.push([p, v, style.getPropertyPriority(p)]);
    }
    return keep;
  }

  function rescueRules(rules, map, mirror) {
    for (const rule of rules) {
      const recs = map.get(rule);
      if (!recs || !recs.lost) continue;
      const twin = twinOf(rule, mirror);
      if (!twin) continue;
      let added = false;
      for (const { shs, ctx } of recs.lost.values()) {
        const texts = shs.map((sh) => [sh, twin.style.getPropertyValue('--lull-raw-' + sh).trim()]).filter((pair) => pair[1]);
        const hit = texts.find((pair) => pair[1].includes('var(')) || texts[0];
        if (!hit) continue;
        const [sh, raw] = hit;
        // Raw records go first: the shorthand must be written before the longhands that follow it.
        recs.unshift({ p: sh, v: raw, pr: twin.style.getPropertyPriority('--lull-raw-' + sh), ctx, raw: true, keep: keepOf(rule.style, sh, recs) });
        added = true;
      }
      recs.lost = null;
      if (added) applyRecs(rule.style, recs);
    }
  }

  function sourceOf(sheet) {
    const node = sheet.ownerNode;
    if (node && node.localName === 'style') return Promise.resolve(node.textContent);
    if (!sheet.href) return Promise.resolve(null);
    let sameOrigin = false;
    try {
      sameOrigin = new URL(sheet.href).origin === location.origin;
    } catch {}
    if (!sameOrigin) return fetchCss(sheet.href);
    let p = srcCache.get(sheet.href);
    if (!p) {
      p = fetch(sheet.href, { cache: 'force-cache' }).then((res) => (res.ok ? res.text() : null), () => null);
      srcCache.set(sheet.href, p);
    }
    return p;
  }

  function rescue(sheet, rules) {
    const job = sourceOf(sheet).then((text) => {
      pending.delete(job);
      const map = sheets.get(sheet);
      if (!text || !map || !state.on) return;
      try {
        rescueRules(rules, map, mirrorOf(text));
      } catch {}
    });
    pending.add(job);
  }

  // ---- style sheets -------------------------------------------------------

  function printOnly(media) {
    return !!media && /^\s*(only\s+)?print\s*$/i.test(media.mediaText);
  }

  function gather(rules, out, imports) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule instanceof CSSImportRule) {
        imports.push(rule);
        continue;
      }
      if (rule instanceof CSSFontFaceRule || rule instanceof CSSPageRule) continue;
      if (rule instanceof CSSMediaRule && printOnly(rule.media)) continue;
      if (rule.style && typeof rule.style.setProperty === 'function') out.push(rule);
      const kids = rule.cssRules;
      if (kids && kids.length) gather(kids, out, imports);
    }
  }

  // A generator so that a large first pass can be spread over several frames.
  function* processSheet(sheet, owner, root, force) {
    if (!sheet || ownSet.has(sheet)) return;
    const old = sheets.get(sheet);
    if (old && !force) return;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      if (sheet.href) loadForeign(owner, sheet.href, root, sheet.ownerNode === owner);
      return;
    }
    if (!rules || printOnly(sheet.media)) return;
    const list = [];
    const imports = [];
    gather(rules, list, imports);
    const next = new Map();
    const lost = [];
    let n = 0;
    for (const rule of list) {
      let recs = old && old.get(rule);
      if (recs === undefined) {
        recs = staged.get(rule) || collect(rule.style);
        if (recs.lost) lost.push(rule);
        if (recs.length) applyRecs(rule.style, recs);
        else if (!recs.lost) recs = null;
      }
      next.set(rule, recs);
      if ((++n & 31) === 0) yield;
    }
    sheets.set(sheet, next);
    if (lost.length) rescue(sheet, lost);
    for (const imp of imports) yield* processSheet(imp.styleSheet, owner, root, force);
  }

  function run(gen) {
    for (const _ of gen);
  }

  const tick = () =>
    globalThis.scheduler && scheduler.yield
      ? scheduler.yield()
      : new Promise((resolve) => setTimeout(resolve, 0));

  // Read every style rule and fetch every text that will be needed, without changing the
  // page. Editing a rule makes the browser restyle the whole document, so the edits are
  // saved up for start(), which makes them all in one go. Reading can be spread over frames.
  async function prepare() {
    const jobs = [];
    let t = performance.now();
    const read = async (sheet) => {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        if (sheet.href) jobs.push(fetchCss(sheet.href));
        return;
      }
      if (!rules || printOnly(sheet.media)) return;
      const list = [];
      const imports = [];
      gather(rules, list, imports);
      let lost = false;
      for (const rule of list) {
        const recs = collect(rule.style);
        staged.set(rule, recs);
        if (recs.lost) lost = true;
        if (performance.now() - t > 8) {
          await tick();
          t = performance.now();
        }
      }
      if (lost) jobs.push(sourceOf(sheet));
      for (const imp of imports) if (imp.styleSheet) await read(imp.styleSheet);
    };
    for (const sheet of Array.from(document.styleSheets)) await read(sheet);
    await Promise.race([Promise.all(jobs), new Promise((resolve) => setTimeout(resolve, 2500))]);
  }

  // Let work that only waits on already-fetched text finish. Awaiting a resolved promise
  // does not let the browser paint. Returns true if something is still on the network.
  async function settle() {
    for (let i = 0; i < 30 && pending.size; i++) await null;
    return pending.size > 0;
  }

  function whenIdle() {
    return Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 2500))]);
  }

  // ---- style sheets on other origins --------------------------------------

  // First ask the way a page would: a cross-origin request that the host has to permit.
  // That request is subject to every protection the browser gives pages, and most public
  // CDNs permit it.
  const corsRefused = new Set(); // hosts that said no: asking again only fills the console
  function readAsPage(href) {
    let host;
    try {
      host = new URL(href).host;
    } catch {
      return Promise.resolve(null);
    }
    if (corsRefused.has(host)) return Promise.resolve(null);
    return fetch(href, { mode: 'cors', credentials: 'omit', cache: 'force-cache' }).then(
      (res) => (res.ok && /text\/css/i.test(res.headers.get('content-type') || '') ? res.text() : null),
      () => {
        corsRefused.add(host);
        return null;
      },
    );
  }

  // Only when the host does not permit it is the service worker asked, and the worker
  // refuses addresses a page should not be able to reach through Lull.
  function readAsWorker(href) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'css', url: href }, (text) => {
          void chrome.runtime.lastError;
          resolve(typeof text === 'string' ? text : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function fetchCss(href) {
    let p = cssCache.get(href);
    if (!p) {
      p = readAsPage(href).then((text) => (text != null ? text : readAsWorker(href)));
      cssCache.set(href, p);
    }
    return p;
  }

  function kill(st) {
    st.dead = true;
    if (st.el) st.el.remove();
    if (st.fallback && st.root) st.root.adoptedStyleSheets = st.root.adoptedStyleSheets.filter((s) => s !== st.fallback);
  }

  function loadForeign(owner, href, root, self, depth = 0) {
    const key = owner || root;
    let per = foreign.get(key);
    if (!per) foreign.set(key, (per = new Map()));
    if (self) {
      // The owner now points at a different file: drop what was built for the old one.
      for (const [h, st] of per) {
        if (st.self && h !== href) {
          kill(st);
          per.delete(h);
        }
      }
    }
    if (per.has(href)) return;
    const st = { href, owner, root, self, copy: null, map: null, el: null, fallback: null, dead: false, replaced: 0 };
    per.set(href, st);
    const job = fetchCss(href).then((text) => {
      pending.delete(job);
      if (st.dead || !state.on || text == null) return;
      try {
        buildForeign(st, text, depth);
      } catch {}
    });
    pending.add(job);
  }

  const IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi;

  function buildForeign(st, text, depth) {
    const copy = new CSSStyleSheet({ baseURL: st.href });
    copy.replaceSync(text);
    st.copy = copy;
    st.map = new Map();
    const list = [];
    gather(copy.cssRules, list, []);
    const lost = [];
    for (const rule of list) {
      const recs = collect(rule.style);
      if (recs.lost) lost.push(rule);
      else if (!recs.length) continue;
      applyRecs(rule.style, recs);
      st.map.set(rule, recs);
    }
    if (lost.length) rescueRules(lost, st.map, mirrorOf(text));
    place(st);
    if (depth >= 2) return;
    let m;
    let count = 0;
    IMPORT.lastIndex = 0;
    while ((m = IMPORT.exec(text)) && count++ < 8) {
      try {
        loadForeign(st.owner, new URL(m[1], st.href).href, st.root, false, depth + 1);
      } catch {}
    }
  }

  function absUrls(value, base) {
    return value.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (all, quote, url) => {
      if (/^(data:|blob:|#|[a-z][a-z0-9+.-]*:\/\/)/i.test(url)) return all;
      try {
        return `url("${new URL(url, base).href}")`;
      } catch {
        return all;
      }
    });
  }

  function declText(style, recs, base) {
    let text = '';
    for (const rec of recs) {
      const important = rec.pr ? '!important' : '';
      if (rec.custom) {
        const name = rec.p.slice(2);
        for (const v of VARIANTS) {
          const prop = `--lull-${v}-${name}`;
          const val = style.getPropertyValue(prop);
          if (val) text += `${prop}:${val}${important};`;
        }
      } else if (rec.raw) {
        text += `${rec.p}:${absUrls(C.rewrite(rec.v, rec.ctx), base)}${important};`;
        for (const [p, v, pr] of rec.keep) text += `${p}:${absUrls(v, base)}${pr ? '!important' : ''};`;
      } else {
        // Unchanged values (inherit, transparent) are written too: leaving them out would
        // let an earlier rule's override win where the site's later rule used to.
        let val = style.getPropertyValue(rec.p);
        if (!val) continue;
        if (val.includes('url(')) val = absUrls(val, base);
        text += `${rec.p}:${val}${important};`;
      }
    }
    return text;
  }

  // Serialise only the colour declarations of a (privately parsed) foreign sheet, inside
  // the same @media / @supports / @layer / nesting structure the site used.
  function emit(rules, st) {
    let out = '';
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule instanceof CSSKeyframesRule) {
        for (const frame of rule.cssRules) {
          if (st.map.has(frame)) {
            out += absUrls(rule.cssText, st.href);
            break;
          }
        }
        continue;
      }
      const recs = st.map.get(rule);
      const body = recs ? declText(rule.style, recs, st.href) : '';
      const kids = rule.cssRules;
      const inner = kids && kids.length ? emit(kids, st) : '';
      if (!body && !inner) continue;
      if (rule instanceof CSSStyleRule) out += `${rule.selectorText}{${body}${inner}}`;
      else if (rule instanceof CSSMediaRule) out += `@media ${rule.conditionText}{${inner}}`;
      else if (rule instanceof CSSSupportsRule) out += `@supports ${rule.conditionText}{${inner}}`;
      else if (rule instanceof CSSLayerBlockRule) out += `@layer ${rule.name}{${inner}}`;
      else if (kids) out += rule.cssText.slice(0, rule.cssText.indexOf('{') + 1) + inner + '}';
      else out += body;
    }
    return out;
  }

  let nonce;
  function pageNonce() {
    if (nonce === undefined) {
      const el = document.querySelector('style[nonce],script[nonce],link[nonce]');
      nonce = (el && el.nonce) || '';
    }
    return nonce;
  }

  function place(st) {
    const css = emit(st.copy.cssRules, st);
    if (!st.fallback) {
      if (!st.el) {
        st.el = document.createElement('style');
        st.el.className = OWN_CLASS;
        if (pageNonce()) st.el.nonce = pageNonce();
      }
      const el = st.el;
      el.media = (st.owner && st.owner.media) || '';
      el.textContent = css;
      if (!el.isConnected) {
        if (st.owner && st.owner.isConnected) st.owner.after(el);
        else if (st.root === document) (document.head || document.documentElement).append(el);
        else st.root.append(el);
      }
      el.disabled = state.paused;
      if (el.sheet) return;
      // The page's Content-Security-Policy refused an inline <style>. A constructed sheet is
      // not subject to it, at the cost of sitting after every other sheet in the cascade.
      st.el = null;
      el.remove();
      st.fallback = new CSSStyleSheet();
      st.root.adoptedStyleSheets = [...st.root.adoptedStyleSheets, st.fallback];
    }
    st.fallback.replaceSync(css);
    st.fallback.disabled = state.paused;
  }

  // ---- inline styles and colour attributes --------------------------------

  function intern(body, weak) {
    const id = (weak ? 'p' : 's') + body;
    let key = keys.get(id);
    if (!key) {
      if (keys.size > 5000) return null;
      key = `${state.gen}-${keys.size + 1}`;
      keys.set(id, key);
      const sel = weak ? `:where([${ATTR_P}="${key}"])` : `[${ATTR_S}="${key}"]`;
      const sheet = ownSheet('inline');
      try {
        sheet.insertRule(`${sel}{${body}}`, sheet.cssRules.length);
      } catch {}
    }
    return key;
  }

  function setKey(el, attr, key) {
    const cur = el.getAttribute(attr);
    if (key) {
      if (cur !== key) el.setAttribute(attr, key);
    } else if (cur !== null) {
      el.removeAttribute(attr);
    }
  }

  const STYLE_HINT = /colou?r|background|border|shadow|fill|stroke|outline|blend|--/i;

  function inlineOne(el) {
    const st = el.getAttribute('style') || '';
    const name = el.localName;
    const bg = el.getAttribute('bgcolor') || '';
    const fc = name === 'font' ? el.getAttribute('color') : name === 'body' ? el.getAttribute('text') : '';
    const sig = st + '\u0001' + bg + '\u0001' + (fc || '');
    if (sigs.get(el) === sig) return;
    sigs.set(el, sig);
    let strong = '';
    if (st && STYLE_HINT.test(st) && el.style) {
      for (const rec of collect(el.style)) {
        if (rec.custom) {
          const prop = rec.p.slice(2);
          for (const v of VARIANTS) strong += `--lull-${v}-${prop}:${variantValue(rec, v)};`;
        } else {
          const next = rewriteDecl(rec);
          if (next !== rec.v) strong += `${rec.p}:${next}!important;`;
        }
      }
    }
    let weak = '';
    const bgc = bg && C.legacy(bg, 'bg');
    if (bgc) weak += `background-color:${bgc};`;
    const fgc = fc && C.legacy(fc, 'fg');
    if (fgc) weak += `color:${fgc};`;
    setKey(el, ATTR_S, strong && intern(strong, false));
    if (weak || !(el instanceof SVGElement)) setKey(el, ATTR_P, weak && intern(weak, true));
  }

  const SVG_ATTRS = ['fill', 'stroke', 'stop-color'];
  const SVG_SKIP = /^(none|currentcolor|inherit|transparent|context-fill|context-stroke)$|^url\(/i;

  function coversSvg(el, svg) {
    if (el.localName !== 'rect') return false;
    const w = el.getAttribute('width');
    const h = el.getAttribute('height');
    if (w === '100%' && h === '100%') return true;
    const box = svg.viewBox && svg.viewBox.baseVal;
    const W = (box && box.width) || parseFloat(svg.getAttribute('width'));
    const H = (box && box.height) || parseFloat(svg.getAttribute('height'));
    return W > 0 && H > 0 && parseFloat(w) >= W * 0.9 && parseFloat(h) >= H * 0.9;
  }

  // Colours written as SVG attributes. Dark shapes become light. Light shapes stay light
  // unless the same drawing also has dark shapes (a white tick on a black disc), in which
  // case both are swapped so the drawing keeps its contrast.
  function svgOne(svg) {
    const els = svg.querySelectorAll('[fill],[stroke],[stop-color]');
    if (els.length > 400) return;
    const items = [];
    let dark = 0;
    let light = 0;
    const read = (el) => {
      for (const attr of SVG_ATTRS) {
        const v = el.getAttribute(attr);
        if (!v || SVG_SKIP.test(v.trim())) continue;
        const col = C.parse(v);
        if (!col && !v.includes('var(')) continue;
        const k = col ? C.kind(col) : 'other';
        if (k === 'dark') dark++;
        else if (k === 'light') light++;
        items.push([el, attr, v, k]);
      }
    };
    read(svg);
    for (const el of els) read(el);
    const pair = dark > 0 && light > 0;
    const bodies = new Map();
    for (const [el, attr, v, k] of items) {
      const ctx = k === 'light' && (pair || coversSvg(el, svg)) ? 'bg' : 'fg';
      bodies.set(el, (bodies.get(el) || '') + `${attr}:${C.rewrite(v, ctx)};`);
    }
    for (const [el, body] of bodies) setKey(el, ATTR_P, intern(body, true));
  }

  function* scanInline(root) {
    let n = 0;
    for (const el of root.querySelectorAll('[style],[bgcolor],font[color],body[text]')) {
      inlineOne(el);
      if ((++n & 63) === 0) yield;
    }
    for (const svg of root.querySelectorAll('svg')) {
      if (!svg.ownerSVGElement) svgOne(svg);
      if ((++n & 15) === 0) yield;
    }
  }

  // ---- scopes: the document and its shadow roots --------------------------

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (!el.localName.includes('-') || el.classList.contains(OWN_CLASS)) return null;
    try {
      return chrome.dom.openOrClosedShadowRoot(el);
    } catch {
      return null;
    }
  }

  function findShadows(node) {
    const first = node.nodeType === 1 && shadowOf(node);
    if (first) addScope(first);
    if (!node.firstElementChild) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      const root = shadowOf(el);
      if (root) addScope(root);
    }
  }

  function linkIsSheet(el) {
    return el.localName === 'link' && el.relList.contains('stylesheet');
  }

  function handleOwner(el) {
    if (el.classList.contains(OWN_CLASS)) return;
    if (el.localName === 'style' && !watched.has(el)) {
      watched.add(el);
      textObserver.observe(el, { childList: true, characterData: true, subtree: true });
    }
    const sheet = el.sheet;
    const before = ownerSheet.get(el);
    if (before && before !== sheet) sheets.delete(before);
    // A link that has not loaded is left alone: Lull only ever asks for a style sheet the
    // browser has already let this page load. Its load event brings it back here.
    if (!sheet) return;
    ownerSheet.set(el, sheet);
    run(processSheet(sheet, el, el.getRootNode(), true));
  }

  function* scanScope(root) {
    if (state.colors) {
      for (const sheet of Array.from(root.styleSheets)) {
        const owner = sheet.ownerNode;
        if (owner && owner.nodeType === 1) {
          if (owner.classList.contains(OWN_CLASS)) continue;
          ownerSheet.set(owner, sheet);
          if (owner.localName === 'style' && !watched.has(owner)) {
            watched.add(owner);
            textObserver.observe(owner, { childList: true, characterData: true, subtree: true });
          }
        }
        yield* processSheet(sheet, owner, root, false);
      }
      for (const sheet of root.adoptedStyleSheets) yield* processSheet(sheet, null, root, false);
      yield* scanInline(root);
    }
    findShadows(root === document ? document.documentElement : root);
    for (const fn of hooks.scope) fn(root);
  }

  function addScope(root) {
    if (scopes.has(root)) return;
    scopes.add(root);
    adopt(root);
    observer.observe(root, OBSERVE);
    root.addEventListener('load', onLoad, true);
    root.addEventListener('lull:css', onCss);
    root.addEventListener('lull:shadow', onShadow);
    if (root !== document) run(scanScope(root));
  }

  function rescanAdopted(roots) {
    const seen = new Set();
    for (const root of roots) {
      adopt(root);
      for (const sheet of root.adoptedStyleSheets) {
        if (ownSet.has(sheet) || seen.has(sheet)) continue;
        seen.add(sheet);
        run(processSheet(sheet, null, root, true));
      }
    }
  }

  // ---- reacting to the page changing --------------------------------------

  const OBSERVE = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'bgcolor', 'fill', 'stroke', 'stop-color', 'media'],
  };

  function dropOwner(el) {
    const per = foreign.get(el);
    if (per) {
      for (const st of per.values()) kill(st);
      foreign.delete(el);
    }
    const sheet = ownerSheet.get(el);
    if (sheet) sheets.delete(sheet);
  }

  function nodeAdded(node) {
    if (node.classList.contains(OWN_CLASS)) return;
    if (state.colors) {
      const name = node.localName;
      if (name === 'style' || linkIsSheet(node)) handleOwner(node);
      if (node.hasAttribute('style') || node.hasAttribute('bgcolor') || name === 'font') inlineOne(node);
      if (name === 'svg') svgOne(node.ownerSVGElement || node);
      else if (node.ownerSVGElement) svgOne(node.ownerSVGElement);
      if (node.firstElementChild) {
        for (const el of node.querySelectorAll('style,link[rel~="stylesheet" i]')) handleOwner(el);
        run(scanInline(node));
      }
    }
    findShadows(node);
    for (const fn of hooks.added) fn(node);
  }

  function nodeRemoved(node) {
    if (node.classList.contains(OWN_CLASS)) {
      // Something on the page removed one of Lull's override sheets. Put it back, but give
      // up if the page keeps doing it.
      for (const per of foreign.values()) {
        for (const st of per.values()) {
          if (st.el === node && !st.dead && st.replaced++ < 5) place(st);
        }
      }
      return;
    }
    const name = node.localName;
    if (name === 'style' || name === 'link') dropOwner(node);
    else if (node.firstElementChild && (foreign.size || sheets.size)) {
      for (const el of node.querySelectorAll('style,link')) dropOwner(el);
    }
  }

  const observer = new MutationObserver((list) => {
    if (!state.on) return;
    const styled = new Set();
    const svgs = new Set();
    for (const m of list) {
      const t = m.target;
      if (m.type === 'childList') {
        for (const node of m.removedNodes) if (node.nodeType === 1 && !node.isConnected) nodeRemoved(node);
        for (const node of m.addedNodes) if (node.nodeType === 1 && node.isConnected) nodeAdded(node);
      } else if (!state.colors) {
        continue;
      } else if (m.attributeName === 'style' || m.attributeName === 'bgcolor') {
        styled.add(t);
      } else if (m.attributeName === 'media') {
        if (t.localName === 'style' || linkIsSheet(t)) handleOwner(t);
      } else {
        svgs.add(t.ownerSVGElement || t);
      }
    }
    for (const el of styled) inlineOne(el);
    for (const svg of svgs) if (svg.localName === 'svg') svgOne(svg);
  });

  const textObserver = new MutationObserver((list) => {
    if (!state.on || !state.colors) return;
    const seen = new Set();
    for (const m of list) {
      let el = m.target;
      while (el && el.localName !== 'style') el = el.parentNode;
      if (el) seen.add(el);
    }
    for (const el of seen) handleOwner(el);
  });

  function onLoad(e) {
    const t = e.target;
    if (state.on && state.colors && t && t.nodeType === 1 && linkIsSheet(t)) handleOwner(t);
  }

  // Sent by hook.js when page script edits a style sheet.
  function onCss(e) {
    if (!state.on || !state.colors) return;
    const t = e.target;
    const here = e.currentTarget;
    if (t === document) {
      rescanAdopted(scopes);
    } else if (t.nodeType === 1 && t.getRootNode() === here) {
      if (t.localName === 'style' || t.localName === 'link') handleOwner(t);
      const root = shadowOf(t);
      if (root) {
        addScope(root);
        rescanAdopted([root]);
      }
    }
  }

  // Sent by hook.js when page script attaches a shadow root.
  function onShadow(e) {
    if (!state.on) return;
    const t = e.target;
    if (t.nodeType !== 1 || t.getRootNode() !== e.currentTarget) return;
    const root = shadowOf(t);
    if (root) addScope(root);
  }

  // Without hook.js (a tab that was open before Lull was switched on) fall back to a slow
  // check for style sheets and shadow roots that script has changed.
  const lengths = new WeakMap();
  function poll() {
    if (!state.on || state.hook || document.hidden) return;
    for (const root of Array.from(scopes)) {
      if (state.colors) {
        for (const sheet of root.styleSheets) {
          let n = -1;
          try {
            n = sheet.cssRules.length;
          } catch {}
          if (n >= 0 && lengths.get(sheet) !== n) {
            lengths.set(sheet, n);
            run(processSheet(sheet, sheet.ownerNode, root, true));
          }
        }
        rescanAdopted([root]);
      }
    }
    findShadows(document.documentElement);
  }

  // ---- public API -----------------------------------------------------------

  function start(theme, opts) {
    bulk();
    state.on = true;
    state.colors = !!opts.colors;
    state.paused = false;
    C.setTheme(theme);
    writeBase();
    ownSheet('inline');
    document.addEventListener('lull:pong', () => (state.hook = true), { once: true });
    document.dispatchEvent(new Event('lull:on'));
    addScope(document);
    run(scanScope(document));
    staged = new WeakMap();
    if (!state.hook) pollTimer = setInterval(poll, 1500);
  }

  function retheme() {
    for (const map of sheets.values()) {
      for (const [rule, recs] of map) if (recs) applyRecs(rule.style, recs);
    }
    for (const per of foreign.values()) {
      for (const st of per.values()) {
        if (!st.copy || st.dead) continue;
        for (const [rule, recs] of st.map) applyRecs(rule.style, recs);
        place(st);
      }
    }
  }

  function update(theme) {
    bulk();
    C.setTheme(theme);
    writeBase();
    if (!state.colors) return;
    retheme();
    state.gen++;
    keys.clear();
    sigs = new WeakMap();
    ownSheet('inline').replaceSync('');
    for (const root of scopes) run(scanInline(root));
  }

  function restoreAll() {
    for (const map of sheets.values()) {
      for (const [rule, recs] of map) {
        if (!recs) continue;
        try {
          restoreRecs(rule.style, recs);
        } catch {}
      }
    }
  }

  // Printing uses the page's original colours: light text on white paper is unreadable.
  function pause() {
    if (!state.on || state.paused) return;
    bulk();
    state.paused = true;
    restoreAll();
    for (const sheet of ownSet) sheet.disabled = true;
    for (const per of foreign.values()) {
      for (const st of per.values()) {
        if (st.el) st.el.disabled = true;
        if (st.fallback) st.fallback.disabled = true;
      }
    }
  }

  function resume() {
    if (!state.on || !state.paused) return;
    bulk();
    state.paused = false;
    for (const sheet of ownSet) sheet.disabled = false;
    retheme();
  }

  function stop() {
    if (!state.on) return;
    bulk();
    state.on = false;
    clearInterval(pollTimer);
    observer.disconnect();
    textObserver.disconnect();
    document.dispatchEvent(new Event('lull:off'));
    state.hook = false;
    restoreAll();
    sheets.clear();
    for (const per of foreign.values()) for (const st of per.values()) kill(st);
    foreign.clear();
    cssCache.clear();
    srcCache.clear();
    pending.clear();
    for (const root of scopes) {
      unadopt(root);
      root.removeEventListener('load', onLoad, true);
      root.removeEventListener('lull:css', onCss);
      root.removeEventListener('lull:shadow', onShadow);
      for (const el of root.querySelectorAll(`[${ATTR_S}],[${ATTR_P}]`)) {
        el.removeAttribute(ATTR_S);
        el.removeAttribute(ATTR_P);
      }
    }
    scopes.clear();
    for (const sheet of ownSet) {
      sheet.replaceSync('');
      sheet.disabled = false;
    }
    keys.clear();
    sigs = new WeakMap();
    state.gen++;
  }

  Lull.theme = { prepare, start, settle, whenIdle, stop, update, pause, resume, ownSheet, hooks, scopes, state };
})();
