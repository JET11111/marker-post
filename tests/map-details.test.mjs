import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getLocationDetails, findNearestRoadSection, layoutAtSection, projectOnSection } from '../map-details.mjs';

const point = [-1.4, 50.9];
const lane = (code, startM = 0, endM = 100) => ({ code, startM, endM });
const road = (id = 'a', extra = {}) => ({ id, road: 'M27', carriageway: 'A', direction: 'E',
  form: 'DC', directionality: '1', from: 'start', to: 'end', routeEligible: false,
  coordinates: [[-1.401, 50.9], [-1.399, 50.9]], lanes: [lane('CL1'), lane('CL2'), lane('LH')], ...extra });
const selection = (extra = {}) => ({ kind: 'point', coordinate: point, ...extra });
const post = (id, carriageway = 'A', coordinate = point, extra = {}) => ({ id, kind: 'post', road: 'M27',
  carriageway, coordinate, title: id, post: { surveyedAt: null }, ...extra });
const bay = (id, kind, carriageway = 'A', coordinate = point, extra = {}) => ({ id, kind, road: 'M27', carriageway, coordinate, ...extra });

test('inspection includes links unavailable to routing and excludes shoulders from lane counts', () => {
  const link = road();
  const result = getLocationDetails({ selection: selection(), links: [link] });
  assert.equal(result.section.link.id, 'a');
  assert.equal(result.layout.runningCount, 2);
  assert.equal(result.layout.shoulder, 'Recorded');
});

test('lane count is local to the tap, handles reverse intervals and deduplicates codes', () => {
  const link = road('local', { reportedLaneCount: 7, lanes: [lane('CL1'), lane('CL2', 100, 0),
    lane('CL2'), lane('CL3', 50, 100), lane('LH', 0, 50)] });
  assert.equal(layoutAtSection(link, [-1.4005, 50.9]).runningCount, 2);
  const after = layoutAtSection(link, [-1.3995, 50.9]);
  assert.equal(after.runningCount, 3);
  assert.equal(after.shoulder, 'Not recorded');
  assert.equal(after.shoulderRecorded, null, 'missing record never means a confirmed absent shoulder');
});

test('invalid, missing and uncovered lane records remain unknown', () => {
  for (const lanes of [[], [lane('CL1', NaN, 100)], [lane('CL1', -1, 100)], [lane('CL1', 50, 100)]]) {
    const result = layoutAtSection(road('gaps', { lanes, reportedLaneCount: 4 }), [-1.4008, 50.9]);
    assert.equal(result.runningCount, null);
    assert.equal(result.shoulder, 'Unknown');
  }
  assert.equal(layoutAtSection(road(), [-1.4, 51]).runningCount, null);
});

test('single-carriageway lanes clearly identify their two-direction total', () => {
  const result = layoutAtSection(road('single', { directionality: '0', form: 'SC', lanes: [lane('CL1'), lane('CR1', 100, 0)] }), point);
  assert.equal(result.running, '2 recorded total');
  assert.equal(result.totalAcrossDirections, true);
});

test('projection uses polyline geometry rather than endpoint distance and tolerates duplicate vertices', () => {
  const link = road('bent', { coordinates: [[-1.401, 50.9], [-1.401, 50.9], [-1.4, 50.9], [-1.4, 50.901]] });
  const result = projectOnSection(link, [-1.4, 50.9005]);
  assert.ok(result.distanceM < .01);
  assert.ok(result.fraction > .6 && result.fraction < .8);
  assert.equal(projectOnSection(road('flat', { coordinates: [point, point] }), point), null);
  assert.equal(projectOnSection(link, [NaN, 50.9]), null);
});

test('tap between carriageways does not present one as certain, but direct section selection does', () => {
  const a = road('a', { coordinates: [[-1.401, 50.89995], [-1.399, 50.89995]] });
  const b = road('b', { carriageway: 'B', coordinates: [[-1.401, 50.90005], [-1.399, 50.90005]] });
  const uncertain = getLocationDetails({ selection: selection(), links: [a, b], postFeatures: [post('a')] });
  assert.equal(uncertain.section, null);
  assert.equal(uncertain.sectionAmbiguous, true);
  assert.equal(uncertain.layout.runningCount, null);
  assert.equal(uncertain.nearestPost, null);
  assert.equal(getLocationDetails({ selection: selection({ link: a }), links: [a, b] }).section.link.id, 'a');
});

test('known marker carriageway is respected even if the other carriageway is closer', () => {
  const a = road('a', { coordinates: [[-1.401, 50.90015], [-1.399, 50.90015]] });
  const b = road('b', { carriageway: 'B' });
  const result = getLocationDetails({ selection: post('P1/0A'), links: [a, b] });
  assert.equal(result.section.link.id, 'a');
  assert.equal(result.section.association, 'matched-post');
  assert.equal(result.nearestPost.association, 'selected-record');
});

test('nearest marker and bay never substitute an opposing carriageway', () => {
  const result = getLocationDetails({ selection: selection(), links: [road()],
    postFeatures: [post('wrong', 'B'), post('right', 'A', [-1.399, 50.9])],
    areas: [bay('wrong', 'layby', 'B'), bay('right', 'layby', 'A', [-1.398, 50.9])] });
  assert.equal(result.nearestPost.feature.id, 'right');
  assert.equal(result.nearestLayby.feature.id, 'right');
  assert.ok(result.nearestLayby.distanceM > 100);
  assert.equal(result.nearestLayby.association, 'same-carriageway');
  assert.equal(getLocationDetails({ selection: selection(), links: [road()], areas: [bay('wrong', 'layby', 'B')] }).nearestLayby, null);
});

