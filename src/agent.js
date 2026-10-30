// The RideTaste agent: Claude chats with the rider and plans in steps. It asks Qloo for places
// (find_places), builds and checks a ride from them (build_ride), fixes what the checks flag,
// then explains each stop on the map (show_ride). Every step is logged for the rider to see.

import Anthropic from '@anthropic-ai/sdk';
import { config, qlooIsLive } from './config.js';
import { assembleRide, gatherCandidates, PlanError } from './planner.js';
import { TASTE_CATEGORIES } from './qloo.js';

const MAX_TOOL_ROUNDS = 12;

// How many candidate places the model sees from a search: the best few of each type, then the best overall.
const CANDIDATES_SHOWN = 20;
const PER_CATEGORY = 3;

// A search with fewer places than this is worth widening.
const FEW_CANDIDATES = 8;

const STOP_TYPES = ['cafe', 'food', 'culture', 'sight', 'stay'];

const SYSTEM_PROMPT = `You are RideTaste, a friendly cycling buddy who plans bike rides around the rider's taste.

You plan in steps, and you check your own work:
1. Find out where the rider starts, roughly how far they want to ride, and a few things they love (films, music, books, food, shows, places). If the start or the tastes are missing, ask one short question. If the distance is missing, assume 15 km and say so.
2. Call find_places. Put every favourite in "tastes" with the best-fitting category; use "food" for dishes, drinks and cuisines. Look at the result:
   - tastesRecognised shows what Qloo matched each favourite to. If a match is clearly the wrong thing (a book matched to a film of the same name, a song to a place), call find_places again with a better category or a more specific name.
   - If missingTastes is not empty, retry those once with another wording (e.g. "filter kaapi" -> "South Indian coffee") or category. If they still fail, go on without them.
   - If problems says there are few places, or none of a type the rider wants, call find_places again with a bigger radius_km (at most 40).
3. Call build_ride. Use "prefer" for wishes like "more food" (food: 2) or "no sightseeing" (sight: 0). Use include_stop_ids when the rider asks for a particular place from the candidates (e.g. one tagged "lake" when they want to end near a lake), and exclude_stop_ids for places they don't want.
4. Read "checks" in the build_ride result. If a check fails and you can fix it (a different distance, max_stops, prefer, include or exclude, or a wider search), fix it and build again. Stop after two or three attempts and tell the rider honestly what didn't fit.
5. Call show_ride once with one short "why" per stop (one sentence, under 25 words) and a two-sentence summary.
6. Finally reply in 2-4 short sentences. The map, stop cards and your step log already show the details, so don't list every stop again.

If the rider is riding with a friend and mentions the friend's favourites, include them with who: "friend". Stops are then picked to suit both; mention which stops both of you will like (likedBy "both") and keep the friend's tastes in later searches.

When the rider asks for changes: for "shorter", "longer", "more food" or a particular stop, call build_ride again with the same search; only call find_places again if the start, finish or tastes change, or the area needs to be bigger. Then call show_ride again.

Ground every claim in tool results. "affinity" is Qloo's estimate (0 to 1) of how much people with the rider's tastes like a place; it does not say which favourite caused the match, so don't claim one did. Don't invent opening hours, prices, menus, traffic or road conditions, or other facts about a place or route. You may use the place's tags and category. If dataSource is "demo", tell the rider these are sample places, not live Qloo results. If route.source is "estimate", say the distance is approximate.

Keep it upbeat and brief.`;

const TASTES_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'e.g. "Spirited Away", "Prateek Kuhad", "masala dosa".' },
      category: {
        type: 'string',
        enum: TASTE_CATEGORIES,
        description: 'Use "food" for dishes, drinks and cuisines (e.g. "filter coffee", "ramen"); they are matched to Qloo taste tags.',
      },
      who: {
        type: 'string',
        enum: ['you', 'friend'],
        description: 'Whose favourite this is. Use "friend" for a friend riding along; default "you".',
      },
    },
    required: ['name'],
  },
};

