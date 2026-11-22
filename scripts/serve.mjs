#!/usr/bin/env node
// Zero-dependency static server for local development and previews.
//   node scripts/serve.mjs            serve the repository root on :8080
//   node scripts/serve.mjs www 8081   serve a build output on :8081
// Serves .js/.mjs as JavaScript (needed for ES modules) and honours HTTP
// Range requests (needed for PMTiles archives). Not for production use.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a))) || 8080;
const root = resolve(args.find((a) => !/^\d+$/.test(a)) || '.');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.pbf': 'application/x-protobuf', '.pmtiles': 'application/octet-stream', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8', '.map': 'application/json',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Resolve inside the root only: anything that climbs out is refused.
    const parts = decodeURIComponent(url.pathname).split('/').filter((p) => p && p !== '.');
    if (parts.includes('..')) { res.writeHead(403).end('Forbidden'); return; }
    let file = join(root, ...parts);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) { file = join(file, 'index.html'); info = await stat(file).catch(() => null); }
    if (!info?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }

    const headers = {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      start = Math.max(0, start);
      end = Math.min(info.size - 1, end);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err?.message || err));
  }
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}`));
