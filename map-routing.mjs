/**
 * Conservative, distance-based routing on the National Highways Network Model.
 * No public-road fallback, proximity joins, live traffic assumptions or ETA.
 *
 * Input: { links, turnRestrictions, routing: { restrictionsComplete: true } }.
 * Link: { id, road, description, from, to, directionality: 0|1|2,
 *   ownership: 'NH', srn: 'Y', state: 'O', routeEligible: true,
 *   coordinates: [[longitude, latitude], ...], lengthM?, carriageway?, direction? }.
 * Turn: { id, type: 'NT'|'MT'|'OW', links: [{id,sequence,directionality}],
 *   inclusions: [], exemptions: [] }. NT/MT are ordered directed link sequences.
 * Unsupported turn records close affected links; missing restriction coverage
 * disables all routing. OW records require handledByDirectionality: true and
 * normalized link directionality (or allowedDirectionality).
 *
 * Coordinates/fractions refer to digitized geometry; source metres never imply
 * marker-post chainage. A fraction is proportional to geometry length.
 */

const EARTH_RADIUS_M = 6371008.8;
const EPSILON = 1e-9;
const MAX_JOIN_GAP_M = 12;
const ENDPOINT_ONLY_FORMS = new Set(['L', 'EA']);
const radians = degrees => degrees * Math.PI / 180;
const upper = value => String(value ?? '').trim().toUpperCase();
const roadKey = value => upper(value).replace(/[\s()]+/g, '');

export function distanceMetres(a, b) {
  const dlat = radians(b[1] - a[1]);
  const dlon = radians(b[0] - a[0]);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(radians(a[1])) *
    Math.cos(radians(b[1])) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function geometryMetrics(coordinates) {
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distanceMetres(coordinates[i - 1], coordinates[i]));
  }
  return { cumulative, total: cumulative[cumulative.length - 1] };
}