const TOOLS = [
  {
    name: 'find_places',
    description:
      "Looks up the rider's favourites in Qloo's taste graph and asks Qloo which nearby places people with those tastes like. Returns what each favourite matched, the candidate places with Qloo affinity scores, and any problems (unrecognised tastes, few places, missing stop types). Call again with changes to fix problems.",
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Where the ride starts: neighbourhood and city, a landmark, or "lat,lon".' },
        end: { type: 'string', description: 'Where the ride ends. Omit to loop back to the start.' },
        distance_km: { type: 'number', description: 'Target ride length in km (3-120). Sets the default search radius.' },
        tastes: TASTES_SCHEMA,
        radius_km: { type: 'number', description: 'Search radius in km (1-40). Omit for the default, which covers what the ride can reach.' },
      },
      required: ['start', 'tastes'],
    },
  },
  {
    name: 'build_ride',
    description:
      'Builds a bike ride from the latest find_places candidates: picks stops that balance Qloo affinity, variety and distance, then routes it by bike. Returns the ride and checks against what was asked. Call again with changes to fix failed checks.',
    input_schema: {
      type: 'object',
      properties: {
        distance_km: { type: 'number', description: 'Target ride length in km (3-120). Defaults to the distance given to find_places.' },
        prefer: {
          type: 'object',
          description: 'Weights for stop types: 0 = exclude, 1 = normal, 2 = strongly prefer.',
          properties: {
            cafe: { type: 'number' },
            food: { type: 'number' },
            culture: { type: 'number', description: 'Theatres, music venues, cinemas, bookshops.' },
            sight: { type: 'number' },
            stay: { type: 'number', description: 'Hotels and other places to stay. Excluded (0) unless the rider asks.' },
          },
        },
        max_stops: { type: 'integer', description: 'How many stops (1-6). Default 3.' },
        include_stop_ids: { type: 'array', items: { type: 'string' }, description: 'Candidate ids that must be stops.' },
        exclude_stop_ids: { type: 'array', items: { type: 'string' }, description: 'Candidate ids that must not be stops.' },
      },
    },
  },
  {
    name: 'show_ride',
    description: "Shows the latest built ride on the rider's map with a short reason for each stop. Call after build_ride.",
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two sentences describing the ride.' },
        reasons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stop_id: { type: 'string' },
              why: { type: 'string', description: 'One sentence on why this stop fits the rider.' },
            },
            required: ['stop_id', 'why'],
          },
        },
      },
      required: ['summary', 'reasons'],
    },
  },
];

const round2 = (x) => Math.round(x * 100) / 100;

function tasteLabels(tastes, withFriend) {
  return tastes.map((t) => {
    const as = t.kind === 'tag' ? ' (Qloo taste tag)' : t.type ? ` (${t.type.replace('urn:entity:', '')})` : '';
    const whose = withFriend && t.who === 'friend' ? 'friend: ' : '';
    return whose + (t.name === t.query ? `${t.name}${as}` : `${t.query} -> ${t.name}${as}`);
  });
}

function countByCategory(places) {
  const counts = {};
  for (const p of places) counts[p.category] = (counts[p.category] ?? 0) + 1;
  return counts;
}

/** The best few places of each type, then the best overall, so the model sees the variety on offer. */
function shownCandidates(candidates) {
  const shown = new Set();
  for (const type of STOP_TYPES) {
    candidates.filter((c) => c.category === type).slice(0, PER_CATEGORY).forEach((c) => shown.add(c));
  }
  for (const c of candidates) {
    if (shown.size >= CANDIDATES_SHOWN) break;
    shown.add(c);
  }
  return [...shown]
    .sort((a, b) => b.affinity - a.affinity)
    .map((c) => ({
      stop_id: c.id,
      name: c.name,
      category: c.category,
      affinity: round2(c.affinity),
      ...(c.likedBy ? { likedBy: c.likedBy } : {}),
      tags: c.tags.slice(0, 3),
    }));
}

/** Problems with a search that the agent may be able to fix by searching again. */
function searchProblems(search) {
  const problems = [];
  if (search.missingTastes.length) problems.push(`Qloo didn't recognise: ${search.missingTastes.join(', ')}.`);
  const usable = search.candidates.filter((c) => STOP_TYPES.includes(c.category));
  if (usable.length < FEW_CANDIDATES) problems.push(`Only ${usable.length} usable places within ${Math.round(search.radiusKm)} km.`);
  const counts = countByCategory(usable);
  const lacking = ['cafe', 'food', 'sight'].filter((type) => !counts[type]);
  if (lacking.length) problems.push(`No ${lacking.join(' or ')} places found.`);
  return problems;
}

