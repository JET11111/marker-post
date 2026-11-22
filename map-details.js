/** Read-only map inspection. Distances are straight-line to recorded points.
 * A spatial association is never evidence of access, direction of travel,
 * current availability, or a field-verified layout. No routing is used here.
 */
const RADIUS_M = 6371008.8;
const radians = value => value * Math.PI / 180;
const upper = value => String(value ?? '').trim().toUpperCase();
const roadKey = value => upper(value).replace(/[^A-Z0-9]/g, '');
const coordinateValid = value => Array.isArray(value) && value.length >= 2 &&
  Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const parentForms = new Set(['DC', 'SC']);
const bayForms = new Set(['L', 'EA']);
const ambiguousCode = value => !upper(value) || upper(value) === 'X';
const isInterchangePost = feature => feature.kind === 'post' && feature.post?.roadAliases?.length > 0 &&
  !/^(?:M\d+|A\d+M?)$/.test(roadKey(feature.road));
const geometryCache = new WeakMap();
const contextCache = new WeakMap();

export function straightLineDistance(a, b) {
  if (!coordinateValid(a) || !coordinateValid(b)) return Infinity;
  const h = Math.sin(radians(b[1] - a[1]) / 2) ** 2 + Math.cos(radians(a[1])) *
    Math.cos(radians(b[1])) * Math.sin(radians(b[0] - a[0]) / 2) ** 2;
  return 2 * RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

function metrics(link) {
  if (!link || typeof link !== 'object') return null;
  if (geometryCache.has(link)) return geometryCache.get(link);
  const coords = link.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || !coords.every(coordinateValid)) return null;
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + straightLineDistance(coords[i - 1], coords[i]));
  const result = { cumulative, lengthM: cumulative.at(-1) };
  geometryCache.set(link, result);
  return result.lengthM > 0 ? result : null;
}

/** Projection uses geometry length, not the source's lane or post chainage. */
export function projectOnSection(link, point) {
  if (!coordinateValid(point)) return null;
  const geometry = metrics(link);
  if (!geometry?.lengthM) return null;
  let best = null;
  const scale = Math.cos(radians(point[1]));
  for (let i = 1; i < link.coordinates.length; i++) {
    const a = link.coordinates[i - 1], b = link.coordinates[i];
    const x = (b[0] - a[0]) * scale, y = b[1] - a[1], length2 = x * x + y * y;
    if (!length2) continue;
    const t = Math.max(0, Math.min(1, (((point[0] - a[0]) * scale) * x + (point[1] - a[1]) * y) / length2));
    const coordinate = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const distanceM = straightLineDistance(point, coordinate);
    if (!best || distanceM < best.distanceM) best = { link, coordinate, distanceM,
      fraction: (geometry.cumulative[i - 1] + t * (geometry.cumulative[i] - geometry.cumulative[i - 1])) / geometry.lengthM };
  }
  return best;
}

function roadCandidates(links, point, options = {}) {
  const roads = options.roads?.map(roadKey).filter(Boolean) || (options.road ? [roadKey(options.road)] : []);
  const carriageway = upper(options.carriageway);
  const candidates = [];
  for (const link of links) {
    if (bayForms.has(link.form) || (options.parentOnly && !parentForms.has(link.form))) continue;
    if (roads.length && !roads.includes(roadKey(link.road))) continue;
    if (carriageway && upper(link.carriageway) !== carriageway) continue;
    // Access/turn restrictions affect travel, not the visibility of layout records.
    const candidate = projectOnSection(link, point);
    if (candidate && candidate.distanceM <= (options.maxDistanceM ?? 70)) candidates.push(candidate);
  }
  return candidates.sort((a, b) => a.distanceM - b.distanceM);
}

function ambiguousCandidates(candidates) {
  const first = candidates[0];
  if (!first) return false;
  return candidates.slice(1).some(candidate => candidate.distanceM - first.distanceM < 6 &&
    (roadKey(candidate.link.road) !== roadKey(first.link.road) ||
      upper(candidate.link.carriageway) !== upper(first.link.carriageway) ||
      candidate.link.form !== first.link.form));
}

/** Does not choose between nearly equidistant carriageways or crossing roads. */
export function findNearestRoadSection(links, point, options = {}) {
  const candidates = roadCandidates(links || [], point, options);
  return ambiguousCandidates(candidates) ? null : candidates[0] || null;
}

const unknownLayout = () => ({ running: 'Unknown', shoulder: 'Unknown', runningCount: null,
  shoulderRecorded: null, totalAcrossDirections: false });

