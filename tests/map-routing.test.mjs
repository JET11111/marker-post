import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, findSnapCandidates, routeBetween, distanceMetres } from '../map-routing.mjs';

const coordinates = {
  A: [-1.400, 51.000], B: [-1.399, 51.000], C: [-1.398, 51.000],
  D: [-1.399, 51.001], E: [-1.400, 51.001], F: [-1.398, 51.001],
  X: [-1.400, 51.0001], Y: [-1.399, 51.0001], Z: [-1.398, 51.0001],
};
function link(id, from, to, extra = {}) {
  return { id, from, to, road: 'M3', carriageway: 'A', direction: 'N', form: 'DC',
    ownership: 'NH', srn: 'Y', state: 'O', routeEligible: true, directionality: 1,
    lengthM: 100, coordinates: [coordinates[from], coordinates[to]], ...extra };
}
function router(links, turnRestrictions = [], extra = {}) {
  return createRouter({ links, turnRestrictions, routing: { restrictionsComplete: true }, ...extra });
}
const snap = (linkId, fraction) => ({ linkId, fraction });
const ids = route => route.segments.map(segment => segment.linkId);
const turn = (type, refs) => ({ id: `${type}-${refs.join('-')}`, type,
  links: refs.map((id, sequence) => ({ id, sequence, directionality: 1 })),
  inclusions: [], exemptions: [] });

test('forward travel charges only the portion between positions on the same link', () => {
  const route = routeBetween(router([link('a', 'A', 'B')]), snap('a', 0.2), snap('a', 0.8));
  assert.equal(route.ok, true);
  assert.ok(Math.abs(route.distanceM - 60) < 0.00001);
  assert.deepEqual(route.coordinates[0], [-1.3998, 51]);
  assert.deepEqual(route.coordinates.at(-1), [-1.3992, 51]);
});

test('one-way link cannot route backwards, even for a short distance', () => {
  const route = routeBetween(router([link('a', 'A', 'B')]), snap('a', 0.8), snap('a', 0.7));
  assert.equal(route.ok, false);
  assert.equal(route.code, 'NO_NETWORK_ROUTE');
});

test('reverse-digitized roads use correct travel direction and geometry', () => {
  const road = router([link('a', 'A', 'B', { directionality: '2' })]);
  assert.equal(routeBetween(road, snap('a', 0.2), snap('a', 0.8)).ok, false);
  const route = routeBetween(road, snap('a', 0.8), snap('a', 0.2));
  assert.equal(route.ok, true);
  assert.ok(Math.abs(route.distanceM - 60) < 0.00001);
  assert.ok(route.coordinates[0][0] > route.coordinates.at(-1)[0]);
});

test('bidirectional single carriageway permits either direction from a position', () => {
  const road = router([link('a', 'A', 'B', { directionality: 0 })]);
  assert.equal(routeBetween(road, snap('a', 0.2), snap('a', 0.8)).ok, true);
  assert.equal(routeBetween(road, snap('a', 0.8), snap('a', 0.2)).ok, true);
});

test('nearby opposing carriageways stay disconnected without genuine topology', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'Y', 'X', { carriageway: 'B' })]);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('b', 0.5)).code, 'NO_NETWORK_ROUTE');
});

test('partial first and last links are counted accurately over a connected route', () => {
  const route = routeBetween(router([link('a', 'A', 'B'), link('b', 'B', 'C')]), snap('a', 0.75), snap('b', 0.25));
  assert.equal(route.ok, true);
  assert.equal(route.distanceM, 50);
  assert.deepEqual(ids(route), ['a', 'b']);
});

test('destination behind on a one-way link requires a genuine junction loop', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'D'), link('c', 'D', 'E'), link('d', 'E', 'A')]);
  const route = routeBetween(road, snap('a', 0.8), snap('a', 0.2));
  assert.equal(route.ok, true);
  assert.equal(route.distanceM, 340);
  assert.deepEqual(ids(route), ['a', 'b', 'c', 'd', 'a']);
});

test('immediate U-turn through a reverse edge is rejected', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'A')]);
  assert.equal(routeBetween(road, snap('a', 0.8), snap('a', 0.2)).ok, false);
});

test('chooses the shortest permitted route rather than the fewest links', () => {
  const road = router([
    link('start', 'E', 'A'), link('long', 'A', 'C', { lengthM: 1000 }),
    link('short1', 'A', 'B', { lengthM: 100 }), link('short2', 'B', 'C', { lengthM: 100 }),
    link('end', 'C', 'F'),
  ]);
  const route = routeBetween(road, snap('start', 0.5), snap('end', 0.5));
  assert.equal(route.ok, true);
  assert.equal(route.distanceM, 300);
  assert.deepEqual(ids(route), ['start', 'short1', 'short2', 'end']);
});

