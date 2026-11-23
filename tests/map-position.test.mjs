// What the map may say about the phone's position, and how a selected bay
// says it was tied to its road (the last part of map-details.js).
// PROPOSED FILE: save as tests/map-position.test.mjs (the imports are written for that place).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getLocationDetails, positionStatus } from '../map-details.js';
import { positionStale } from '../core/posts.js';

// Two o'clock in the afternoon, local time, so the labels read the same in any time zone.
const now = new Date(2026, 10, 22, 14, 40, 0).getTime();
const ago = (seconds) => now - seconds * 1000;

test('a current, real position needs no words; "My location" quotes only an accuracy the phone gave', () => {
  assert.deepEqual(positionStatus({ speed: 30, accuracy: 6.4 }, ago(5), now),
    { current: true, label: '', notice: 'Location accuracy ±6 m. Check the carriageway.' });
  // No figure from the phone (nothing, nought or less, not a number): none is made up.
  for (const accuracy of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.deepEqual(positionStatus({ speed: 30, accuracy }, ago(5), now),
      { current: true, label: '', notice: 'Location found, accuracy unknown. Check the carriageway.' }, String(accuracy));
  }
});

test('a position past its limit is only ever the last known one, with the time it was taken', () => {
  assert.deepEqual(positionStatus({ speed: 30, accuracy: 6 }, ago(16), now),
    { current: false, label: 'Last known 14:39', notice: 'Showing your last known position, 14:39. Check the carriageway.' });
  // Not today: the date goes in front, so an old time cannot be read as today's.
  assert.equal(positionStatus({ speed: 0, accuracy: 6 }, ago(26 * 3600), now).label, 'Last known 21 Nov, 12:40');
  assert.equal(positionStatus({ speed: 0, accuracy: 6 }, new Date(2025, 11, 31, 23, 59).getTime(), now).label, 'Last known 31 Dec 2025, 23:59');
  // A position with no time of its own is never current, and no time is invented for it.
  assert.deepEqual(positionStatus({ speed: 0, accuracy: 6 }, 0, now),
    { current: false, label: 'Last known position', notice: 'Showing your last known position. Check the carriageway.' });
  // No accuracy is quoted for a last known position.
  assert.doesNotMatch(positionStatus({ speed: 30, accuracy: 6 }, ago(16), now).notice, /±|accuracy/);
});

test('a made-up position is always called a simulated position', () => {
  assert.deepEqual(positionStatus({ speed: 25, accuracy: 5, simulated: true }, ago(1), now),
    { current: true, label: 'Simulated position', notice: 'Simulated position. Not your real location.' });
  assert.deepEqual(positionStatus({ speed: 25, accuracy: 5, simulated: true }, ago(60), now),
    { current: false, label: 'Simulated position · last known 14:39', notice: 'Simulated position. Not your real location.' });
  assert.equal(positionStatus({ speed: 25, simulated: true }, 0, now).label, 'Simulated position · last known');
});

test('whether the map calls a position current is the one rule in core/posts.js, to the millisecond', () => {
  for (const speed of [31, 2.5, 0, null, undefined, NaN]) {
    for (const unseen of [false, true]) {
      for (const age of [-5000, 0, 14999, 15000, 15001, 29999, 30000, 30001, 119999, 120000, 120001, 86400000]) {
        assert.equal(positionStatus({ speed }, now - age, now, unseen).current, !positionStale(now - age, speed, now, unseen),
          `speed ${speed}, ${age} ms old, unseen ${unseen}`);
      }
    }
  }
  // Standing still, 90 s is current while the app is watching, but not for a position from before it was put away.
  assert.equal(positionStatus({ speed: 0 }, ago(90), now).current, true);
  assert.equal(positionStatus({ speed: 0 }, ago(90), now, true).current, false);
  assert.equal(positionStatus({ speed: 0 }, ago(90), now, true).label, 'Last known 14:38');
});

// ------------------------------------------------- how a bay was tied to a road

const lane = (code, startM = 0, endM = 100) => ({ code, startM, endM });
const road = (id = 'a', extra = {}) => ({ id, road: 'M27', carriageway: 'A', direction: 'E', form: 'DC', directionality: '1',
  from: 'start', to: 'end', coordinates: [[-1.401, 50.9], [-1.399, 50.9]], lanes: [lane('CL1'), lane('CL2'), lane('LH')], ...extra });

test('a selected emergency area is a provisional match; a lay-by joined to its road by the records is not', () => {
  // The emergency area record names no road or carriageway: only the nearest road's geometry ties it.
  const era = { id: 'era', kind: 'era', coordinate: [-1.4, 50.9001], sourceKey: 'emergencyAreas' };
  const eraDetail = getLocationDetails({ selection: era, links: [road()], areas: [era] });
  assert.equal(eraDetail.section.link.carriageway, 'A', 'the card will show this carriageway');
  assert.equal(eraDetail.nearestEra.association, 'selected-record');
  assert.equal(eraDetail.nearestEra.matchedAssociation, 'nearby-unverified', 'so it must be labelled as an unverified match');
  // The lay-by's own link joins its parent road at real nodes.
  const laybyLink = road('bay', { form: 'L', carriageway: 'X', lanes: [lane('CL1')] });
  const layby = { id: 'layby', kind: 'layby', road: 'M27', carriageway: 'X', coordinate: [-1.4, 50.9001], linkId: 'bay', link: laybyLink };
  const laybyDetail = getLocationDetails({ selection: layby, links: [road(), laybyLink], areas: [layby] });
  assert.equal(laybyDetail.nearestLayby.matchedAssociation, 'same-carriageway');
  assert.equal(laybyDetail.nearestLayby.matchedCarriageway, 'A');
  // Nothing near enough: nothing is claimed.
  const lost = { id: 'far', kind: 'era', coordinate: [-1.4, 50.95], sourceKey: 'emergencyAreas' };
  const lostDetail = getLocationDetails({ selection: lost, links: [road()], areas: [lost] });
  assert.equal(lostDetail.nearestEra.matchedAssociation, null);
  assert.equal(lostDetail.section, null);
});

test('in the published snapshot no emergency area that names no carriageway passes as a recorded match', async () => {
  const network = JSON.parse(await readFile(new URL('../data/network.json', import.meta.url), 'utf8'));
  const byId = new Map(network.links.map((l) => [l.id, l]));
  const midpoint = (coords) => coords?.[Math.floor(coords.length / 2)];
  // The same shaping as NetworkMap.load() in map.js.
  const features = (network.areas || []).map((a) => ({
    ...a,
    road: a.road || byId.get(a.linkId)?.road,
    carriageway: a.carriageway || byId.get(a.linkId)?.carriageway,
    link: byId.get(a.linkId),
    coordinate: a.coordinate || midpoint(a.coordinates), sourceKey: a.source || 'emergencyAreas',
  })).filter((f) => f.coordinate?.length === 2);
  // The data is refreshed daily, so no count is asserted: on 22 November 2026
  // all 37 emergency areas were of this kind, and all 50 lay-bys were tied to
  // their road by the records.
  for (const f of features) {
    if (f.kind !== 'era' || f.carriageway || f.link) continue;
    const own = getLocationDetails({ selection: f, links: network.links, areas: features, sources: network.sources }).nearestEra;
    assert.notEqual(own.matchedAssociation, 'same-carriageway', `${f.id}: its record names no carriageway`);
  }
});