export function layoutAtSection(link, coordinate) {
  const projection = projectOnSection(link, coordinate);
  if (!projection || projection.distanceM > 100 || !link.lanes?.length) return unknownLayout();
  const records = link.lanes.filter(lane => Number.isFinite(lane.startM) && Number.isFinite(lane.endM) &&
    lane.startM >= 0 && lane.endM >= 0);
  // Lane measures and geometry have different surveyed lengths. A proportion
  // maps between them; the aggregate reportedLaneCount includes shoulders.
  const lengthM = Math.max(0, ...records.flatMap(lane => [lane.startM, lane.endM]));
  if (!lengthM) return unknownLayout();
  const atM = projection.fraction * lengthM;
  const active = records.filter(lane => Math.min(lane.startM, lane.endM) <= atM + 1e-7 &&
    Math.max(lane.startM, lane.endM) >= atM - 1e-7);
  const running = new Set(active.filter(lane => /^(?:C|-)[LR]\d+$/.test(lane.code)).map(lane => lane.code));
  const shoulder = active.some(lane => lane.code === 'LH' || lane.code === 'RH');
  const totalAcrossDirections = String(link.directionality) === '0';
  return { running: running.size ? `${running.size} recorded${totalAcrossDirections ? ' total' : ''}` : 'Unknown',
    shoulder: shoulder ? 'Recorded' : running.size ? 'Not recorded' : 'Unknown',
    runningCount: running.size || null, shoulderRecorded: shoulder ? true : null, totalAcrossDirections };
}

function contextFor(links) {
  if (contextCache.has(links)) return contextCache.get(links);
  const byId = new Map(), byNode = new Map();
  for (const link of links) {
    byId.set(link.id, link);
    for (const node of [link.from, link.to].filter(Boolean)) {
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node).push(link);
    }
  }
  const context = { links, byId, byNode, attachments: new WeakMap() };
  contextCache.set(links, context);
  return context;
}

function featureCoordinate(feature) {
  return feature?.coordinate || (feature?.post ? [feature.post.lng, feature.post.lat] : null);
}

function attachmentFor(feature, context) {
  if (context.attachments.has(feature)) return context.attachments.get(feature);
  const linked = feature.link || context.byId.get(feature.linkId);
  let attachment = null;
  // Conflicting source identities cannot be repaired by proximity.
  if (linked && ((feature.road && roadKey(feature.road) !== roadKey(linked.road)) ||
      (!ambiguousCode(feature.carriageway) && !ambiguousCode(linked.carriageway) &&
        upper(feature.carriageway) !== upper(linked.carriageway)))) {
    context.attachments.set(feature, null);
    return null;
  }
  if (linked && bayForms.has(linked.form)) {
    const joined = [linked.from, linked.to].filter(Boolean).flatMap(node => context.byNode.get(node) || [])
      .filter(link => parentForms.has(link.form) && roadKey(link.road) === roadKey(linked.road));
    const identities = new Set(joined.map(link => `${roadKey(link.road)}:${upper(link.carriageway)}`));
    if (identities.size === 1) {
      if (!ambiguousCode(feature.carriageway) && upper(feature.carriageway) !== upper(joined[0].carriageway)) {
        context.attachments.set(feature, null);
        return null;
      }
      attachment = { road: joined[0].road, carriageway: joined[0].carriageway,
        direction: joined[0].direction, association: 'same-carriageway', link: joined[0] };
    }
  }
  if (!attachment && (feature.road || linked?.road) && !ambiguousCode(feature.carriageway || linked?.carriageway)) {
    attachment = { road: feature.road || linked.road, carriageway: feature.carriageway || linked.carriageway,
      direction: feature.direction || linked?.direction, association: 'same-carriageway', link: linked };
  }
  if (!attachment) {
    // ERA records have no road/carriageway attributes. The nearest parent road
    // is a provisional geometric association, never an asserted source fact.
    const candidates = roadCandidates(context.links, featureCoordinate(feature), {
      road: feature.road || linked?.road, maxDistanceM: 65, parentOnly: true });
    if (candidates[0] && !ambiguousCandidates(candidates)) {
      const link = candidates[0].link;
      const sourceDirection = upper(feature.direction || linked?.direction);
      if (!sourceDirection || !upper(link.direction) || sourceDirection === upper(link.direction))
        attachment = { road: link.road, carriageway: link.carriageway, direction: link.direction,
          association: 'nearby-unverified', link };
    }
  }
  context.attachments.set(feature, attachment);
  return attachment;
}