function pointAt(link, fraction) {
  if (fraction <= 0) return [...link.coordinates[0]];
  if (fraction >= 1) return [...link.coordinates.at(-1)];
  const distance = fraction * link.metrics.total;
  for (let i = 1; i < link.coordinates.length; i += 1) {
    if (link.metrics.cumulative[i] < distance) continue;
    const sectionLength = link.metrics.cumulative[i] - link.metrics.cumulative[i - 1];
    const t = sectionLength > 0 ? (distance - link.metrics.cumulative[i - 1]) / sectionLength : 0;
    const a = link.coordinates[i - 1];
    const b = link.coordinates[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  return [...link.coordinates.at(-1)];
}

function sliceGeometry(link, from, to) {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const result = [pointAt(link, low)];
  for (let i = 1; i < link.coordinates.length - 1; i += 1) {
    const fraction = link.metrics.cumulative[i] / link.metrics.total;
    if (fraction > low + EPSILON && fraction < high - EPSILON) result.push([...link.coordinates[i]]);
  }
  result.push(pointAt(link, high));
  return from > to ? result.reverse() : result;
}

function directions(link) {
  const code = String(link.allowedDirectionality ?? link.directionality);
  return code === '0' ? [1, 2] : code === '1' ? [1] : code === '2' ? [2] : [];
}

function makeEdge(link, travelDirection) {
  const forward = travelDirection === 1;
  return {
    link, travelDirection, key: `${link.id}/${travelDirection}`,
    from: forward ? link.from : link.to, to: forward ? link.to : link.from,
    start: forward ? link.coordinates[0] : link.coordinates.at(-1),
    end: forward ? link.coordinates.at(-1) : link.coordinates[0],
  };
}

function matches(reference, edge) {
  return reference.id === edge.link.id &&
    (reference.directionality === 0 || reference.directionality === edge.travelDirection);
}

function normalizeTurns(records, blocked) {
  const turns = [];
  for (const record of records) {
    const references = Array.isArray(record.links) ? record.links : [];
    const close = () => references.forEach(ref => blocked.add(String(ref.id)));
    const hasConditions = Boolean(record.inclusions?.length || record.exemptions?.length);
    if (record.type === 'OW' && record.handledByDirectionality === true && !hasConditions) continue;
    if (!['NT', 'MT'].includes(record.type) || hasConditions || references.length < 2) {
      close();
      continue;
    }
    const ordered = [...references].sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const sequence = ordered.map(ref => ({
      id: String(ref.id ?? ''), directionality: ref.directionality == null ? 0 : Number(ref.directionality),
    }));
    const order = ordered.map(ref => Number(ref.sequence));
    if (sequence.some(ref => !ref.id || ![0, 1, 2].includes(ref.directionality)) ||
        order.some(value => !Number.isFinite(value)) || new Set(order).size !== order.length) {
      close();
      continue;
    }
    turns.push({ id: record.id, type: record.type, sequence });
  }
  return turns;
}

export function createRouter(network) {
  const blocked = new Set();
  const turns = normalizeTurns(network?.turnRestrictions ?? [], blocked);
  const links = new Map();
  const outgoing = new Map();
  const issues = [];
  const idCounts = new Map();
  for (const source of network?.links ?? []) {
    const id = String(source.id ?? '');
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const source of network?.links ?? []) {
    const id = String(source.id ?? '');
    const eligible = source.ownership === 'NH' && source.srn === 'Y' && source.state === 'O' &&
      source.routeEligible === true && !blocked.has(id);
    if (!eligible) continue;
    if (!id || !source.from || !source.to || !directions(source).length ||
        !Array.isArray(source.coordinates) || source.coordinates.length < 2 ||
        !source.coordinates.every(validCoordinate)) {
      issues.push({ linkId: id, reason: 'Invalid routing topology or geometry' });
      continue;
    }
    const coordinates = source.coordinates.map(point => point.slice(0, 2));
    const metrics = geometryMetrics(coordinates);
    if (metrics.total <= 0 || idCounts.get(id) > 1) {
      issues.push({ linkId: id, reason: 'Duplicate or zero-length road link' });
      continue;
    }
    const link = { ...source, id, from: String(source.from), to: String(source.to), coordinates, metrics,
      lengthM: Number.isFinite(source.lengthM) && source.lengthM > 0 ? source.lengthM : metrics.total };
    links.set(id, link);
    for (const direction of directions(link)) {
      const edge = makeEdge(link, direction);
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge);
    }
  }
  const starters = new Map();
  turns.forEach((turn, index) => {
    const id = turn.sequence[0].id;
    if (!starters.has(id)) starters.set(id, []);
    starters.get(id).push(index);
  });
  const unmappedRestriction = (network?.turnRestrictions ?? []).some(record =>
    !Array.isArray(record.links) || !record.links.length || record.links.some(ref => !ref.id));
  return { network, links, outgoing, turns, starters, issues,
    restrictionsComplete: network?.routing?.restrictionsComplete === true && !unmappedRestriction };
}

/** Returns every nearby eligible carriageway separately; the caller chooses. */
export function findSnapCandidates(routerOrNetwork, coordinate, options = {}) {
  if (!validCoordinate(coordinate)) return [];
  const router = routerOrNetwork?.links instanceof Map ? routerOrNetwork : createRouter(routerOrNetwork);
  const maxDistanceM = options.maxDistanceM ?? 150;
  const limit = options.limit ?? 6;
  const wantedRoad = options.road ? roadKey(options.road) : null;
  const wantedCarriageway = options.carriageway ? upper(options.carriageway) : null;
  const wantedDirection = options.direction ? upper(options.direction) : null;
  const scaleX = Math.cos(radians(coordinate[1]));
  const candidates = [];
  for (const link of router.links.values()) {
    if (wantedRoad && roadKey(link.road) !== wantedRoad) continue;
    if (wantedCarriageway && upper(link.carriageway) !== wantedCarriageway) continue;
    if (wantedDirection && upper(link.direction) !== wantedDirection) continue;
    let best = null;
    for (let i = 1; i < link.coordinates.length; i += 1) {
      const a = link.coordinates[i - 1];
      const b = link.coordinates[i];
      const dx = (b[0] - a[0]) * scaleX;
      const dy = b[1] - a[1];
      const px = (coordinate[0] - a[0]) * scaleX;
      const py = coordinate[1] - a[1];
      const denominator = dx * dx + dy * dy;
      const t = denominator ? Math.max(0, Math.min(1, (px * dx + py * dy) / denominator)) : 0;
      const projected = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const distanceM = distanceMetres(coordinate, projected);
      if (best && distanceM >= best.distanceM) continue;
      const sectionM = link.metrics.cumulative[i] - link.metrics.cumulative[i - 1];
      best = { linkId: link.id, fraction: (link.metrics.cumulative[i - 1] + sectionM * t) / link.metrics.total,
        distanceM, coordinate: projected, road: link.road, carriageway: link.carriageway,
        direction: link.direction, description: link.description, form: link.form,
        travelDirections: directions(link) };
    }
    if (best?.distanceM <= maxDistanceM) candidates.push(best);
  }
  return candidates.sort((a, b) => a.distanceM - b.distanceM || a.linkId.localeCompare(b.linkId)).slice(0, limit);
}

function advanceRestrictions(router, active, edge) {
  const mandatory = active.filter(([index]) => router.turns[index].type === 'MT');
  // Alternatives with the same approach are allowed. Different mandatory
  // approaches must each be satisfied (conservative when rules overlap).
  const groups = new Map();
  for (const [index, count] of mandatory) {
    const turn = router.turns[index];
    const approach = JSON.stringify(turn.sequence.slice(0, count));
    if (!groups.has(approach)) groups.set(approach, []);
    groups.get(approach).push(turn.sequence[count]);
  }
  for (const alternatives of groups.values()) if (!alternatives.some(ref => matches(ref, edge))) return null;
  const next = [];
  for (const [index, count] of active) {
    const turn = router.turns[index];
    if (!matches(turn.sequence[count], edge)) continue;
    if (count + 1 === turn.sequence.length) {
      if (turn.type === 'NT') return null;
    } else next.push([index, count + 1]);
  }
  for (const index of router.starters.get(edge.link.id) ?? []) {
    if (matches(router.turns[index].sequence[0], edge)) next.push([index, 1]);
  }
  return next.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function canTransition(previous, next) {
  if (!previous) return true;
  // Reversing on the same link, or immediately returning to the previous node,
  // is never silently treated as a legal U-turn.
  if (previous.link.id === next.link.id || next.to === previous.from) return false;
  return previous.to === next.from && distanceMetres(previous.end, next.start) <= MAX_JOIN_GAP_M;
}

function segment(edge, start, end) {
  return { linkId: edge.link.id, road: edge.link.road, description: edge.link.description,
    carriageway: edge.link.carriageway, direction: edge.link.direction, form: edge.link.form,
    travelDirection: edge.travelDirection, fractionStart: start, fractionEnd: end,
    distanceM: Math.abs(end - start) * edge.link.lengthM, coordinates: sliceGeometry(edge.link, start, end) };
}

class MinHeap {
  items = [];
  push(value) {
    let index = this.items.length;
    this.items.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].cost <= value.cost) break;
      this.items[index] = this.items[parent]; index = parent;
    }
    this.items[index] = value;
  }
  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].cost < this.items[child].cost) child += 1;
        if (last.cost <= this.items[child].cost) break;
        this.items[index] = this.items[child]; index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function failure(code, message) { return { ok: false, code, message }; }

