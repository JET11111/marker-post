import { getLocationDetails } from './map-details.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalRoad = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const roadName = (s) => ({ A3M:'A3(M)', CHILWORTH:'Chilworth · M3 / M27', PITSEA:'M27 / M275 interchange' }[normalRoad(s)] || s || 'Network link');
const metres = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
const dateLabel = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not supplied';
const ageDays = (value) => value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 86400000) : Infinity;
const midpoint = (coords) => coords?.[Math.floor(coords.length / 2)];
const latLng = ([lng, lat]) => [lat, lng];
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
    this.selection = null;
    this.layersOn = { network: true, posts: true, era: true, layby: true, junction: false, streets: true };
    this.postFeatures = this.posts.map((p) => this.postFeature(p));
    this.host = $('map-app');
    this.host.innerHTML = `
      <div class="map-stage">
        <div id="network-map" aria-label="Interactive Hampshire road map"></div>
        <div class="map-search-area" role="search" aria-label="Search the map">
          <div class="map-search-wrap">${icon('search')}<input class="map-search" id="map-search" aria-label="Find a marker post, road or bay" type="search" autocomplete="off" spellcheck="false" placeholder="Search a post, road or bay" aria-controls="map-results"/><button id="map-search-clear" class="map-clear hidden" type="button" aria-label="Clear search">×</button></div>
          <div id="map-results" class="map-results hidden" aria-label="Search results"></div>
        </div>
        <button id="map-options" class="map-tool map-options" type="button" aria-label="Map options">${icon('layers')}</button>
        <button id="map-sources" class="map-data-pill" type="button" aria-label="Data dates and coverage"><i></i><span id="map-source-label">Loading road data</span></button>
        <div class="map-tools"><button id="map-locate" class="map-tool" type="button" aria-label="My location">${icon('locate')}</button><button id="map-plus" class="map-tool map-desktop" type="button" aria-label="Zoom in">${icon('plus')}</button><button id="map-minus" class="map-tool map-desktop" type="button" aria-label="Zoom out">${icon('minus')}</button></div>
        <div class="map-hint" id="map-hint">Tap a road or marker for details</div>
        <section class="map-sheet hidden" id="map-sheet" aria-label="Location details"><div id="map-panel" aria-live="polite"></div></section>
        <div id="map-toast" class="map-toast hidden" role="status"></div>
      </div>
      <dialog class="map-dialog" id="map-options-dialog" aria-labelledby="map-options-title"><div class="map-detail-top"><h2 id="map-options-title">Map options</h2><button class="map-small-btn" id="map-options-close" type="button">Done</button></div>
        <div class="map-layer-list">${[['network','Road network','#75b9ec'],['posts','Marker posts','#ffc23d'],['era','ERA records · unverified','#d6c28f'],['layby','Lay-bys','#bcb1ef'],['junction','Junctions','#d2dfeb'],['streets','Street map','#91a6b7']].map(([id,label,color]) => `<label><i style="background:${color}"></i>${label}<input type="checkbox" data-layer="${id}" ${this.layersOn[id] ? 'checked' : ''}/></label>`).join('')}</div>
        <div class="map-option-actions"><button id="map-fit" class="map-small-btn" type="button">Show whole patch</button><button id="map-day" class="map-small-btn" type="button" aria-pressed="false">Light background</button></div><p class="map-subtext">Pinch to zoom. Tap a gold dot to see its marker reference.</p>
      </dialog>
      <dialog class="map-dialog" id="map-data-dialog" aria-labelledby="map-data-title"><div class="map-detail-top"><h2 id="map-data-title">Data dates &amp; coverage</h2><button class="map-small-btn" id="map-data-close" type="button">Done</button></div><div id="map-data-content"></div></dialog>`;
    const L = window.L;
    this.map = L.map('network-map', { zoomControl: false, preferCanvas: true, minZoom: 8, maxZoom: 19, maxBounds: [[49.9,-3.5],[52.2,.5]], maxBoundsViscosity: .7 }).setView([51.025,-1.32],10);
    this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, keepBuffer: 1, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(this.map);
    this.map.attributionControl.addAttribution('<a href="https://www.arcgis.com/home/item.html?id=4b64217e40dc48ebb38315a9a95c96e5" target="_blank" rel="noopener">National Highways · OGL</a>');
    this.tiles.on('tileerror', () => { if (!this.tileErrorShown) { this.tileErrorShown = true; this.toast('Street background unavailable. Network records remain visible.'); } });
    L.control.scale({ metric: true, imperial: true, position: 'bottomleft' }).addTo(this.map);
    this.networkLayer = L.layerGroup().addTo(this.map); this.postLayer = L.layerGroup().addTo(this.map);
    this.featureLayer = L.layerGroup().addTo(this.map); this.labelLayer = L.layerGroup().addTo(this.map);
    this.selectedLayer = L.layerGroup().addTo(this.map); this.gpsLayer = L.layerGroup().addTo(this.map);
    this.map.on('moveend zoomend', () => this.renderPoints());
    this.map.on('click', (e) => { if (this.network) this.select({ id: `point:${e.latlng.lng.toFixed(6)},${e.latlng.lat.toFixed(6)}`, kind: 'point', title: 'Selected point', coordinate: [e.latlng.lng, e.latlng.lat] }); });
    this.bind(); this.renderGPS();

  }
  bind() {
    $('map-search').addEventListener('input', () => { this.search(); $('map-search-clear').classList.toggle('hidden', !$('map-search').value); });
    $('map-search').addEventListener('focus', () => { this.closeDetail(); this.search(); });
    $('map-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('map-results').querySelector('button')?.click(); } if (e.key === 'Escape') { $('map-results').classList.add('hidden'); $('map-search').blur(); } });
    $('map-search-clear').onclick = () => { $('map-search').value = ''; $('map-search-clear').classList.add('hidden'); $('map-results').classList.add('hidden'); $('map-search').focus(); };
    $('map-plus').onclick = () => this.map.zoomIn(); $('map-minus').onclick = () => this.map.zoomOut();
    $('map-fit').onclick = () => { this.fitPatch(); $('map-options-dialog').close(); };
    $('map-locate').onclick = () => this.locate();
    $('map-day').onclick = () => { const active = $('network-map').classList.toggle('day-map'); $('map-day').setAttribute('aria-pressed', String(active)); };
    $('map-options').onclick = () => { $('map-search').blur(); $('map-results').classList.add('hidden'); $('map-options-dialog').showModal(); };
    $('map-options-close').onclick = () => $('map-options-dialog').close();
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
    this.map.on('dragstart', () => { $('map-search').blur(); $('map-results').classList.add('hidden'); });
  }
  async load() {
    try {
      const response = await fetch('data/network.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Network data returned ${response.status}`);
      const data = await response.json();
      if (data.schemaVersion !== 1 || !Array.isArray(data.links) || !data.links.length || !data.sources) throw new Error('Network snapshot is incomplete.');
      this.refreshFailed = response.headers.get('X-Markerpost-Cache') === 'fallback'; this.upstreamNewer = false;
      this.network = data; this.linkById = new Map(data.links.map((l) => [l.id, l]));
      this.features = (data.areas || []).map((a) => ({ ...a,
        title: a.kind === 'layby' ? 'Lay-by' : 'Emergency area',
        road: a.road || this.linkById.get(a.linkId)?.road,
        carriageway: a.carriageway || this.linkById.get(a.linkId)?.carriageway,
        link: this.linkById.get(a.linkId),
        coordinate: a.coordinate || midpoint(a.coordinates), sourceKey: a.source || 'emergencyAreas',
      })).filter((f) => f.coordinate?.length === 2);
      this.renderNetwork(); this.renderPoints();
      if (this.selection) this.renderPanel(); else this.closeDetail();
      this.updateSourceLabel();
      this.checkSourceDates();
    } catch (error) {
      this.refreshFailed = true;
      if (this.network) {
        this.checkStatus = 'Refresh failed. The last successfully loaded, dated snapshot is still displayed.';
        this.renderPanel(); this.updateSourceLabel(); this.toast(this.checkStatus);
        return;
      }
      $('map-panel').innerHTML = `<div class="map-warning">The network snapshot could not load. Marker posts can still be explored; road details and bays are unavailable.</div><button id="map-retry" class="map-action" type="button">Retry network download</button>`;
      $('map-sheet').classList.remove('hidden');
      $('map-retry').onclick = () => this.load(); this.updateSourceLabel(); this.renderPoints();
      console.error('Network map:', error);
    }
  }
  show() {
    requestAnimationFrame(() => { this.map.invalidateSize(); this.renderPoints(); });
    if (this.network && (!this.lastSourceCheck || Date.now() - this.lastSourceCheck > 300000)) {
      this.checkSourceDates();
    }
  }
  fitPatch() { this.map.fitBounds([[50.72,-1.95],[51.4,-.73]], { padding: [30,30] }); this.closeDetail(); }
  postFeature(p) { return { id: `post:${p.sourceId || `${p.road}:${p.ref}`}`, kind: 'post', title: p.ref, road: p.road, carriageway: p.direction, coordinate: [p.lng,p.lat], post: p }; }
  linkFeature(link, coordinate) {
    return { id: link.id, kind: link.form === 'L' ? 'layby' : link.form === 'EA' ? 'era' : 'link', title: link.form === 'L' ? 'Lay-by' : link.form === 'EA' ? 'Emergency area' : roadName(link.road), road: link.road, carriageway: link.carriageway, coordinate: coordinate || midpoint(link.coordinates), link, sourceKey: 'network' };
  }
  renderNetwork() {
    this.networkLayer.clearLayers(); const L = window.L;
    for (const link of this.network.links) {
      const coords = link.coordinates?.map(latLng); if (!coords || coords.length < 2) continue;
      const isM = /^M|\(M\)/.test(link.road || '');
      const path = L.polyline(coords, { color: isM ? '#75b9ec' : '#73b9af', weight: ['SL','SR'].includes(link.form) ? 2 : 3.2, opacity: .8, bubblingMouseEvents: false }).addTo(this.networkLayer);
      const hit = L.polyline(coords, { weight: 14, opacity: 0, bubblingMouseEvents: false }).addTo(this.networkLayer);
      const inspect = (e) => this.select(this.linkFeature(link, [e.latlng.lng,e.latlng.lat]), false);
      path.on('click', inspect); hit.on('click', inspect);
    }
  }
  renderPoints() {
    if (!this.map || !this.map.getSize().x) return;
    const L = window.L, zoom = this.map.getZoom(), bounds = this.map.getBounds().pad(.05);
    this.postLayer.clearLayers(); this.featureLayer.clearLayers(); this.labelLayer.clearLayers();
    const visible = (coord) => coord && bounds.contains(latLng(coord));

    if (this.layersOn.posts && zoom >= 12) {
      for (const feature of this.postFeatures) {
        if (!visible(feature.coordinate)) continue;
        const dot = L.circleMarker(latLng(feature.coordinate), { radius: 10, opacity: 0, fillOpacity: 0, weight: 0, bubblingMouseEvents: false }).addTo(this.postLayer);
        L.circleMarker(latLng(feature.coordinate), { radius: zoom >= 15 ? 3.5 : 2.5, color: '#efc16f', fillColor: '#efc16f', fillOpacity: .95, weight: 1, interactive: false }).addTo(this.postLayer);
        dot.on('click', () => this.select(feature, false));

      }
    }
    for (const feature of this.features || []) {
      if (zoom < 12 || !this.layersOn[feature.kind] || !visible(feature.coordinate)) continue;
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
      const roadShown = new Set();
      for (const link of this.network?.links || []) {
        if (!['DC','SC'].includes(link.form) || !link.road || roadShown.has(link.road)) continue;
        const coordinate = midpoint(link.coordinates); if (!visible(coordinate)) continue;
        roadShown.add(link.road);
        if (link.road === 'Unclassified Unnamed Road') continue;
        L.marker(latLng(coordinate), { interactive: false, icon: L.divIcon({ className: 'map-road-label', html: esc(roadName(link.road)), iconSize:null, iconAnchor: [18,9] }) }).addTo(this.labelLayer);
      }
    }

  }
  renderGPS() {
    this.gpsLayer.clearLayers(); if (!this.position) return;
    const L = window.L, p = this.position, fresh = Date.now() - (p.timestamp || 0) < 120000;
    if (Number.isFinite(p.accuracy)) L.circle([p.lat,p.lng], { radius: p.accuracy, color: '#70c6fd', weight: 1, fillOpacity: .08 }).addTo(this.gpsLayer);
    L.circleMarker([p.lat,p.lng], { radius: 7, color: '#fff', weight: 2, fillColor: fresh ? '#4fbbff' : '#8798a8', fillOpacity: 1 }).addTo(this.gpsLayer).bindTooltip(fresh ? `You · ±${Math.round(p.accuracy || 0)} m` : 'Last recorded position');
  }
  locate() {
    if (!navigator.geolocation) { this.toast('Location is unavailable on this device. Select a post or road on the map.'); return; }
    this.toast('Finding your position…');
    navigator.geolocation.getCurrentPosition((p) => {
      this.position = { lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, heading: p.coords.heading, timestamp: p.timestamp };
      this.renderGPS(); this.map.setView([p.coords.latitude,p.coords.longitude],15);
      this.toast(`Location accuracy ±${Math.round(p.coords.accuracy)} m. Check the carriageway.`);

    }, () => this.toast('Location unavailable. Search for a marker post or tap the map instead.'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  }
  closeDetail() {
    this.selection = null; this.selectedLayer.clearLayers(); $('map-sheet').classList.add('hidden'); this.host.classList.remove('has-selection'); $('map-hint').classList.remove('hidden');
  }
  select(feature, move = true) {
    if (!feature?.coordinate) return;
    $('map-search').blur(); $('map-results').classList.add('hidden');
    this.selection = feature; this.renderDetail(); this.highlight(feature);
    $('map-sheet').classList.remove('hidden'); this.host.classList.add('has-selection'); $('map-hint').classList.add('hidden');
    $('map-sheet').scrollTop = 0;
    // Place the selection in the unobscured area above the bottom card.
    if (move) this.map.setView(latLng(feature.coordinate), Math.max(15, this.map.getZoom()), { animate: false });
    requestAnimationFrame(() => {
      const point = this.map.latLngToContainerPoint(latLng(feature.coordinate));
      const height = this.map.getSize().y, sheet = $('map-sheet').offsetHeight;
      const targetY = Math.max(135, (height - sheet + 80) / 2);
      if (move || point.y > height - sheet - 25 || point.y < 95) this.map.panBy([move ? 0 : point.x - this.map.getSize().x / 2, point.y - targetY], { animate: false });
    });
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
    $('map-search').blur(); this.closeDetail();
  }
  renderPanel() { if (this.selection) this.renderDetail(); }
  renderDetail() {
    const f = this.selection;
    const detail = getLocationDetails({ selection:f, links:this.network?.links, postFeatures:this.postFeatures, areas:this.features, sources:this.network?.sources });
    const link = detail.section?.link, layout = detail.layout;
    const post = f.kind === 'post' ? { feature:f, distanceM:0 } : detail.nearestPost;
    const road = f.road || link?.road, carriageway = f.carriageway || link?.carriageway;
    const nearby = [detail.nearestEra, detail.nearestLayby];
    const association = (item) => item?.association === 'same-carriageway' ? `Carriageway ${esc(item.matchedCarriageway || carriageway || '')}` : item?.association === 'selected-record' ? 'Selected record' : 'Carriageway unverified';
    const row = (item, label, index) => item ? `<button class="map-nearby" type="button" data-nearby="${index}"><span><strong>${label}</strong><small>${association(item)}${item.sourceKey === 'emergencyAreas' ? ' · older record' : ''}</small></span><b>${metres(item.distanceM)}<span aria-hidden="true"> ›</span></b></button>` : `<div class="map-nearby"><span><strong>${label}</strong><small>No matching record within 30 km</small></span><b>Unknown</b></div>`;
    $('map-panel').innerHTML = `<div class="map-sheet-heading"><div><div class="map-detail-type">${esc(road ? roadName(road) : 'Map point')}${carriageway ? ` · ${esc(carriageway)}` : ''}</div><h2 class="map-reference">${esc(f.kind === 'post' ? f.title : f.kind === 'era' ? 'Emergency area' : f.kind === 'layby' ? 'Lay-by' : f.kind === 'junction' ? f.title : 'Road details')}</h2></div><button class="map-close" id="map-detail-close" type="button" aria-label="Close details">×</button></div>
      <div class="map-sheet-body">
        <div class="map-detail-grid"><div><span>Running lanes</span><strong>${esc(layout.running)}</strong></div><div><span>Hard shoulder</span><strong>${esc(layout.shoulder)}</strong></div></div>
        ${f.kind !== 'post' ? (post ? `<button class="map-post-row" id="map-nearest-post" type="button"><span>Nearest marker <small>${metres(post.distanceM)} · straight-line</small></span><strong>${esc(post.feature.title)} ›</strong></button>` : '<div class="map-subtext">Nearest marker: no matching record.</div>') : ''}
        <div class="map-distance-label">Nearest bay records <span>straight-line</span></div>
        ${row(nearby[0],'ERA',0)}${row(nearby[1],'Lay-by',1)}
        <details class="map-record-notes"><summary>Record details &amp; dates</summary>
          <p class="map-subtext">${esc(link?.description || 'No unambiguous road section matched. Tap the correct road line for its recorded layout.')}</p>
          ${detail.section?.association === 'interchange-unverified' ? '<p class="map-warning">Interchange alignment is unverified. Lane and shoulder details remain unknown.</p>' : ''}
          <p class="map-subtext">Road source: ${dateLabel(this.network?.sources.network?.dataLastEditDate)}. Lane counts are recorded values; “not recorded” does not mean no hard shoulder. Physical layouts are unverified.</p>
          <p class="map-subtext">Bay distances are to recorded points, not driving distances or a bay ahead. ERA coverage is incomplete and availability is unknown. ERA source: ${dateLabel(this.network?.sources.emergencyAreas?.dataLastEditDate)}.</p>
          <p class="map-subtext">Marker survey date unknown.${post && post.association && post.association !== 'same-carriageway' ? ' Nearby marker association is unverified.' : ''}${f.post?.link ? ` Source link: ${esc(f.post.link)}.` : ''}</p>
          <p class="map-subtext">${f.coordinate[1].toFixed(6)}, ${f.coordinate[0].toFixed(6)}</p>
          <button class="map-small-btn" id="map-copy" type="button">Copy location</button>
        </details>
      </div>`;
    $('map-detail-close').onclick = () => this.closeDetail();
    if ($('map-nearest-post')) $('map-nearest-post').onclick = () => this.select(post.feature);
    $('map-panel').querySelectorAll('[data-nearby]').forEach((b) => b.onclick = () => this.select(nearby[Number(b.dataset.nearby)].feature));
    $('map-copy').onclick = () => this.copy(`${road ? `${roadName(road)} ` : ''}${f.title}\n${f.coordinate[1].toFixed(6)}, ${f.coordinate[0].toFixed(6)}`);
  }
  updateSourceLabel() {
    const age = ageDays(this.network?.fetchedAt);
    $('map-source-label').textContent = !this.network ? 'Data unavailable' : !navigator.onLine ? 'Offline snapshot' : this.refreshFailed ? 'Refresh failed · saved data' : this.upstreamNewer ? 'Newer source available' : age > 2 ? `Snapshot ${Math.floor(age)}d old` : 'Road data · ' + dateLabel(this.network?.sources.network?.dataLastEditDate);
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
      <h3>Coverage</h3><p>National Highways roads in a Hampshire-area bounding box, with a connecting buffer. Includes A36 and NH-owned junction links. This is not an exact county or patrol boundary. The street background includes roads beyond the highlighted National Highways network.</p>
      <h3>Emergency areas, shoulders and lay-bys</h3><p>National Highways records are displayed as supplied. The separate ERA layer was published before the two new M27 J9–J10 bays opened in February 2025. It cannot be treated as a complete current inventory. Amber icons identify those older records. Running-lane counts exclude recorded shoulders; absence of a shoulder record does not confirm there is no shoulder.</p>
      <h3>Marker posts</h3><p>Your existing references are preserved. Missing slip-road posts and interchange letters are not guessed from nearby mainline posts. Nearby-post distances are straight-line distances, not a surveyed chainage for the selected feature.</p>
      <h3>Sources</h3><p><a href="https://www.arcgis.com/home/item.html?id=4b64217e40dc48ebb38315a9a95c96e5" target="_blank" rel="noopener">National Highways Network Model</a> · <a href="https://www.arcgis.com/home/item.html?id=d293e5e9c6ea459896f1c3f06a470a87" target="_blank" rel="noopener">Emergency Areas</a> · Open Government Licence v3.0.<br>Street background © OpenStreetMap contributors; it is a separate source from the highlighted network.</p>
      <button id="map-refresh-data" class="map-action primary" type="button">Refresh map snapshot</button>`;
    $('map-refresh-data').onclick = async () => { $('map-refresh-data').disabled = true; this.closeDetail(); await this.load(); this.renderSources(); };
  }
  toast(message) { $('map-toast').textContent = message; $('map-toast').classList.remove('hidden'); clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => $('map-toast').classList.add('hidden'), 5000); }
  async copy(text) { try { await navigator.clipboard.writeText(text); this.toast('Location copied.'); } catch { this.toast('Copy is unavailable in this browser. The reference and coordinates are in the selected record.'); } }
}
