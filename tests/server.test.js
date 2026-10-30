import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { AgentUnavailableError } from '../src/agent.js';
import { offlineFetch } from './helpers.js';

config.qlooApiKey = ''; // demo data

let server;
let base;
const chats = [];

before(async () => {
  const agent = {
    chat: async (session, message) => {
      chats.push({ session, message });
      return { reply: `echo: ${message}`, ride: null };
    },
  };
  server = createApp({ agent, planDeps: { fetchImpl: offlineFetch } });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/status reports agent and data mode', async () => {
  const res = await fetch(`${base}/api/status`);
  assert.deepEqual(await res.json(), { agent: true, qloo: 'demo' });
});

test('POST /api/plan returns a ride from comma-separated tastes', async () => {
  const res = await post('/api/plan', { start: '18.5236,73.841', distanceKm: 12, tastes: 'Spirited Away, masala dosa' });
  assert.equal(res.status, 200);
  const { ride } = await res.json();
  assert.equal(ride.tastes.length, 2);
  assert.ok(ride.stops.length > 0);
});

test('POST /api/plan plans for a friend too', async () => {
  const res = await post('/api/plan', { start: '18.5236,73.841', distanceKm: 12, tastes: 'Spirited Away', friendTastes: 'Coldplay, momos' });
  const { ride } = await res.json();
  assert.equal(ride.withFriend, true);
  assert.deepEqual(ride.tastes.map((t) => t.who), ['you', 'friend', 'friend']);
});

test('POST /api/plan applies stop-type weights from the tweak buttons and ignores bad ones', async () => {
  const ride = async (prefer) => (await (await post('/api/plan', { start: '18.5236,73.841', distanceKm: 15, tastes: 'Spirited Away, filter coffee', prefer })).json()).ride;
  const cafesOnly = await ride({ cafe: 1, food: 0, culture: 0, sight: 0 });
  assert.ok(cafesOnly.stops.length > 0);
  assert.ok(cafesOnly.stops.every((s) => s.category === 'cafe'));

  const junk = await ride({ cafe: 'lots', food: null, sight: Infinity, hotel: 5 });
  assert.ok(junk.stops.length > 0);
  assert.ok(junk.stops.every((s) => Number.isFinite(s.affinity)));
});

test('POST /api/plan explains bad input with 422', async () => {
  const res = await post('/api/plan', { start: '18.5,73.8', tastes: '' });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /at least one/);
});

test('POST /api/chat keeps a session across messages', async () => {
  const first = await (await post('/api/chat', { message: 'hello' })).json();
  assert.equal(first.reply, 'echo: hello');
  const second = await (await post('/api/chat', { sessionId: first.sessionId, message: 'again' })).json();
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(chats.at(-1).session, chats.at(-2).session);
});

test('POST /api/chat rejects empty messages and bad JSON', async () => {
  assert.equal((await post('/api/chat', { message: '  ' })).status, 400);
  const res = await fetch(`${base}/api/chat`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('POST /api/chat pauses chat when Claude is unavailable, so the app falls back to the quick planner', async () => {
  let calls = 0;
  const outOfCredits = {
    chat: async () => {
      calls++;
      throw Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error' } }, 'Your credit balance is too low', new Headers());
    },
  };
  const app = createApp({ agent: outOfCredits, planDeps: { fetchImpl: offlineFetch } });
  await new Promise((resolve) => app.listen(0, resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  const chat = () => fetch(`${url}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'plan a ride' }) });
  try {
    const res = await chat();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.agentDown, true);
    assert.doesNotMatch(body.error, /credit/); // the raw API error stays in the server log
    assert.equal((await (await fetch(`${url}/api/status`)).json()).agent, false);

    // While paused, chat answers at once without calling Claude again.
    assert.equal((await chat()).status, 503);
    assert.equal(calls, 1);
  } finally {
    app.close();
  }
});

test('serves the web app and blocks path traversal', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>RideTaste<\/title>/);
  const sneaky = await fetch(`${base}/..%2fpackage.json`);
  assert.notEqual(sneaky.status, 200);
});

test('POST /api/chat also pauses chat when OpenAI is unavailable', async () => {
  const noCredits = { chat: async () => { throw new AgentUnavailableError('OpenAI 429: You exceeded your current quota', 429); } };
  const app = createApp({ agent: noCredits, planDeps: { fetchImpl: offlineFetch } });
  await new Promise((resolve) => app.listen(0, resolve));
  try {
    const res = await fetch(`http://localhost:${app.address().port}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'plan a ride' }) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).agentDown, true);
  } finally {
    app.close();
  }
});