function routeResult(segments, startCoordinate, visited) {
  const nonzero = segments.filter(item => item.distanceM > EPSILON);
  const coordinates = [];
  const steps = [];
  let distanceM = 0;
  for (const item of nonzero) {
    distanceM += item.distanceM;
    for (const coordinate of item.coordinates) {
      if (!coordinates.length || distanceMetres(coordinates.at(-1), coordinate) > 0.01) coordinates.push(coordinate);
    }
    const previous = steps.at(-1);
    if (previous && previous.road === item.road && previous.carriageway === item.carriageway && previous.form === item.form) {
      previous.distanceM += item.distanceM;
      previous.linkIds.push(item.linkId);
    } else steps.push({ road: item.road || 'NH connecting road', description: item.description || '',
      carriageway: item.carriageway, direction: item.direction, form: item.form,
      distanceM: item.distanceM, linkIds: [item.linkId] });
  }
  if (!coordinates.length) coordinates.push(startCoordinate);
  return { ok: true, distanceM, miles: distanceM / 1609.344, coordinates, segments: nonzero, steps,
    visitedStates: visited, restrictionsChecked: true };
}

/** Shortest legal distance between two explicit snaps on the directed network. */
export function routeBetween(routerOrNetwork, start, destination, options = {}) {
  const router = routerOrNetwork?.links instanceof Map ? routerOrNetwork : createRouter(routerOrNetwork);
  if (!router.restrictionsComplete) return failure('UNKNOWN_RESTRICTIONS',
    'Network restriction data is incomplete. Routing is unavailable until a complete refresh succeeds.');
  const startLink = router.links.get(start?.linkId);
  const endLink = router.links.get(destination?.linkId);
  if (!startLink || !endLink) return failure('INELIGIBLE_ENDPOINT',
    'Choose both points on an open, unrestricted National Highways road within the loaded area.');
  const validFraction = value => Number.isFinite(value) && value >= 0 && value <= 1;
  if (!validFraction(start.fraction) || !validFraction(destination.fraction)) return failure('INVALID_ENDPOINT',
    'The selected road position is invalid. Select the point again.');
  const startCoordinate = pointAt(startLink, start.fraction);
  if (startLink.id === endLink.id && Math.abs(start.fraction - destination.fraction) <= EPSILON) {
    return routeResult([], startCoordinate, 0);
  }
  let best = null;
  const finish = (cost, state, lastSegment) => {
    if (!best || cost < best.cost) best = { cost, state, lastSegment };
  };
  if (startLink.id === endLink.id) {
    for (const direction of directions(startLink)) {
      if (direction === 1 && destination.fraction < start.fraction ||
          direction === 2 && destination.fraction > start.fraction) continue;
      const item = segment(makeEdge(startLink, direction), start.fraction, destination.fraction);
      finish(item.distanceM, null, item);
    }
  }
  const heap = new MinHeap();
  const distances = new Map();
  const enqueue = (node, previous, active, cost, parent, via) => {
    if (best && cost >= best.cost) return;
    const key = `${node}|${previous?.key ?? ''}|${JSON.stringify(active)}`;
    if (distances.has(key) && distances.get(key) <= cost) return;
    const state = { key, node, previous, active, cost, parent, via };
    distances.set(key, cost); heap.push(state);
  };
  for (const direction of directions(startLink)) {
    const edge = makeEdge(startLink, direction);
    const to = direction === 1 ? 1 : 0;
    const item = segment(edge, start.fraction, to);
    const active = advanceRestrictions(router, [], edge);
    if (active) enqueue(edge.to, edge, active, item.distanceM, null, item);
  }
  // Even a zero-length first segment preserves the selected carriageway and
  // its approach restrictions. A free node seed would silently erase no-turn,
  // mandatory-turn and U-turn constraints at exact endpoint coordinates.
  let visited = 0;
  while (heap.items.length) {
    const current = heap.pop();
    if (distances.get(current.key) !== current.cost) continue;
    if (best && current.cost >= best.cost) break;
    visited += 1;
    if (visited > (options.maxVisitedStates ?? 250000)) return failure('SEARCH_LIMIT',
      'This route is too complex for the loaded network. Choose a nearer destination.');
    // Destination endpoints also pass through the ordinary transition checks.
    // Sharing a node identifier alone is not permission to cross carriageways
    // or to stop on a different road with inconsistent endpoint geometry.
    for (const edge of router.outgoing.get(current.node) ?? []) {
      // A lay-by or emergency area may be an explicit destination, but must
      // never become a shortcut in a longer route. Departures from a selected
      // area are already represented by the start-link seeds above.
      if (ENDPOINT_ONLY_FORMS.has(edge.link.form) && edge.link.id !== endLink.id) continue;
      if (!canTransition(current.previous, edge)) continue;
      const active = advanceRestrictions(router, current.active, edge);
      if (!active) continue;
      if (edge.link.id === endLink.id) {
        const from = edge.travelDirection === 1 ? 0 : 1;
        const item = segment(edge, from, destination.fraction);
        finish(current.cost + item.distanceM, current, item);
      }
      if (ENDPOINT_ONLY_FORMS.has(edge.link.form)) continue;
      const item = segment(edge, edge.travelDirection === 1 ? 0 : 1, edge.travelDirection === 1 ? 1 : 0);
      enqueue(edge.to, edge, active, current.cost + item.distanceM, current, item);
    }
  }
  if (!best) return failure('NO_NETWORK_ROUTE',
    'No permitted National Highways-only route connects these carriageways in the loaded area. A local-road connection, restricted turn, or road outside coverage may be required.');
  const segments = [];
  for (let state = best.state; state; state = state.parent) if (state.via) segments.push(state.via);
  segments.reverse();
  if (best.lastSegment) segments.push(best.lastSegment);
  return routeResult(segments, startCoordinate, visited);
}