test('a normal-road marker alias cannot override its known opposing carriageway', () => {
  const marker = post('opposite', 'B', point, { post: { roadAliases: ['M27', 'M3'] } });
  const result = getLocationDetails({ selection: selection(), links: [road()], postFeatures: [marker] });
  assert.equal(result.nearestPost, null);
});

test('conflicting bay source identities are not silently repaired using nearby geometry', () => {
  const main = road();
  const linked = road('bay', { form: 'L', carriageway: 'X' });
  const result = getLocationDetails({ selection: selection(), links: [main, linked],
    areas: [bay('conflict', 'layby', 'B', point, { linkId: linked.id })] });
  assert.equal(result.nearestLayby, null);
});

test('lay-by X code resolves through real parent-road endpoint nodes', () => {
  const main = road();
  const laybyLink = road('bay', { form: 'L', carriageway: 'X', from: 'start', to: 'end', lanes: [lane('CL1')] });
  const area = bay('layby', 'layby', 'X', [-1.4, 50.9001], { linkId: 'bay' });
  const result = getLocationDetails({ selection: selection(), links: [main, laybyLink], areas: [area] });
  assert.equal(result.nearestLayby.association, 'same-carriageway');
  assert.equal(result.nearestLayby.feature.id, 'layby');
  assert.equal(result.nearestLayby.feature.carriageway, 'X');
  assert.equal(result.nearestLayby.matchedCarriageway, 'A');
  const areaDetails = getLocationDetails({ selection: { ...area, link: laybyLink }, links: [main, laybyLink], areas: [area] });
  assert.equal(areaDetails.section.link.id, 'a');
  assert.equal(areaDetails.layout.runningCount, 2, 'inspect the parent road rather than the lay-by lane');
});

test('unattributed ERA stays unverified and retains its older source publication', () => {
  const area = { id: 'era', kind: 'era', coordinate: [-1.4, 50.9001], sourceKey: 'emergencyAreas' };
  const result = getLocationDetails({ selection: selection(), links: [road()], areas: [area],
    sources: { emergencyAreas: { dataLastEditDate: '2025-02-01T00:00:00Z' } } });
  assert.equal(result.nearestEra.association, 'nearby-unverified');
  assert.equal(result.nearestEra.verificationStatus, 'unverified');
  assert.equal(result.nearestEra.sourceEditedAt, '2025-02-01T00:00:00Z');
});

test('ERA geometry on the opposite carriageway is excluded even without source attributes', () => {
  const opposite = road('b', { carriageway: 'B', coordinates: [[-1.401, 50.9004], [-1.399, 50.9004]] });
  const area = { id: 'era', kind: 'era', coordinate: [-1.4, 50.9005], sourceKey: 'emergencyAreas' };
  const result = getLocationDetails({ selection: selection({ link: road() }), links: [road(), opposite], areas: [area] });
  assert.equal(result.nearestEra, null);
});

test('Chilworth source aliases allow a provisional spatial match without inventing post letters', () => {
  const marker = post('P17/4L', 'L', point, { road: 'CHILWORTH', post: { roadAliases: ['M27', 'M3'], surveyedAt: null } });
  const link = road('slip', { form: 'SL', carriageway: 'J' });
  const result = getLocationDetails({ selection: marker, links: [link] });
  assert.equal(result.section.link.id, 'slip');
  assert.equal(result.section.association, 'interchange-unverified');
  assert.equal(result.layout.runningCount, null);
  assert.equal(result.layout.shoulder, 'Unknown');
  assert.equal(result.nearestPost.feature.carriageway, 'L');
  const linkResult = getLocationDetails({ selection: selection({ link }), links: [link], postFeatures: [marker] });
  assert.equal(linkResult.nearestPost.feature.id, 'P17/4L');
  assert.equal(linkResult.nearestPost.association, 'nearby-unverified');
});

test('distant or off-network selections return missing records rather than a forced match', () => {
  assert.equal(findNearestRoadSection([road()], [-1.4, 51]), null);
  const result = getLocationDetails({ selection: selection(), links: [road()],
    areas: [bay('too far', 'layby', 'A', [-1.4, 51.3])] });
  assert.equal(result.nearestLayby, null);
  assert.equal(getLocationDetails({ selection: selection({ coordinate: null }) }).section, null);
});

test('committed snapshot provides a parent layout and matching lay-by on A31', async () => {
  const network = JSON.parse(await readFile(new URL('../data/network.json', import.meta.url)));
  const area = network.areas.find(value => value.kind === 'layby' && value.road === 'A31' && value.direction === 'W');
  assert.ok(area, 'A31 westbound lay-by is present in the fixture');
  const result = getLocationDetails({ selection: area, links: network.links, areas: network.areas, sources: network.sources });
  assert.equal(result.section.link.road, 'A31');
  assert.equal(result.section.link.form, 'DC');
  assert.equal(result.section.link.direction, 'W');
  assert.ok(result.layout.runningCount >= 2);
  assert.equal(result.nearestLayby.distanceM, 0);
});
