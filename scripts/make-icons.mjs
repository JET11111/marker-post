#!/usr/bin/env node
// Draw the app icon once and write every size each platform needs.
//
//   node scripts/make-icons.mjs
//
// The mark is the marker post from the original icon: an amber post with a
// pale cap, on near-black. Bitmaps are rendered with the Chrome already on the
// machine (scripts/browser.mjs); the Android adaptive icon, its monochrome
// (themed) layer and the launch icon are written as vector drawables, so they
// need no bitmaps at all. The results are committed: nothing here runs in CI.
//
//   Web app   icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
//   iOS       AppIcon (1024, no transparency), launch image for light and dark
//   Android   launcher bitmaps for Android 7, adaptive icon, themed icon, launch icon

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { launch } from './browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const out = (...p) => join(ROOT, ...p);

const COLOUR = { tile: '#101114', post: '#FFB81C', cap: '#F2F2F7', ground: '#3A3A42' };
const LAUNCH = { light: '#F2F2F7', dark: '#000000' }; // the app's own page backgrounds

// The mark, drawn on a 1024 square and centred on it. Later shapes sit on top.
const MARK = [
  { fill: 'post', x: 440, y: 304, w: 144, h: 500, r: 26 },
  { fill: 'ground', x: 352, y: 792, w: 320, h: 24, r: 12 },
  { fill: 'cap', x: 404, y: 208, w: 216, h: 108, r: 26 },
];

// ------------------------------------------------------------------ drawing

/** The mark as SVG shapes, scaled by k about the centre of a `size` square. */
function markSvg(size, k, colour = COLOUR) {
  const f = (size / 1024) * k, c = size / 2;
  return MARK.map((m) => {
    const x = c + (m.x - 512) * f, y = c + (m.y - 512) * f;
    return `<rect x="${x}" y="${y}" width="${m.w * f}" height="${m.h * f}" rx="${m.r * f}" fill="${colour[m.fill] || colour.all}"/>`;
  }).join('');
}
/**
 * One icon as an SVG document.
 * shape: 'square' fills the image, 'rounded' and 'circle' leave the corners
 * see-through, 'tile' is a small rounded tile on a plain background (launch image).
 */
