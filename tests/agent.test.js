import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, rideChecks } from '../src/agent.js';
import { config } from '../src/config.js';
import { offlineFetch } from './helpers.js';

config.qlooApiKey = ''; // demo data

/** A stand-in for the Anthropic client that replays scripted responses. */
function scriptedClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error('no more scripted responses');
          return typeof next === 'function' ? next(params) : next;
        },
      },
    },
  };
}

const toolUse = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });

const lastResult = (params) => params.messages.at(-1).content[0];

test('agent finds places, builds a ride, attaches reasons and replies', async () => {
  const client = scriptedClient([
    toolUse('t1', 'find_places', { start: '18.5236,73.841', distance_km: 12, tastes: [{ name: 'Studio Ghibli', category: 'movie' }] }),
    (params) => {
      const result = lastResult(params);
      assert.equal(result.tool_use_id, 't1');
      const search = JSON.parse(result.content);
      assert.equal(search.dataSource, 'demo');
      assert.ok(search.candidates.length > 0);
      assert.ok(search.tastesRecognised.length > 0);
      return toolUse('t2', 'build_ride', {});
    },
    (params) => {
      const ride = JSON.parse(lastResult(params).content);
      assert.ok(Array.isArray(ride.checks));
      return toolUse('t3', 'show_ride', {
        summary: 'A calm loop.',
        reasons: [{ stop_id: ride.stops[0].stop_id, why: 'Quiet and green, like a Ghibli film.' }],
      });
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Your ride is ready! (sample data)' }] },
  ]);

  const agent = createAgent({ client, planDeps: { fetchImpl: offlineFetch } });
  const session = { messages: [], ride: null };
  const { reply, ride, steps } = await agent.chat(session, 'Ride from FC Road, I love Studio Ghibli');

  assert.equal(reply, 'Your ride is ready! (sample data)');
  assert.equal(ride.summary, 'A calm loop.');
  assert.equal(ride.stops[0].why, 'Quiet and green, like a Ghibli film.');
  assert.equal(ride.requestedKm, 12);
  assert.equal(client.requests.length, 4);
  assert.match(steps[0].text, /Matched in Qloo/);
  assert.ok(steps.some((s) => /^Built a /.test(s.text)));
  assert.equal(steps.at(-1).text, 'Wrote why each stop fits you');

  // Request shape: model, refusal fallbacks, effort.
  const req = client.requests[0];
  assert.equal(req.model, config.model);
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(req.output_config, { effort: 'medium' });
  assert.deepEqual(req.tools.map((t) => t.name), ['find_places', 'build_ride', 'show_ride']);
});

test('a failed check goes back to the agent, and the fix shows up as a retry step', async () => {
  const client = scriptedClient([
    toolUse('t1', 'find_places', { start: '18.5236,73.841', distance_km: 10, tastes: [{ name: 'coffee', category: 'food' }] }),
    toolUse('t2', 'build_ride', { prefer: { cafe: 1, food: 0, culture: 0, sight: 0, stay: 2 } }),
    (params) => {
      const ride = JSON.parse(lastResult(params).content);
      assert.equal(ride.allChecksPassed, false);
      assert.ok(ride.checks.some((c) => !c.ok && c.check === 'preference'));
      return toolUse('t3', 'build_ride', {});
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed it.' }] },
  ]);
  const { steps } = await createAgent({ client, planDeps: { fetchImpl: offlineFetch } }).chat({ messages: [], ride: null }, 'coffee ride');
  assert.ok(steps.some((s) => s.status === 'warn' && /^Check:/.test(s.text)));
  assert.ok(steps.some((s) => s.status === 'retry' && /^Rebuilt/.test(s.text)));
});

test('rideChecks flags distance, stop count, preferences and missing includes', () => {
  const ride = { requestedKm: 20, route: { distanceKm: 9, source: 'osrm' }, stops: [{ id: 'a', category: 'sight' }] };
  const checks = rideChecks(ride, { maxStops: 3, prefer: { food: 2, sight: 0 }, include: ['zzz'] });
  const failed = checks.filter((c) => !c.ok).map((c) => c.check);
  assert.deepEqual(failed.sort(), ['distance', 'include', 'preference', 'preference', 'stops']);

  const good = { requestedKm: 10, route: { distanceKm: 10.5, source: 'osrm' }, stops: [{ id: 'a', category: 'cafe' }] };
  assert.ok(rideChecks(good, { maxStops: 1 }).every((c) => c.ok));
});

test('rideChecks flags three stops of one type, unless the rider asked for only that type', () => {
  const ride = { requestedKm: 10, route: { distanceKm: 10, source: 'osrm' }, stops: ['a', 'b', 'c'].map((id) => ({ id, category: 'food' })) };
  assert.ok(rideChecks(ride).some((c) => !c.ok && c.check === 'variety'));
  const onlyFood = { cafe: 0, culture: 0, sight: 0 };
  assert.ok(rideChecks(ride, { prefer: onlyFood }).every((c) => c.check !== 'variety'));
});

test('build_ride before find_places is rejected', async () => {
  const client = scriptedClient([
    toolUse('t1', 'build_ride', {}),
    (params) => {
      assert.equal(lastResult(params).is_error, true);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    },
  ]);
  await createAgent({ client }).chat({ messages: [], ride: null }, 'hi');
});

test('history is append-only across turns', async () => {
  const client = scriptedClient([
    { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Where do you start?' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Got it.' }] },
  ]);
  const agent = createAgent({ client });
  const session = { messages: [], ride: null };
  await agent.chat(session, 'Plan me a ride');
  const firstTurn = structuredClone(session.messages);
  await agent.chat(session, 'From Kothrud');
  assert.deepEqual(session.messages.slice(0, firstTurn.length), firstTurn);
  assert.deepEqual(client.requests[1].messages.slice(0, firstTurn.length), firstTurn);
});

