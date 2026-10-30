import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { clearQlooCache } from '../src/qloo.js';
import { assembleRide, blendForTwo, chooseStops, gatherCandidates, planRide, PlanError } from '../src/planner.js';
import { FC_ROAD, offlineFetch } from './helpers.js';

config.qlooApiKey = ''; // demo data

// Points roughly north of FC Road, about 1 km apart.
const place = (id, category, affinity, northKm) => ({
  id,
  name: id,
  category,
  affinity,
  lat: FC_ROAD.lat + northKm / 111,
  lon: FC_ROAD.lon,
});

test('chooseStops picks high-affinity stops within the distance budget', () => {
  const candidates = [
    place('near-cafe', 'cafe', 0.8, 1),
    place('far-sight', 'sight', 0.95, 30), // far beyond a 10 km ride
    place('near-food', 'food', 0.7, 2),
  ];
  const { stops, estimatedKm } = chooseStops({ start: FC_ROAD, candidates, distanceKm: 10, maxStops: 3 });
  assert.deepEqual(stops.map((s) => s.id).sort(), ['near-cafe', 'near-food']);
  assert.ok(estimatedKm <= 10 * 1.15);
});

test('chooseStops stretches a short ride towards the requested distance', () => {
  const candidates = [place('near-cafe', 'cafe', 0.8, 0.5), place('far-sight', 'sight', 0.6, 5)];
  const { stops, estimatedKm } = chooseStops({ start: FC_ROAD, candidates, distanceKm: 15 });
  assert.deepEqual(stops.map((s) => s.id).sort(), ['far-sight', 'near-cafe']);
  assert.ok(estimatedKm >= 10, `got ${estimatedKm} km`);
});

test('chooseStops respects maxStops', () => {
  const candidates = [1, 2, 3, 4].map((i) => place(`p${i}`, 'sight', 0.9, i * 0.5));
  assert.equal(chooseStops({ start: FC_ROAD, candidates, distanceKm: 20, maxStops: 2 }).stops.length, 2);
});

test('chooseStops skips whole districts', () => {
  const candidates = [place('district', 'area', 0.99, 1), place('cafe', 'cafe', 0.5, 1.5)];
  assert.deepEqual(chooseStops({ start: FC_ROAD, candidates, distanceKm: 10 }).stops.map((s) => s.id), ['cafe']);
});

test('chooseStops skips hotels unless asked for', () => {
  const candidates = [place('hotel', 'stay', 0.99, 1), place('cafe', 'cafe', 0.5, 1.5)];
  assert.deepEqual(chooseStops({ start: FC_ROAD, candidates, distanceKm: 10 }).stops.map((s) => s.id), ['cafe']);
  const withHotel = chooseStops({ start: FC_ROAD, candidates, distanceKm: 10, prefer: { stay: 1 } });
  assert.ok(withHotel.stops.some((s) => s.id === 'hotel'));
});

test('chooseStops: a preference of 0 excludes a category', () => {
  const candidates = [place('sight', 'sight', 0.99, 1), place('cafe', 'cafe', 0.5, 1.5)];
  const { stops } = chooseStops({ start: FC_ROAD, candidates, distanceKm: 10, prefer: { sight: 0 } });
  assert.deepEqual(stops.map((s) => s.id), ['cafe']);
});

test('chooseStops prefers variety over three of the same kind', () => {
  const candidates = [
    place('cafe1', 'cafe', 0.8, 1),
    place('cafe2', 'cafe', 0.79, 1.2),
    place('cafe3', 'cafe', 0.78, 1.4),
    place('food', 'food', 0.7, 1.1),
  ];
  const { stops } = chooseStops({ start: FC_ROAD, candidates, distanceKm: 10, maxStops: 3 });
  assert.ok(stops.some((s) => s.id === 'food'), `got ${stops.map((s) => s.id)}`);
});

test('chooseStops orders stops along the ride and reports detours', () => {
  const candidates = [place('far', 'cafe', 0.8, 3), place('near', 'food', 0.8, 1)];
  const { stops } = chooseStops({ start: FC_ROAD, end: place('end', 'other', 0, 4), candidates, distanceKm: 12 });
  assert.deepEqual(stops.map((s) => s.id), ['near', 'far']);
  assert.ok(stops.every((s) => s.detourKm >= 0));
});

test('chooseStops puts required stops in, even low-scoring or far ones', () => {
  const far = place('far', 'sight', 0.1, 9);
  const candidates = [place('near', 'cafe', 0.9, 1), far];
  const { stops } = chooseStops({ start: FC_ROAD, candidates, distanceKm: 6, maxStops: 2, required: [far] });
  assert.ok(stops.some((s) => s.id === 'far'));
  assert.equal(stops.filter((s) => s.id === 'far').length, 1);
});