/** Compares a built ride with what was asked for. Each check passes or says what's wrong. */
export function rideChecks(ride, { maxStops = 3, prefer = {}, include = [] } = {}) {
  const checks = [];
  const km = ride.route.distanceKm;
  const asked = ride.requestedKm;
  if (km < asked * 0.75) checks.push({ ok: false, check: 'distance', note: `${km} km is well short of the ${asked} km asked for. Try more stops or a wider search.` });
  else if (km > asked * 1.25) checks.push({ ok: false, check: 'distance', note: `${km} km is well over the ${asked} km asked for. Try fewer or closer stops.` });
  else checks.push({ ok: true, check: 'distance', note: `${km} km for ${asked} km asked.` });

  const wanted = Math.min(Math.max(Math.round(Number(maxStops) || 3), 1), 6);
  if (ride.stops.length < wanted) {
    checks.push({ ok: false, check: 'stops', note: `Only ${ride.stops.length} of ${wanted} stops fit. Try a longer ride, a wider search or other stop types.` });
  }
  // Rides should mix stop types, unless the rider ruled the other types out ("only cafés").
  const allowedTypes = ['cafe', 'food', 'culture', 'sight'].filter((type) => (prefer[type] ?? 1) > 0);
  const types = new Set(ride.stops.map((s) => s.category));
  if (ride.stops.length >= 2 && types.size === 1 && allowedTypes.length > 1) {
    checks.push({ ok: false, check: 'variety', note: `All ${ride.stops.length} stops are ${[...types][0]} stops. Try prefer to mix in other types.` });
  }
  for (const [type, weight] of Object.entries(prefer)) {
    if (weight >= 2 && !ride.stops.some((s) => s.category === type)) {
      checks.push({ ok: false, check: 'preference', note: `The rider wants more ${type} stops, but the ride has none.` });
    }
    if (weight === 0 && ride.stops.some((s) => s.category === type)) {
      checks.push({ ok: false, check: 'preference', note: `The ride has a ${type} stop, which the rider didn't want.` });
    }
  }
  const missing = include.filter((id) => !ride.stops.some((s) => s.id === id));
  if (missing.length) checks.push({ ok: false, check: 'include', note: `Not among the candidates, so not included: ${missing.join(', ')}.` });
  if (ride.route.source === 'estimate') checks.push({ ok: true, check: 'route', note: 'Routing service unavailable: distance is an estimate.' });
  return checks;
}

/** What the model sees from a built ride: enough to explain it, without the route geometry. */
function rideForModel(ride, checks) {
  return {
    dataSource: ride.dataSource,
    start: ride.start.label,
    end: ride.loop ? '(loop back to start)' : ride.end.label,
    requestedKm: ride.requestedKm,
    route: { distanceKm: ride.route.distanceKm, durationMin: ride.route.durationMin, source: ride.route.source },
    ...(ride.withFriend ? { withFriend: true, friendStats: ride.friendStats } : {}),
    stops: ride.stops.map((s) => ({
      stop_id: s.id,
      order: s.order,
      name: s.name,
      category: s.category,
      affinity: round2(s.affinity),
      ...(s.likedBy
        ? {
            likedBy: s.likedBy,
            affinityYou: s.affinityYou === null ? null : round2(s.affinityYou),
            affinityFriend: s.affinityFriend === null ? null : round2(s.affinityFriend),
          }
        : {}),
      atKm: s.atKm,
      tags: s.tags,
      address: s.address,
    })),
    checks,
    allChecksPassed: checks.every((c) => c.ok),
  };
}

function asString(x) {
  return typeof x === 'string' ? x : '';
}

function asIds(x) {
  return (Array.isArray(x) ? x : []).map(asString).filter(Boolean);
}

function parseTastes(input) {
  return (Array.isArray(input) ? input : [])
    .map((t) => ({ name: asString(t?.name).trim(), category: asString(t?.category), who: t?.who === 'friend' ? 'friend' : 'you' }))
    .filter((t) => t.name);
}

const listCounts = (counts) => Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(', ');