test('planning errors go back to the model as tool errors', async () => {
  const client = scriptedClient([
    toolUse('t1', 'find_places', { start: 'Nowhere-ville', tastes: [{ name: 'jazz' }] }),
    (params) => {
      const result = params.messages.at(-1).content[0];
      assert.equal(result.is_error, true);
      assert.match(result.content, /Couldn't find the start/);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Which city are you in?' }] };
    },
  ]);
  const agent = createAgent({ client, planDeps: { fetchImpl: offlineFetch } });
  const { reply, ride } = await agent.chat({ messages: [], ride: null }, 'Ride from Nowhere-ville');
  assert.equal(reply, 'Which city are you in?');
  assert.equal(ride, null);
});

test('show_ride before plan_ride is rejected', async () => {
  const client = scriptedClient([
    toolUse('t1', 'show_ride', { summary: 'x', reasons: [] }),
    (params) => {
      assert.equal(params.messages.at(-1).content[0].is_error, true);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    },
  ]);
  await createAgent({ client }).chat({ messages: [], ride: null }, 'hi');
});

test('a refusal gets a friendly reply', async () => {
  const client = scriptedClient([{ stop_reason: 'refusal', content: [] }]);
  const { reply } = await createAgent({ client }).chat({ messages: [], ride: null }, '...');
  assert.match(reply, /plan a ride instead/);
});

// ---------- ChatGPT (OpenAI) ----------

/** A stand-in for the OpenAI client that replays scripted Chat Completions responses. */
function scriptedOpenAI(responses) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        create: async (params) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error('no more scripted responses');
          return typeof next === 'function' ? next(params) : next;
        },
      },
    },
  };
}

const call = (id, name, input) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }],
});
const say = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }] });

test('ChatGPT: finds places, builds, shows the ride and replies', async () => {
  const client = scriptedOpenAI([
    call('c1', 'find_places', { start: '18.5236,73.841', distance_km: 12, tastes: [{ name: 'Studio Ghibli', category: 'movie' }] }),
    (params) => {
      const result = params.messages.at(-1);
      assert.equal(result.role, 'tool');
      assert.equal(result.tool_call_id, 'c1');
      assert.ok(JSON.parse(result.content).candidates.length > 0);
      return call('c2', 'build_ride', {});
    },
    (params) => {
      const ride = JSON.parse(params.messages.at(-1).content);
      return call('c3', 'show_ride', { summary: 'A calm loop.', reasons: [{ stop_id: ride.stops[0].stop_id, why: 'Green and quiet.' }] });
    },
    say('Your ride is ready!'),
  ]);

  const agent = createAgent({ client, planDeps: { fetchImpl: offlineFetch } });
  assert.equal(agent.provider, 'openai');
  const { reply, ride, steps } = await agent.chat({ messages: [], ride: null }, 'Ride from FC Road, I love Studio Ghibli');

  assert.equal(reply, 'Your ride is ready!');
  assert.equal(ride.summary, 'A calm loop.');
  assert.equal(ride.stops[0].why, 'Green and quiet.');
  assert.equal(steps.at(-1).text, 'Wrote why each stop fits you');

  const req = client.requests[0];
  assert.equal(req.model, config.openaiModel);
  assert.equal(req.messages[0].role, 'system');
  assert.deepEqual(req.tools.map((t) => t.function.name), ['find_places', 'build_ride', 'show_ride']);
  // The assistant's tool call is kept in history, followed by its tool result.
  const history = client.requests[1].messages;
  assert.equal(history.at(-2).tool_calls[0].id, 'c1');
});

test('ChatGPT: bad tool arguments and tool errors go back as tool messages', async () => {
  const client = scriptedOpenAI([
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'build_ride', arguments: '{not json' } }] } }] },
    (params) => {
      const result = params.messages.at(-1);
      assert.equal(result.role, 'tool');
      assert.match(result.content, /^Error: No places yet/);
      return say('Where are you starting?');
    },
  ]);
  const { reply } = await createAgent({ client }).chat({ messages: [], ride: null }, 'hi');
  assert.equal(reply, 'Where are you starting?');
});

test('ChatGPT: reasoning_effort is sent only when configured', async () => {
  const client = scriptedOpenAI([say('hi'), say('hi')]);
  const agent = createAgent({ client });
  await agent.chat({ messages: [], ride: null }, 'hello');
  assert.equal('reasoning_effort' in client.requests[0], false);
  config.openaiReasoningEffort = 'none';
  try {
    await agent.chat({ messages: [], ride: null }, 'hello');
    assert.equal(client.requests[1].reasoning_effort, 'none');
  } finally {
    config.openaiReasoningEffort = '';
  }
});

test('ChatGPT: a refusal gets a friendly reply', async () => {
  const client = scriptedOpenAI([{ choices: [{ message: { role: 'assistant', content: null, refusal: 'No.' } }] }]);
  const { reply } = await createAgent({ client }).chat({ messages: [], ride: null }, '...');
  assert.match(reply, /plan a ride instead/);
});
