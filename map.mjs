import { createRouter, findSnapCandidates, routeBetween } from './map-routing.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalRoad = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const roadName = (s) => ({ A3M:'A3(M)', CHILWORTH:'Chilworth · M3 / M27', PITSEA:'M27 / M275 interchange' }[normalRoad(s)] || s || 'Network link');
const miles = (m) => `${(m / 1609.344).toFixed(m < 1609.344 ? 2 : 1)} mi`;
const metres = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
const dateLabel = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not supplied';
const ageDays = (value) => value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 86400000) : Infinity;
const midpoint = (coords) => coords?.[Math.floor(coords.length / 2)];
const latLng = ([lng, lat]) => [lat, lng];
const distance = (a, b) => {
  const r = Math.PI / 180, x = (b[0] - a[0]) * r * Math.cos((a[1] + b[1]) * r / 2), y = (b[1] - a[1]) * r;
  return Math.hypot(x, y) * 6371000;
};
const iconPaths = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  locate: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8l8 8m0-8-8 8"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>', minus: '<path d="M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9Zm-10 11 10 6 10-6M2 19l10 6 10-6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.info}</svg>`;
function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }

let instance;
export async function initMap(options) {
  if (instance) return instance;
  if (!window.L) await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'vendor/leaflet/leaflet.js';
    script.onload = resolve; script.onerror = reject; document.head.append(script);
  });
  const app = new HampshireMap(options);
  instance = { show: () => app.show(), selectPost: (p) => app.ready.then(() => app.select(app.postFeature(p))) };
  app.ready = app.load();
  await app.ready;
  return instance;
}

class HampshireMap {
  constructor({ posts, junctions, position }) {
    this.posts = posts || []; this.junctions = junctions || []; this.position = position;
    this.mode = 'explore'; this.selection = null; this.start = null; this.end = null; this.result = null;
    this.saved = readLocal('markerpost-map-saved-v1', []); this.flagged = readLocal('markerpost-map-flags-v1', []);
    this.layersOn = { network: true, posts: true, era: true, layby: true, junction: false, streets: true };
    this.postFeatures = this.posts.map((p) => this.postFeature(p));
    this.host = $('map-app');
    this.host.innerHTML = `
      <header class="map-top"><div><div class="map-kicker">Hampshire · National Highways</div><h1>Your network<span>, in detail.</span></h1></div>
        <button class="map-source-button" id="map-sources" type="button"><i></i><span id="map-source-label">Checking data</span></button></header>
      <div class="map-workspace">
        <aside class="map-side" id="map-side" aria-label="Map tools">
          <button class="map-mobile-handle" id="map-expand" type="button" aria-label="Expand or shrink map tools" aria-expanded="false"><span></span></button>
          <label class="map-search-label" for="map-search">Find a marker post, road or bay</label>
          <div class="map-search-wrap">${icon('search')}<input class="map-search" id="map-search" type="search" autocomplete="off" spellcheck="false" placeholder="M27 13.6 A" aria-controls="map-results" /></div>
          <div class="map-search-hint">Try a post reference, “M3 J14” or “A31 layby”.</div>
          <div id="map-results" class="map-results hidden" aria-label="Search results"></div>
          <div class="map-modes"><button class="map-mode active" id="map-explore" type="button">Explore the patch</button><button class="map-mode" id="map-route" type="button">Plan a route ↗</button></div>
          <div id="map-panel" aria-live="polite"><div class="map-loading">Loading network records…</div></div>
        </aside>
        <div class="map-stage"><div id="network-map" aria-label="Interactive Hampshire road map"></div>
          <div class="map-floating-top"><span class="map-float-pill"><b>NH</b> NETWORK ONLY</span><span class="map-float-pill" id="map-view-label">Hampshire + connecting buffer</span></div>
          <div class="map-tools"><button id="map-locate" class="map-tool" type="button" title="My location" aria-label="My location">${icon('locate')}</button><button id="map-fit" class="map-tool" type="button" title="Show whole patch" aria-label="Show whole patch">${icon('fit')}</button><button id="map-plus" class="map-tool" type="button" aria-label="Zoom in">${icon('plus')}</button><button id="map-minus" class="map-tool" type="button" aria-label="Zoom out">${icon('minus')}</button><button id="map-day" class="map-tool" type="button" title="Toggle light basemap" aria-label="Toggle light basemap" aria-pressed="false">${icon('sun')}</button></div>
          <details class="map-legend" id="map-legend" open><summary>Map layers</summary><div class="map-layer-list">
            ${[['network','Network','#75b9ec'],['posts','Posts','#ffc23d'],['era','ERA records','#72dfcb'],['layby','Lay-bys','#bcb1ef'],['junction','Junctions','#d2dfeb'],['streets','Street map','#91a6b7']].map(([id, label, color]) => `<label><input type="checkbox" data-layer="${id}" ${this.layersOn[id] ? 'checked' : ''}/><i style="background:${color}"></i>${label}</label>`).join('')}
          </div><div class="map-map-note" id="map-zoom-hint">Zoom in to see individual marker posts.</div></details>
          <div id="map-toast" class="map-toast hidden" role="status"></div>
        </div>
      </div>
      <dialog class="map-dialog" id="map-data-dialog" aria-labelledby="map-data-title"><div class="map-detail-top"><h2 id="map-data-title">Know your data</h2><button class="map-small-btn" id="map-data-close" type="button">Close</button></div><div id="map-data-content"></div></dialog>`;
    const L = window.L;
    this.map = L.map('network-map', { zoomControl: false, preferCanvas: true, minZoom: 8, maxZoom: 19, maxBounds: [[49.9,-3.5],[52.2,.5]], maxBoundsViscosity: .7 }).setView([51.025,-1.32],10);
    this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, keepBuffer: 1, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(this.map);
    this.map.attributionControl.addAttribution('<a href="https://www.arcgis.com/home/item.html?id=4b64217e40dc48ebb38315a9a95c96e5" target="_blank" rel="noopener">National Highways · OGL</a>');
    this.tiles.on('tileerror', () => { if (!this.tileErrorShown) { this.tileErrorShown = true; this.toast('Street background unavailable. Network records remain visible.'); } });
    L.control.scale({ metric: true, imperial: true, position: 'bottomleft' }).addTo(this.map);
    this.networkLayer = L.layerGroup().addTo(this.map); this.postLayer = L.layerGroup().addTo(this.map);
    this.featureLayer = L.layerGroup().addTo(this.map); this.labelLayer = L.layerGroup().addTo(this.map);
    this.selectedLayer = L.layerGroup().addTo(this.map); this.routeLayer = L.layerGroup().addTo(this.map); this.gpsLayer = L.layerGroup().addTo(this.map);
    this.map.on('moveend zoomend', () => this.renderPoints());
    this.map.on('click', (e) => { if (this.network) this.select({ id: `point:${e.latlng.lng.toFixed(6)},${e.latlng.lat.toFixed(6)}`, kind: 'point', title: 'Selected point', coordinate: [e.latlng.lng, e.latlng.lat] }); });
    this.bind(); this.renderGPS();
    if (matchMedia('(max-width: 700px)').matches) $('map-legend').open = false;
  }
  bind() {
    $('map-search').addEventListener('input', () => this.search());
    $('map-search').addEventListener('focus', () => { if (matchMedia('(max-width: 700px)').matches) { $('map-side').classList.add('expanded'); $('map-expand').setAttribute('aria-expanded','true'); setTimeout(() => this.map.invalidateSize(),220); } });
    $('map-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('map-results').querySelector('button')?.click(); } if (e.key === 'Escape') $('map-results').classList.add('hidden'); });
    $('map-explore').onclick = () => this.setMode('explore'); $('map-route').onclick = () => this.setMode('route');
    $('map-plus').onclick = () => this.map.zoomIn(); $('map-minus').onclick = () => this.map.zoomOut(); $('map-fit').onclick = () => this.fitPatch();
    $('map-locate').onclick = () => this.locate();
    $('map-day').onclick = () => { const active = $('network-map').classList.toggle('day-map'); $('map-day').setAttribute('aria-pressed', String(active)); };
    $('map-expand').onclick = () => { const active = $('map-side').classList.toggle('expanded'); $('map-expand').setAttribute('aria-expanded', String(active)); setTimeout(() => this.map.invalidateSize(), 220); };
    $('map-sources').onclick = () => this.showSources(); $('map-data-close').onclick = () => $('map-data-dialog').close();
    this.host.querySelectorAll('[data-layer]').forEach((input) => input.addEventListener('change', () => {
      this.layersOn[input.dataset.layer] = input.checked;
      if (input.dataset.layer === 'network') { if (input.checked) this.networkLayer.addTo(this.map); else this.map.removeLayer(this.networkLayer); }
      if (input.dataset.layer === 'streets') { if (input.checked) this.tiles.addTo(this.map); else this.map.removeLayer(this.tiles); }
      this.renderPoints();
    }));
    window.addEventListener('markerpost:position', (e) => { this.position = e.detail; this.renderGPS(); });
    window.addEventListener('offline', () => this.updateSourceLabel()); window.addEventListener('online', () => this.updateSourceLabel());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.show(); });
  }
  async load() {
    try {
      const response = await fetch('data/network.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Network data returned ${response.status}`);
      const data = await response.json();
      if (data.schemaVersion !== 1 || !Array.isArray(data.links) || !data.links.length || !data.sources) throw new Error('Network snapshot is incomplete.');
      this.refreshFailed = response.headers.get('X-Markerpost-Cache') === 'fallback'; this.upstreamNewer = false;
      this.network = data; this.linkById = new Map(data.links.map((l) => [l.id, l]));
      this.router = createRouter(data);
      this.features = (data.areas || []).map((a) => ({ ...a,
        title: a.kind === 'layby' ? 'Lay-by' : 'Emergency area',
        road: a.road || this.linkById.get(a.linkId)?.road,
        carriageway: a.carriageway || this.linkById.get(a.linkId)?.carriageway,
        link: this.linkById.get(a.linkId),
        coordinate: a.coordinate || midpoint(a.coordinates), sourceKey: a.source || 'emergencyAreas',
      })).filter((f) => f.coordinate?.length === 2);
      this.renderNetwork(); this.renderPoints(); this.renderPanel(); this.updateSourceLabel();
      this.checkSourceDates();
    } catch (error) {
      this.refreshFailed = true;
      if (this.network) {
        this.checkStatus = 'Refresh failed. The last successfully loaded, dated snapshot is still displayed.';
        this.renderPanel(); this.updateSourceLabel(); this.toast(this.checkStatus);
        return;
      }
      $('map-panel').innerHTML = `<div class="map-warning">The network snapshot could not load. Marker posts can still be explored; routing and bays are unavailable.</div><button id="map-retry" class="map-action" type="button">Retry network download</button>`;
      $('map-retry').onclick = () => this.load(); this.updateSourceLabel(); this.renderPoints();
      console.error('Network map:', error);
    }
  }
  show() {
    requestAnimationFrame(() => { this.map.invalidateSize(); this.renderPoints(); });
    if (this.network && (!this.lastSourceCheck || Date.now() - this.lastSourceCheck > 300000)) {
      this.invalidateOldRoute(); this.checkSourceDates();
    }
  }
  fitPatch() { this.map.fitBounds([[50.72,-1.95],[51.4,-.73]], { padding: [30,30] }); $('map-view-label').textContent = 'Hampshire + connecting buffer'; }
  postFeature(p) { return { id: `post:${p.sourceId || `${p.road}:${p.ref}`}`, kind: 'post', title: p.ref, road: p.road, carriageway: p.direction, coordinate: [p.lng,p.lat], post: p }; }
  linkFeature(link, coordinate) {
    return { id: link.id, kind: link.form === 'L' ? 'layby' : link.form === 'EA' ? 'era' : 'link', title: link.form === 'L' ? 'Lay-by' : link.form === 'EA' ? 'Emergency area' : roadName(link.road), road: link.road, carriageway: link.carriageway, coordinate: coordinate || midpoint(link.coordinates), link, sourceKey: 'network' };
  }
  renderNetwork() {
    this.networkLayer.clearLayers(); const L = window.L;
    for (const link of this.network.links) {
      const coords = link.coordinates?.map(latLng); if (!coords || coords.length < 2) continue;
      const isM = /^M|\(M\)/.test(link.road || ''), restricted = !link.routeEligible;
      const path = L.polyline(coords, { color: restricted ? '#748793' : isM ? '#75b9ec' : '#73b9af', weight: ['SL','SR'].includes(link.form) ? 2 : 3.2, opacity: restricted ? .5 : .85, dashArray: restricted ? '3 5' : null, bubblingMouseEvents: false }).addTo(this.networkLayer);
      path.on('click', (e) => this.select(this.linkFeature(link, [e.latlng.lng,e.latlng.lat])));
    }
  }
  renderPoints() {
    if (!this.map || !this.map.getSize().x) return;
    const L = window.L, zoom = this.map.getZoom(), bounds = this.map.getBounds().pad(.05);
    this.postLayer.clearLayers(); this.featureLayer.clearLayers(); this.labelLayer.clearLayers();
    const visible = (coord) => coord && bounds.contains(latLng(coord));
    const labelCells = new Set(); let shown = 0;
    if (this.layersOn.posts && zoom >= 12) {
      for (const feature of this.postFeatures) {
        if (!visible(feature.coordinate)) continue;
        const dot = L.circleMarker(latLng(feature.coordinate), { radius: zoom >= 15 ? 4 : 2.8, color: '#efc16f', fillColor: '#efc16f', fillOpacity: .95, weight: 1, bubblingMouseEvents: false }).addTo(this.postLayer);
        dot.on('click', () => this.select(feature, false)); shown++;
        if (zoom >= 14) {
          const p = this.map.latLngToContainerPoint(latLng(feature.coordinate)); const cell = `${Math.floor(p.x/85)}:${Math.floor(p.y/32)}`;
          if (!labelCells.has(cell)) { labelCells.add(cell); dot.bindTooltip(feature.title, { permanent: true, direction: 'right', className: 'map-post-label', offset: [5,0] }); }
        }
      }
    }
    for (const feature of this.features || []) {
      if (!this.layersOn[feature.kind] || !visible(feature.coordinate)) continue;
      const old = feature.kind === 'era' && feature.sourceKey !== 'network';
      const marker = L.marker(latLng(feature.coordinate), { icon: L.divIcon({ className: 'map-marker-icon', html: `<span class="map-pin ${feature.kind === 'layby' ? 'layby' : old ? 'era-old' : ''}">${feature.kind === 'layby' ? 'P' : 'EA'}</span>`, iconSize: [24,24], iconAnchor: [12,12] }), title: `${feature.title}${old ? ' · older source' : ''}`, keyboard: true, bubblingMouseEvents: false }).addTo(this.featureLayer);
      marker.on('click', () => this.select(feature));
    }
    if (this.layersOn.junction && zoom >= 11) for (const j of this.junctions) {
      const coordinate = [j.lng,j.lat]; if (!visible(coordinate)) continue;
      const feature = { id: `junction:${j.road}:${j.jct}`, title: `${roadName(j.road)} ${j.jct}`, kind: 'junction', road: j.road, coordinate };
      L.marker(latLng(coordinate), { icon: L.divIcon({ className: 'map-marker-icon', html: `<span class="map-pin junction">${esc(j.jct)}</span>`, iconSize: [26,26], iconAnchor: [13,13] }), title: feature.title, bubblingMouseEvents: false }).addTo(this.featureLayer).on('click', () => this.select(feature));
    }
    if (zoom < 13) {
      for (const [name, coordinate] of [['WINCHESTER',[-1.313,51.063]],['SOUTHAMPTON',[-1.405,50.91]],['PORTSMOUTH',[-1.095,50.805]],['BASINGSTOKE',[-1.087,51.267]],['ANDOVER',[-1.48,51.209]],['PETERSFIELD',[-.939,51.005]],['RINGWOOD',[-1.78,50.846]],['FAREHAM',[-1.18,50.852]]]) {
        if (visible(coordinate)) L.marker(latLng(coordinate), { interactive: false, icon: L.divIcon({ className: 'map-town-label', html: name, iconSize: [90,15], iconAnchor: [45,-10] }) }).addTo(this.labelLayer);
      }
      const roadShown = new Set();
      for (const link of this.network?.links || []) {
        if (!['DC','SC'].includes(link.form) || !link.road || roadShown.has(link.road)) continue;
        const coordinate = midpoint(link.coordinates); if (!visible(coordinate)) continue;
        roadShown.add(link.road);
        if (link.road === 'Unclassified Unnamed Road') continue;
        L.marker(latLng(coordinate), { interactive: false, icon: L.divIcon({ className: 'map-road-label', html: esc(roadName(link.road)), iconSize:null, iconAnchor: [18,9] }) }).addTo(this.labelLayer);
      }
    }
    $('map-zoom-hint').textContent = zoom < 12 ? 'Zoom in to see individual marker posts. Amber EA icons use the older source.' : `${shown.toLocaleString()} marker posts in view · label spacing adjusts as you zoom.`;
  }
  renderGPS() {
    this.gpsLayer.clearLayers(); if (!this.position) return;
    const L = window.L, p = this.position, fresh = Date.now() - (p.timestamp || 0) < 120000;
    if (Number.isFinite(p.accuracy)) L.circle([p.lat,p.lng], { radius: p.accuracy, color: '#70c6fd', weight: 1, fillOpacity: .08 }).addTo(this.gpsLayer);
    L.circleMarker([p.lat,p.lng], { radius: 7, color: '#fff', weight: 2, fillColor: fresh ? '#4fbbff' : '#8798a8', fillOpacity: 1 }).addTo(this.gpsLayer).bindTooltip(fresh ? `You · ±${Math.round(p.accuracy || 0)} m` : 'Last recorded position');
  }
  locate(asStart = false) {
    if (!navigator.geolocation) { this.toast('Location is unavailable on this device. Select a post or road on the map.'); return; }
    this.toast('Finding your position…');
    navigator.geolocation.getCurrentPosition((p) => {
      this.position = { lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, heading: p.coords.heading, timestamp: p.timestamp };
      this.renderGPS(); this.map.setView([p.coords.latitude,p.coords.longitude],15);
      this.toast(`Location accuracy ±${Math.round(p.coords.accuracy)} m. Check the carriageway.`);
      if (asStart) this.chooseEndpoint('start', { id: 'gps', title: 'My location', kind: 'point', coordinate: [p.coords.longitude,p.coords.latitude], gpsAccuracy: p.coords.accuracy });
    }, () => this.toast('Location unavailable. You can choose your start on the map instead.'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  }
  setMode(mode) {
    this.mode = mode; $('map-explore').classList.toggle('active', mode === 'explore'); $('map-route').classList.toggle('active', mode === 'route'); this.renderPanel();
    if (mode === 'route' && matchMedia('(max-width: 700px)').matches) { $('map-side').classList.add('expanded'); $('map-expand').setAttribute('aria-expanded','true'); setTimeout(() => this.map.invalidateSize(),220); }
  }
  select(feature, move = true) {
    if (!feature?.coordinate) return;
    $('map-search').blur();
    this.selection = feature; this.setMode('explore'); this.highlight(feature);
    if (move) this.map.setView(latLng(feature.coordinate), Math.max(14, this.map.getZoom()));
    $('map-results').classList.add('hidden'); $('map-view-label').textContent = `${roadName(feature.road)}${feature.carriageway ? ` · ${feature.carriageway}` : ''}`;
    if (matchMedia('(max-width: 700px)').matches) $('map-side').scrollTop = 0;
  }
  highlight(feature) {
    this.selectedLayer.clearLayers(); const L = window.L;
    if (feature.link) L.polyline(feature.link.coordinates.map(latLng), { color: '#ffe0a0', weight: 7, opacity: .9, interactive: false }).addTo(this.selectedLayer);
    L.circleMarker(latLng(feature.coordinate), { radius: 10, color: '#ffe0a0', weight: 3, fillColor: '#ffc23d', fillOpacity: .2, interactive: false }).addTo(this.selectedLayer);
  }
  search() {
    const raw = $('map-search').value.trim().toUpperCase(), results = $('map-results');
    if (!raw) { results.classList.add('hidden'); return; }
    const clean = raw.replace(/LAY-BY|LAY BY/g,'LAYBY'), tokens = clean.split(/\s+/).filter(Boolean);
    const postMatch = clean.match(/^(M\d+|A\d+(?:\(M\)|M)?)\s+P?(\d+)(?:[./](\d))\s*([A-Z])?$/);
    const found = [];
    if (postMatch) {
      const [, road, km, tenth, dir] = postMatch, chainage = Number(km) + Number(tenth)/10;
      for (const feature of this.postFeatures) if ([feature.road,...(feature.post.roadAliases || [])].some((r) => normalRoad(r) === normalRoad(road)) && Math.abs(feature.post.distance-chainage) < .001 && (!dir || feature.carriageway === dir)) found.push(feature);
    } else {
      const normalizedQuery = normalRoad(clean);
      for (const road of [...new Set(this.network?.links.map((l) => l.road).filter(Boolean) || this.posts.map((p) => p.road))]) {
        if (normalRoad(road) === normalizedQuery) found.push({ kind: 'road', road, title: roadName(road), id: `road:${road}` });
      }
      const corpus = [...(this.features || []), ...this.junctions.map((j) => ({ id: `junction:${j.road}:${j.jct}`, kind:'junction', road:j.road, title:`${roadName(j.road)} ${j.jct}`, coordinate:[j.lng,j.lat] })), ...this.postFeatures];
      for (const feature of corpus) {
        const haystack = `${feature.road || ''} ${roadName(feature.road)} ${feature.title} ${feature.kind} ${feature.link?.description || ''} ${feature.post?.link || ''} ${feature.post?.roadAliases?.join(' ') || ''}`.toUpperCase().replace(/LAY-BY/g,'LAYBY');
        if (tokens.every((t) => haystack.includes(t))) found.push(feature);
        if (found.length >= 25) break;
      }
      if (found.length < 12) for (const link of this.network?.links || []) {
        const haystack = `${link.road} ${link.description}`.toUpperCase();
        if (tokens.every((t) => haystack.includes(t)) && !found.some((f) => f.id === link.id)) found.push(this.linkFeature(link));
        if (found.length >= 20) break;
      }
    }
    results.classList.remove('hidden');
    results.innerHTML = found.length ? found.slice(0,25).map((f, i) => `<button class="map-result" type="button" data-result="${i}"><span class="map-result-badge">${esc(f.kind === 'post' ? 'POST' : f.kind.toUpperCase())}</span><span><strong>${esc(f.title)}</strong><small>${esc(f.link?.description || (f.kind === 'road' ? 'Show this road on the map' : `${roadName(f.road)}${f.carriageway ? ` · carriageway ${f.carriageway}` : ''}`))}</small></span></button>`).join('') : '<div class="map-empty">No recorded match. Missing slip-road posts are not estimated. Try a road or junction to inspect its network links.</div>';
    results.querySelectorAll('[data-result]').forEach((button) => button.onclick = () => { const f = found[Number(button.dataset.result)]; if (f.kind === 'road') this.focusRoad(f.road); else this.select(f); results.classList.add('hidden'); });
  }
  focusRoad(road) {
    const links = this.network?.links.filter((l) => normalRoad(l.road) === normalRoad(road)) || [];
    const coordinates = links.flatMap((l) => l.coordinates).map(latLng);
    if (coordinates.length) this.map.fitBounds(coordinates, { padding: [35,35], maxZoom: 14 });
    $('map-view-label').textContent = `${roadName(road)} · NH sections`; this.selection = null; this.selectedLayer.clearLayers(); this.setMode('explore');
  }
  renderPanel() {
    if (this.mode === 'route') { this.renderRoute(); return; }
    if (this.selection) { this.renderDetail(); return; }
    const roads = ['M3','M27','M271','M275','A3(M)','A27','A31','A34','A303','A36'];
    $('map-panel').innerHTML = `<div class="map-section-label">Jump to a road</div><div class="map-roads">${roads.map((r) => `<button class="map-road-chip" data-road="${r}" type="button">${r}</button>`).join('')}</div>
      <div class="map-overview-card"><h2>A clearer view<br>of your patch.</h2><p class="map-subtext">Tap a road to inspect its recorded layout. Choose a post or bay to plan a route on the National Highways network.</p>
      <div class="map-stat-row"><div class="map-stat"><strong>${this.posts.length.toLocaleString()}</strong><span>Marker posts</span></div><div class="map-stat"><strong>${(this.features?.filter((f) => f.kind === 'layby').length || 0)}</strong><span>Lay-by records</span></div></div>
      <div class="map-tip">${icon('info')}<span>Every post keeps its exact recorded reference, including slip-road letters. Missing posts stay unknown.</span></div>
      <p class="map-warning">ERA coverage needs verification. Some official records come from an older source; tap a bay to see its date.</p></div>
      <div class="map-section-label">Saved places <span style="opacity:.6">· this device</span></div><div id="map-saved"></div>`;
    $('map-panel').querySelectorAll('[data-road]').forEach((b) => b.onclick = () => this.focusRoad(b.dataset.road));
    this.renderSaved();
  }
  renderSaved() {
    const host = $('map-saved'); if (!host) return;
    host.innerHTML = this.saved.length ? this.saved.map((f, i) => `<div class="map-bookmark"><button type="button" data-saved="${i}">${esc(roadName(f.road))} · ${esc(f.title)}</button><button type="button" data-remove="${i}" aria-label="Remove saved place">×</button></div>`).join('') : '<p class="map-subtext">Save useful posts and regular access points here.</p>';
    host.querySelectorAll('[data-saved]').forEach((b) => b.onclick = () => {
      const saved = this.saved[Number(b.dataset.saved)]; const feature = this.postFeatures.find((f) => f.id === saved.id) || this.features?.find((f) => f.id === saved.id) || (this.linkById?.has(saved.id) ? this.linkFeature(this.linkById.get(saved.id), saved.coordinate) : null) || (['point','junction'].includes(saved.kind) ? saved : null);
      if (feature) this.select(feature); else this.toast('This saved record is no longer in the current snapshot.');
    });
    host.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => { this.saved.splice(Number(b.dataset.remove),1); writeLocal('markerpost-map-saved-v1',this.saved); this.renderSaved(); });
  }
  layoutSummary(link, coordinate) {
    if (!link?.lanes?.length) return { running: 'Unknown', shoulder: 'Unknown' };
    // Lane count is derived from interval records, never from the aggregate that includes shoulders.
    const candidates = findSnapCandidates(this.router, coordinate, { maxDistanceM: 100, limit: 50 });
    const snap = candidates.find((s) => s.linkId === link.id); if (!snap) return { running: 'Unknown', shoulder: 'Unknown' };
    // Source linear-reference length differs slightly from geodesic geometry.
    // Reverse-flow records can have startM > endM. Never drop these lanes.
    const sourceLength = Math.max(...link.lanes.flatMap((l) => [l.startM, l.endM]).filter(Number.isFinite));
    if (!(sourceLength > 0)) return { running: 'Unknown', shoulder: 'Unknown' };
    const chainage = snap.fraction * sourceLength;
    const lanes = link.lanes.filter((l) => Number.isFinite(l.startM) && Number.isFinite(l.endM) && Math.min(l.startM,l.endM) <= chainage && Math.max(l.startM,l.endM) >= chainage);
    const running = new Set(lanes.filter((l) => /^C[LR]\d+$|^-[LR]\d+$/.test(l.code)).map((l) => l.code));
    const shoulders = lanes.filter((l) => l.code === 'LH' || l.code === 'RH');
    return { running: running.size ? `${running.size} recorded${link.directionality === '0' ? ' total' : ''}` : 'Unknown', shoulder: shoulders.length ? 'Recorded · verify' : 'Not recorded' };
  }
  renderDetail() {
    const f = this.selection, flagged = this.flagged.includes(f.id), source = this.network?.sources[f.sourceKey || 'network'];
    const isHistorical = f.kind === 'post' || f.kind === 'junction';
    const layout = f.link ? this.layoutSummary(f.link,f.coordinate) : null;
    const nearestPosts = this.postFeatures.filter((p) => !f.road || normalRoad(p.road) === normalRoad(f.road)).map((p) => ({ f:p, d:distance(f.coordinate,p.coordinate) })).sort((a,b) => a.d-b.d).filter((p) => p.f.id !== f.id).slice(0,3);
    const adjacent = (this.features || []).filter((p) => p.id !== f.id).map((p) => ({ f:p, d:distance(f.coordinate,p.coordinate) })).sort((a,b) => a.d-b.d).slice(0,3);
    $('map-panel').innerHTML = `<div class="map-detail-top"><span class="map-detail-type">${esc({post:'Marker post',era:'Emergency area record',layby:'Lay-by record',link:'Network section',point:'Map point',junction:'Junction reference'}[f.kind])}</span><button class="map-small-btn" id="map-detail-close" type="button">Clear ×</button></div>
      <div class="map-reference ${f.kind !== 'post' ? 'small' : ''}">${esc(f.title)}</div><div class="map-detail-road">${esc(f.road ? roadName(f.road) : 'Location record')}${f.carriageway ? ` · ${esc(f.carriageway)}` : ''}</div>
      ${f.link?.description ? `<p class="map-detail-description">${esc(f.link.description)}</p>` : ''}
      ${f.post?.link ? `<p class="map-detail-description">Source link: <strong>${esc(f.post.link)}</strong><br>Recovered interchange reference · survey date unknown</p>` : ''}
      ${layout ? `<div class="map-detail-grid"><div><span>Running lanes</span><strong>${layout.running}</strong></div><div><span>Hard shoulder</span><strong>${layout.shoulder}</strong></div></div>` : ''}
      <p class="map-warning">${flagged ? 'Flagged for review on this device. Do not rely on this record until checked.' : isHistorical ? 'Existing app reference. Survey / verification date is unknown.' : f.kind === 'point' ? 'Select the correct carriageway before routing to this point.' : `Source data edit: ${dateLabel(source?.dataLastEditDate)}. Physical layout and availability are not field-verified.`}${f.kind === 'era' ? ' ERA coverage may be incomplete; this icon does not confirm a bay is open or vacant.' : ''}</p><p class="map-subtext">${f.coordinate[1].toFixed(6)}, ${f.coordinate[0].toFixed(6)}</p>
      <div class="map-actions"><button class="map-action" id="map-set-start" type="button">Start here</button><button class="map-action primary" id="map-set-end" type="button">Route to here ↗</button></div>
      <div class="map-secondary-actions"><button class="map-small-btn" id="map-save" type="button">${this.saved.some((s) => s.id === f.id) ? '★ Saved' : '☆ Save place'}</button><button class="map-small-btn" id="map-copy" type="button">Copy location</button><button class="map-small-btn" id="map-flag" type="button">${flagged ? 'Clear review flag' : 'Flag for review'}</button></div>
      <div class="map-section-label">Nearby posts · straight-line</div>${nearestPosts.map((p,i) => `<button class="map-nearby" type="button" data-nearpost="${i}"><strong>${esc(p.f.title)}</strong><span>${metres(p.d)}</span></button>`).join('') || '<p class="map-subtext">No recorded posts nearby.</p>'}
      <div class="map-section-label">Nearby bays · straight-line</div>${adjacent.map((p,i) => `<button class="map-nearby" type="button" data-nearbay="${i}"><strong>${esc(p.f.title)}</strong><span>${metres(p.d)}</span><small style="display:block;color:#8aa7b8;margin-top:4px">${esc(p.f.road ? roadName(p.f.road) : 'Official location record')}</small></button>`).join('') || '<p class="map-subtext">No bay records loaded.</p>'}
      <p class="map-subtext">Nearby does not mean reachable on this carriageway. Use the route planner to check network access.</p>`;
    $('map-detail-close').onclick = () => { this.selection = null; this.selectedLayer.clearLayers(); this.renderPanel(); };
    $('map-set-start').onclick = () => this.chooseEndpoint('start', f); $('map-set-end').onclick = () => this.chooseEndpoint('end', f);
    $('map-save').onclick = () => { if (!this.saved.some((s) => s.id === f.id)) this.saved.push({id:f.id,kind:f.kind,title:f.title,road:f.road,coordinate:f.coordinate}); const ok = writeLocal('markerpost-map-saved-v1',this.saved); this.renderDetail(); this.toast(ok ? 'Saved on this device.' : 'Storage unavailable; saved for this session only.'); };
    $('map-copy').onclick = () => this.copy(`${f.road ? `${roadName(f.road)} ` : ''}${f.title}${f.kind === 'post' ? '' : ' · reference unverified'}\n${f.coordinate[1].toFixed(6)}, ${f.coordinate[0].toFixed(6)}`);
    $('map-flag').onclick = () => { this.flagged = flagged ? this.flagged.filter((id) => id !== f.id) : [...this.flagged,f.id]; writeLocal('markerpost-map-flags-v1',this.flagged); this.result = null; this.routeLayer.clearLayers(); this.renderDetail(); this.toast('Review flag saved on this device only.'); };
    $('map-panel').querySelectorAll('[data-nearpost]').forEach((b) => b.onclick = () => this.select(nearestPosts[Number(b.dataset.nearpost)].f));
    $('map-panel').querySelectorAll('[data-nearbay]').forEach((b) => b.onclick = () => this.select(adjacent[Number(b.dataset.nearbay)].f));
  }
  chooseEndpoint(which, feature) {
    if (!this.router) { this.toast('Network data must load before routing.'); return; }
    if (this.flagged.includes(feature.id)) { this.toast('This record is flagged for review. Check it before using it in a route.'); return; }
    if (feature.gpsAccuracy > 60) { this.toast('GPS is too imprecise to select a carriageway. Choose a known marker post or road section.'); return; }
    const interchangePost = feature.post?.link && feature.post?.roadAliases?.length;
    let candidates = findSnapCandidates(this.router, feature.coordinate, { road: interchangePost ? undefined : feature.road, carriageway: feature.kind === 'post' && !interchangePost ? feature.carriageway : undefined, maxDistanceM: interchangePost ? 35 : feature.kind === 'post' ? 100 : 65, limit: 12 });
    if (interchangePost) candidates = candidates.filter((s) => feature.post.roadAliases.some((r) => normalRoad(r) === normalRoad(s.road)) && ['SL','DL'].includes(this.linkById.get(s.linkId)?.form));
    if (feature.link) candidates = candidates.filter((s) => s.linkId === feature.link.id);
    candidates = candidates.filter((s) => !this.flagged.includes(s.linkId));
    this.setMode('route'); this.result = null; this.routeLayer.clearLayers();
    if (!candidates.length) {
      $('map-route-message').textContent = 'No eligible NH carriageway could be matched here. This may be outside coverage, restricted, or a missing connection. Select a recorded network section; no off-network connector will be invented.'; return;
    }
    const panel = $('map-route-candidates');
    panel.innerHTML = `<div class="map-section-label">Confirm ${which === 'start' ? 'start' : 'destination'} carriageway</div><p class="map-subtext">${esc(feature.title)} · choose the road you intend to use. The matched point is on its road centreline.${interchangePost ? ` Source link ${esc(feature.post.link)}: alignment with these network records has not been verified.` : ''}</p>${candidates.map((s,i) => { const link = this.linkById.get(s.linkId); return `<button class="map-candidate" type="button" data-candidate="${i}">${esc(link?.description || roadName(s.road))}<small>${esc(roadName(s.road))} · carriageway ${esc(link?.carriageway || 'unknown')} · ${esc(link?.direction || 'direction in source')} · ${metres(s.distanceM)} from selection</small></button>`; }).join('')}<button class="map-small-btn" id="map-cancel-candidate" type="button">Cancel</button>`;
    panel.querySelectorAll('[data-candidate]').forEach((b) => b.onclick = () => {
      const snap = candidates[Number(b.dataset.candidate)]; const link = this.linkById.get(snap.linkId);
      this[which] = { ...snap, featureId:feature.id, label:feature.kind === 'post' ? `${roadName(feature.road)} ${feature.title}` : `${feature.title} · ${roadName(link?.road)}`, description:link?.description, carriageway:link?.carriageway };
      this.result = null; this.renderRoute(); this.drawEndpoints();
    });
    $('map-cancel-candidate').onclick = () => this.renderRoute();
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  renderRoute() {
    $('map-panel').innerHTML = `<div class="map-detail-type">Network route planner</div><p class="map-subtext">Choose two points using a marker reference or the map. Confirm each carriageway before planning.</p>
      <div class="map-route-points">${[['start','A','Start'],['end','B','Destination']].map(([key,letter,title]) => `<div class="map-route-point"><span class="map-route-letter">${letter}</span><div><strong>${esc(this[key]?.label || `Choose ${title.toLowerCase()}`)}</strong><small>${esc(this[key] ? `${this[key].description || ''} · ${this[key].carriageway || '?'}` : 'Search for a post or tap a network section')}</small></div>${this[key] ? `<button type="button" data-clear="${key}" aria-label="Clear ${title.toLowerCase()}">×</button>` : ''}</div>`).join('')}</div>
      <div class="map-secondary-actions"><button id="map-use-gps" class="map-small-btn" type="button">◎ Use my location</button><button id="map-swap" class="map-small-btn" type="button" ${this.start && this.end ? '' : 'disabled'}>⇅ Swap</button></div>
      <div class="map-actions"><button id="map-calculate" type="button" class="map-action primary" ${this.start && this.end ? '' : 'disabled'}>Find network-only route ↗</button></div>
      <button id="map-next-layby" class="map-small-btn" type="button" ${this.start ? '' : 'disabled'}>Find reachable lay-bys from start</button>
      <div id="map-route-candidates"></div><div id="map-route-message" class="map-route-status" role="status"></div><div id="map-route-result"></div>
      <p class="map-warning">Route planning from recorded NH links. No live closures, temporary layouts or clearance checks. Ordinary vehicle access only; restricted access links are excluded.</p>
      <p class="map-subtext">A disconnected route stays disconnected: local roads and crossing the central reservation are never used to fill a gap.</p>`;
    $('map-use-gps').onclick = () => this.locate(true); $('map-swap').onclick = () => { [this.start,this.end] = [this.end,this.start]; this.result = null; this.routeLayer.clearLayers(); this.renderRoute(); this.drawEndpoints(); };
    $('map-panel').querySelectorAll('[data-clear]').forEach((b) => b.onclick = () => { this[b.dataset.clear] = null; this.result = null; this.routeLayer.clearLayers(); this.renderRoute(); this.drawEndpoints(); });
    $('map-calculate').onclick = () => this.calculateRoute();
    $('map-next-layby').onclick = () => this.findReachableLaybys();
    if (this.result) this.renderRouteResult();
  }
  calculateRoute() {
    this.result = null; this.routeLayer.clearLayers();
    if ($('map-route-result')) $('map-route-result').innerHTML = '';
    if (!this.start || !this.end) return;
    const maxAge = this.network.routing?.maxSnapshotAgeDays || 7;
    if (!Number.isFinite(new Date(this.network.fetchedAt).getTime()) || !Number.isFinite(new Date(this.network.sources.network?.dataLastEditDate).getTime()) || ageDays(this.network.fetchedAt) > maxAge || ageDays(this.network.sources.network?.dataLastEditDate) > maxAge) { $('map-route-message').textContent = `The network snapshot is undated or over ${maxAge} days old. Refresh the map data before calculating routes.`; return; }
    if (this.upstreamNewer) { $('map-route-message').textContent = 'A newer official network publication is available. Refresh the app snapshot before planning a route.'; return; }
    if ([this.start.featureId,this.end.featureId,this.start.linkId,this.end.linkId].some((id) => this.flagged.includes(id))) { $('map-route-message').textContent = 'A selected record is flagged for review. Check it or choose another point.'; return; }
    const data = this.flagged.some((id) => this.linkById.has(id)) ? { ...this.network, links:this.network.links.map((l) => this.flagged.includes(l.id) ? { ...l, routeEligible:false } : l) } : null;
    const route = routeBetween(data ? createRouter(data) : this.router, this.start, this.end);
    this.result = route; this.renderRouteResult();
  }
  async findReachableLaybys() {
    const sourceAge = ageDays(this.network?.sources.network?.dataLastEditDate);
    if (this.upstreamNewer || !(sourceAge <= 7) || !(ageDays(this.network?.fetchedAt) <= 7)) {
      $('map-route-message').textContent = 'Refresh the dated network snapshot before finding reachable lay-bys.'; return;
    }
    const start = this.start, snapshot = this.network;
    if (!start || this.flagged.includes(start.featureId) || this.flagged.includes(start.linkId)) return;
    const button = $('map-next-layby'); button.disabled = true;
    $('map-route-message').textContent = 'Checking directed network routes to recorded lay-bys…';
    const router = this.flagged.some((id) => this.linkById.has(id)) ? createRouter({ ...snapshot, links:snapshot.links.map((l) => this.flagged.includes(l.id) ? { ...l,routeEligible:false } : l) }) : this.router;
    const found = [];
    for (const feature of this.features.filter((f) => f.kind === 'layby' && !this.flagged.includes(f.id) && !this.flagged.includes(f.link?.id))) {
      if (this.network !== snapshot || this.start !== start || this.mode !== 'route') return;
      const snap = findSnapCandidates(router, feature.coordinate, { maxDistanceM:40,limit:30 }).find((s) => s.linkId === feature.link?.id);
      if (snap) {
        const route = routeBetween(router,start,snap);
        if (route.ok && route.distanceM > 10) found.push({ feature,snap,route });
      }
      await new Promise((resolve) => setTimeout(resolve,0));
    }
    if (this.network !== snapshot || this.start !== start || this.mode !== 'route') return;
    found.sort((a,b) => a.route.distanceM-b.route.distanceM);
    button.disabled = false;
    $('map-route-message').textContent = found.length ? 'Closest reachable records by network distance. This does not confirm a lay-by is open, empty or suitable for your vehicle.' : 'No recorded lay-by could be reached on the eligible network from this start.';
    $('map-route-candidates').innerHTML = found.slice(0,3).map((item,i) => `<button class="map-candidate" type="button" data-reachable="${i}">${esc(item.feature.link?.description || roadName(item.feature.road))}<small>${miles(item.route.distanceM)} on network · view this route ↗</small></button>`).join('');
    $('map-route-candidates').querySelectorAll('[data-reachable]').forEach((b) => b.onclick = () => {
      const item = found[Number(b.dataset.reachable)];
      this.end = { ...item.snap,featureId:item.feature.id,label:`Lay-by · ${roadName(item.feature.road)}`,description:item.feature.link?.description,carriageway:item.feature.carriageway };
      this.result = item.route; this.renderRoute();
    });
  }
  renderRouteResult() {
    const result = this.result; if (!result || !$('map-route-result')) return;
    this.routeLayer.clearLayers(); this.drawEndpoints();
    if (!result.ok) { $('map-route-message').textContent = result.message || 'No connected, permitted NH-only route was found inside this map’s coverage.'; $('map-route-result').innerHTML = ''; return; }
    $('map-route-message').textContent = '';
    window.L.polyline(result.coordinates.map(latLng), { color: '#092c2a', weight: 10, opacity: .8, interactive: false }).addTo(this.routeLayer);
    window.L.polyline(result.coordinates.map(latLng), { color: '#8ee3cb', weight: 5, opacity: 1, interactive: false }).addTo(this.routeLayer);
    this.drawEndpoints();
    if (result.coordinates.length > 1) this.map.fitBounds(result.coordinates.map(latLng), { padding: [45,45], maxZoom: 16 });
    const groups = [];
    for (const segment of result.segments || []) {
      const link = this.linkById.get(segment.linkId || segment.id); const description = link?.description || segment.description || roadName(link?.road || segment.road);
      if (groups.at(-1)?.description === description) groups.at(-1).distanceM += segment.distanceM || 0;
      else groups.push({ description, distanceM:segment.distanceM || 0, coordinate:midpoint(segment.coordinates || link?.coordinates) });
    }
    $('map-route-result').innerHTML = `<div class="map-route-total">${(result.distanceM/1609.344).toFixed(1)} <small>miles on network</small></div><p class="map-subtext">${(result.distanceM/1000).toFixed(2)} km · shortest permitted distance in this snapshot</p><div class="map-tip">${icon('info')}<span>Check this route before departure. This is a route plan, not live turn-by-turn navigation.</span></div><div class="map-section-label">Route sections</div>${groups.map((g) => `<div class="map-route-step">${esc(g.description)}<span>${miles(g.distanceM)}</span></div>`).join('')}`;
  }
  drawEndpoints() {
    for (const [letter, point] of [['A',this.start],['B',this.end]]) if (point?.coordinate) window.L.marker(latLng(point.coordinate), { icon:window.L.divIcon({ className:'map-marker-icon', html:`<span class="map-route-letter" style="border:2px solid #fff;box-shadow:0 2px 8px #0008">${letter}</span>`, iconSize:[26,26],iconAnchor:[13,13] }), interactive:false, zIndexOffset:1000 }).addTo(this.routeLayer);
  }
  updateSourceLabel() {
    const age = ageDays(this.network?.fetchedAt);
    $('map-source-label').textContent = !this.network ? 'Data unavailable' : !navigator.onLine ? 'Offline snapshot' : this.refreshFailed ? 'Refresh failed · saved data' : this.upstreamNewer ? 'Newer source available' : age > 2 ? `Snapshot ${Math.floor(age)}d old` : 'Data dates & gaps';
  }
  invalidateOldRoute() {
    if (this.upstreamNewer || ageDays(this.network?.fetchedAt) > 7 || ageDays(this.network?.sources.network?.dataLastEditDate) > 7) {
      this.result = null; this.routeLayer.clearLayers();
      if (this.mode === 'route') { this.renderRoute(); $('map-route-message').textContent = 'The previous route was cleared because newer data is available or the snapshot is stale.'; }
    }
  }
  async checkSourceDates() {
    if (!navigator.onLine || !this.network) return;
    this.lastSourceCheck = Date.now(); this.checkStatus = 'Checking source publication dates…';
    const snapshot = this.network;
    const source = snapshot.sources.network;
    try {
      const base = source.url.replace(/\/query.*$/, '').replace(/\/$/, '');
      const url = /FeatureServer\/\d+$/.test(base) ? base : `${base}/1`;
      const res = await fetch(`${url}?f=json`, { signal:AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error('Source check failed');
      const metadata = await res.json(); const edited = metadata.editingInfo?.dataLastEditDate;
      if (this.network !== snapshot) return;
      if (!Number.isFinite(edited)) throw new Error('Source date unavailable');
      this.upstreamNewer = edited > new Date(source.dataLastEditDate).getTime() + 1000;
      this.invalidateOldRoute();
      this.checkStatus = this.upstreamNewer ? 'The official network has a newer publication. The app snapshot has not yet incorporated it.' : 'The snapshot matches the latest network publication checked. This does not verify physical layouts.';
    } catch { if (this.network !== snapshot) return; this.checkStatus = 'Could not check the upstream publication. Using the dated snapshot shown below.'; }
    this.updateSourceLabel();
    if ($('map-data-dialog').open) this.renderSources();
  }
  showSources() { this.renderSources(); $('map-data-dialog').showModal(); }
  renderSources() {
    const n = this.network, sources = n?.sources || {};
    $('map-data-content').innerHTML = `<p>A recent download is not the same as a recently verified road layout. Dates below are kept separate.</p>
      <div class="map-source-row"><span>Snapshot downloaded</span><strong>${dateLabel(n?.fetchedAt)}</strong></div><div class="map-source-row"><span>Network source data edited</span><strong>${dateLabel(sources.network?.dataLastEditDate)}</strong></div><div class="map-source-row"><span>Separate ERA source edited</span><strong>${dateLabel(sources.emergencyAreas?.dataLastEditDate)}</strong></div><div class="map-source-row"><span>Marker posts / junctions verified</span><strong>Unknown · existing app data</strong></div>
      <p class="map-warning">${esc(this.checkStatus || 'Source publication check is pending.')} ERA locations and availability remain unverified.</p>
      <h3>Coverage</h3><p>National Highways roads in a Hampshire-area bounding box, with a connecting buffer. Includes A36 and NH-owned junction links. This is not an exact county or patrol boundary. Off-network roads may appear in the street background but are never used for routing.</p>
      <h3>Emergency areas, shoulders and lay-bys</h3><p>National Highways records are displayed as supplied. The separate ERA layer was published before the two new M27 J9–J10 bays opened in February 2025. It cannot be treated as a complete current inventory. Amber icons identify those older records. Running-lane counts exclude recorded shoulders; absence of a shoulder record does not confirm there is no shoulder.</p>
      <h3>Marker posts</h3><p>Your existing references are preserved. Missing slip-road posts and interchange letters are not guessed from nearby mainline posts. Nearby-post distances are straight-line distances, not a surveyed chainage for the selected feature.</p>
      <h3>Routing limits</h3><p>Only open, NH-owned SRN links with eligible direction and access records are used. Routes use recorded connections and turn restrictions, with uncertain or restricted links excluded. No live closures, emergency exemptions or vehicle clearance guarantees. Routes may be unavailable where this strict network has gaps.</p>
      <h3>Sources</h3><p><a href="https://www.arcgis.com/home/item.html?id=4b64217e40dc48ebb38315a9a95c96e5" target="_blank" rel="noopener">National Highways Network Model</a> · <a href="https://www.arcgis.com/home/item.html?id=d293e5e9c6ea459896f1c3f06a470a87" target="_blank" rel="noopener">Emergency Areas</a> · Open Government Licence v3.0.<br>Street background © OpenStreetMap contributors; it is a separate source from the highlighted network.</p>
      <button id="map-refresh-data" class="map-action primary" type="button">Refresh map snapshot</button>`;
    $('map-refresh-data').onclick = async () => { $('map-refresh-data').disabled = true; this.result = null; this.start = null; this.end = null; this.selection = null; this.routeLayer.clearLayers(); this.selectedLayer.clearLayers(); await this.load(); this.renderSources(); };
  }
  toast(message) { $('map-toast').textContent = message; $('map-toast').classList.remove('hidden'); clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => $('map-toast').classList.add('hidden'), 5000); }
  async copy(text) { try { await navigator.clipboard.writeText(text); this.toast('Location copied.'); } catch { this.toast('Copy is unavailable in this browser. The reference and coordinates are in the selected record.'); } }
}