test('gatherCandidates + assembleRide: wider radius, include and exclude', async () => {
  const deps = { fetchImpl: offlineFetch };
  const tastes = [{ name: 'Spirited Away', category: 'movie' }, { name: 'coffee', category: 'food' }];
  const narrow = await gatherCandidates({ start: FC_ROAD, distanceKm: 6, tastes }, deps);
  const wide = await gatherCandidates({ start: FC_ROAD, distanceKm: 6, tastes, radiusKm: 15 }, deps);
  assert.equal(wide.radiusKm, 15);
  assert.ok(wide.candidates.length >= narrow.candidates.length);

  const first = await assembleRide(wide, { maxStops: 3 }, deps);
  const dropped = first.stops[0].id;
  const without = await assembleRide(wide, { maxStops: 3, exclude: [dropped] }, deps);
  assert.ok(!without.stops.some((s) => s.id === dropped));

  const pick = wide.candidates.at(-1).id;
  const withPick = await assembleRide(wide, { maxStops: 3, include: [pick] }, deps);
  assert.ok(withPick.stops.some((s) => s.id === pick));
  assert.equal(withPick.searchRadiusKm, 15);
});

test('planRide (demo data) returns an explained loop ride', async () => {
  const ride = await planRide(
    { start: FC_ROAD, distanceKm: 15, tastes: [{ name: 'Spirited Away', category: 'movie' }, { name: 'masala dosa' }] },
    { fetchImpl: offlineFetch },
  );
  assert.equal(ride.dataSource, 'demo');
  assert.equal(ride.loop, true);
  // What the "How Qloo picked these stops" panel shows.
  assert.deepEqual(ride.tastes.map((t) => [t.query, t.type]), [['Spirited Away', 'urn:entity:movie'], ['masala dosa', null]]);
  assert.equal(ride.searchRadiusKm, 7.5);
  assert.ok(ride.candidatesConsidered >= ride.stops.length);
  assert.ok(ride.stops.length >= 1 && ride.stops.length <= 3);
  assert.deepEqual(ride.stops.map((s) => s.order), ride.stops.map((_, i) => i + 1));
  for (const s of ride.stops) assert.match(s.why, /^Sample affinity \d+% for people who like Spirited Away and masala dosa\.$/);
  const atKm = ride.stops.map((s) => s.atKm);
  assert.deepEqual(atKm, [...atKm].sort((a, b) => a - b));
  assert.ok(atKm.at(-1) <= ride.route.distanceKm);
  assert.equal(ride.route.source, 'estimate');
  assert.ok(ride.route.distanceKm <= 15 * 1.15 + 0.1);
});

test('planRide geocodes text starts and supports one-way rides', async () => {
  const ride = await planRide(
    { start: 'FC Road, Pune', end: 'Koregaon Park, Pune', distanceKm: 20, tastes: [{ name: 'coffee' }] },
    { fetchImpl: offlineFetch },
  );
  assert.equal(ride.loop, false);
  assert.equal(ride.end.label, 'Koregaon Park, Pune');
});

test('planRide explains what went wrong', async () => {
  await assert.rejects(planRide({ start: FC_ROAD, tastes: [] }), PlanError);
  await assert.rejects(
    planRide({ start: 'Nowhere-ville', tastes: [{ name: 'x' }] }, { fetchImpl: offlineFetch }),
    /Couldn't find the start "Nowhere-ville"/,
  );
});

// ---------- Live-mode pipeline with a fake Qloo ----------

const liveFetch = ({ tagsWork = true } = {}) => {
  clearQlooCache(); // each live test starts with a cold cache
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fn = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.pathname === '/v2/tags') return json({ results: { tags: [{ id: 'urn:tag:category:place:coffee_shop', name: 'Coffee Shop' }] } });
    if (u.pathname === '/search') return json({ results: [{ entity_id: `E-${u.searchParams.get('query')}`, name: u.searchParams.get('query'), types: ['urn:entity:place'] }] });
    if (u.pathname === '/v2/insights') {
      if (!tagsWork && u.searchParams.has('signal.interests.tags')) return json({ error: 'at least one valid signal or filter is required' }, 400);
      return json({ results: { entities: [{ entity_id: 'P1', name: 'Bean There', location: { lat: FC_ROAD.lat + 0.01, lon: FC_ROAD.lon }, query: { affinity: 0.8 }, tags: [{ name: 'Cafe' }] }] } });
    }
    throw new Error('offline (test)'); // routing etc.
  };
  fn.calls = calls;
  return fn;
};

