// National Highways public Network Model and Emergency Areas. Node 22+, no keys.
// Deliberately atomic: incomplete responses never replace the last good snapshot.
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const NETWORK = 'https://services-eu1.arcgis.com/mZXeBXkkZpekxjXT/arcgis/rest/services/Network_Model_Public_view2/FeatureServer';
const ERA = 'https://services-eu1.arcgis.com/mZXeBXkkZpekxjXT/arcgis/rest/services/National_Highways_Emergency_Areas/FeatureServer/0';
const BOUNDS = [-2.05, 50.65, -0.65, 51.45];
const OUT = resolve(process.env.NETWORK_OUTPUT || 'data/network.json');
const NOW = Date.now();
const attrs = rows => rows.map(row => row.attributes);
const guid = value => String(value || '').replace(/[{}]/g, '').toLowerCase();
const iso = value => Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
const finite = value => Number.isFinite(value) ? value : null;
const unique = values => [...new Set(values.filter(Boolean))];
const batches = (values, size = 80) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));
const sqlIn = (field, values) => `${field} IN (${values.map(v => `'${String(v).replaceAll("'", "''")}'`).join(',')})`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let active = 0;
const queue = [];
async function limit(fn) {
  if (active >= 6) await new Promise(resolve => queue.push(resolve));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

async function request(url, params = {}) {
  return limit(async () => {
    const query = new URLSearchParams({ f: 'json', ...params });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // The public ArcGIS gateway rejects GET query strings above ~2 KB.
        const long = query.toString().length > 1500;
        const response = await fetch(long ? url : `${url}?${query}`, {
          signal: AbortSignal.timeout(45000),
          ...(long ? { method: 'POST', body: query } : {}),
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(`ArcGIS ${data.error.code}: ${data.error.message} ${data.error.details?.join('; ') || ''}`);
        return data;
      } catch (error) {
        if (attempt === 2) throw new Error(`${url}: ${error.message}`);
        await pause(1000 * (attempt + 1));
      }
    }
  });
}

// ArcGIS returnIdsOnly is not subject to the feature transfer limit. Fetch every
// returned ID in bounded chunks and verify set equality to detect truncation.
async function queryAll(url, params = {}) {
  const { outFields = '*', returnGeometry = false, outSR = 4326, ...filter } = params;
  const idsResponse = await request(`${url}/query`, { where: '1=1', ...filter, returnIdsOnly: true });
  if (!('objectIds' in idsResponse) || idsResponse.exceededTransferLimit) throw new Error(`Incomplete ID response: ${url}`);
  const ids = idsResponse.objectIds || [];
  if (!ids.length) return [];
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate IDs: ${url}`);
  const oid = idsResponse.objectIdFieldName;
  if (!oid) throw new Error(`Missing object ID field: ${url}`);
  const fields = outFields === '*' ? '*' : unique([oid, ...outFields.split(',')]).join(',');
  const chunks = await Promise.all(batches(ids, 500).map(async chunk => {
    const response = await request(`${url}/query`, { objectIds: chunk.join(','), outFields: fields, returnGeometry, outSR });
    if (!Array.isArray(response.features) || response.exceededTransferLimit) throw new Error(`Truncated feature response: ${url}`);
    const returned = new Set(response.features.map(f => f.attributes[oid]));
    if (returned.size !== chunk.length || chunk.some(id => !returned.has(id))) throw new Error(`Missing feature IDs: ${url}`);
    return response.features;
  }));
  return chunks.flat();
}

async function queryByValues(layer, field, values, options = {}) {
  if (!values.length) return [];
  const chunks = await Promise.all(batches(unique(values)).map(batch => queryAll(`${NETWORK}/${layer}`, { where: sqlIn(field, batch), ...options })));
  const result = new Map();
  for (const row of chunks.flat()) result.set(row.attributes.objectid, row);
  return [...result.values()];
}

function distance(a, b) {
  const r = Math.PI / 180;
  const dlat = (b[1] - a[1]) * r, dlng = (b[0] - a[0]) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dlng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
const length = coordinates => coordinates.slice(1).reduce((sum, c, i) => sum + distance(coordinates[i], c), 0);
function midpoint(coordinates) {
  let remaining = length(coordinates) / 2;
  for (let i = 1; i < coordinates.length; i++) {
    const segment = distance(coordinates[i - 1], coordinates[i]);
    if (remaining <= segment) {
      const f = segment ? remaining / segment : 0;
      return coordinates[i - 1].map((v, d) => +(v + f * (coordinates[i][d] - v)).toFixed(7));
    }
    remaining -= segment;
  }
  return coordinates.at(-1);
}
const cleanCoordinates = coordinates => coordinates.map(c => c.slice(0, 2).map(n => +n.toFixed(7)));
const validDates = a => (!a.startdate || a.startdate <= NOW) && (!a.enddate || a.enddate > NOW);
function index(rows, key) {
  const map = new Map();
  for (const row of rows) { const id = guid(row[key]); if (!map.has(id)) map.set(id, []); map.get(id).push(row); }
  return map;
}
const condition = (rows, kind) => rows.map(a => ({ type: a[`${kind}type`], code: a[kind] }));

async function main() {
  const spatial = { geometry: BOUNDS.join(','), geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects' };
  const [networkMeta, eraMeta] = await Promise.all([request(`${NETWORK}/1`), request(ERA)]);
  console.log('Fetching official NH links and emergency-area geometries…');
  const [rawLinks, rawAreas, accessRefsAll, vehicleRefsAll, vehicleNodeRefsAll, turnRefsAll] = await Promise.all([
    queryAll(`${NETWORK}/1`, { ...spatial, where: "ownership='NH' AND srn='Y'", returnGeometry: true }),
    queryAll(ERA, { ...spatial, returnGeometry: true }),
    queryAll(`${NETWORK}/11`, { outFields: 'accessid,linkid,applicabledirection,atposition' }),
    queryAll(`${NETWORK}/22`, { outFields: 'vehicleid,linkid,nodeid,applicabledirection,atposition' }),
    queryAll(`${NETWORK}/23`, { outFields: 'vehicleid,linkid' }),
    queryAll(`${NETWORK}/19`, { outFields: 'turnid,linkid,sequence,applicabledirection' }),
  ]);
  if (rawLinks.length < 1000 || rawAreas.length < 10) throw new Error(`Unexpectedly small response: ${rawLinks.length} links, ${rawAreas.length} areas`);
  const linkIds = new Set(rawLinks.map(row => guid(row.attributes.linkid)));
  const nodeIds = new Set(rawLinks.flatMap(row => [guid(row.attributes.startnode), guid(row.attributes.endnode)]));
  const accessRefs = attrs(accessRefsAll).filter(a => linkIds.has(guid(a.linkid)));
  const vehicleRefs = attrs([...vehicleRefsAll, ...vehicleNodeRefsAll]).filter(a => linkIds.has(guid(a.linkid)) || (a.nodeid && nodeIds.has(guid(a.nodeid))));
  const allTurns = attrs(turnRefsAll);
  const turnIds = unique(allTurns.filter(a => linkIds.has(guid(a.linkid))).map(a => guid(a.turnid)));
  const turnIdSet = new Set(turnIds);
  // Keep the full ordered restriction, even when it crosses the extraction edge.
  const turnRefs = allTurns.filter(a => turnIdSet.has(guid(a.turnid)));
  const accessIds = unique(accessRefs.map(a => guid(a.accessid)));
  const vehicleIds = unique(vehicleRefs.map(a => guid(a.vehicleid)));
  console.log(`Found ${rawLinks.length} NH links and ${rawAreas.length} published ERA shapes; fetching lanes and ${turnIds.length} turn rules…`);
  const [lanesRaw, accessRaw, accessInRaw, accessExRaw, vehicleRaw, turnRaw, turnInRaw, turnExRaw] = await Promise.all([
    queryByValues(9, 'linkid', [...linkIds], { outFields: 'linkid,lanenumber,start,end_,directionality,averagewidth,minimumwidth,startdate,enddate' }),
    queryByValues(2, 'accessid', accessIds),
    queryByValues(12, 'accessid', accessIds),
    queryByValues(13, 'accessid', accessIds),
    queryByValues(3, 'vehicleid', vehicleIds),
    queryByValues(4, 'turnid', turnIds),
    queryByValues(20, 'turnid', turnIds),
    queryByValues(21, 'turnid', turnIds),
  ]);
  const laneByLink = index(attrs(lanesRaw).filter(validDates), 'linkid');
  const links = rawLinks.map(({ attributes: a, geometry }) => {
    const paths = geometry?.paths || [];
    if (!paths.length || paths.some(path => path.length < 2)) throw new Error(`Missing geometry for ${a.linkid}`);
    const coordinates = cleanCoordinates(paths[0]);
    const routeBlockReasons = [];
    if (a.ownership !== 'NH' || a.srn !== 'Y') throw new Error(`Non-NH record passed source filter: ${a.linkid}`);
    if (a.operationalstate !== 'O') routeBlockReasons.push('Road is not recorded open');
    if (!validDates(a)) routeBlockReasons.push('Road validity dates exclude the download date');
    if (!['0', '1', '2'].includes(a.directionality)) routeBlockReasons.push('Unknown traffic direction');
    if (!a.startnode || !a.endnode) routeBlockReasons.push('Missing network connection');
    if (paths.length !== 1) routeBlockReasons.push('Multipart road geometry requires review');
    if (a.linkform === 'SR') routeBlockReasons.push('Service/access road requires explicit access verification');
    if (!['DC', 'SC', 'SL', 'R', 'DL', 'L', 'EA', 'SR'].includes(a.linkform)) routeBlockReasons.push('Unknown road form');
    return {
      id: guid(a.linkid), road: a.roadname || 'Unnamed NH road', description: a.linkdesc || '',
      from: guid(a.startnode), to: guid(a.endnode), directionality: a.directionality, direction: a.direction,
      carriageway: a.carriageway, form: a.linkform, state: a.operationalstate, ownership: a.ownership, srn: a.srn,
      coordinates, ...(paths.length > 1 ? { paths: paths.map(cleanCoordinates) } : {}), lengthM: +length(coordinates).toFixed(2),
      reportedLaneCount: finite(a.numberoflanes), lanes: (laneByLink.get(guid(a.linkid)) || []).map(lane => ({
        code: lane.lanenumber, startM: finite(lane.start), endM: finite(lane.end_), directionality: lane.directionality,
        averageWidthM: lane.averagewidth > 0 ? lane.averagewidth : null, minimumWidthM: lane.minimumwidth > 0 ? lane.minimumwidth : null,
      })),
      startDate: iso(a.startdate), endDate: iso(a.enddate), sourceEditedAt: iso(a.last_edited_date),
      routeEligible: routeBlockReasons.length === 0, routeBlockReasons,
    };
  });
  const byId = new Map(links.map(link => [link.id, link]));
  const block = (id, reason) => { const link = byId.get(guid(id)); if (link) { link.routeEligible = false; if (!link.routeBlockReasons.includes(reason)) link.routeBlockReasons.push(reason); } };
  const accessById = new Map(attrs(accessRaw).map(a => [guid(a.accessid), a]));
  const accessIn = index(attrs(accessInRaw), 'accessid'), accessEx = index(attrs(accessExRaw), 'accessid');
  const accessRestrictions = accessRefs.map(ref => {
    const source = accessById.get(guid(ref.accessid));
    if (!source) throw new Error(`Missing access restriction ${ref.accessid}`);
    const inclusions = condition(accessIn.get(guid(ref.accessid)) || [], 'inclusion');
    const exemptions = condition(accessEx.get(guid(ref.accessid)) || [], 'exemption');
    if (source.restriction !== 'PA' || inclusions.length || exemptions.length) block(ref.linkid, source.description || `Access restriction ${source.restriction}`);
    return { id: guid(ref.accessid), linkId: guid(ref.linkid), type: source.restriction, description: source.description, directionality: ref.applicabledirection, atM: finite(ref.atposition), inclusions, exemptions };
  });
  const vehicleById = new Map(attrs(vehicleRaw).map(a => [guid(a.vehicleid), a]));
  const vehicleRestrictions = vehicleRefs.map(ref => {
    const source = vehicleById.get(guid(ref.vehicleid));
    if (!source) throw new Error(`Missing vehicle restriction ${ref.vehicleid}`);
    block(ref.linkid, source.description || 'Vehicle restriction requires a verified vehicle profile');
    if (ref.nodeid) for (const link of links) if (link.from === guid(ref.nodeid) || link.to === guid(ref.nodeid)) block(link.id, source.description || 'Vehicle restriction at network connection');
    return { id: guid(ref.vehicleid), linkId: guid(ref.linkid) || null, nodeId: guid(ref.nodeid) || null, type: source.restriction, description: source.description, measure: source.measure, unit: source.unitofmeasure, directionality: ref.applicabledirection || '0' };
  });
  const turnById = new Map(attrs(turnRaw).map(a => [guid(a.turnid), a]));
  const turnIn = index(attrs(turnInRaw), 'turnid'), turnEx = index(attrs(turnExRaw), 'turnid'), turnSequences = index(turnRefs, 'turnid');
  const turnRestrictions = turnIds.map(id => {
    const source = turnById.get(id);
    if (!source) throw new Error(`Missing turn restriction ${id}`);
    const sequence = (turnSequences.get(id) || []).sort((a, b) => a.sequence - b.sequence).map(a => ({ id: guid(a.linkid), sequence: a.sequence, directionality: a.applicabledirection }));
    const inclusions = condition(turnIn.get(id) || [], 'inclusion'), exemptions = condition(turnEx.get(id) || [], 'exemption');
    const rule = { id, type: source.restriction, links: sequence, inclusions, exemptions };
    if (inclusions.length || exemptions.length) {
      for (const part of sequence) block(part.id, 'Conditional turn restriction requires verification');
    } else if (source.restriction === 'OW' && sequence.length && sequence.every(part => ['1', '2'].includes(part.directionality))) {
      // A publisher OW can reference several road segments after a split, often
      // all with sequence 0. Where each segment already has that exact one-way
      // direction this rule adds no turn transition; retain and confirm it.
      // Never use this to invent a direction for an ambiguous multi-link rule.
      const consistent = sequence.every(part => {
        const link = byId.get(part.id);
        return !link || ((!link.allowedDirectionality || link.allowedDirectionality === part.directionality) &&
          (link.directionality === part.directionality || (sequence.length === 1 && link.directionality === '0')));
      });
      if (consistent) {
        for (const part of sequence) if (byId.has(part.id)) byId.get(part.id).allowedDirectionality = part.directionality;
        rule.handledByDirectionality = true;
      } else { for (const part of sequence) block(part.id, 'One-way restriction conflicts with road direction'); }
    } else if (!['NT', 'MT'].includes(source.restriction) || sequence.length < 2 || sequence.some((a, i) => a.sequence !== i || !['0', '1', '2'].includes(a.directionality))) {
      for (const part of sequence) block(part.id, 'Turn restriction could not be interpreted');
    }
    return rule;
  });
  const areas = rawAreas.map(({ attributes: a, geometry }) => {
    const paths = geometry?.paths?.map(cleanCoordinates);
    if (!paths?.length) throw new Error(`Missing ERA geometry ${a.objectid_1}`);
    return { id: `era:${guid(a.globalid_1) || a.objectid_1}`, kind: 'era', source: 'emergencyAreas', coordinate: midpoint(paths[0]), paths, sourceEditedAt: null, layoutVerifiedAt: null };
  });
  for (const link of links.filter(link => ['EA', 'L'].includes(link.form))) areas.push({
    id: `network:${link.id}`, kind: link.form === 'EA' ? 'era' : 'layby', source: 'network', linkId: link.id,
    road: link.road, carriageway: link.carriageway, direction: link.direction, description: link.description,
    coordinate: midpoint(link.coordinates), paths: link.paths || [link.coordinates], sourceEditedAt: link.sourceEditedAt, layoutVerifiedAt: null,
  });
  const [networkAfter, eraAfter] = await Promise.all([request(`${NETWORK}/1`), request(ERA)]);
  for (const [before, after, name] of [[networkMeta, networkAfter, 'Network Model'], [eraMeta, eraAfter, 'Emergency Areas']]) {
    if (before.editingInfo?.dataLastEditDate !== after.editingInfo?.dataLastEditDate) throw new Error(`${name} changed during extraction; retry for a consistent snapshot`);
  }
  const fetchedAt = new Date().toISOString();
  const out = {
    schemaVersion: 1, fetchedAt,
    sources: {
      network: { title: 'National Highways Network Model', url: NETWORK, landingUrl: 'https://network-model-highwaysengland.hub.arcgis.com/', dataLastEditDate: iso(networkMeta.editingInfo?.dataLastEditDate), lastCheckedAt: fetchedAt, licence: 'Open Government Licence v3.0', layoutVerifiedAt: null },
      emergencyAreas: { title: 'National Highways Emergency Areas', url: ERA, landingUrl: 'https://www.arcgis.com/home/item.html?id=d293e5e9c6ea459896f1c3f06a470a87', dataLastEditDate: iso(eraMeta.editingInfo?.dataLastEditDate), lastCheckedAt: fetchedAt, licence: 'Open Government Licence v3.0', layoutVerifiedAt: null },
    },
    coverage: { bounds: BOUNDS, kind: 'Approximate Hampshire patrol area with connecting buffer; not an administrative county boundary', roads: unique(links.map(link => link.road)).sort(), counts: { links: links.length, routeEligibleLinks: links.filter(link => link.routeEligible).length, lanes: lanesRaw.length, publishedEraShapes: rawAreas.length, networkEmergencyAreas: links.filter(link => link.form === 'EA').length, laybys: links.filter(link => link.form === 'L').length } },
    routing: { restrictionsComplete: true, restrictionsCheckedAt: fetchedAt, basis: 'Recorded NH-owned SRN links only; shortest distance; no live closures, permissions or traffic', maxSnapshotAgeDays: 7, externalRoadFallback: false },
    links, turnRestrictions, accessRestrictions, vehicleRestrictions, areas,
  };
  validate(out);
  let previous;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.links?.length && out.links.length < previous.links.length * 0.8) throw new Error('More than 20% of previous links disappeared; manual review required');
  await mkdir(dirname(OUT), { recursive: true });
  const temp = `${OUT}.tmp-${process.pid}`;
  try { await writeFile(temp, `${JSON.stringify(out)}\n`); await rename(temp, OUT); } finally { await unlink(temp).catch(() => {}); }
  console.log(`Saved ${OUT}: ${links.length} links, ${areas.length} area records, ${turnRestrictions.length} turn rules. Network publication ${out.sources.network.dataLastEditDate}; ERA publication ${out.sources.emergencyAreas.dataLastEditDate}.`);
}

function validate(data) {
  if (data.schemaVersion !== 1 || !data.routing?.restrictionsComplete || !Array.isArray(data.links) || data.links.length < 1000) throw new Error('Invalid network snapshot');
  const ids = new Set();
  for (const link of data.links) {
    if (!link.id || ids.has(link.id) || link.ownership !== 'NH' || link.srn !== 'Y') throw new Error('Invalid/duplicate/non-NH road');
    ids.add(link.id);
    if (!(link.lengthM > 0) || link.coordinates.length < 2 || link.coordinates.some(c => c.length !== 2 || !c.every(Number.isFinite) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) throw new Error(`Invalid geometry ${link.id}`);
    if (link.routeEligible && (link.state !== 'O' || !link.from || !link.to || link.routeBlockReasons.length)) throw new Error(`Invalid routing eligibility ${link.id}`);
  }
  for (const road of ['M3', 'M27', 'M271', 'M275', 'A3(M)', 'A3', 'A27', 'A31', 'A34', 'A303', 'A36']) if (!data.coverage.roads.includes(road)) throw new Error(`Missing expected Hampshire road ${road}`);
  if (!data.sources.network.dataLastEditDate || !data.sources.emergencyAreas.dataLastEditDate) throw new Error('Source publication dates missing');
}

if (process.argv.includes('--validate')) {
  validate(JSON.parse(await readFile(OUT, 'utf8')));
  console.log(`Validated ${OUT}`);
} else {
  await main();
}
