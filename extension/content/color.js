// Colour maths: parse CSS colours and map them into a calm dark range.
// Everything is done in OKLCH, where equal steps in lightness look equal to the eye, so
// "no pure black, no pure white, no vivid colour" can be stated as simple limits.
(() => {
  'use strict';
  const Lull = (globalThis.Lull ||= {});

  const NAMED = new Map(
    (
      'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,' +
      'black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,' +
      'chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,' +
      'darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,' +
      'darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,' +
      'darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,' +
      'darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,' +
      'dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,' +
      'ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,' +
      'honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
      'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,' +
      'lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,' +
      'lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,' +
      'lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,' +
      'mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,' +
      'mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,' +
      'midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,' +
      'oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,' +
      'palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,' +
      'pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,' +
      'royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,' +
      'sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,' +
      'springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,' +
      'violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32'
    )
      .split(',')
      .map((pair) => pair.split(':')),
  );

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const NEUTRAL = 0.025; // chroma below this reads as grey

  // ---- conversions -----------------------------------------------------

  function toLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function fromLinear(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function rgbToOklch(r, g, b) {
    r = toLinear(r);
    g = toLinear(g);
    b = toLinear(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    let h = (Math.atan2(B, A) * 180) / Math.PI;
    if (h < 0) h += 360;
    return [L, Math.hypot(A, B), h];
  }

  function oklabToLinear(L, A, B) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }

  // OKLCH to 8-bit sRGB. Colours outside the sRGB gamut lose chroma, never lightness or hue.
  function oklchToRgb(L, C, h) {
    const rad = (h * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let lin = oklabToLinear(L, C * cos, C * sin);
    for (let i = 0; i < 12 && lin.some((v) => v < -0.0005 || v > 1.0005); i++) {
      C *= 0.85;
      lin = oklabToLinear(L, C * cos, C * sin);
    }
    return lin.map((v) => Math.round(clamp(fromLinear(clamp(v, 0, 1)), 0, 1) * 255));
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
    };
    return [f(0), f(8), f(4)];
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return [h, s, l];
  }

  // ---- parsing ---------------------------------------------------------
  // A parsed colour is { r, g, b, a, ax }. `ax` holds an alpha that is not a plain number,
  // such as var(--tw-bg-opacity), so it can be written back untouched.

  function parseHex(h) {
    const n = h.length;
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    if (n === 3 || n === 4) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: n === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1,
      };
    }
    if (n === 6 || n === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: n === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  function num(s, scale) {
    if (s === 'none') return 0;
    const v = parseFloat(s);
    return s.endsWith('%') ? (v / 100) * scale : v;
  }

  function angle(s) {
    if (s === 'none') return 0;
    const v = parseFloat(s);
    if (s.endsWith('turn')) return v * 360;
    if (s.endsWith('grad')) return v * 0.9;
    if (s.endsWith('rad')) return (v * 180) / Math.PI;
    return v;
  }

  // Split the inside of a colour function into three channels and an optional alpha,
  // without being confused by commas or slashes inside nested parentheses.
  function splitArgs(body) {
    const parts = [];
    let depth = 0;
    let cur = '';
    let alpha = null;
    let inAlpha = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && !inAlpha && (ch === ',' || ch === '/' || ch === ' ' || ch === '\n' || ch === '\t')) {
        if (cur) parts.push(cur);
        cur = '';
        if (ch === '/') inAlpha = true;
        continue;
      }
      cur += ch;
    }
    if (inAlpha) alpha = cur.trim();
    else if (cur) parts.push(cur);
    if (alpha == null && parts.length === 4) alpha = parts.pop();
    return parts.length === 3 ? [parts, alpha] : null;
  }

  function parseFn(name, body) {
    const args = splitArgs(body);
    if (!args) return null;
    const [p, alpha] = args;
    if (p.some((s) => s.includes('('))) return null;
    let rgb;
    if (name === 'rgb' || name === 'rgba') {
      rgb = [num(p[0], 255), num(p[1], 255), num(p[2], 255)];
    } else if (name === 'hsl' || name === 'hsla') {
      rgb = hslToRgb(angle(p[0]), parseFloat(p[1]) / 100 || 0, parseFloat(p[2]) / 100 || 0);
    } else if (name === 'oklch') {
      rgb = oklchToRgb(num(p[0], 1), num(p[1], 0.4), angle(p[2]));
    } else if (name === 'oklab') {
      const A = num(p[1], 0.4);
      const B = num(p[2], 0.4);
      rgb = oklchToRgb(num(p[0], 1), Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI);
    } else {
      return null;
    }
    if (rgb.some(Number.isNaN)) return null;
    const col = { r: clamp(rgb[0], 0, 255), g: clamp(rgb[1], 0, 255), b: clamp(rgb[2], 0, 255), a: 1 };
    if (alpha != null) {
      if (/^[-+]?[\d.]+%?$/.test(alpha)) col.a = clamp(num(alpha, 1), 0, 1);
      else if (alpha === 'none') col.a = 0;
      else col.ax = alpha;
    }
    return col;
  }

  // Anything the fast parsers do not know (lab(), color(), relative colours) is handed to
  // the browser's own colour parser through a 1x1 canvas.
  let probe;
  const probed = new Map();
  function parseSlow(text) {
    if (probed.has(text)) return probed.get(text);
    let col = null;
    try {
      probe ||= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      probe.fillStyle = '#010203';
      probe.fillStyle = text;
      if (probe.fillStyle !== '#010203') {
        probe.clearRect(0, 0, 1, 1);
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        col = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    } catch {
      col = null;
    }
    if (probed.size > 2000) probed.clear();
    probed.set(text, col);
    return col;
  }

  function parse(text) {
    text = text.trim();
    if (text[0] === '#') return parseHex(text.slice(1));
    const open = text.indexOf('(');
    if (open > 0 && text.endsWith(')')) {
      const name = text.slice(0, open).toLowerCase();
      return parseFn(name, text.slice(open + 1, -1)) || (text.includes('var(') ? null : parseSlow(text));
    }
    const hex = NAMED.get(text.toLowerCase());
    return hex ? parseHex(hex) : null;
  }

  // ---- the theme -------------------------------------------------------

  let T = null;
  const cache = new Map();
  const CTX_ID = { bg: 0, fg: 1, bd: 2 };

  function makeTheme(settings, pageIsDark) {
    const P = globalThis.LULL.PALETTES[settings.palette] || globalThis.LULL.PALETTES.slate;
    const s = clamp(settings.saturation, 0, 100) / 100;
    const textL = 0.76 + (clamp(settings.contrast, 0, 100) / 100) * 0.19;
    const t = {
      base: P.base, // lightness that white backgrounds become
      floor: P.base - 0.045, // lightness that black backgrounds become
      peak: P.base + 0.18, // the lightest any background may be
      hue: P.hue,
      tint: P.tint,
      textL,
      textLo: Math.max(textL - 0.2, 0.64), // dimmest text; 0.64 keeps it near 5:1 on the base surface
      textHi: Math.min(0.96, textL + 0.05),
      capBg: 0.02 + s * 0.1,
      capFg: 0.03 + s * 0.15,
      dark: !!pageIsDark,
    };
    const css = (L, C, h) => `rgb(${oklchToRgb(L, C, h).join(', ')})`;
    t.css = {
      bg: css(t.base, t.tint, t.hue),
      fg: css(textL, t.tint, t.hue),
      border: css(t.base + 0.13, t.tint, t.hue),
      link: css(textL - 0.07, Math.min(0.1, t.capFg), P.link),
      visited: css(textL - 0.1, Math.min(0.08, t.capFg), P.link + 55),
      selBg: css(t.base + 0.2, Math.min(0.06, t.capBg + 0.02), P.link),
      selFg: css(Math.min(0.96, textL + 0.06), t.tint, t.hue),
      markBg: css(t.base + 0.16, Math.min(0.07, t.capBg + 0.02), 95),
      plate: css(textL - 0.04, t.tint, t.hue),
    };
    return t;
  }

  function setTheme(theme) {
    T = theme;
    cache.clear();
  }

  // Backgrounds: white becomes the base surface, black becomes a slightly deeper one, and
  // mid-tones (buttons, badges) land in between. Nothing reaches pure black.
  function mapBg(L, C, h) {
    const l = L >= 0.6 ? T.base + ((1 - L) / 0.4) * (T.peak - T.base) : T.floor + (L / 0.6) * (T.peak - T.floor);
    if (C < NEUTRAL) return [l, T.tint, T.hue];
    return [l, Math.min(C, L >= 0.6 ? T.capBg : T.capBg * 1.6), h];
  }

  // Text: dark text becomes light, light text stays light, and nothing reaches pure white.
  function mapFg(L, C, h) {
    const l =
      L < 0.62 ? T.textL - (L / 0.62) * (T.textL - T.textLo) : T.textLo + ((L - 0.62) / 0.38) * (T.textHi - T.textLo);
    if (C < NEUTRAL) return [l, T.tint, T.hue];
    return [l, Math.min(C, T.capFg), h];
  }

  // Borders: on a light page a darker border was a stronger line, so it becomes a lighter
  // line here. On a page that was already dark, borders are only kept inside a calm range.
  function mapBd(L, C, h) {
    const l = T.dark ? clamp(L, T.base + 0.06, 0.6) : Math.min(0.62, T.base + 0.07 + (1 - L) * 0.33);
    if (C < NEUTRAL) return [l, T.tint, T.hue];
    return [l, Math.min(C, (T.capBg + T.capFg) / 2), h];
  }

  const MAPS = { bg: mapBg, fg: mapFg, bd: mapBd };

  function transform(r, g, b, ctx) {
    r = Math.round(r);
    g = Math.round(g);
    b = Math.round(b);
    const key = CTX_ID[ctx] * 16777216 + (r << 16) + (g << 8) + b;
    let out = cache.get(key);
    if (!out) {
      const [L, C, h] = rgbToOklch(r, g, b);
      out = oklchToRgb(...MAPS[ctx](L, C, h));
      cache.set(key, out);
    }
    return out;
  }

  function paint(col, ctx) {
    const [r, g, b] = transform(col.r, col.g, col.b, ctx);
    if (col.ax) return `rgb(${r} ${g} ${b} / ${col.ax})`;
    if (col.a < 1) return `rgba(${r}, ${g}, ${b}, ${+col.a.toFixed(3)})`;
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ---- rewriting CSS values ---------------------------------------------

  const TOKEN =
    /["']|url\(|var\(|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|#[0-9a-f]{3,8}(?![\w-])|(?<![\w\-.#$@])[a-z]{3,20}(?![\w\-(])/gi;

  function closeParen(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return i;
    }
    return s.length - 1;
  }

  // Rewrite every colour inside a CSS value for one context (bg, fg or bd).
  // var(--x) becomes var(--lull-<ctx>-x, var(--x)): if Lull has seen --x defined as a colour
  // it also defined the context variant; if not, the original keeps working.
  function rewrite(value, ctx) {
    if (value.length < 3) return value;
    let out = '';
    let last = 0;
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(value))) {
      const tok = m[0];
      const i = m.index;
      let end = i + tok.length;
      let rep = null;
      if (tok === '"' || tok === "'") {
        const close = value.indexOf(tok, i + 1);
        end = close < 0 ? value.length : close + 1;
      } else if (tok.endsWith('(')) {
        const close = closeParen(value, end - 1);
        const name = tok.slice(0, -1).toLowerCase();
        const inner = value.slice(end, close);
        end = close + 1;
        if (name === 'var') {
          const comma = inner.indexOf(',');
          const vname = (comma < 0 ? inner : inner.slice(0, comma)).trim();
          if (!vname.startsWith('--lull-')) {
            const rest = comma < 0 ? '' : rewrite(inner.slice(comma), ctx);
            rep = `var(--lull-${ctx}-${vname.slice(2)}, var(${vname}${rest}))`;
          }
        } else if (name !== 'url') {
          const col = parseFn(name, inner) || (inner.includes('var(') ? null : parseSlow(value.slice(i, end)));
          if (col) rep = paint(col, ctx);
          else if (inner.includes('var(')) rep = tok + rewrite(inner, ctx) + ')';
        }
      } else if (tok[0] === '#') {
        const col = parseHex(tok.slice(1));
        if (col) rep = paint(col, ctx);
      } else {
        const hex = NAMED.get(tok.toLowerCase());
        if (hex) rep = paint(parseHex(hex), ctx);
      }
      if (rep != null) {
        out += value.slice(last, i) + rep;
        last = end;
      }
      TOKEN.lastIndex = end;
    }
    return last ? out + value.slice(last) : value;
  }

  // "255 255 255" or "210 40% 98%": bare channels meant for rgb(var(--x)) / hsl(var(--x)).
  const TRIPLET = /^\s*(-?\d*\.?\d+)(deg)?(\s*,\s*|\s+)(-?\d*\.?\d+)(%?)(\s*,\s*|\s+)(-?\d*\.?\d+)(%?)\s*$/;

  function triplet(value) {
    const m = TRIPLET.exec(value);
    if (!m) return null;
    const hsl = m[5] === '%' && m[8] === '%';
    if (!hsl && (m[2] || m[5] || m[8] || +m[1] > 255 || +m[4] > 255 || +m[7] > 255)) return null;
    return m;
  }

  function rewriteTriplet(m, ctx) {
    const hsl = m[5] === '%';
    const rgb = hsl ? hslToRgb(+m[1], +m[4] / 100, +m[7] / 100) : [+m[1], +m[4], +m[7]];
    const out = transform(rgb[0], rgb[1], rgb[2], ctx);
    if (!hsl) return `${out[0]}${m[3]}${out[1]}${m[6]}${out[2]}`;
    const [h, s, l] = rgbToHsl(...out);
    return `${+h.toFixed(1)}${m[2] || ''}${m[3]}${+(s * 100).toFixed(1)}%${m[6]}${+(l * 100).toFixed(1)}%`;
  }

  // Could this custom property hold a colour, or lead to one? Plain numbers, lengths and
  // maths cannot, and skipping them keeps Lull from tripling every spacing variable.
  const COLOR_FN = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|gradient)\(/i;
  const MATHS = /(?:calc|clamp|min|max|url)\(/i;
  function isColorish(value) {
    if (triplet(value)) return true;
    if (COLOR_FN.test(value)) return true;
    if (MATHS.test(value)) return false;
    if (value.includes('var(')) return true;
    return rewrite(value, 'bg') !== value;
  }

  // Legacy attribute colours: bgcolor="ffffff", <font color="navy">.
  function legacy(value, ctx) {
    const s = value.trim();
    const col = parse(s) || (/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(s) ? parseHex(s) : null);
    return col ? paint(col, ctx) : null;
  }

  // 'dark' or 'light' for near-greys, 'other' for mid-tones and real colours.
  function kind(col) {
    const [L, C] = rgbToOklch(col.r, col.g, col.b);
    if (C > 0.04) return 'other';
    return L < 0.45 ? 'dark' : L > 0.8 ? 'light' : 'other';
  }

  function lightness(col) {
    return rgbToOklch(col.r, col.g, col.b)[0];
  }

  Lull.color = {
    parse,
    rewrite,
    triplet,
    rewriteTriplet,
    isColorish,
    legacy,
    kind,
    lightness,
    makeTheme,
    setTheme,
    rgbToOklch,
    oklchToRgb,
    get theme() {
      return T;
    },
  };
})();
