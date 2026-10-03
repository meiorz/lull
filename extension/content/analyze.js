// Decides what a picture needs on a dark page. Shared by the content script (pictures it can
// read directly) and the service worker (pictures on other origins).
// Verdicts: 'invert'  dark single-colour artwork on a see-through background (logos, formulas)
//           'plate'   dark but colourful artwork on a see-through background
//           'bright'  an opaque, mostly white picture (diagrams, screenshots)
//           'ok'      leave it alone
(() => {
  'use strict';

  // `data` is RGBA pixels of a small thumbnail.
  function classifyPixels(data) {
    let total = 0;
    let clear = 0;
    let dark = 0;
    let light = 0;
    let vivid = 0;
    for (let i = 0; i < data.length; i += 4) {
      total++;
      const a = data[i + 3];
      if (a < 40) {
        clear++;
        continue;
      }
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 70) vivid++;
      else if (lum < 0.3) dark++;
      else if (lum > 0.82) light++;
    }
    const solid = total - clear;
    if (!solid) return 'ok';
    if (clear / total > 0.1) {
      if (dark / solid > 0.75) return 'invert';
      if (dark / solid > 0.35 && light / solid < 0.2) return 'plate';
      return 'ok';
    }
    return light / solid > 0.6 ? 'bright' : 'ok';
  }

  // SVG files cannot be decoded in a service worker, so read their colours from the source.
  function classifySvg(text) {
    if (text.length > 400000) return 'ok';
    const found = text.match(/(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)/gi) || [];
    let dark = 0;
    let other = 0;
    for (const hit of found) {
      const value = hit.replace(/^[^:=]*[:=]\s*["']?\s*/, '').toLowerCase();
      if (value === 'none' || value === 'currentcolor' || value === 'transparent' || value === 'inherit') continue;
      const rgb = svgColor(value);
      if (!rgb) continue;
      const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      const spread = Math.max(...rgb) - Math.min(...rgb);
      if (lum < 0.3 && spread < 70) dark++;
      else other++;
    }
    // No colours at all means every shape uses the SVG default, which is black.
    if (!dark && !other) return /<(path|rect|circle|polygon|text|ellipse|line|polyline|use|g)\b/i.test(text) ? 'invert' : 'ok';
    if (!other) return 'invert';
    return dark > other ? 'plate' : 'ok';
  }

  function svgColor(value) {
    if (value[0] === '#') {
      let h = value.slice(1);
      if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length < 6) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
    if (m) return [+m[1], +m[2], +m[3]];
    if (value === 'black') return [0, 0, 0];
    if (value === 'white') return [255, 255, 255];
    return null;
  }

  globalThis.LullAnalyze = { classifyPixels, classifySvg };
})();