/** Runs one tool. Returns the tool result for the model and the steps to show the rider. */
async function runTool(name, input, session, turn, planDeps) {
  if (name === 'find_places') {
    try {
      const search = await gatherCandidates({
        start: asString(input.start),
        end: asString(input.end),
        distanceKm: input.distance_km,
        tastes: parseTastes(input.tastes),
        radiusKm: input.radius_km,
      }, planDeps);
      session.search = search;
      const again = turn.searches++ > 0;
      const problems = searchProblems(search);
      const usable = search.candidates.filter((c) => STOP_TYPES.includes(c.category));
      const steps = [
        { status: 'ok', text: `Matched in Qloo: ${tasteLabels(search.found, search.withFriend).join(' · ')}` },
        {
          status: again ? 'retry' : 'ok',
          text: `${again ? 'Searched again' : 'Asked Qloo for places'} within ${Math.round(search.radiusKm)} km of ${search.start.label}: ${usable.length} found${usable.length ? ` (${listCounts(countByCategory(usable))})` : ''}`,
        },
        ...problems.map((p) => ({ status: 'warn', text: p })),
      ];
      return {
        content: JSON.stringify({
          dataSource: qlooIsLive() ? 'qloo' : 'demo',
          start: search.start.label,
          end: search.loop ? '(loop back to start)' : search.end.label,
          searchRadiusKm: Math.round(search.radiusKm * 10) / 10,
          tastesRecognised: tasteLabels(search.found, search.withFriend),
          missingTastes: search.missingTastes,
          candidatesFound: usable.length,
          byCategory: countByCategory(usable),
          ...(search.withFriend ? { withFriend: true, friendStats: search.friendStats } : {}),
          candidates: shownCandidates(usable),
          problems,
        }),
        steps,
      };
    } catch (err) {
      const message = err instanceof PlanError ? err.message : `Search failed: ${err.message}`;
      return { content: message, isError: true, steps: [{ status: 'error', text: message }] };
    }
  }

  if (name === 'build_ride') {
    if (!session.search) return { content: 'No places yet. Call find_places first.', isError: true, steps: [] };
    const options = {
      distanceKm: input.distance_km ?? session.search.distanceKm,
      prefer: input.prefer && typeof input.prefer === 'object' ? input.prefer : {},
      maxStops: input.max_stops,
      include: asIds(input.include_stop_ids),
      exclude: asIds(input.exclude_stop_ids),
    };
    try {
      const ride = await assembleRide(session.search, options, planDeps);
      session.ride = ride;
      const checks = rideChecks(ride, options);
      const again = turn.builds++ > 0;
      const shape = ride.loop ? 'loop' : 'one-way ride';
      const steps = [
        { status: again ? 'retry' : 'ok', text: `${again ? 'Rebuilt' : 'Built'} a ${ride.route.distanceKm} km ${shape} with ${ride.stops.length} stop${ride.stops.length === 1 ? '' : 's'}` },
        ...checks.filter((c) => !c.ok).map((c) => ({ status: 'warn', text: `Check: ${c.note}` })),
      ];
      if (checks.every((c) => c.ok)) steps.push({ status: 'ok', text: 'Checked distance, stops and preferences: all fit' });
      return { content: JSON.stringify(rideForModel(ride, checks)), steps };
    } catch (err) {
      const message = err instanceof PlanError ? err.message : `Building the ride failed: ${err.message}`;
      return { content: message, isError: true, steps: [{ status: 'error', text: message }] };
    }
  }

  if (name === 'show_ride') {
    if (!session.ride) return { content: 'No ride built yet. Call build_ride first.', isError: true, steps: [] };
    const reasons = new Map(
      (Array.isArray(input.reasons) ? input.reasons : []).map((r) => [asString(r?.stop_id), asString(r?.why)]),
    );
    session.ride = {
      ...session.ride,
      summary: asString(input.summary),
      stops: session.ride.stops.map((s) => (reasons.get(s.id) ? { ...s, why: reasons.get(s.id) } : s)),
    };
    return { content: 'Shown on the map.', steps: [{ status: 'ok', text: 'Wrote why each stop fits you' }] };
  }

  return { content: `Unknown tool ${name}`, isError: true, steps: [] };
}

export function createAgent({ client, planDeps } = {}) {
  const anthropic = client ?? new Anthropic({ apiKey: config.anthropicApiKey });

  /**
   * Runs one rider message through the agent. `session` keeps {messages, search, ride} between calls.
   * Returns the reply, the latest ride and the steps the agent took for this message.
   */
  async function chat(session, userText) {
    // Append-only history: earlier turns (including thinking blocks) are never edited.
    session.messages.push({ role: 'user', content: userText });
    const turn = { steps: [], searches: 0, builds: 0 };
    const done = (reply) => ({ reply, ride: session.ride ?? null, steps: turn.steps });

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.beta.messages.create({
        model: config.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: session.messages,
      });
      session.messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') return done("Sorry, I can't help with that one. Want to plan a ride instead?");
      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !toolUses.length) {
        const reply = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        return done(reply || 'Your ride is on the map.');
      }

      // All tool results go back in a single user message.
      const results = [];
      for (const use of toolUses) {
        const { content, isError, steps } = await runTool(use.name, use.input ?? {}, session, turn, planDeps);
        turn.steps.push(...steps);
        results.push({ type: 'tool_result', tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
      }
      session.messages.push({ role: 'user', content: results });
    }

    return done('That took more steps than expected. Your latest ride is on the map.');
  }

  return { chat };
}
