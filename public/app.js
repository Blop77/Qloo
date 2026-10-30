// RideTaste web app: quick-plan form, chat with the agent, map and stop cards.

const $ = (id) => document.getElementById(id);

const state = {
  agent: false,
  sessionId: null,
  ride: null,
  busy: false,
  prefer: {}, // stop-type weights set by the tweak chips when the agent is off
};

// ---------- Map ----------

const map = L.map('map', { zoomControl: true }).setView([18.5204, 73.8567], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const rideLayer = L.layerGroup().addTo(map);

function numberIcon(label, extraClass = '') {
  return L.divIcon({
    className: '',
    html: `<div class="marker-num ${extraClass}">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

// ---------- Rendering ----------

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CATEGORY = { cafe: '☕ Café', food: '🍽️ Food', culture: '🎭 Culture', sight: '🌳 Sight', stay: '🏨 Stay', other: '📍 Stop' };

function renderRide(ride) {
  state.ride = ride;
  rideLayer.clearLayers();
  $('empty').hidden = Boolean(ride);
  if (!ride) return;

  const line = L.polyline(ride.route.geometry, { color: '#c2410c', weight: 5, opacity: 0.85 }).addTo(rideLayer);
  L.marker([ride.start.lat, ride.start.lon], { icon: numberIcon('S', 'marker-start'), title: 'Start' })
    .bindPopup(`<strong>Start</strong><br>${escapeHtml(ride.start.label)}`)
    .addTo(rideLayer);
  if (!ride.loop) {
    L.marker([ride.end.lat, ride.end.lon], { icon: numberIcon('F', 'marker-start'), title: 'Finish' })
      .bindPopup(`<strong>Finish</strong><br>${escapeHtml(ride.end.label)}`)
      .addTo(rideLayer);
  }
  for (const s of ride.stops) {
    L.marker([s.lat, s.lon], { icon: numberIcon(s.order), title: s.name })
      .bindPopup(`<strong>${s.order}. ${escapeHtml(s.name)}</strong><br>${escapeHtml(s.why)}`)
      .addTo(rideLayer);
  }
  map.fitBounds(line.getBounds(), { padding: [30, 30] });

  const notes = [];
  if (ride.dataSource === 'demo') notes.push('<span class="warn">Sample places, not live Qloo results.</span>');
  if (ride.route.source === 'estimate') notes.push('<span class="warn">Approximate distance (routing service unavailable).</span>');
  if (Math.abs(ride.route.distanceKm - ride.requestedKm) > ride.requestedKm * 0.25) {
    notes.push(`<span class="warn">You asked for ${ride.requestedKm} km: no good stops fit that distance exactly.</span>`);
  }
  if (ride.missingTastes?.length) notes.push(`<span class="warn">Qloo didn't recognise: ${escapeHtml(ride.missingTastes.join(', '))}</span>`);

  const summary = $('ride-summary');
  summary.hidden = false;
  summary.innerHTML = `
    ${ride.summary ? `<p>${escapeHtml(ride.summary)}</p>` : ''}
    <span><strong>${ride.route.distanceKm} km</strong> ${ride.loop ? 'loop' : 'one way'}</span>
    <span><strong>~${formatDuration(ride.route.durationMin)}</strong> riding</span>
    <span><strong>${ride.stops.length}</strong> stop${ride.stops.length === 1 ? '' : 's'}</span>
    ${notes.join(' ')}
    <button type="button" class="gpx" id="gpx-btn">Download GPX</button>`;
  $('gpx-btn').addEventListener('click', () => downloadGpx(ride));

  renderHowQloo(ride);

  $('stops').innerHTML = ride.stops.length
    ? ride.stops.map(stopCard).join('')
    : '<li class="note">No stops fit this ride. Try a longer distance or different favourites.</li>';
}

function stopCard(s) {
  const pct = Math.round(s.affinity * 100);
  const maps = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`;
  return `
    <li class="stop">
      <div class="stop-num">${s.order}</div>
      <div>
        <h3>${escapeHtml(s.name)}</h3>
        <div class="meta">
          <span>${CATEGORY[s.category] ?? CATEGORY.other}</span>
          ${s.likedBy ? friendMatch(s) : `<span class="affinity" title="How much people with your taste like this place">
            <span class="affinity-bar"><span style="width:${pct}%"></span></span>${pct}% match
          </span>`}
          <span>at km ${s.atKm}</span>
        </div>
        <p class="why">${escapeHtml(s.why)}</p>
        ${s.tags?.length ? `<div class="tags" title="Tags Qloo returned for this place">${s.tags.slice(0, 4).map((t) => `<span>${escapeHtml(tagLabel(t))}</span>`).join('')}</div>` : ''}
        <div class="links">
          ${s.address ? `${escapeHtml(s.address)} · ` : ''}<a href="${maps}" target="_blank" rel="noopener">Open in Maps</a>
        </div>
      </div>
    </li>`;
}

/** Match scores for each rider when riding with a friend. */
function friendMatch(s) {
  const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
  const label = { both: '👯 Both of you', you: 'Mostly you', friend: 'Mostly your friend' }[s.likedBy];
  return `<span class="liked-by ${s.likedBy}">${label}</span>
    <span title="Qloo affinity for each rider">you ${pct(s.affinityYou)} · friend ${pct(s.affinityFriend)}</span>`;
}

// Qloo tags can be names ("Coffee Shop") or ids ("urn:tag:category:place:coffee_shop").
function tagLabel(tag) {
  const last = String(tag).split(':').pop().replace(/_/g, ' ');
  return last.charAt(0).toUpperCase() + last.slice(1);
}

const TYPE_LABEL = {
  'urn:entity:artist': 'artist',
  'urn:entity:movie': 'film',
  'urn:entity:tv_show': 'TV show',
  'urn:entity:book': 'book',
  'urn:entity:podcast': 'podcast',
  'urn:entity:video_game': 'video game',
  'urn:entity:brand': 'brand',
  'urn:entity:person': 'person',
  'urn:entity:place': 'place',
  'urn:entity:destination': 'destination',
  tag: 'food & drink tag',
};

/** Explains the three steps from favourites to stops, using this ride's own data. */
function renderHowQloo(ride) {
  const panel = $('how-qloo');
  panel.hidden = false;
  const demo = ride.dataSource === 'demo';
  const describe = (list) => list
    .map((t) => {
      const type = TYPE_LABEL[t.type] ? ` <span class="hint">(${TYPE_LABEL[t.type]})</span>` : '';
      const renamed = t.name !== t.query ? ` <span class="hint">for "${escapeHtml(t.query)}"</span>` : '';
      return `<strong>${escapeHtml(t.name)}</strong>${type}${renamed}`;
    })
    .join(' · ');
  const tastes = ride.withFriend
    ? `<br>You: ${describe(ride.tastes.filter((t) => t.who !== 'friend'))}<br>Your friend: ${describe(ride.tastes.filter((t) => t.who === 'friend'))}`
    : describe(ride.tastes);
  const f = ride.friendStats;
  const places = ride.withFriend
    ? `It ran once for each of you: <strong>${f.you}</strong> places for you, <strong>${f.friend}</strong> for your friend,
      and <strong>${f.both}</strong> that appeared for both. Each comes with an affinity score per rider.`
    : `It returned <strong>${ride.candidatesConsidered}</strong>, each with an affinity score (the "% match" on each stop).`;
  const pick = ride.withFriend
    ? `places you'd <em>both</em> enjoy (Qloo affinities combined, so a stop only scores high if it suits both of you)`
    : 'Qloo affinity';
  const missing = ride.missingTastes?.length ? ` Qloo didn't find: ${escapeHtml(ride.missingTastes.join(', '))}.` : '';
  $('how-qloo-demo').hidden = !demo;
  $('how-qloo-steps').innerHTML = `
    <li><strong>Your taste → Qloo's taste graph.</strong> Qloo's Search and Tags APIs matched your favourites: ${tastes}.${missing}</li>
    <li><strong>Taste → places.</strong> Qloo's Insights API looked within ${ride.searchRadiusKm} km of ${escapeHtml(ride.start.label)}
      for places that people with this taste enjoy. ${places}</li>
    <li><strong>Places → your ride.</strong> RideTaste picked the ${ride.stops.length} stop${ride.stops.length === 1 ? '' : 's'} with the best mix of
      ${pick}, variety (cafés, food, culture, sights) and fit to your ${ride.requestedKm} km, then routed it by bike.</li>`;
}

function formatDuration(min) {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

function downloadGpx(ride) {
  const pts = ride.route.geometry.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('');
  const wpts = ride.stops.map((s) => `<wpt lat="${s.lat}" lon="${s.lon}"><name>${escapeHtml(`${s.order}. ${s.name}`)}</name></wpt>`).join('');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RideTaste" xmlns="http://www.topografix.com/GPX/1/1">${wpts}<trk><name>RideTaste ride</name><trkseg>${pts}</trkseg></trk></gpx>`;
  const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'ridetaste-ride.gpx' });
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Chat ----------

// The agent sometimes writes **bold**; show it as bold instead of raw asterisks. Everything else is escaped.
function formatReply(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function addMessage(kind, text) {
  const li = document.createElement('li');
  li.className = kind;
  if (kind === 'bot') li.innerHTML = formatReply(text);
  else li.textContent = text;
  $('messages').append(li);
  li.scrollIntoView({ block: 'nearest' });
  return li;
}

const STEP_ICON = { ok: '✓', retry: '↻', warn: '!', error: '✗' };

/** The agent's step log for one message: searches, checks and the fixes it made. */
function addSteps(steps) {
  const fixes = steps.filter((s) => s.status === 'retry').length;
  const li = document.createElement('li');
  li.className = 'steps';
  li.innerHTML = `
    <details open>
      <summary>🧭 What the agent did · ${steps.length} step${steps.length === 1 ? '' : 's'}${fixes ? ` · ${fixes} fix${fixes === 1 ? '' : 'es'}` : ''}</summary>
      <ol>${steps.map((s) => `<li class="step-${escapeHtml(s.status)}"><span class="icon" aria-hidden="true">${STEP_ICON[s.status] ?? '·'}</span><span>${escapeHtml(s.text)}</span></li>`).join('')}</ol>
    </details>`;
  $('messages').append(li);
  return li;
}

function setBusy(busy) {
  state.busy = busy;
  for (const el of document.querySelectorAll('button, #chat-input')) el.disabled = busy;
  $('plan-btn').textContent = busy ? 'Planning…' : 'Plan my ride';
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { agentDown: Boolean(data.agentDown) });
  return data;
}

// Returns false when the AI agent is unavailable (e.g. out of credits), so the form can plan without it.
async function sendChat(text) {
  if (state.busy || !text.trim()) return true;
  addMessage('user', text);
  const typing = addMessage('bot typing', 'Planning your ride…');
  setBusy(true);
  try {
    const data = await postJson('/api/chat', { sessionId: state.sessionId, message: text });
    state.sessionId = data.sessionId;
    typing.remove();
    if (data.steps?.length) addSteps(data.steps);
    addMessage('bot', data.reply);
    if (data.ride) showResults(data.ride);
    return true;
  } catch (err) {
    typing.remove();
    if (!err.agentDown) {
      addMessage('error', err.message);
      return true;
    }
    setAgentMode(false);
    addMessage('bot', err.message);
    return false;
  } finally {
    setBusy(false);
  }
}

function showResults(ride) {
  renderRide(ride);
  if (window.matchMedia('(max-width: 820px)').matches) $('map').scrollIntoView({ behavior: 'smooth' });
}

// ---------- Quick plan form ----------

$('distance').addEventListener('input', (e) => ($('distance-out').value = e.target.value));

// One-click examples, so a first-time visitor sees a full ride without thinking up inputs.
const EXAMPLES = [
  { start: 'FC Road, Pune', distanceKm: 12, tastes: 'Spirited Away, Studio Ghibli, filter coffee' },
  { start: 'Koregaon Park, Pune', distanceKm: 15, tastes: 'Prateek Kuhad, The Local Train, misal pav' },
  { start: 'Washington Square Park, New York', distanceKm: 15, tastes: 'The Grand Budapest Hotel, Vampire Weekend, bagels' },
  { start: 'FC Road, Pune', distanceKm: 15, tastes: 'Spirited Away, Prateek Kuhad, filter coffee', friendTastes: 'Coldplay, Harry Potter, momos' },
];

for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => {
    const ex = EXAMPLES[Number(button.dataset.example)];
    $('start').value = ex.start;
    $('distance').value = ex.distanceKm;
    $('distance-out').value = ex.distanceKm;
    $('tastes').value = ex.tastes;
    $('friend-tastes').value = ex.friendTastes ?? '';
    $('plan-form').requestSubmit();
  });
}

function formRequest() {
  return {
    start: $('start').value.trim(),
    distanceKm: Number($('distance').value),
    tastes: $('tastes').value.trim(),
    friendTastes: $('friend-tastes').value.trim(),
  };
}

$('plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.prefer = {};
  const { start, distanceKm, tastes, friendTastes } = formRequest();

  if (state.agent) {
    const friend = friendTastes ? ` I'm riding with a friend who loves: ${friendTastes}.` : '';
    if (await sendChat(`I'm starting from ${start} and want to ride about ${distanceKm} km. Things I love: ${tastes}.${friend}`)) return;
    // The agent is unavailable: plan the same ride with the quick planner below.
  }

  setBusy(true);
  try {
    const { ride } = await postJson('/api/plan', { start, distanceKm, tastes, friendTastes });
    showResults(ride);
  } catch (err) {
    $('empty').hidden = false;
    $('empty').textContent = err.message;
  } finally {
    setBusy(false);
  }
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value;
  $('chat-input').value = '';
  sendChat(text);
});

