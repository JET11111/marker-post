// The Hampshire network map: a MapLibre GL vector map with the National
// Highways network, marker posts and bay records drawn on top as the app's
// own layers. Loaded on demand the first time the Map tab is opened.
//
// Inspection is read-only and comes from map-details.js. Every distance shown
// is a straight-line distance to a recorded point, and anything the records
// do not establish stays "Unknown" or is labelled unverified.

import { getLocationDetails } from './map-details.js';
import * as P from './platform.js';
import { loadSnapshot } from './data.js';
import { isDark, onThemeChange, setTheme, themeChoice } from './theme.js';
import { h, icon, ICONS, show } from './dom.js';
import { buildStyle, PALETTE, FONT } from './map-style.js';
import { openBasemap, offlineBasemap, BASEMAP_ATTRIBUTION } from './basemap.js';

const $ = (id) => document.getElementById(id);
const normalRoad = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const roadName = (s) => ({ A3M: 'A3(M)', CHILWORTH: 'Chilworth · M3 / M27', PITSEA: 'M27 / M275 interchange' }[normalRoad(s)] || s || 'Network link');
const metres = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const dateLabel = (value) => (value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not supplied');
const ageDays = (value) => (value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 86400000) : Infinity);
const midpoint = (coords) => coords?.[Math.floor(coords.length / 2)];
const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;

// MapLibre zoom levels (one lower than the old raster map's for the same view).
const ZOOM = { start: 9, min: 6.5, max: 18, posts: 11, junctions: 10, shieldsBelow: 12, select: 14, locate: 14, roadFocus: 13 };
const PATCH_BOUNDS = [[-1.95, 50.72], [-0.73, 51.4]];
const EMPTY = { type: 'FeatureCollection', features: [] };
const LAYERS_KEY = 'mp-map-layers';
const DEFAULT_LAYERS = { network: true, posts: true, era: true, layby: true, junction: false, streets: true };

let instance;
export async function initMap(options) {
  if (instance) return instance;
  const maplibregl = await import('./vendor/maplibre-gl/maplibre-gl.js');
  // Explicit worker address: the library cannot work it out inside the iOS app.
  maplibregl.setWorkerUrl(new URL('vendor/maplibre-gl/maplibre-gl-worker.js', document.baseURI).href);
  await new Promise((resolve) => {
    if (document.querySelector('link[data-maplibre]')) { resolve(); return; }
    const link = h('link', { rel: 'stylesheet', href: 'vendor/maplibre-gl/maplibre-gl.css', 'data-maplibre': '' });
    link.onload = resolve; link.onerror = resolve; // unstyled controls are better than no map
    document.head.append(link);
  });
  const app = new NetworkMap(maplibregl, options);
  app.ready = app.start();
  await app.ready;
  instance = { show: () => app.show(), selectPost: (p) => app.select(app.postFeature(p)) };
  return instance;
}

class NetworkMap {
  constructor(maplibregl, { posts, junctions, position }) {
    this.gl = maplibregl;
    this.posts = posts || []; this.junctions = junctions || []; this.position = position;
    this.selection = null;
    this.layersOn = { ...DEFAULT_LAYERS };
    try { Object.assign(this.layersOn, JSON.parse(localStorage.getItem(LAYERS_KEY) || '{}')); } catch { /* defaults */ }
    this.postFeatures = this.posts.map((p) => this.postFeature(p));
    this.geo = { network: EMPTY, posts: this.postsGeo(), areas: EMPTY, junctions: this.junctionsGeo() };
    this.host = $('map-app');
    this.buildChrome();
  }

  // ------------------------------------------------------------- features