test('live: food tastes become Qloo tags in the insights request', async () => {
  config.qlooApiKey = 'test-key';
  try {
    const fetchImpl = liveFetch();
    const ride = await planRide({ start: FC_ROAD, distanceKm: 8, tastes: [{ name: 'Spirited Away', category: 'movie' }, { name: 'coffee', category: 'food' }] }, { fetchImpl });
    const insights = fetchImpl.calls.find((u) => u.pathname === '/v2/insights');
    assert.equal(insights.searchParams.get('signal.interests.tags'), 'urn:tag:category:place:coffee_shop');
    assert.equal(insights.searchParams.get('signal.interests.entities'), 'E-Spirited Away');
    assert.deepEqual(ride.tastes.map((t) => [t.query, t.kind]), [['Spirited Away', 'entity'], ['coffee', 'tag']]);
    assert.equal(ride.stops[0].name, 'Bean There');
  } finally {
    config.qlooApiKey = '';
  }
});

test('live: if Qloo rejects the tags, food tastes fall back to entity search', async () => {
  config.qlooApiKey = 'test-key';
  try {
    const fetchImpl = liveFetch({ tagsWork: false });
    const ride = await planRide({ start: FC_ROAD, distanceKm: 8, tastes: [{ name: 'coffee', category: 'food' }] }, { fetchImpl });
    assert.deepEqual(ride.tastes.map((t) => [t.query, t.kind]), [['coffee', 'entity']]);
    assert.equal(ride.stops.length, 1);
    const last = fetchImpl.calls.filter((u) => u.pathname === '/v2/insights').at(-1);
    assert.equal(last.searchParams.get('signal.interests.entities'), 'E-coffee');
    assert.equal(last.searchParams.has('signal.interests.tags'), false);
  } finally {
    config.qlooApiKey = '';
  }
});

// ---------- Riding with a friend ----------

test('blendForTwo ranks places both riders like above one-sided favourites', () => {
  const at = { lat: FC_ROAD.lat, lon: FC_ROAD.lon };
  const yours = [{ id: 'shared', affinity: 0.7, ...at }, { id: 'only-you', affinity: 0.95, ...at }];
  const friends = [{ id: 'shared', affinity: 0.8, ...at }, { id: 'only-friend', affinity: 0.9, ...at }];
  const blended = blendForTwo(yours, friends);
  assert.deepEqual(blended.map((p) => [p.id, p.likedBy]), [
    ['shared', 'both'],
    ['only-you', 'you'],
    ['only-friend', 'friend'],
  ]);
  assert.equal(blended[0].affinity.toFixed(3), Math.sqrt(0.7 * 0.8).toFixed(3));
  assert.equal(blended[1].affinity, 0.95 * 0.5);
  assert.equal(blended[1].affinityFriend, null);
});

test('planRide with a friend (demo data) explains each stop for both riders', async () => {
  const ride = await planRide(
    {
      start: FC_ROAD,
      distanceKm: 15,
      tastes: [{ name: 'Spirited Away' }, { name: 'coffee', who: 'friend' }],
    },
    { fetchImpl: offlineFetch },
  );
  assert.equal(ride.withFriend, true);
  assert.deepEqual(ride.tastes.map((t) => [t.query, t.who]), [['Spirited Away', 'you'], ['coffee', 'friend']]);
  assert.ok(ride.friendStats.both > 0);
  for (const s of ride.stops) {
    assert.equal(s.likedBy, 'both'); // demo data has the same places for everyone
    assert.match(s.why, /for you \(Spirited Away\) and \d+% for your friend \(coffee\)/);
  }
});

test('planRide needs at least one taste of your own, and works solo without a friend', async () => {
  await assert.rejects(planRide({ start: FC_ROAD, tastes: [{ name: 'coffee', who: 'friend' }] }), /at least one/);
  const solo = await planRide({ start: FC_ROAD, tastes: [{ name: 'coffee' }] }, { fetchImpl: offlineFetch });
  assert.equal(solo.withFriend, false);
  assert.equal(solo.friendStats, null);
  assert.ok(solo.stops.every((s) => !s.likedBy));
});

test('live: each rider gets their own Qloo insights request', async () => {
  config.qlooApiKey = 'test-key';
  try {
    const fetchImpl = liveFetch();
    const ride = await planRide(
      { start: FC_ROAD, distanceKm: 8, tastes: [{ name: 'Spirited Away' }, { name: 'Coldplay', who: 'friend' }] },
      { fetchImpl },
    );
    const insights = fetchImpl.calls.filter((u) => u.pathname === '/v2/insights').map((u) => u.searchParams.get('signal.interests.entities'));
    assert.deepEqual(insights.sort(), ['E-Coldplay', 'E-Spirited Away']);
    assert.equal(ride.stops[0].likedBy, 'both');
  } finally {
    config.qlooApiKey = '';
  }
});