function iconSvg({ size, k, shape = 'square', background }) {
  let base = '';
  let mark = markSvg(size, k);
  if (shape === 'square') base = `<rect width="${size}" height="${size}" fill="${COLOUR.tile}"/>`;
  if (shape === 'rounded') {
    const inset = size / 24;
    base = `<rect x="${inset}" y="${inset}" width="${size - 2 * inset}" height="${size - 2 * inset}" rx="${size * 0.19}" fill="${COLOUR.tile}"/>`;
  }
  if (shape === 'circle') base = `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - size / 48}" fill="${COLOUR.tile}"/>`;
  if (shape === 'tile') {
    // A 2732 px image is shown scaled to fill the screen, so the tile is about a fifth of a phone's width.
    const tile = size * 0.2, at = (size - tile) / 2;
    base = `<rect width="${size}" height="${size}" fill="${background}"/>`
      + `<rect x="${at}" y="${at}" width="${tile}" height="${tile}" rx="${tile * 0.225}" fill="${background === LAUNCH.dark ? '#1C1C1E' : COLOUR.tile}"/>`;
    mark = `<g transform="translate(${at} ${at})">${markSvg(tile, 1)}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${base}${mark}</svg>`;
}

/** The mark as an Android vector drawable on the 108dp adaptive-icon canvas. */
function vectorDrawable({ k, colour = COLOUR, disc }) {
  const f = (108 / 1024) * k, n = (v) => Number(v.toFixed(3));
  const paths = MARK.map((m) => {
    const x = n(54 + (m.x - 512) * f), y = n(54 + (m.y - 512) * f);
    const w = n(m.w * f), h = n(m.h * f), r = n(m.r * f);
    // A rounded rectangle, clockwise from the top edge. A side of no length (a fully rounded end) is left out.
    const side = (cmd, len) => (Math.abs(len) < 0.0005 ? '' : `${cmd}${n(len)}`);
    const d = `M${n(x + r)},${y}${side('h', w - 2 * r)}a${r},${r} 0 0 1 ${r},${r}${side('v', h - 2 * r)}a${r},${r} 0 0 1 -${r},${r}${side('h', -(w - 2 * r))}a${r},${r} 0 0 1 -${r},-${r}${side('v', -(h - 2 * r))}a${r},${r} 0 0 1 ${r},-${r}z`;
    return `    <path android:fillColor="${colour[m.fill] || colour.all}" android:pathData="${d}" />`;
  });
  if (disc) {
    paths.unshift(`    <path android:fillColor="${disc.colour}" android:pathData="M${54 - disc.r},54a${disc.r},${disc.r} 0 1 0 ${2 * disc.r},0a${disc.r},${disc.r} 0 1 0 -${2 * disc.r},0z" />`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by scripts/make-icons.mjs. Edit the drawing there, not here. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
${paths.join('\n')}
</vector>
`;
}

// ---------------------------------------------------------------------- PNG

/** Decode the 8-bit RGBA PNG that Chrome produces. */
function decodePng(buf) {
  let at = 8, width = 0, height = 0, colourType = 6;
  const idat = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colourType = data[9];
      if (data[8] !== 8 || (colourType !== 6 && colourType !== 2) || data[12] !== 0) throw new Error('Unexpected PNG format');
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const bpp = colourType === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? px[row + x - bpp] : 0;
      const up = y > 0 ? px[row - stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      px[row + x] = (line[x] + predicted) & 255;
    }
  }
  return { width, height, bpp, px };
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
/** Encode as PNG. alpha false writes plain RGB: Apple rejects an app icon that has a transparency channel at all. */
function encodePng({ width, height, bpp, px }, { alpha }) {
  const outBpp = alpha ? 4 : 3;
  const raw = Buffer.alloc(height * (width * outBpp + 1));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * bpp;
      raw[o++] = px[i]; raw[o++] = px[i + 1]; raw[o++] = px[i + 2];
      if (alpha) raw[o++] = bpp === 4 ? px[i + 3] : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------- work

const browser = await launch();
async function render(file, spec) {
  const transparent = spec.shape === 'rounded' || spec.shape === 'circle';
  const page = await browser.page({ width: spec.size, height: spec.size, scale: 1, mobile: false });
  const html = `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${iconSvg(spec)}`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitMs: 150 });
  const image = decodePng(await page.screenshot(null, { transparent }));
  if (image.width !== spec.size || image.height !== spec.size) throw new Error(`${file}: rendered ${image.width}x${image.height}`);
  mkdirSync(dirname(out(file)), { recursive: true });
  writeFileSync(out(file), encodePng(image, { alpha: transparent }));
  // Close the tab as well as the connection, so the tabs do not pile up while the script runs.
  await page.send('Page.close').catch(() => {});
  page.socket.close();
  console.log(`  ${file} (${spec.size} px)`);
}
const write = (file, text) => { mkdirSync(dirname(out(file)), { recursive: true }); writeFileSync(out(file), text); console.log(`  ${file}`); };

try {
  console.log('Web app');
  await render('icons/icon-192.png', { size: 192, k: 1 });
  await render('icons/icon-512.png', { size: 512, k: 1 });
  await render('icons/icon-maskable-512.png', { size: 512, k: 0.82 }); // inside the maskable safe circle
  await render('icons/apple-touch-icon.png', { size: 180, k: 1 });

  console.log('iOS');
  const assets = 'ios/App/App/Assets.xcassets';
  await render(`${assets}/AppIcon.appiconset/AppIcon-512@2x.png`, { size: 1024, k: 1 });
  for (const f of readdirSync(out(assets, 'Splash.imageset'))) {
    if (f.endsWith('.png')) rmSync(out(assets, 'Splash.imageset', f));
  }
  await render(`${assets}/Splash.imageset/splash-light.png`, { size: 2732, shape: 'tile', background: LAUNCH.light });
  await render(`${assets}/Splash.imageset/splash-dark.png`, { size: 2732, shape: 'tile', background: LAUNCH.dark });
  write(`${assets}/Splash.imageset/Contents.json`, `${JSON.stringify({
    images: [
      { idiom: 'universal', filename: 'splash-light.png', scale: '1x' },
      { idiom: 'universal', filename: 'splash-dark.png', scale: '1x', appearances: [{ appearance: 'luminosity', value: 'dark' }] },
      { idiom: 'universal', scale: '2x' },
      { idiom: 'universal', scale: '2x', appearances: [{ appearance: 'luminosity', value: 'dark' }] },
      { idiom: 'universal', scale: '3x' },
      { idiom: 'universal', scale: '3x', appearances: [{ appearance: 'luminosity', value: 'dark' }] },
    ],
    info: { version: 1, author: 'xcode' },
  }, null, 2)}\n`);

  console.log('Android');
  const res = 'android/app/src/main/res';
  for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    await render(`${res}/mipmap-${density}/ic_launcher.png`, { size, k: 0.84, shape: 'rounded' });
    await render(`${res}/mipmap-${density}/ic_launcher_round.png`, { size, k: 0.78, shape: 'circle' });
  }
  // Adaptive icon layers: the launcher crops to the middle two thirds, so the mark stays well inside it.
  write(`${res}/drawable/ic_launcher_foreground.xml`, vectorDrawable({ k: 0.78 }));
  write(`${res}/drawable/ic_launcher_monochrome.xml`, vectorDrawable({ k: 0.78, colour: { all: '#FFFFFF' } }));
  // Launch icon: the system shows the middle two thirds in a circle. The dark disc keeps the pale cap visible on a light launch screen.
  write(`${res}/drawable/splash_icon.xml`, vectorDrawable({ k: 0.6, disc: { r: 30, colour: COLOUR.tile } }));
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;
  write(`${res}/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
  write(`${res}/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
  write(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${COLOUR.tile}</color>
</resources>
`);
} finally {
  await browser.close();
}
console.log('Done.');