  postFeature(p) {
    return { id: `post:${p.sourceId || `${p.road}:${p.ref}`}`, kind: 'post', title: p.ref, road: p.road, carriageway: p.direction, coordinate: [p.lng, p.lat], post: p };
  }
  linkFeature(link, coordinate) {
    return {
      id: link.id,
      kind: link.form === 'L' ? 'layby' : link.form === 'EA' ? 'era' : 'link',
      title: link.form === 'L' ? 'Lay-by' : link.form === 'EA' ? 'Emergency area' : roadName(link.road),
      road: link.road, carriageway: link.carriageway, coordinate: coordinate || midpoint(link.coordinates), link, sourceKey: 'network',
    };
  }
  junctionFeature(j) {
    return { id: `junction:${j.road}:${j.jct}`, title: `${roadName(j.road)} ${j.jct}`, kind: 'junction', road: j.road, coordinate: [j.lng, j.lat] };
  }
  postsGeo() {
    return {
      type: 'FeatureCollection',
      features: this.postFeatures.map((f, i) => ({ type: 'Feature', properties: { id: i }, geometry: { type: 'Point', coordinates: f.coordinate } })),
    };
  }
  junctionsGeo() {
    return {
      type: 'FeatureCollection',
      features: this.junctions.map((j, i) => ({ type: 'Feature', properties: { id: i, jct: j.jct }, geometry: { type: 'Point', coordinates: [j.lng, j.lat] } })),
    };
  }
  networkGeo() {
    const features = [];
    for (const link of this.network?.links || []) {
      if (!link.coordinates || link.coordinates.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: {
          id: link.id,
          cls: /^M|\(M\)/.test(link.road || '') ? 'M' : 'A',
          slip: ['SL', 'SR'].includes(link.form),
          // Road-number shields only on carriageway links with a real road name.
          label: ['DC', 'SC'].includes(link.form) && link.road && link.road !== 'Unclassified Unnamed Road' ? roadName(link.road) : '',
        },
        geometry: { type: 'LineString', coordinates: link.coordinates },
      });
    }
    return { type: 'FeatureCollection', features };
  }
  areasGeo() {
    return {
      type: 'FeatureCollection',
      features: (this.features || []).map((f, i) => ({
        type: 'Feature',
        properties: { id: i, kind: f.kind, old: f.kind === 'era' && f.sourceKey !== 'network' },
        geometry: { type: 'Point', coordinates: f.coordinate },
      })),
    };
  }

  // ----------------------------------------------------------------- chrome

  buildChrome() {
    const switchRow = (id, label, sub, key) => h('label', { class: 'row row-switch' },
      key,
      h('span', { class: 'map-layer-text' }, h('span', { class: 'row-title', text: label }), sub ? h('small', { text: sub }) : null),
      h('input', { type: 'checkbox', 'data-layer': id, checked: this.layersOn[id] }),
      h('span', { class: 'switch', 'aria-hidden': 'true' }));
    const key = (cls, text) => h('i', { class: `map-key ${cls}`, 'aria-hidden': 'true', text: text || '' });

    this.host.replaceChildren(
      h('div', { class: 'map-stage' },
        h('div', { id: 'network-map', 'aria-label': 'Interactive Hampshire road map' }),
        h('div', { class: 'map-top', role: 'search', 'aria-label': 'Search the map' },
          h('label', { class: 'map-search-wrap' },
            icon(ICONS.search, { size: 20, stroke: 2 }),
            h('input', { class: 'map-search', id: 'map-search', type: 'search', 'aria-label': 'Find a marker post, road or bay',
              autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', placeholder: 'Search a post, road or bay', 'aria-controls': 'map-results' }),
            h('button', { id: 'map-search-clear', class: 'map-clear hidden', type: 'button', 'aria-label': 'Clear search' }, icon(ICONS.close, { size: 18, stroke: 2.4 }))),
          h('button', { id: 'map-options', class: 'map-tool', type: 'button', 'aria-label': 'Map layers' }, icon(ICONS.layers))),
        h('div', { id: 'map-results', class: 'map-results hidden', 'aria-label': 'Search results' }),
        h('button', { id: 'map-sources', class: 'map-data-pill', type: 'button', 'aria-label': 'Data dates and coverage' },
          h('i', { class: 'dot wait', id: 'map-source-dot' }), h('span', { id: 'map-source-label', text: 'Loading road data' })),
        h('div', { class: 'map-tools' },
          h('button', { id: 'map-locate', class: 'map-tool map-tool-you', type: 'button', 'aria-label': 'My location' }, icon(ICONS.locate)),
          h('button', { id: 'map-compass', class: 'map-tool hidden', type: 'button', 'aria-label': 'Point the map north' }, icon(ICONS.compass)),
          h('button', { id: 'map-plus', class: 'map-tool map-desktop', type: 'button', 'aria-label': 'Zoom in' }, icon(ICONS.plus)),
          h('button', { id: 'map-minus', class: 'map-tool map-desktop', type: 'button', 'aria-label': 'Zoom out' }, icon(ICONS.minus))),
        h('div', { class: 'map-attribution', id: 'map-attribution' }),
        h('div', { class: 'map-hint', id: 'map-hint', text: 'Tap a road or marker for details' }),
        h('section', { class: 'map-sheet hidden', id: 'map-sheet', 'aria-label': 'Location details' },
          h('div', { class: 'sheet-grabber', 'aria-hidden': 'true' }),
          h('div', { id: 'map-panel', 'aria-live': 'polite' })),
        h('div', { id: 'map-toast', class: 'map-toast hidden', role: 'status' })),

      h('dialog', { class: 'sheet', id: 'map-options-dialog', 'aria-labelledby': 'map-options-title' },
        h('div', { class: 'sheet-grabber', 'aria-hidden': 'true' }),
        h('div', { class: 'sheet-head' },
          h('h2', { class: 'sheet-title', id: 'map-options-title', text: 'Map layers' }),
          h('button', { class: 'btn-text', type: 'button', 'data-close': '', text: 'Done' })),
        h('div', { class: 'sheet-body' },
          h('div', { class: 'group' },
            switchRow('network', 'Road network', null, key('line')),
            switchRow('posts', 'Marker posts', null, key('post')),
            switchRow('era', 'ERA records', 'Unverified · older source', key('era', 'EA')),
            switchRow('layby', 'Lay-bys', null, key('layby', 'P')),
            switchRow('junction', 'Junctions', null, key('junction', 'J')),
            switchRow('streets', 'Street map', 'Separate source from the network', key('streets'))),
          h('div', { class: 'section-label', text: 'Appearance' }),
          h('div', { class: 'segmented', id: 'map-theme', role: 'group', 'aria-label': 'Appearance' },
            ...[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) =>
              h('button', { type: 'button', 'data-theme-choice': value, 'aria-pressed': 'false', text: label }))),
          h('div', { id: 'map-offline', class: 'hidden' },
            h('div', { class: 'section-label', text: 'Street map without signal' }),
            h('div', { class: 'card' },
              h('p', { id: 'map-offline-status' }),
              h('button', { id: 'map-offline-action', class: 'btn btn-secondary', type: 'button' }))),
          h('button', { id: 'map-fit', class: 'btn btn-secondary', type: 'button', text: 'Show whole patch' }),
          h('p', { class: 'note', text: 'Pinch to zoom, two fingers to turn or tilt. Tap a marker dot to see its reference.' }))),

      h('dialog', { class: 'sheet', id: 'map-data-dialog', 'aria-labelledby': 'map-data-title' },
        h('div', { class: 'sheet-grabber', 'aria-hidden': 'true' }),
        h('div', { class: 'sheet-head' },
          h('h2', { class: 'sheet-title', id: 'map-data-title', text: 'Data dates and coverage' }),
          h('button', { class: 'btn-text', type: 'button', 'data-close': '', text: 'Done' })),
        h('div', { class: 'sheet-body', id: 'map-data-content' })),
    );
  }

  bind() {
    const map = this.map;
    $('map-search').addEventListener('input', () => { this.search(); show($('map-search-clear'), Boolean($('map-search').value)); });
    $('map-search').addEventListener('focus', () => { this.closeDetail(); this.search(); });
    $('map-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('map-results').querySelector('button')?.click(); }
      if (e.key === 'Escape') { this.hideResults(); $('map-search').blur(); }
    });
    $('map-search-clear').onclick = () => { $('map-search').value = ''; show($('map-search-clear'), false); this.hideResults(); $('map-search').focus(); };
    $('map-plus').onclick = () => map.zoomIn();
    $('map-minus').onclick = () => map.zoomOut();
    $('map-fit').onclick = () => { $('map-options-dialog').close(); this.fitPatch(); };
    $('map-locate').onclick = () => this.locate();
    $('map-compass').onclick = () => map.easeTo({ bearing: 0, pitch: 0, duration: 300, essential: true });
    $('map-options').onclick = () => { $('map-search').blur(); this.hideResults(); this.paintTheme(); this.paintOffline(); $('map-options-dialog').showModal(); };
    $('map-sources').onclick = () => this.showSources();
    this.host.querySelectorAll('[data-layer]').forEach((input) => input.addEventListener('change', () => {
      this.layersOn[input.dataset.layer] = input.checked;
      try { localStorage.setItem(LAYERS_KEY, JSON.stringify(this.layersOn)); } catch { /* not saved */ }
      if (input.dataset.layer === 'streets') this.applyStyle(); else this.applyVisibility();
      P.haptic('selection');
    }));
    $('map-theme').querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => {
      setTheme(b.dataset.themeChoice); this.paintTheme(); P.haptic('selection');
    }));
    $('map-offline-action').onclick = () => this.toggleOffline();

    window.addEventListener('markerpost:position', (e) => { this.position = e.detail; this.renderGPS(); });
    window.addEventListener('offline', () => this.updateSourceLabel());
    window.addEventListener('online', () => this.updateSourceLabel());
    // Android back: close the search results or the detail card before leaving the map.
    window.addEventListener('markerpost:back', (e) => {
      if (!$('map-results').classList.contains('hidden')) { this.hideResults(); $('map-search').blur(); e.preventDefault(); }
      else if (this.selection) { this.closeDetail(); e.preventDefault(); }
    });
    P.onAppState((active) => { if (active) this.show(); });
    onThemeChange(() => this.applyStyle());

    map.on('click', (e) => this.onMapClick(e));
    map.on('dragstart', () => { $('map-search').blur(); this.hideResults(); });
    map.on('rotate', () => this.paintCompass());
    map.on('pitch', () => this.paintCompass());
    // Without this handler MapLibre prints its own errors; with it, they are ours to report.
    map.on('error', (e) => this.onMapError(e));
  }

  // ------------------------------------------------------------------ start

  async start() {
    const gl = this.gl;
    this.basemap = await openBasemap(gl);
    try {
      this.map = new gl.Map({
        container: 'network-map',
        style: this.style(),
        center: [-1.32, 51.025], zoom: ZOOM.start, minZoom: ZOOM.min, maxZoom: ZOOM.max,
        maxBounds: [[-3.5, 49.9], [0.5, 52.2]],
        maxPitch: 50,
        renderWorldCopies: false,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        fadeDuration: 150,
        refreshExpiredTiles: false,
        attributionControl: false,
        clickTolerance: 8,
      });
    } catch (err) {
      const text = err instanceof gl.GPUInitializationError || /webgl/i.test(String(err?.message))
        ? 'This device cannot draw the map. The nearest post, signs and go-to tools still work.'
        : 'The map could not start. The nearest post, signs and go-to tools still work.';
      this.host.replaceChildren(h('div', { class: 'map-loading', role: 'status', text }));
      console.error('Map:', err);
      throw err;
    }
    const map = this.map;
    map.addControl(new gl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-right');
    map.addControl(new gl.ScaleControl({ unit: 'imperial', maxWidth: 110 }), 'bottom-right');
    // Fires for the first style, after a theme change, and after the system
    // gives the graphics context back: the app layers are re-added each time.
    map.on('style.load', () => this.addOverlays());
    this.bind();
    this.paintAttribution();
    this.paintCompass();
    if (!this.basemap.available) this.toast('Street background unavailable. Network records remain visible.');
    await this.load();
  }

  style() {
    $('network-map').style.background = PALETTE[isDark() ? 'dark' : 'light'].land;
    return buildStyle({ dark: isDark(), basemap: this.basemap?.available ? this.basemap : null, streets: this.layersOn.streets });
  }
  applyStyle() {
    if (!this.map) return;
    this.map.setStyle(this.style(), { diff: false }); // 'style.load' re-adds the app layers
    this.paintAttribution();
  }

  onMapError(e) {
    const message = String(e?.error?.message || e?.error || '');
    // A tile the archive does not hold is normal (detail is only kept near the network).
    if (/tile|404|aborted|AbortError/i.test(message)) return;
    console.error('Map:', e?.error || e);
  }

  // --------------------------------------------------------- overlay layers

  addImages(c) {
    const map = this.map, ratio = 2;
    const canvas = (w, hgt) => {
      const el = document.createElement('canvas');
      el.width = w * ratio; el.height = hgt * ratio;
      const ctx = el.getContext('2d');
      ctx.scale(ratio, ratio);
      return { el, ctx };
    };
    const put = (name, el, options = {}) => {
      if (map.hasImage(name)) map.removeImage(name);
      map.addImage(name, el.getContext('2d').getImageData(0, 0, el.width, el.height), { pixelRatio: ratio, ...options });
    };
    const badge = (name, text, fill) => {
      const w = 28, hgt = 20, { el, ctx } = canvas(w, hgt);
      ctx.beginPath(); ctx.roundRect(1, 1, w - 2, hgt - 2, 6);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = c.postStroke; ctx.stroke();
      ctx.fillStyle = c.badgeText; ctx.font = '800 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, hgt / 2 + 0.5);
      put(name, el);
    };
    // A rounded rectangle that stretches to fit its text (road shields, junction pills).
    const plate = (name, fill, radius) => {
      const size = 20, { el, ctx } = canvas(size, size);
      ctx.beginPath(); ctx.roundRect(0, 0, size, size, radius);
      ctx.fillStyle = fill; ctx.fill();
      const a = radius * ratio, b = (size - radius) * ratio;
      put(name, el, { stretchX: [[a, b]], stretchY: [[a, b]], content: [a, a, b, b] });
    };
    badge('mp-era-old', 'EA', c.eraOld);
    badge('mp-era', 'EA', c.era);
    badge('mp-layby', 'P', c.layby);
    plate('mp-shield-m', c.shieldMotorway, 5);
    plate('mp-shield-a', c.shieldARoad, 5);
    plate('mp-pill', c.junction, 9);
  }

  addOverlays() {
    const map = this.map, c = PALETTE[isDark() ? 'dark' : 'light'];
    this.addImages(c);
    // Network lines go beneath the base map's labels so place names stay readable.
    const firstLabel = map.getLayersOrder().find((id) => map.getLayer(id)?.type === 'symbol');
    const source = (id, data, extra = {}) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data, promoteId: 'id', ...extra }); };
    const layer = (def, before) => { if (!map.getLayer(def.id)) map.addLayer(def, before); };
    const byZoom = (stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flatMap(([z, main, slip]) => [z, ['case', ['get', 'slip'], slip, main]])];
    const round = { 'line-cap': 'round', 'line-join': 'round' };

    source('mp-network', this.geo.network, { tolerance: 0.375, buffer: 64, maxzoom: 14 });
    source('mp-posts', this.geo.posts, { buffer: 8, maxzoom: 14 });
    source('mp-areas', this.geo.areas, { buffer: 16, maxzoom: 14 });
    source('mp-junctions', this.geo.junctions, { buffer: 16, maxzoom: 14 });
    source('mp-selection', EMPTY);
    source('mp-gps', EMPTY);

    layer({ id: 'mp-network-halo', type: 'line', source: 'mp-network', layout: round, filter: ['==', ['get', 'id'], ''],
      paint: { 'line-color': c.selection, 'line-opacity': 0.55, 'line-width': byZoom([[6, 7, 6], [10, 11, 9], [13, 14, 11], [16, 22, 17], [18, 40, 30]]) } }, firstLabel);
    layer({ id: 'mp-network-casing', type: 'line', source: 'mp-network', layout: round,
      paint: { 'line-color': c.networkCasing, 'line-width': byZoom([[6, 2, 1.3], [10, 4, 2.6], [13, 6, 4], [16, 11, 7.5], [18, 24, 16]]) } }, firstLabel);
    layer({ id: 'mp-network-line', type: 'line', source: 'mp-network', layout: round,
      paint: {
        'line-color': ['case', ['get', 'slip'],
          ['match', ['get', 'cls'], 'M', c.slipMotorway, c.slipARoad],
          ['match', ['get', 'cls'], 'M', c.motorway, c.aRoad]],
        'line-width': byZoom([[6, 1.2, 0.8], [10, 2.6, 1.6], [13, 3.8, 2.4], [16, 8, 5.5], [18, 19, 12]]),
      } }, firstLabel);

    // Road-number shields from the network itself, for the overview zooms.
    layer({ id: 'mp-shields', type: 'symbol', source: 'mp-network', maxzoom: ZOOM.shieldsBelow,
      filter: ['!=', ['get', 'label'], ''],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 320,
        'text-field': ['get', 'label'], 'text-font': FONT.medium, 'text-size': 11,
        'text-rotation-alignment': 'viewport', 'text-pitch-alignment': 'viewport',
        'icon-image': ['match', ['get', 'cls'], 'M', 'mp-shield-m', 'mp-shield-a'],
        'icon-text-fit': 'both', 'icon-text-fit-padding': [2, 5, 2, 5],
        'icon-rotation-alignment': 'viewport', 'icon-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': ['match', ['get', 'cls'], 'M', '#FFFFFF', c.shieldARoadText] } });

    layer({ id: 'mp-posts', type: 'circle', source: 'mp-posts', minzoom: ZOOM.posts,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], ZOOM.posts, 2.2, 14, 3.6, 17, 6],
        'circle-color': c.post, 'circle-stroke-color': c.postStroke, 'circle-stroke-width': 1.2,
      } });
    layer({ id: 'mp-junctions', type: 'symbol', source: 'mp-junctions', minzoom: ZOOM.junctions,
      layout: {
        'text-field': ['get', 'jct'], 'text-font': FONT.medium, 'text-size': 11,
        'icon-image': 'mp-pill', 'icon-text-fit': 'both', 'icon-text-fit-padding': [3, 7, 3, 7],
        'text-allow-overlap': true, 'icon-allow-overlap': true,
      },
      paint: { 'text-color': '#FFFFFF' } });
    layer({ id: 'mp-areas', type: 'symbol', source: 'mp-areas', minzoom: ZOOM.posts,
      layout: {
        'icon-image': ['case', ['==', ['get', 'kind'], 'layby'], 'mp-layby', ['get', 'old'], 'mp-era-old', 'mp-era'],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      } });

    layer({ id: 'mp-gps-accuracy', type: 'fill', source: 'mp-gps', filter: ['==', ['get', 'kind'], 'accuracy'],
      paint: { 'fill-color': c.you, 'fill-opacity': 0.14 } });
    layer({ id: 'mp-gps-accuracy-edge', type: 'line', source: 'mp-gps', filter: ['==', ['get', 'kind'], 'accuracy'],
      paint: { 'line-color': c.you, 'line-opacity': 0.5, 'line-width': 1 } });
    layer({ id: 'mp-selection-ring', type: 'circle', source: 'mp-selection',
      paint: { 'circle-radius': 11, 'circle-color': c.selection, 'circle-opacity': 0.25, 'circle-stroke-color': c.selectionRing, 'circle-stroke-width': 2.5 } });
    layer({ id: 'mp-gps-puck', type: 'circle', source: 'mp-gps', filter: ['==', ['get', 'kind'], 'puck'],
      paint: { 'circle-radius': 7, 'circle-color': ['case', ['get', 'fresh'], c.you, c.youStale], 'circle-stroke-color': c.youRing, 'circle-stroke-width': 2.5 } });

    this.applyVisibility();
    this.applySelection();
    this.renderGPS();
  }

  setData(id, data) {
    const src = this.map?.getSource(id);
    if (src) src.setData(data);
  }

  applyVisibility() {
    const map = this.map;
    if (!map || !map.getLayer('mp-posts')) return;
    const vis = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
    const on = this.layersOn;
    for (const id of ['mp-network-halo', 'mp-network-casing', 'mp-network-line']) vis(id, on.network);
    vis('mp-shields', on.network);
    vis('mp-posts', on.posts);
    vis('mp-junctions', on.junction);
    vis('mp-areas', on.era || on.layby);
    if (map.getLayer('mp-areas')) {
      map.setFilter('mp-areas', on.era && on.layby ? null
        : ['==', ['get', 'kind'], on.layby ? 'layby' : 'era']);
    }
  }

  applySelection() {
    const map = this.map, f = this.selection;
    if (!map || !map.getLayer('mp-network-halo')) return;
    map.setFilter('mp-network-halo', ['==', ['get', 'id'], f?.link?.id || '']);
    this.setData('mp-selection', f ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 0 }, geometry: { type: 'Point', coordinates: f.coordinate } }] } : EMPTY);
  }

  renderGPS() {
    const p = this.position;
    if (!this.map || !this.map.getSource('mp-gps')) return;
    if (!p) { this.setData('mp-gps', EMPTY); return; }
    const fresh = Date.now() - (p.timestamp || 0) < 120000;
    const features = [{ type: 'Feature', properties: { id: 1, kind: 'puck', fresh }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }];
    if (Number.isFinite(p.accuracy) && p.accuracy > 0) {
      // The accuracy radius drawn to scale on the ground.
      const ring = [], dLat = p.accuracy / 110540, dLng = p.accuracy / (111320 * Math.cos((p.lat * Math.PI) / 180));
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * 2 * Math.PI;
        ring.push([p.lng + dLng * Math.cos(a), p.lat + dLat * Math.sin(a)]);
      }
      features.unshift({ type: 'Feature', properties: { id: 0, kind: 'accuracy' }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    this.setData('mp-gps', { type: 'FeatureCollection', features });
  }

  // ------------------------------------------------------------------- data

  async load({ refresh = true } = {}) {
    try {
      const { data, origin } = await loadSnapshot('network.json', {
        refresh,
        stamp: (d) => d.fetchedAt,
        validate: (d) => Boolean(d && d.schemaVersion === 1 && Array.isArray(d.links) && d.links.length && d.sources),
        timeoutMs: 20000,
      });
      // "saved" and "bundled" both mean this is not a copy downloaded just now.
      this.refreshFailed = origin !== 'network';
      this.upstreamNewer = false;
      this.network = data;
      this.linkById = new Map(data.links.map((l) => [l.id, l]));
      this.features = (data.areas || []).map((a) => ({
        ...a,
        title: a.kind === 'layby' ? 'Lay-by' : 'Emergency area',
        road: a.road || this.linkById.get(a.linkId)?.road,
        carriageway: a.carriageway || this.linkById.get(a.linkId)?.carriageway,
        link: this.linkById.get(a.linkId),
        coordinate: a.coordinate || midpoint(a.coordinates), sourceKey: a.source || 'emergencyAreas',
      })).filter((f) => f.coordinate?.length === 2);
      this.geo.network = this.networkGeo();
      this.geo.areas = this.areasGeo();
      this.setData('mp-network', this.geo.network);
      this.setData('mp-areas', this.geo.areas);
      if (this.selection) this.renderDetail(); else this.closeDetail();
      this.updateSourceLabel();
      this.checkSourceDates();
    } catch (error) {
      this.refreshFailed = true;
      if (this.network) {
        this.checkStatus = 'Refresh failed. The last successfully loaded, dated snapshot is still displayed.';
        if (this.selection) this.renderDetail();
        this.updateSourceLabel(); this.toast(this.checkStatus);
        return;
      }
      $('map-panel').replaceChildren(
        h('div', { class: 'map-sheet-body' },
          h('p', { class: 'callout', text: 'The network snapshot could not load. Marker posts can still be explored; road details and bays are unavailable.' }),
          h('button', { class: 'btn btn-secondary', type: 'button', text: 'Retry network download', onclick: () => this.load() })));
      show($('map-sheet'), true);
      this.updateSourceLabel();
      console.error('Network map:', error);
    }
  }

  show() {
    if (!this.map) return;
    requestAnimationFrame(() => this.map.resize());
    // iOS stops a page's background workers without telling it; wake them.
    try { this.gl.getGlobalDispatcher?.().ensureWorkers?.(); } catch { /* older library: not needed */ }
    if (this.network && (!this.lastSourceCheck || Date.now() - this.lastSourceCheck > 300000)) this.checkSourceDates();
  }

  fitPatch() {
    this.closeDetail();
    this.map.fitBounds(PATCH_BOUNDS, { padding: 30, duration: 400, essential: true });
  }

  // ------------------------------------------------------------ interaction

  onMapClick(e) {
    if (!this.network && !this.posts.length) return;
    const map = this.map, r = 16, pt = e.point;
    const layers = ['mp-areas', 'mp-junctions', 'mp-posts', 'mp-network-line']
      .filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
    const hits = layers.length ? map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers }) : [];

    // A point record under the finger wins: the nearest of posts, bays and junctions.
    let best = null, bestD = Infinity;
    for (const f of hits) {
      if (f.geometry.type !== 'Point') continue;
      const p = map.project(f.geometry.coordinates), d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = f; }
    }
    // …but only within a fingertip of it, so a road between two posts can still be tapped.
    if (best && bestD <= 12) {
      const i = best.properties.id;
      const feature = best.layer.id === 'mp-posts' ? this.postFeatures[i]
        : best.layer.id === 'mp-junctions' ? this.junctionFeature(this.junctions[i])
          : this.features?.[i];
      if (feature) { this.select(feature, best.layer.id !== 'mp-posts'); return; }
    }

    // Otherwise the road line nearest the finger, inspected at the tapped point.
    let link = null, linkD = Infinity;
    for (const id of new Set(hits.filter((f) => f.layer.id === 'mp-network-line').map((f) => f.properties.id))) {
      const candidate = this.linkById?.get(id);
      if (!candidate) continue;
      const pts = candidate.coordinates.map((c) => map.project(c));
      for (let i = 1; i < pts.length; i++) {
        const d = segmentDistance(pt, pts[i - 1], pts[i]);
        if (d < linkD) { linkD = d; link = candidate; }
      }
    }
    if (link) { this.select(this.linkFeature(link, [e.lngLat.lng, e.lngLat.lat]), false); return; }

    if (this.network) {
      this.select({ id: `point:${e.lngLat.lng.toFixed(6)},${e.lngLat.lat.toFixed(6)}`, kind: 'point', title: 'Selected point', coordinate: [e.lngLat.lng, e.lngLat.lat] }, false);
    }
  }

  async locate() {
    const recent = this.position && Date.now() - (this.position.timestamp || 0) < 10000;
    try {
      if (!recent) { this.toast('Finding your position…'); this.position = await P.getCurrentPosition(); this.renderGPS(); }
      const p = this.position;
      this.map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(ZOOM.locate, this.map.getZoom()), duration: 500, essential: true });
      this.toast(`Location accuracy ±${Math.round(p.accuracy || 0)} m. Check the carriageway.`);
    } catch {
      this.toast('Location unavailable. Search for a marker post or tap the map instead.');
    }
  }

  closeDetail() {
    this.selection = null;
    this.applySelection();
    show($('map-sheet'), false);
    this.host.classList.remove('has-selection');
    show($('map-hint'), true);
    if (this.map) this.map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 200 });
  }

  select(feature, move = true) {
    if (!feature?.coordinate) return;
    $('map-search').blur(); this.hideResults();
    this.selection = feature;
    this.renderDetail();
    this.applySelection();
    const sheet = $('map-sheet');
    show(sheet, true); this.host.classList.add('has-selection'); show($('map-hint'), false);
    sheet.scrollTop = 0;
    this.host.style.setProperty('--map-sheet-height', `${sheet.offsetHeight + 8}px`);
    P.haptic('light');
    // Keep the selection in the clear area above the card.
    const map = this.map, wide = window.matchMedia('(min-width: 701px), (orientation: landscape) and (max-height: 540px)').matches;
    const padding = wide ? { left: sheet.offsetWidth + 24, bottom: 0, top: 0, right: 0 } : { bottom: sheet.offsetHeight + 16, top: 90, left: 0, right: 0 };
    const point = map.project(feature.coordinate), size = map.getContainer();
    const hidden = wide ? point.x < padding.left + 20 : point.y > size.clientHeight - padding.bottom - 24 || point.y < padding.top;
    if (move || hidden) {
      map.easeTo({ center: feature.coordinate, zoom: move ? Math.max(ZOOM.select, map.getZoom()) : map.getZoom(), padding, duration: 350, essential: true });
    }
  }

  hideResults() { show($('map-results'), false); }

  search() {
    const raw = $('map-search').value.trim().toUpperCase(), results = $('map-results');
    if (!raw) { this.hideResults(); return; }
    const clean = raw.replace(/LAY-BY|LAY BY/g, 'LAYBY'), tokens = clean.split(/\s+/).filter(Boolean);
    const postMatch = clean.match(/^(M\d+|A\d+(?:\(M\)|M)?)\s+P?(\d+)(?:[./](\d))\s*([A-Z])?$/);
    const found = [];
    if (postMatch) {
      const [, road, km, tenth, dir] = postMatch, chainage = Number(km) + Number(tenth) / 10;
      for (const feature of this.postFeatures) {
        if ([feature.road, ...(feature.post.roadAliases || [])].some((r) => normalRoad(r) === normalRoad(road)) &&
            Math.abs(feature.post.distance - chainage) < 0.001 && (!dir || feature.carriageway === dir)) found.push(feature);
      }
    } else {
      const normalizedQuery = normalRoad(clean);
      for (const road of [...new Set(this.network?.links.map((l) => l.road).filter(Boolean) || this.posts.map((p) => p.road))]) {
        if (normalRoad(road) === normalizedQuery) found.push({ kind: 'road', road, title: roadName(road), id: `road:${road}` });
      }
      const corpus = [...(this.features || []), ...this.junctions.map((j) => this.junctionFeature(j)), ...this.postFeatures];
      for (const feature of corpus) {
        const haystack = `${feature.road || ''} ${roadName(feature.road)} ${feature.title} ${feature.kind} ${feature.link?.description || ''} ${feature.post?.link || ''} ${feature.post?.roadAliases?.join(' ') || ''}`.toUpperCase().replace(/LAY-BY/g, 'LAYBY');
        if (tokens.every((t) => haystack.includes(t))) found.push(feature);
        if (found.length >= 25) break;
      }
      if (found.length < 12) {
        for (const link of this.network?.links || []) {
          const haystack = `${link.road} ${link.description}`.toUpperCase();
          if (tokens.every((t) => haystack.includes(t)) && !found.some((f) => f.id === link.id)) found.push(this.linkFeature(link));
          if (found.length >= 20) break;
        }
      }
    }
    show(results, true);
    if (!found.length) {
      results.replaceChildren(h('div', { class: 'map-empty', text: 'No recorded match. Missing slip-road posts are not estimated. Try a road or junction to inspect its network links.' }));
      return;
    }
    results.replaceChildren(...found.slice(0, 25).map((f) => h('button', {
      class: 'map-result', type: 'button',
      onclick: () => { if (f.kind === 'road') this.focusRoad(f.road); else this.select(f); this.hideResults(); },
    },
    h('span', { class: 'map-result-badge', text: f.kind === 'post' ? 'POST' : f.kind.toUpperCase() }),
    h('span', {},
      h('strong', { text: f.title }),
      h('small', { text: f.link?.description || (f.kind === 'road' ? 'Show this road on the map' : `${roadName(f.road)}${f.carriageway ? ` · carriageway ${f.carriageway}` : ''}`) })))));
  }

  focusRoad(road) {
    const links = this.network?.links.filter((l) => normalRoad(l.road) === normalRoad(road)) || [];
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const l of links) for (const [lng, lat] of l.coordinates) {
      west = Math.min(west, lng); east = Math.max(east, lng); south = Math.min(south, lat); north = Math.max(north, lat);
    }
    $('map-search').blur(); this.closeDetail();
    if (Number.isFinite(west)) this.map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: ZOOM.roadFocus, duration: 500, essential: true });
  }

  // ------------------------------------------------------------ detail card

  renderDetail() {
    const f = this.selection;
    if (!f) return;
    const detail = getLocationDetails({ selection: f, links: this.network?.links, postFeatures: this.postFeatures, areas: this.features, sources: this.network?.sources });
    const link = detail.section?.link, layout = detail.layout;
    const post = f.kind === 'post' ? { feature: f, distanceM: 0 } : detail.nearestPost;
    const isBay = ['layby', 'era'].includes(f.kind);
    const road = f.road || link?.road, carriageway = isBay ? link?.carriageway : f.carriageway || link?.carriageway;
    const association = (item) => (item?.association === 'same-carriageway' ? `carriageway ${item.matchedCarriageway || carriageway || ''}`.trim()
      : item?.association === 'selected-record' ? 'selected record' : 'carriageway unverified');
    const chevron = () => icon(ICONS.chevron, { size: 16, stroke: 2.2 });

    const bayRow = (item, label) => (item
      ? h('button', { class: 'map-row', type: 'button', onclick: () => this.select(item.feature) },
        h('span', { class: 'map-row-text' },
          h('strong', { text: label }),
          h('small', { text: `Straight-line · ${association(item)}${item.sourceKey === 'emergencyAreas' ? ' · older record' : ''}` })),
        h('b', {}, metres(item.distanceM), chevron()))
      : h('div', { class: 'map-row' },
        h('span', { class: 'map-row-text' }, h('strong', { text: label }), h('small', { text: 'No matching record within 30 km' })),
        h('b', { class: 'unknown', text: 'Unknown' })));

    const title = f.kind === 'post' ? f.title : f.kind === 'era' ? 'Emergency area' : f.kind === 'layby' ? 'Lay-by' : f.kind === 'junction' ? f.title : 'Road details';
    const sources = this.network?.sources || {};
    const [lng, lat] = f.coordinate;

    $('map-panel').replaceChildren(
      h('div', { class: 'map-sheet-heading' },
        h('div', {},
          h('div', { class: 'section-label map-detail-type', text: `${road ? roadName(road) : 'Map point'}${carriageway ? ` · carriageway ${carriageway}` : ''}` }),
          h('h2', { class: 'map-reference', text: title })),
        h('button', { class: 'map-close', type: 'button', 'aria-label': 'Close details', onclick: () => this.closeDetail() }, icon(ICONS.close, { size: 18, stroke: 2.4 }))),
      h('div', { class: 'map-sheet-body' },
        isBay ? h('p', { class: 'map-subtext', text: 'Adjoining road layout' }) : null,
        h('div', { class: 'map-detail-grid' },
          h('div', {}, h('span', { text: 'Running lanes' }), h('strong', { text: layout.running })),
          h('div', {}, h('span', { text: 'Hard shoulder' }), h('strong', { text: layout.shoulder }))),
        f.kind !== 'post' ? (post
          ? h('button', { class: 'map-row', type: 'button', onclick: () => this.select(post.feature) },
            h('span', { class: 'map-row-text' }, h('strong', { text: 'Nearest marker' }), h('small', { text: `${metres(post.distanceM)} · straight-line` })),
            h('b', { class: 'accent' }, post.feature.title, chevron()))
          : h('div', { class: 'map-row' },
            h('span', { class: 'map-row-text' }, h('strong', { text: 'Nearest marker' }), h('small', { text: 'No matching record' })),
            h('b', { class: 'unknown', text: 'Unknown' }))) : null,
        bayRow(detail.nearestEra, 'ERA record'),
        bayRow(detail.nearestLayby, 'Lay-by record'),
        h('details', { class: 'map-record-notes' },
          h('summary', { text: 'Record details and dates' }),
          h('p', { class: 'map-subtext', text: link?.description || 'No unambiguous road section matched. Tap the correct road line for its recorded layout.' }),
          detail.section?.association === 'interchange-unverified'
            ? h('p', { class: 'callout', text: 'Interchange alignment is unverified. Lane and shoulder details remain unknown.' }) : null,
          h('p', { class: 'map-subtext', text: `Road source: ${dateLabel(sources.network?.dataLastEditDate)}. Lane counts are recorded values; “not recorded” does not mean no hard shoulder. Physical layouts are unverified.` }),
          h('p', { class: 'map-subtext', text: `Bay distances are to recorded points, not driving distances or a bay ahead. ERA coverage is incomplete and availability is unknown. ERA source: ${dateLabel(sources.emergencyAreas?.dataLastEditDate)}.` }),
          h('p', { class: 'map-subtext', text: `Marker survey date unknown.${post && post.association && post.association !== 'same-carriageway' ? ' Nearby marker association is unverified.' : ''}${f.post?.link ? ` Source link: ${f.post.link}.` : ''}` }),
          h('p', { class: 'map-subtext', text: `${lat.toFixed(6)}, ${lng.toFixed(6)}` }),
          h('button', { class: 'btn btn-secondary', type: 'button', text: 'Copy location',
            onclick: () => this.copy(`${road ? `${roadName(road)} ` : ''}${f.title}\n${lat.toFixed(6)}, ${lng.toFixed(6)}`) }))),
    );
  }

  // --------------------------------------------------- data dates and source

  updateSourceLabel() {
    const age = ageDays(this.network?.fetchedAt);
    const label = !this.network ? 'Data unavailable'
      : !navigator.onLine ? 'Offline snapshot'
        : this.refreshFailed ? 'Refresh failed · saved data'
          : this.upstreamNewer ? 'Newer source available'
            : age > 2 ? `Snapshot ${Math.floor(age)}d old`
              : `Road data · ${dateLabel(this.network?.sources.network?.dataLastEditDate)}`;
    $('map-source-label').textContent = label;
    const dot = $('map-source-dot');
    dot.classList.remove('live', 'wait', 'err');
    dot.classList.add(!this.network ? 'err' : label.startsWith('Road data') ? 'live' : 'wait');
  }

  async checkSourceDates() {
    if (!navigator.onLine || !this.network) return;
    this.lastSourceCheck = Date.now(); this.checkStatus = 'Checking source publication dates…';
    const snapshot = this.network;
    const source = snapshot.sources.network;
    try {
      const base = source.url.replace(/\/query.*$/, '').replace(/\/$/, '');
      const url = /FeatureServer\/\d+$/.test(base) ? base : `${base}/1`;
      const res = await fetch(`${url}?f=json`, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error('Source check failed');
      const metadata = await res.json(); const edited = metadata.editingInfo?.dataLastEditDate;
      if (this.network !== snapshot) return;
      if (!Number.isFinite(edited)) throw new Error('Source date unavailable');
      this.upstreamNewer = edited > new Date(source.dataLastEditDate).getTime() + 1000;
      this.checkStatus = this.upstreamNewer
        ? 'The official network has a newer publication. The app snapshot has not yet incorporated it.'
        : 'The snapshot matches the latest network publication checked. This does not verify physical layouts.';
    } catch {
      if (this.network !== snapshot) return;
      this.checkStatus = 'Could not check the upstream publication. Using the dated snapshot shown below.';
    }
    this.updateSourceLabel();
    if ($('map-data-dialog').open) this.renderSources();
  }

  showSources() { this.renderSources(); $('map-data-dialog').showModal(); }

  renderSources() {
    const n = this.network, sources = n?.sources || {};
    const row = (label, value) => h('div', { class: 'row' }, h('span', { class: 'row-label', text: label }), h('span', { class: 'row-value', text: value }));
    const link = (text, href) => h('a', { href, target: '_blank', rel: 'noopener', text });
    const refresh = h('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh map snapshot' });
    refresh.onclick = async () => { refresh.disabled = true; this.closeDetail(); await this.load(); this.renderSources(); };
    $('map-data-content').replaceChildren(
      h('p', { text: 'A recent download is not the same as a recently verified road layout. Dates below are kept separate.' }),
      h('div', { class: 'group' },
        row('Snapshot downloaded', dateLabel(n?.fetchedAt)),
        row('Network source data edited', dateLabel(sources.network?.dataLastEditDate)),
        row('Separate ERA source edited', dateLabel(sources.emergencyAreas?.dataLastEditDate)),
        row('Marker posts / junctions verified', 'Unknown · existing app data')),
      h('p', { class: 'callout', text: `${this.checkStatus || 'Source publication check is pending.'} ERA locations and availability remain unverified.` }),
      h('h3', { text: 'Coverage' }),
      h('p', { text: 'National Highways roads in a Hampshire-area bounding box, with a connecting buffer. Includes A36 and NH-owned junction links. This is not an exact county or patrol boundary. The street background includes roads beyond the highlighted National Highways network.' }),
      h('h3', { text: 'Emergency areas, shoulders and lay-bys' }),
      h('p', { text: 'National Highways records are displayed as supplied. The separate ERA layer was published before the two new M27 J9–J10 bays opened in February 2025. It cannot be treated as a complete current inventory. Amber icons identify those older records. Running-lane counts exclude recorded shoulders; absence of a shoulder record does not confirm there is no shoulder.' }),
      h('h3', { text: 'Marker posts' }),
      h('p', { text: 'Your existing references are preserved. Missing slip-road posts and interchange letters are not guessed from nearby mainline posts. Nearby-post distances are straight-line distances, not a surveyed chainage for the selected feature.' }),
      h('h3', { text: 'Street map' }),
      h('p', { text: 'The street background is drawn from OpenStreetMap data and is a separate source from the highlighted network. Full street detail is kept within about 3 km of National Highways roads; further away the map shows an overview only.' }),
      h('h3', { text: 'Sources' }),
      h('p', {},
        link('National Highways Network Model', 'https://www.arcgis.com/home/item.html?id=4b64217e40dc48ebb38315a9a95c96e5'), ' · ',
        link('Emergency Areas', 'https://www.arcgis.com/home/item.html?id=d293e5e9c6ea459896f1c3f06a470a87'),
        ' · Open Government Licence v3.0. Street background © ', link('OpenStreetMap', 'https://www.openstreetmap.org/copyright'),
        ' contributors, drawn with Protomaps tiles.'),
      refresh,
    );
  }

  // -------------------------------------------------- appearance and chrome

  paintTheme() {
    const choice = themeChoice();
    $('map-theme').querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
  }
  paintCompass() {
    const map = this.map;
    show($('map-compass'), Math.abs(map.getBearing()) > 0.5 || map.getPitch() > 0.5);
    const svg = $('map-compass').firstElementChild;
    if (svg) svg.style.transform = `rotate(${-map.getBearing()}deg)`;
  }
  paintAttribution() {
    const streets = this.layersOn.streets && this.basemap?.available;
    const link = (text, href) => h('a', { href, target: '_blank', rel: 'noopener', text });
    $('map-attribution').replaceChildren(
      ...(streets ? [link(BASEMAP_ATTRIBUTION, 'https://www.openstreetmap.org/copyright'), ' · '] : []),
      link('National Highways (OGL)', 'https://www.arcgis.com/home/item.html?id=4b64217e40dc48ebb38315a9a95c96e5'));
  }

  // ------------------------------------- street map kept on the phone (web)

  async paintOffline() {
    if (!offlineBasemap.supported) return;
    const box = $('map-offline'), status = $('map-offline-status'), action = $('map-offline-action');
    show(box, true);
    if (this.offlineBusy) return;
    const state = await offlineBasemap.status();
    if (state.saved) {
      status.textContent = `Saved on this phone${state.bytes ? ` (${megabytes(state.bytes)})` : ''}${state.savedAt ? `, ${dateLabel(state.savedAt)}` : ''}. The street map works with no signal.`;
      action.textContent = 'Remove saved street map';
      action.disabled = false;
    } else {
      const size = await offlineBasemap.size();
      status.textContent = size
        ? 'Not saved. The network and marker posts always work offline; the street background needs a connection unless you save it.'
        : 'The street map is not available to download right now.';
      action.textContent = size ? `Save street map (${megabytes(size)})` : 'Save street map';
      action.disabled = !size;
    }
  }

  async toggleOffline() {
    if (this.offlineBusy) return;
    const status = $('map-offline-status'), action = $('map-offline-action');
    this.offlineBusy = true; action.disabled = true;
    try {
      if ((await offlineBasemap.status()).saved) {
        await offlineBasemap.remove();
      } else {
        await offlineBasemap.save((received, total) => {
          status.textContent = total ? `Downloading… ${megabytes(received)} of ${megabytes(total)}` : `Downloading… ${megabytes(received)}`;
        });
        P.haptic('success');
      }
      // Switch the map to the new source straight away.
      this.basemap = await openBasemap(this.gl);
      this.applyStyle();
    } catch (err) {
      this.toast('The street map could not be saved. Check your connection and try again.');
      console.error('Street map:', err);
    } finally {
      this.offlineBusy = false;
      this.paintOffline();
    }
  }

  toast(message) {
    const t = $('map-toast');
    t.textContent = message; show(t, true);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => show(t, false), 5000);
  }

  async copy(text) {
    try { await navigator.clipboard.writeText(text); this.toast('Location copied.'); }
    catch { this.toast('Copy is unavailable in this browser. The reference and coordinates are in the selected record.'); }
  }
}

/** Distance in pixels from point p to the segment a–b. */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
