#!/usr/bin/env node
// Zero-dependency static server for local development and previews.
//   node scripts/serve.mjs            serve the repository root on :8080
//   node scripts/serve.mjs www 8081   serve a build output on :8081
// Serves .js/.mjs as JavaScript (needed for ES modules) and honours HTTP
// Range requests (needed for PMTiles archives). Not for production use.
//
// It answers this computer only (http://localhost), never another device on
// the same network. And whatever folder it serves, it does not hand out hidden
// files (.git, .env), the phone projects (android/, ios/) or signing files:
// the rule is mayServe in guards.mjs.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { mayServe, partsBelow, requestedFile } from './guards.mjs';

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

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // By name first: nothing outside the folder, nothing hidden, no signing material.
    let file = requestedFile(root, url.pathname);
    if (file && (await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    // Then by what is really on disk. A link, or a Windows short name such as
    // ANDROI~1, can lead somewhere the name did not show, so the real path is
    // held to the same rule. A refusal looks the same as a file that is not there.
    const real = file ? await realpath(file).catch(() => null) : null;
    const info = real && mayServe(partsBelow(await realpath(root), real)) ? await stat(real) : null;
    if (!info?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }

    const headers = {
      'Content-Type': TYPES[extname(real).toLowerCase()] || 'application/octet-stream',
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
      createReadStream(real, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(real).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err?.message || err));
  }
};

// This computer only. Both of its own addresses are used (127.0.0.1 and ::1),
// so that "localhost" works whichever one a browser tries first; neither can
// be reached from another device.
const listen = (host) => new Promise((done) => {
  createServer(handler).once('error', done).listen(port, host, () => done(null));
});
const failed = await listen('127.0.0.1');
if (failed) {
  console.error(failed.code === 'EADDRINUSE'
    ? `Port ${port} is already in use on this computer. Stop the other program, or add a different port number to the command (for example ${port + 1}).`
    : `The server could not start: ${failed.message}`);
  process.exit(1);
}
const second = await listen('::1'); // fails on a computer with IPv6 switched off: the first address is enough
console.log(`Serving ${root} at http://localhost:${port} (this computer only)`);
if (second?.code === 'EADDRINUSE') {
  console.log(`Another program is already using port ${port} on this computer. If the page that opens is not this app, use http://127.0.0.1:${port} instead.`);
}
