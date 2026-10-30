// Plans a ride: favourites -> Qloo entities -> taste-matched places -> stops -> bike route.

import { qlooIsLive } from './config.js';
import { geocode, haversineKm, routeBike, round1, ROAD_FACTOR } from './geo.js';
import { FOOD_CATEGORY, findTasteEntity, findTastePlaces, findTasteTag } from './qloo.js';

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

// A stop may make the ride this much longer than requested.
const DISTANCE_SLACK = 1.15;

// Distance-fit weight: moving the ride's length by the whole requested distance
// (towards or away from it) is worth this much affinity.
const DISTANCE_WEIGHT = 0.6;

// Hotels, whole districts and errands (shops, services) make odd bike stops, so they're skipped unless asked for.
const DEFAULT_PREFER = { stay: 0, area: 0, errand: 0 };

// Each extra stop of an already-chosen category is worth this much less, so rides mix cafés, food, culture and sights.
const REPEAT_FACTOR = 0.75;

const roadKm = (a, b) => haversineKm(a, b) * ROAD_FACTOR;

function tourKm(tour) {
  let total = 0;
  for (let i = 1; i < tour.length; i++) total += roadKm(tour[i - 1], tour[i]);
  return total;
}

/**
 * Picks stops greedily. Each round inserts the candidate with the best
 *   score = affinity * preference * repeatPenalty - lambda * (|L + detour - T| - |L - T|)
 * where L is the current ride length and T the requested distance. So while the ride is
 * shorter than requested, a detour helps; once it's long enough, a detour costs.
 * Each stop goes in at its cheapest position, and the ride never exceeds T * DISTANCE_SLACK.
 *
 * `prefer` maps category ('cafe' | 'food' | 'sight' | 'other') to a weight; 0 excludes it.
 * `required` candidates go in first, at their cheapest position, whatever their score or the budget.
 */
export function chooseStops({ start, end = start, candidates, distanceKm, maxStops = 3, prefer = {}, required = [] }) {
  const budgetKm = distanceKm * DISTANCE_SLACK;
  const lambda = DISTANCE_WEIGHT / distanceKm;
  const tour = [start, end];
  const chosen = [];
  const remaining = candidates.filter((c) => c.affinity > 0 && !required.includes(c));

  for (const c of required) {
    const { insertAt, detourKm } = cheapestInsertion(tour, c);
    const stop = { ...c, score: round2(c.affinity), detourKm: round1(detourKm) };
    tour.splice(insertAt, 0, stop);
    chosen.push(stop);
  }

  while (chosen.length < maxStops) {
    let best = null;
    for (const c of remaining) {
      const weight = prefer[c.category] ?? DEFAULT_PREFER[c.category] ?? 1;
      if (weight <= 0) continue;

      const { insertAt, detourKm } = cheapestInsertion(tour, c);
      const lengthKm = tourKm(tour);
      if (lengthKm + detourKm > budgetKm) continue;

      const repeats = chosen.filter((s) => s.category === c.category).length;
      const fitChange = Math.abs(lengthKm + detourKm - distanceKm) - Math.abs(lengthKm - distanceKm);
      const score = c.affinity * weight * REPEAT_FACTOR ** repeats - lambda * fitChange;
      if (!best || score > best.score) best = { candidate: c, insertAt, detourKm, score };
    }
    if (!best || best.score <= 0) break;

    const stop = { ...best.candidate, score: round2(best.score), detourKm: round1(best.detourKm) };
    tour.splice(best.insertAt, 0, stop);
    chosen.push(stop);
    remaining.splice(remaining.indexOf(best.candidate), 1);
  }

  return { stops: tour.slice(1, -1), estimatedKm: round1(tourKm(tour)) };
}

