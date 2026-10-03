// Two local servers for the tests: the "site" and a second origin that plays the role of a
// CDN which does not allow cross-origin reads (the common case that breaks dark themes).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SITE = 8931;
export const CDN = 8932;
// What the servers saw, for tests that check which requests were (not) made.
export const seen = { hits: {}, hugeSent: 0, hugeFinished: false };

function png(w, h, paint) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(paint(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const IMAGES = {
  // black bars on a see-through background: a typical logo
  '/logo-dark.png': png(96, 32, (x, y) => (x % 12 < 7 && y > 6 && y < 26 ? [10, 10, 10, 255] : [0, 0, 0, 0])),
  // dark lettering plus an orange mark on a see-through background
  '/logo-color.png': png(96, 32, (x, y) =>
    y < 6 || y > 26 ? [0, 0, 0, 0] : x < 30 ? [240, 120, 20, 255] : x % 12 < 7 ? [15, 20, 40, 255] : [0, 0, 0, 0],
  ),
  // a white diagram with a few lines
  '/bright.png': png(240, 140, (x, y) => (x % 40 === 0 || y % 35 === 0 ? [30, 30, 30, 255] : [255, 255, 255, 255])),
  // a colourful mid-tone picture
  '/photo.png': png(240, 140, (x, y) => [80 + (x % 120), 110, 60 + (y % 100), 255]),
};
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
// One second of silence, for the autoplay test.
const WAV = (() => {
  const samples = 8000;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return buf;
})();
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><path d="M2 2h36v16H2z M6 6v8h28V6z" fill-rule="evenodd"/></svg>';

const CSS = {
  '/site.css': `
    body { margin: 16px; font: 16px/1.5 sans-serif; background: #ffffff; color: #1a1a1a; }
    a { color: #0645ad; }
    .site-card { background: #fff; color: #222; border: 1px solid #ddd; padding: 8px; }
    .spin { width: 20px; height: 20px; background: #06c; animation: spin 1s linear infinite; transition: opacity 2s; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .site-broken { background: linear-gradient(rgba(255,255,255,0), var(--bg, #fff)); background-repeat: no-repeat; }
    @media print { body { background: #fff; } }`,
  '/cdn.css': `
    :root { --cdn-bg: #ffffff; --cdn-ink: #202020; }
    .cdn-card { background: #ffffff; color: #333333; padding: 8px; }
    .cdn-btn { background: #1a73e8; color: #fff !important; }
    .cdn-var { background: var(--cdn-bg); color: var(--cdn-ink); }
    @media (min-width: 1px) { .cdn-mq { background-color: #f0f0f0; } }
    @layer comp { .cdn-layer { background: #fafafa; } }
    .cdn-order { color: #b00000; }
    .cdn-order { color: inherit; }
    .cdn-pic { background: #fff url(photo.png) no-repeat; }
    .cdn-broken { background: var(--cdn-bg) url(photo.png); background-repeat: repeat-x; border: 2px solid var(--cdn-ink); border-top-width: 0; }`,
};

Object.assign(CSS, {
  '/local.css': '.local-card { background: #ffffff; color: #111111; }',
  '/after-redirect.css': '.redir-card { background: #ffffff; color: #111111; }',
});
const CORS_CSS = '.cors-card { background: #ffffff; color: #111111; }';
// A PNG header that claims 30000 x 30000 pixels, with nothing behind it.
const BOMB = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(30000, 16);
  b.writeUInt32BE(30000, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
})();

function handler(port) {
  return async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    seen.hits[path] = (seen.hits[path] || 0) + 1;
    const wait = Number(url.searchParams.get('ms')) || 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const send = (type, body, extra = {}) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(body);
    };
    if (CSS[path]) return send('text/css', CSS[path]);
    if (IMAGES[path]) return send('image/png', IMAGES[path]);
    // A white product photo with a .jpg address: once from a host that allows cross-origin
    // reads and once from one that does not.
    if (path === '/product.jpg') return send('image/png', IMAGES['/bright.png'], { 'access-control-allow-origin': '*' });
    if (path === '/product-private.jpg') return send('image/png', IMAGES['/bright.png']);
    if (path === '/anim.gif') return send('image/gif', GIF);
    if (path === '/anim-cors.gif') return send('image/gif', GIF, { 'access-control-allow-origin': '*' });
    if (path === '/bomb.png') return send('image/png', BOMB);
    if (path === '/cors.css') return send('text/css', CORS_CSS, { 'access-control-allow-origin': '*' });
    if (path === '/redir.css' || path === '/redir-cors.css') {
      const cors = path === '/redir-cors.css';
      res.writeHead(302, { location: cors ? '/cors.css' : '/after-redirect.css', ...(cors ? { 'access-control-allow-origin': '*' } : {}) });
      return res.end();
    }
    if (path === '/huge.css') {
      // 40 MB with no Content-Length: a download that must be cut off, not trusted.
      res.writeHead(200, { 'content-type': 'text/css' });
      const chunk = Buffer.alloc(256 * 1024, 'a');
      let sent = 0;
      const pump = () => {
        while (sent < 40 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', () => {
        seen.hugeSent = sent;
        seen.hugeFinished = res.writableFinished;
      });
      return pump();
    }
    if (path === '/tone.wav') return send('audio/wav', WAV);
    if (path === '/formula.svg') return send('image/svg+xml', SVG);
    if (path.endsWith('.html')) {
      try {
        const html = readFileSync(join(here, 'fixtures', path.slice(1)), 'utf8').replaceAll('{{CDN}}', `http://localhost:${CDN}`);
        const extra = path === '/csp.html' ? { 'content-security-policy': `default-src 'self' http://localhost:${CDN}; style-src 'self' http://localhost:${CDN}` } : {};
        return send('text/html; charset=utf-8', html, extra);
      } catch {}
    }
    res.writeHead(404);
    res.end('not found');
  };
}

export function startServers() {
  const servers = [createServer(handler(SITE)).listen(SITE), createServer(handler(CDN)).listen(CDN)];
  return () => servers.forEach((s) => s.close());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServers();
  console.log(`site http://localhost:${SITE}/light.html   cdn http://localhost:${CDN}`);
}