// ---------- Tweaks without the agent ----------

// When the AI chat is off, the suggestion chips still change the ride: they shorten the form's
// distance or change the stop-type weights, then re-plan with the quick planner so Qloo picks again.
async function tweakRide(kind, label) {
  if (state.busy) return;
  if (label) addMessage('user', label);
  if (kind === 'shorter') {
    const km = Math.max(Number($('distance').min), Math.round(Number($('distance').value) * 0.7));
    $('distance').value = km;
    $('distance-out').value = km;
  } else if (kind === 'food') {
    state.prefer = { ...state.prefer, food: 2, sight: 0.5 };
  } else if (kind === 'cafes') {
    state.prefer = { cafe: 1, food: 0, culture: 0, sight: 0 };
  }
  const typing = addMessage('bot typing', 'Planning your ride…');
  setBusy(true);
  try {
    const { ride } = await postJson('/api/plan', { ...formRequest(), prefer: state.prefer });
    typing.remove();
    showResults(ride);
    const n = ride.stops.length;
    addMessage('bot', n
      ? `Done: ${n} stop${n === 1 ? '' : 's'}, picked again by Qloo. The map shows the new ride.`
      : 'No stops of that kind fit this ride. Try a longer distance or another button.');
  } catch (err) {
    typing.remove();
    addMessage('error', err.message);
  } finally {
    setBusy(false);
  }
}

for (const chip of document.querySelectorAll('[data-say]')) {
  chip.addEventListener('click', async () => {
    if (!state.agent) return tweakRide(chip.dataset.tweak, chip.textContent);
    if (!(await sendChat(chip.dataset.say))) tweakRide(chip.dataset.tweak);
  });
}

// ---------- Startup ----------

// With the agent off, the chat card keeps its tweak chips but hides the free-text box.
function setAgentMode(on) {
  state.agent = on;
  $('chat').hidden = false;
  $('chat-title').textContent = on ? 'Chat with your ride buddy' : 'Tweak your ride';
  $('chat-form').hidden = !on;
  $('no-agent').hidden = on;
}

(async () => {
  try {
    const status = await (await fetch('/api/status')).json();
    setAgentMode(status.agent);
    const badge = $('data-badge');
    badge.hidden = false;
    badge.textContent = status.qloo === 'live' ? 'Live Qloo data' : 'Demo data';
    badge.classList.toggle('demo', status.qloo !== 'live');
    if (status.agent) addMessage('bot', "Hi! Tell me where you're starting, how far you want to ride, and a few films, music or foods you love. Or fill in the form above.");
  } catch {
    setAgentMode(false);
  }
})();