/** Where in the tour `c` adds the least distance, and how much it adds. */
function cheapestInsertion(tour, c) {
  let insertAt = -1;
  let detourKm = Infinity;
  for (let i = 1; i < tour.length; i++) {
    const delta = roadKm(tour[i - 1], c) + roadKm(c, tour[i]) - roadKm(tour[i - 1], tour[i]);
    if (delta < detourKm) {
      detourKm = delta;
      insertAt = i;
    }
  }
  return { insertAt, detourKm };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

const CATEGORY_LABEL = { cafe: 'Café', food: 'Food', culture: 'Culture', sight: 'Sight', stay: 'Stay', other: 'Stop' };

/** A reason built only from the data, used until (or unless) the agent writes a better one. */
function listNames(tastes) {
  const names = tastes.map((t) => t.name);
  return names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and ');
}

export function defaultReason(stop, tastes) {
  const source = stop.source === 'demo' ? 'Sample affinity' : 'Qloo affinity';
  const pct = (x) => Math.round(x * 100);
  if (!stop.likedBy) return `${source} ${pct(stop.affinity)}% for people who like ${listNames(tastes)}.`;

  const yours = listNames(tastes.filter((t) => t.who !== 'friend'));
  const friends = listNames(tastes.filter((t) => t.who === 'friend'));
  if (stop.likedBy === 'both') {
    return `${source} ${pct(stop.affinityYou)}% for you (${yours}) and ${pct(stop.affinityFriend)}% for your friend (${friends}).`;
  }
  return stop.likedBy === 'you'
    ? `${source} ${pct(stop.affinityYou)}% for you (${yours}); it wasn't in your friend's Qloo results.`
    : `${source} ${pct(stop.affinityFriend)}% for your friend (${friends}); it wasn't in your Qloo results.`;
}

/** One favourite -> a Qloo tag (for food) or entity, or the reason it wasn't found. */
async function lookUpTaste(taste, deps) {
  try {
    if (taste.category === FOOD_CATEGORY) {
      const tag = await findTasteTag(taste.name, deps).catch(() => null);
      if (tag) return { query: taste.name, entity: { ...tag, kind: 'tag' } };
    }
    const category = taste.category === FOOD_CATEGORY ? undefined : taste.category;
    const entity = await findTasteEntity(taste.name, category, deps);
    return { query: taste.name, entity: entity && { ...entity, kind: 'entity' } };
  } catch (err) {
    return { query: taste.name, error: err.message };
  }
}

function foundTastes(lookups) {
  return lookups
    .filter((l) => l.entity)
    .map((l) => ({
      id: l.entity.id,
      name: l.entity.name,
      query: l.query,
      kind: l.entity.kind,
      type: l.entity.kind === 'tag' ? 'tag' : l.entity.types?.[0] ?? null,
    }));
}

/**
 * One rider's tastes -> Qloo tags/entities -> places they'd like.
 * If food tags fail or find nothing, those foods are looked up as ordinary entities instead.
 */
async function placesForRider(tastes, { center, radiusKm }, deps) {
  let lookups = await Promise.all(tastes.map((t) => lookUpTaste(t, deps)));
  let found = foundTastes(lookups);
  if (!found.length) return { lookups, found, candidates: [] };

  const ask = () => findTastePlaces({ tastes: found, center, radiusKm, take: 50 }, deps);
  const usesTags = () => found.some((t) => t.kind === 'tag');
  let candidates = await ask().catch((err) => {
    if (!usesTags()) throw err;
    console.warn(`Qloo insights with food tags failed (${err.message}); retrying without tags`);
    return null;
  });
  if (!candidates?.length && usesTags()) {
    lookups = await Promise.all(lookups.map((l) => (l.entity?.kind === 'tag' ? lookUpTaste({ name: l.query }, deps) : l)));
    found = foundTastes(lookups);
    candidates = found.length ? await ask() : [];
  }
  return { lookups, found, candidates };
}

// A place Qloo returned for only one of the two riders gets half credit.
const ONE_SIDED_FACTOR = 0.5;

/**
 * Merges two riders' Qloo results. A place both of them like scores the geometric mean of
 * their affinities, which stays high only when it's a good match for both.
 */
export function blendForTwo(yours, friends) {
  const byId = new Map(yours.map((p) => [p.id, { ...p, affinityYou: p.affinity, affinityFriend: null }]));
  for (const p of friends) {
    const mine = byId.get(p.id);
    if (mine) mine.affinityFriend = p.affinity;
    else byId.set(p.id, { ...p, affinityYou: null, affinityFriend: p.affinity });
  }
  return [...byId.values()]
    .map((p) => {
      const both = p.affinityYou !== null && p.affinityFriend !== null;
      return {
        ...p,
        affinity: both ? Math.sqrt(p.affinityYou * p.affinityFriend) : (p.affinityYou ?? p.affinityFriend) * ONE_SIDED_FACTOR,
        likedBy: both ? 'both' : p.affinityYou !== null ? 'you' : 'friend',
      };
    })
    .sort((a, b) => b.affinity - a.affinity);
}

async function resolvePoint(where, label, deps) {
  if (where && typeof where === 'object' && Number.isFinite(where.lat) && Number.isFinite(where.lon)) return where;
  const point = await geocode(String(where ?? ''), deps);
  if (!point) throw new PlanError(`Couldn't find the ${label} "${where}". Try a neighbourhood and city, e.g. "FC Road, Pune".`);
  return point;
}

/**
 * Full pipeline. `tastes` is a list of {name, category?, who?}, e.g. {name: 'Studio Ghibli', category: 'movie'}.
 * Tastes with who: 'friend' belong to a friend riding along; stops are then picked for both riders.
 * `start` / `end` are place names or {lat, lon}. Leave `end` empty for a loop back to the start.
 * `deps.fetchImpl` replaces fetch for every network call (used by tests).
 */
export async function planRide({ start, end, distanceKm = 15, tastes = [], prefer = {}, maxStops = 3 }, deps = {}) {
  const search = await gatherCandidates({ start, end, distanceKm, tastes }, deps);
  return assembleRide(search, { prefer, maxStops }, deps);
}

const clampKm = (km) => Math.min(Math.max(Number(km) || 15, 3), 120);

/**
 * First half of the pipeline: where the ride goes, and which places Qloo says these riders would like.
 * `radiusKm` overrides the search radius (by default it covers everywhere a ride of `distanceKm` could reach).
 * The agent calls this on its own so it can widen the search or fix tastes before building a ride.
 */
export async function gatherCandidates({ start, end, distanceKm = 15, tastes = [], radiusKm }, deps = {}) {
  if (!tastes.length) throw new PlanError('Tell me at least one film, artist, food or place you love.');
  distanceKm = clampKm(distanceKm);

  const startPt = await resolvePoint(start, 'start', deps);
  const loop = !end || String(end).trim() === '';
  const endPt = loop ? startPt : await resolvePoint(end, 'finish', deps);

  const yourTastes = tastes.filter((t) => t.who !== 'friend');
  const friendTastes = tastes.filter((t) => t.who === 'friend');
  if (!yourTastes.length) throw new PlanError('Tell me at least one film, artist, food or place you love.');

  // Search a circle that covers everywhere the ride could reach.
  const center = loop ? startPt : { lat: (startPt.lat + endPt.lat) / 2, lon: (startPt.lon + endPt.lon) / 2 };
  const reachKm = loop ? distanceKm / 2 : Math.max(distanceKm / 2, haversineKm(startPt, endPt) / 2 + 2);
  const area = { center, radiusKm: Number(radiusKm) > 0 ? Math.min(Math.max(Number(radiusKm), 1), 40) : reachKm };

  // Riding with a friend: ask Qloo separately for each rider, then favour places both of them like.
  const [you, friend] = await Promise.all([
    placesForRider(yourTastes, area, deps),
    friendTastes.length ? placesForRider(friendTastes, area, deps) : null,
  ]);
  const riders = [you, friend].filter(Boolean);
  if (!riders.some((r) => r.found.length)) {
    const lookups = riders.flatMap((r) => r.lookups);
    const reason = lookups.find((l) => l.error)?.error;
    throw new PlanError(`Qloo didn't recognise any of: ${lookups.map((l) => l.query).join(', ')}.${reason ? ` (${reason})` : ''}`);
  }
  const withFriend = Boolean(you.found.length && friend?.found.length);
  const candidates = withFriend ? blendForTwo(you.candidates, friend.candidates) : (you.found.length ? you : friend).candidates;
  const found = [
    ...you.found.map((t) => ({ ...t, who: 'you' })),
    ...(friend?.found ?? []).map((t) => ({ ...t, who: 'friend' })),
  ];
  const missingTastes = riders.flatMap((r) => r.lookups.filter((l) => !l.entity).map((l) => l.query));

  return {
    start: startPt,
    end: endPt,
    loop,
    distanceKm,
    radiusKm: area.radiusKm,
    candidates,
    found,
    missingTastes,
    withFriend,
    friendStats: withFriend
      ? { you: you.candidates.length, friend: friend.candidates.length, both: candidates.filter((c) => c.likedBy === 'both').length }
      : null,
  };
}

/**
 * Second half: picks stops from a gatherCandidates() result and routes the ride.
 * `include` / `exclude` are candidate ids to force in or leave out.
 */
export async function assembleRide(search, { distanceKm = search.distanceKm, prefer = {}, maxStops = 3, include = [], exclude = [] } = {}, deps = {}) {
  distanceKm = clampKm(distanceKm);
  maxStops = Math.min(Math.max(Math.round(Number(maxStops) || 3), 1), 6);
  const { start: startPt, end: endPt, loop, found, missingTastes, withFriend } = search;

  const candidates = search.candidates.filter((c) => !exclude.includes(c.id));
  const required = include.map((id) => candidates.find((c) => c.id === id)).filter(Boolean);
  const { stops } = chooseStops({ start: startPt, end: endPt, candidates, distanceKm, maxStops, prefer, required });
  const route = await routeBike([startPt, ...stops, endPt], deps);

  return {
    start: startPt,
    end: endPt,
    loop,
    requestedKm: distanceKm,
    stops: stops.map((s, i) => ({
      ...s,
      order: i + 1,
      atKm: round1(route.legsKm.slice(0, i + 1).reduce((sum, km) => sum + km, 0)),
      why: defaultReason(s, found),
    })),
    route: { geometry: route.geometry, distanceKm: route.distanceKm, durationMin: route.durationMin, source: route.source },
    tastes: found,
    missingTastes,
    candidatesConsidered: search.candidates.length,
    withFriend,
    friendStats: search.friendStats,
    searchRadiusKm: round1(search.radiusKm),
    dataSource: qlooIsLive() ? 'qloo' : 'demo',
  };
}
