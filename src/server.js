// HTTP server: serves the web app from public/ and the JSON API under /api.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { agentIsAvailable, agentProvider, config, qlooIsLive } from './config.js';
import { AgentUnavailableError, createAgent } from './agent.js';
import { planRide, PlanError } from './planner.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MAX_BODY_BYTES = 32 * 1024;
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
// When the AI model fails (no credits, bad key, overloaded, offline), chat pauses for a while and the
// web app plans with the quick planner instead, so rides keep working.
const AGENT_PAUSE_MS = 2 * 60 * 1000;
const AGENT_DOWN = 'The AI chat is taking a break, so rides come from the quick planner for now. Qloo still picks every stop.';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// Chat sessions live in memory. They are lost on restart, which is fine for a demo.
const sessions = new Map();

function getSession(id) {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.touched > SESSION_TTL_MS) sessions.delete(key);
  }
  let session = id && sessions.get(id);
  if (!session) {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    session = { id: randomUUID(), messages: [], ride: null, busy: false };
    sessions.set(session.id, session);
  }
  session.touched = now;
  return session;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function parseTastes(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;\n]/);
  return list
    .map((t) => (typeof t === 'string' ? { name: t.trim() } : { name: String(t?.name ?? '').trim(), category: t?.category }))
    .filter((t) => t.name)
    .slice(0, 8);
}

// Stop-type weights from the web app's tweak buttons: 0 = exclude, 1 = normal, 2 = strongly prefer.
const PREFER_KEYS = ['cafe', 'food', 'culture', 'sight', 'stay'];

function parsePrefer(raw) {
  const prefer = {};
  for (const key of PREFER_KEYS) {
    const weight = raw?.[key];
    if (typeof weight === 'number' && Number.isFinite(weight)) prefer[key] = Math.min(Math.max(weight, 0), 3);
  }
  return prefer;
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.resolve(PUBLIC_DIR, '.' + (urlPath === '/' ? '/index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

export function createApp({ agent, planDeps } = {}) {
  const rideAgent = agent ?? (agentIsAvailable() ? createAgent() : null);
  let agentPausedUntil = 0;
  const agentReady = () => Boolean(rideAgent) && Date.now() >= agentPausedUntil;

  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && pathname === '/api/status') {
        return sendJson(res, 200, { agent: agentReady(), qloo: qlooIsLive() ? 'live' : 'demo' });
      }

      // Quick plan: no AI agent, just the planning pipeline. Works without an AI key.
      if (req.method === 'POST' && pathname === '/api/plan') {
        const body = await readJson(req);
        const ride = await planRide({
          start: body.start,
          end: body.end,
          distanceKm: body.distanceKm,
          tastes: [...parseTastes(body.tastes), ...parseTastes(body.friendTastes).map((t) => ({ ...t, who: 'friend' }))],
          prefer: parsePrefer(body.prefer),
          maxStops: body.maxStops,
        }, planDeps);
        return sendJson(res, 200, { ride });
      }

      if (req.method === 'POST' && pathname === '/api/chat') {
        if (!rideAgent) return sendJson(res, 503, { error: 'The chat agent needs ANTHROPIC_API_KEY. Use the quick plan form instead.', agentDown: true });
        if (!agentReady()) return sendJson(res, 503, { error: AGENT_DOWN, agentDown: true });
        const body = await readJson(req);
        const message = String(body.message ?? '').trim().slice(0, 2000);
        if (!message) return sendJson(res, 400, { error: 'Message is empty' });
        const session = getSession(body.sessionId);
        if (session.busy) return sendJson(res, 409, { error: 'Still working on your last message.' });
        session.busy = true;
        try {
          const { reply, ride, steps } = await rideAgent.chat(session, message);
          return sendJson(res, 200, { sessionId: session.id, reply, ride, steps: steps ?? [] });
        } catch (err) {
          if (!(err instanceof Anthropic.APIError || err instanceof AgentUnavailableError)) throw err;
          if (err instanceof Anthropic.AuthenticationError) console.error('Anthropic authentication failed: check ANTHROPIC_API_KEY');
          if (err instanceof AgentUnavailableError && err.status === 401) console.error('OpenAI authentication failed: check OPENAI_API_KEY');
          console.error(`AI model unavailable (${err.status ?? err.name}), pausing chat: ${err.message}`);
          agentPausedUntil = Date.now() + AGENT_PAUSE_MS;
          return sendJson(res, 503, { error: AGENT_DOWN, agentDown: true });
        } finally {
          session.busy = false;
        }
      }

      if (req.method === 'GET' && !pathname.startsWith('/api/')) return await serveStatic(req, res);
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof PlanError) return sendJson(res, 422, { error: err.message });
      if (err.status === 400 || err.status === 413) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  });
}

// Start the server when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(config.port, () => {
    console.log(`RideTaste running at http://localhost:${config.port}`);
    console.log(`  Qloo:  ${qlooIsLive() ? 'live API' : 'DEMO sample data (set QLOO_API_KEY for real results)'}`);
    // Names only (never values), to spot a mistyped or empty OpenAI key setting.
    const openaiVars = Object.keys(process.env).filter((k) => /openai|chatgpt|gpt/i.test(k));
    console.log(`  OpenAI settings seen: ${openaiVars.map((k) => `"${k}"${process.env[k]?.trim() ? '' : ' (empty)'}`).join(', ') || 'none'}`);
    const agentModel = agentProvider() === 'openai' ? `OpenAI ${config.openaiModel}` : `Claude ${config.model}`;
    console.log(`  Agent: ${agentIsAvailable() ? agentModel : 'off (set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable chat)'}`);
  });
}