test('lay-bys and emergency areas cannot be used as through-route shortcuts', () => {
  for (const form of ['L', 'EA']) {
    const road = router([
      link('start', 'E', 'A'), link('main', 'A', 'C', { lengthM: 500 }),
      link('area', 'A', 'C', { form, lengthM: 100 }), link('end', 'C', 'F'),
    ]);
    const route = routeBetween(road, snap('start', 0.5), snap('end', 0.5));
    assert.equal(route.ok, true);
    assert.deepEqual(ids(route), ['start', 'main', 'end']);
    assert.equal(route.distanceM, 600);
    const arrival = routeBetween(road, snap('start', 0.5), snap('area', 0.5));
    assert.equal(arrival.ok, true);
    assert.deepEqual(ids(arrival), ['start', 'area']);
    assert.equal(arrival.distanceM, 100);
    const departure = routeBetween(road, snap('area', 0.5), snap('end', 0.5));
    assert.equal(departure.ok, true);
    assert.deepEqual(ids(departure), ['area', 'end']);
    assert.equal(departure.distanceM, 100);
  }
});

test('prohibited turn forces another route', () => {
  const road = router([
    link('start', 'A', 'B'), link('direct', 'B', 'C'), link('other1', 'B', 'D'),
    link('other2', 'D', 'F'), link('other3', 'F', 'C'), link('end', 'C', 'Z'),
  ], [turn('NT', ['start', 'direct'])]);
  const route = routeBetween(road, snap('start', 0.5), snap('end', 0.5));
  assert.equal(route.ok, true);
  assert.deepEqual(ids(route), ['start', 'other1', 'other2', 'other3', 'end']);
});

test('only-turn prevents taking a different departure', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'C'), link('c', 'B', 'D')], [turn('MT', ['a', 'b'])]);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('b', 0.5)).ok, true);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('c', 0.5)).ok, false);
});

test('exact forward endpoint preserves no-turn and mandatory-turn approach state', () => {
  const links = [link('a', 'A', 'B'), link('b', 'B', 'C'), link('c', 'B', 'D')];
  const prohibited = router(links, [turn('NT', ['a', 'b'])]);
  assert.equal(routeBetween(prohibited, snap('a', 0.999999), snap('b', 0.5)).ok, false);
  assert.equal(routeBetween(prohibited, snap('a', 1), snap('b', 0.5)).ok, false);
  assert.equal(routeBetween(prohibited, snap('a', 1), snap('b', 0)).ok, false);
  const mandatory = router(links, [turn('MT', ['a', 'b'])]);
  assert.equal(routeBetween(mandatory, snap('a', 1), snap('b', 0.5)).ok, true);
  assert.equal(routeBetween(mandatory, snap('a', 1), snap('c', 0.5)).ok, false);
});

test('exact reverse endpoint preserves no-turn and mandatory-turn approach state', () => {
  const links = [link('a', 'B', 'A', { directionality: 2 }), link('b', 'B', 'C'), link('c', 'B', 'D')];
  const restriction = type => ({ ...turn(type, ['a', 'b']), links: [
    { id: 'a', sequence: 0, directionality: 2 }, { id: 'b', sequence: 1, directionality: 1 },
  ] });
  const prohibited = router(links, [restriction('NT')]);
  assert.equal(routeBetween(prohibited, snap('a', 0.000001), snap('b', 0.5)).ok, false);
  assert.equal(routeBetween(prohibited, snap('a', 0), snap('b', 0.5)).ok, false);
  const mandatory = router(links, [restriction('MT')]);
  assert.equal(routeBetween(mandatory, snap('a', 0), snap('b', 0.5)).ok, true);
  assert.equal(routeBetween(mandatory, snap('a', 0), snap('c', 0.5)).ok, false);
});

test('exact start endpoint cannot discard approach to make an immediate U-turn', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'A')]);
  assert.equal(routeBetween(road, snap('a', 1), snap('b', 0.5)).ok, false);
});

test('multi-link no-turn sequence is retained across intermediate links', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'C'), link('c', 'C', 'F')], [turn('NT', ['a', 'b', 'c'])]);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('c', 0.5)).ok, false);
  assert.equal(routeBetween(road, snap('b', 0.5), snap('c', 0.5)).ok, true);
});

test('different approach histories at the same link remain separate routing states', () => {
  const road = router([
    link('start', 'A', 'B'), link('short', 'B', 'D'), link('detour1', 'B', 'E'),
    link('detour2', 'E', 'D'), link('merge', 'D', 'F'), link('end', 'F', 'C'),
  ], [turn('NT', ['short', 'merge', 'end'])]);
  const route = routeBetween(road, snap('start', 0.5), snap('end', 0.5));
  assert.equal(route.ok, true);
  assert.deepEqual(ids(route), ['start', 'detour1', 'detour2', 'merge', 'end']);
});