function sectionFor(selection, context) {
  if (selection.link && !bayForms.has(selection.link.form)) {
    // Rehydrate the selected record from this snapshot; a stale saved object
    // cannot supply a layout that no longer exists in the loaded network.
    const section = projectOnSection(context.byId.get(selection.link.id), selection.coordinate);
    return { section: section?.distanceM <= 100 ? { ...section, association: 'selected-section' } : null, sectionAmbiguous: false };
  }
  const interchange = isInterchangePost(selection);
  const areaAttachment = ['layby', 'era'].includes(selection.kind) ? attachmentFor(selection, context) : null;
  const options = { road: areaAttachment?.road || selection.road,
    carriageway: areaAttachment?.carriageway || (!ambiguousCode(selection.carriageway) ? selection.carriageway : undefined),
    maxDistanceM: selection.kind === 'post' ? 100 : 70 };
  let candidates = roadCandidates(context.links, selection.coordinate, options);
  let association = selection.kind === 'post' ? 'matched-post' : 'nearest-section';
  if (!candidates.length && interchange) {
    candidates = roadCandidates(context.links, selection.coordinate, { roads: selection.post.roadAliases, maxDistanceM: 35 });
    association = 'interchange-unverified';
  }
  const sectionAmbiguous = ambiguousCandidates(candidates);
  return { section: !sectionAmbiguous && candidates[0] ? { ...candidates[0], association } : null, sectionAmbiguous };
}

function nearbyResult(feature, coordinate, association, sources) {
  const sourceKey = feature.sourceKey || feature.source || (feature.kind === 'post' ? 'markerPosts' : 'network');
  return { feature, distanceM: straightLineDistance(coordinate, featureCoordinate(feature)), association,
    sourceKey, sourceEditedAt: feature.sourceEditedAt || sources[sourceKey]?.dataLastEditDate || null,
    verificationStatus: feature.post?.verificationStatus || (feature.layoutVerifiedAt ? 'dated-field-record' : 'unverified'),
    layoutVerifiedAt: feature.layoutVerifiedAt || null };
}

/** Accepts the feature objects already used by map.mjs. All result distances
 * refer to selection.coordinate, not a snapped road coordinate. Nearby items
 * never mean ahead, reachable, open, or vacant. No record within the limit is
 * represented by null, not evidence that no bay/post exists.
 */
export function getLocationDetails({ selection, links = [], postFeatures = [], areas = [], sources = {}, maxNearbyM = 30000 } = {}) {
  if (!selection || !coordinateValid(selection.coordinate)) return { section: null, sectionAmbiguous: false,
    layout: unknownLayout(), nearestPost: null, nearestLayby: null, nearestEra: null };
  const context = contextFor(links);
  const { section, sectionAmbiguous } = sectionFor(selection, context);
  const road = roadKey(section?.link.road), carriageway = upper(section?.link.carriageway);
  let nearestPost = selection.kind === 'post' ? nearbyResult(selection, selection.coordinate, 'selected-record', sources) : null;
  if (!nearestPost && section) {
    const possible = [];
    for (const feature of postFeatures) {
      const distanceM = straightLineDistance(selection.coordinate, featureCoordinate(feature));
      if (distanceM > Math.min(maxNearbyM, 2000)) continue;
      if (roadKey(feature.road) === road && upper(feature.carriageway) === carriageway) {
        possible.push(nearbyResult(feature, selection.coordinate, 'same-carriageway', sources));
      } else if (isInterchangePost(feature) && feature.post.roadAliases.some(value => roadKey(value) === road)) {
        // Source interchange lettering differs from Network Model lettering.
        // Only associate with the actual nearest link, and say it is unverified.
        const match = findNearestRoadSection(links, featureCoordinate(feature), { roads: feature.post.roadAliases, maxDistanceM: 35 });
        if (match?.link.id === section.link.id) possible.push(nearbyResult(feature, selection.coordinate, 'nearby-unverified', sources));
      }
    }
    nearestPost = possible.sort((a, b) => a.distanceM - b.distanceM)[0] || null;
  }
  const nearestArea = kind => {
    if (selection.kind === kind) {
      const attachment = attachmentFor(selection, context);
      return { ...nearbyResult(selection, selection.coordinate, 'selected-record', sources),
        matchedRoad: attachment?.road || null, matchedCarriageway: attachment?.carriageway || null };
    }
    if (!section) return null;
    const possible = [];
    for (const feature of areas) {
      if (feature.kind !== kind || straightLineDistance(selection.coordinate, featureCoordinate(feature)) > maxNearbyM) continue;
      const attachment = attachmentFor(feature, context);
      if (!attachment || roadKey(attachment.road) !== road || upper(attachment.carriageway) !== carriageway) continue;
      possible.push({ ...nearbyResult(feature, selection.coordinate,
        section.association === 'interchange-unverified' ? 'nearby-unverified' : attachment.association, sources),
        matchedRoad: attachment.road, matchedCarriageway: attachment.carriageway });
    }
    return possible.sort((a, b) => a.distanceM - b.distanceM)[0] || null;
  };
  // Recovered interchange source labels do not identify a verified Network
  // Model carriageway. Keep the suggested section, but don't transfer its
  // lane/shoulder records to that marker as an asserted layout.
  return { section, sectionAmbiguous, layout: section && section.association !== 'interchange-unverified' ?
    layoutAtSection(section.link, selection.coordinate) : unknownLayout(),
    nearestPost, nearestLayby: nearestArea('layby'), nearestEra: nearestArea('era') };
}