test('duplicate road IDs and unmapped restrictions fail closed', () => {
  assert.equal(router([link('a', 'A', 'B'), link('a', 'B', 'C')]).links.size, 0);
  const road = router([link('a', 'A', 'B')], [{ id: 'missing-link', type: 'NT', links: [] }]);
  assert.equal(routeBetween(road, snap('a', 0.1), snap('a', 0.9)).code, 'UNKNOWN_RESTRICTIONS');
});

test('conditional or unsupported restrictions close all affected links', () => {
  const condition = { ...turn('NT', ['a', 'b']), inclusions: [{ type: 'vehicle', code: 'HGV' }] };
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'C')], [condition]);
  assert.equal(road.links.size, 0);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('b', 0.5)).code, 'INELIGIBLE_ENDPOINT');
});

test('restricted, closed, local authority, non-SRN and unclassified links are excluded', () => {
  for (const extra of [{ routeEligible: false }, { state: 'C' }, { ownership: 'LA' }, { srn: 'N' }, { directionality: null }]) {
    assert.equal(router([link('a', 'A', 'B', extra)]).links.size, 0);
  }
});

test('unknown restriction coverage prevents every route including same-link travel', () => {
  const road = router([link('a', 'A', 'B')], [], { routing: { restrictionsComplete: false } });
  assert.equal(routeBetween(road, snap('a', 0.1), snap('a', 0.9)).code, 'UNKNOWN_RESTRICTIONS');
});

test('snap candidates preserve opposing carriageways and accept marker road/carriageway filters', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'Y', 'X', { carriageway: 'B' })]);
  const point = [-1.3995, 51.00005];
  assert.equal(findSnapCandidates(road, point).length, 2);
  const filtered = findSnapCandidates(road, point, { road: 'm 3', carriageway: 'b' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].linkId, 'b');
  assert.ok(Math.abs(filtered[0].fraction - 0.5) < 0.00001);
  assert.equal(findSnapCandidates(road, point, { carriageway: 'J' }).length, 0);
});

test('snap distance cap prevents inventing long access connectors', () => {
  assert.equal(findSnapCandidates(router([link('a', 'A', 'B')]), [-1.4, 51.1], { maxDistanceM: 150 }).length, 0);
});

test('existing A3M marker records match the official A3(M) road name', () => {
  const road = router([link('a', 'A', 'B', { road: 'A3(M)' })]);
  assert.equal(findSnapCandidates(road, coordinates.A, { road: 'A3M' }).length, 1);
  assert.equal(findSnapCandidates(road, coordinates.A, { road: 'A3' }).length, 0);
});

test('node IDs alone do not create jumps across inconsistent geometry', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'C', { coordinates: [coordinates.E, coordinates.C] })]);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('b', 0.5)).ok, false);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('b', 0)).ok, false);
});

test('curved geometry snaps and slices without cutting corners', () => {
  const road = router([link('a', 'A', 'C', { coordinates: [coordinates.A, coordinates.D, coordinates.C], lengthM: 200 })]);
  const midpoint = findSnapCandidates(road, coordinates.D)[0];
  assert.ok(Math.abs(midpoint.fraction - 0.5) < 0.00001);
  const route = routeBetween(road, snap('a', 0.1), snap('a', 0.9));
  assert.equal(route.coordinates.length, 3);
  assert.deepEqual(route.coordinates[1], coordinates.D);
});

test('one-way source restrictions can constrain an otherwise bidirectional link', () => {
  const record = { id: 'ow', type: 'OW', handledByDirectionality: true,
    links: [{ id: 'a', sequence: 0, directionality: 1 }], inclusions: [], exemptions: [] };
  const road = router([link('a', 'A', 'B', { directionality: 0, allowedDirectionality: 1 })], [record]);
  assert.equal(routeBetween(road, snap('a', 0.2), snap('a', 0.8)).ok, true);
  assert.equal(routeBetween(road, snap('a', 0.8), snap('a', 0.2)).ok, false);
});

test('route can begin or end exactly at a topology node', () => {
  const road = router([link('a', 'A', 'B'), link('b', 'B', 'C')]);
  const route = routeBetween(road, snap('a', 1), snap('b', 0.5));
  assert.equal(route.ok, true);
  assert.equal(route.distanceM, 50);
  assert.equal(routeBetween(road, snap('a', 0.5), snap('b', 0)).distanceM, 50);
});

test('invalid endpoints return an explicit error and no straight-line fallback', () => {
  const road = router([link('a', 'A', 'B')]);
  assert.equal(routeBetween(road, snap('a', -0.1), snap('a', 0.5)).code, 'INVALID_ENDPOINT');
  assert.equal(routeBetween(road, snap('missing', 0.5), snap('a', 0.5)).code, 'INELIGIBLE_ENDPOINT');
  assert.equal(routeBetween(road, snap('a', 0.5), snap('a', 0.5)).distanceM, 0);
  assert.ok(distanceMetres(coordinates.A, coordinates.B) > 50);
});
