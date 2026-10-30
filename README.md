# RideTaste 🚲

[![Tests](https://github.com/Blop77/Qloo/actions/workflows/test.yml/badge.svg)](https://github.com/Blop77/Qloo/actions/workflows/test.yml)

**An AI agent that plans bike rides around your taste.**

### 👉 Live demo: **[ridetaste.onrender.com](https://ridetaste.onrender.com)**

Try it in 30 seconds: tap **👯 Ride with a friend · Pune**, then open **"How Qloo picked these stops"** under the map.
(If the first load is slow, the free server is waking up; give it up to a minute.)

### 🎬 Demo video (56 s): **[youtu.be/au5etS24uRk](https://youtu.be/au5etS24uRk)**

[![Watch the RideTaste demo on YouTube](https://img.youtube.com/vi/au5etS24uRk/maxresdefault.jpg)](https://youtu.be/au5etS24uRk)

Tell it the films, music and food you love, where you're starting and how far you want to ride.
RideTaste asks **Qloo's Taste AI** which cafés, food spots and sights people with your taste enjoy,
picks the best stops that fit your distance, draws the route on a map and explains why each stop suits you.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com) (2026).

---

## How it works

```
 rider ──chat──► AI agent (ChatGPT)
                     │
                     ├──find_places──► geocode start (OpenStreetMap Nominatim)
                     │                 favourites → Qloo entities         (Qloo /search)
                     │                 foods & drinks → Qloo tags         (Qloo /v2/tags)
                     │                 entities + location → places       (Qloo /v2/insights)
                     │◄── matches, candidate places, problems ──┘
                     │     (wrong match? unrecognised taste? too few places? → search again)
                     │
                     ├──build_ride───► pick stops (taste vs distance) + bike route (OSRM bike profile)
                     │◄── ride + checks (distance, stop count, variety, preferences) ──┘
                     │     (a check failed? → change the plan and build again)
                     │
                     └──show_ride────► map + stop cards with "why this fits you"
                                       + "What the agent did" step log in the chat
```

**Qloo is the core of the app.** Without it there's no way to go from "I love *Spirited Away* and
Prateek Kuhad" to "this café and this lake". Qloo's cross-domain taste graph makes that jump:
your favourites become `signal.interests.entities`, foods and drinks become `signal.interests.tags`
(looked up with `/v2/tags`, since a dish isn't an entity), and the location becomes `filter.location`
on a `urn:entity:place` insights query. Each place comes back with an **affinity** score.

**Choosing stops.** The planner greedily inserts stops at their cheapest point in the ride. Each round it
picks the place with the best score:

$$\text{score} = \text{affinity} \times \text{preference} \times 0.75^{\text{repeats}} - \lambda \cdot \Delta\lvert L - T \rvert$$

- *preference* is the rider's weight for cafés, food or sights. "No sightseeing" sets sights to 0.
- *repeats* counts chosen stops of the same type, so rides mix cafés, food and sights.
- *L* is the ride length so far, *T* the requested distance and $\lambda = 0.6 / T$. While the ride is too
  short, a detour helps. Once it's long enough, a detour costs. The ride never goes over $1.15\,T$.

**The agent** runs on ChatGPT (OpenAI's API, `gpt-4.1` by default). It can also run on Claude (Anthropic's API) with the
same tools. It plans in steps and checks its own work:

1. **`find_places`** asks Qloo for places. The result says what each favourite matched and lists any problems:
   tastes Qloo didn't recognise, too few places, or no cafés, food or sights. The agent fixes these itself:
   it retries a taste with other wording or another category, or widens the search radius.
2. **`build_ride`** picks the stops and routes the ride, then checks it against the request: distance,
   number of stops, a mix of stop types, and the rider's preferences. If a check fails, the agent changes the
   plan (distance, stop types, a stop to include or leave out) and builds again.
3. **`show_ride`** puts the ride on the map with a one-line reason for each stop.

For changes like "shorter" or "more food" it rebuilds from the same Qloo results. It only searches again when
the start, the tastes or the area change. Every step appears in the chat under **"What the agent did"**, so
you can see each search, check and fix. The agent is told to base every claim on the tool data and never
invent opening hours, prices or road conditions.

## Features

- **Ride with a friend**: add what a friend loves and RideTaste asks Qloo for each of you separately, then
  favours stops you'd *both* enjoy (the geometric mean of your two affinities), showing each rider's match per stop
- **One-click examples** so first-time visitors (and judges) see a full ride in seconds
- **"How Qloo picked these stops"**: a panel on every ride that shows which Qloo entities your favourites matched,
  how many places Qloo's Insights API returned, and how the stops were chosen, plus Qloo's tags on each stop
- **An agent that checks its own work**: it re-searches when Qloo misses a taste or finds too few places, rebuilds rides that miss the distance or lack variety, and shows every step in the chat ("What the agent did")
- Chat-based planning with follow-up changes, plus a quick-plan form that works without the AI agent
- **Keeps working if the AI is down**: if the AI model is unavailable (no credits, overloaded, offline), chat pauses for
  two minutes and rides come from the quick planner. The **Shorter**, **More food** and **Only cafés** buttons
  still re-plan the ride, so Qloo still picks every stop
- Loop rides or one-way rides (start A, finish B)
- Taste-matched stops with a match score and a reason for each
- Real bike routing on OpenStreetMap, with "at km X" for each stop
- **Download GPX** to load the ride into Strava, Komoot or a bike computer
- Works on phones, with light and dark mode
- **Demo mode**: without a Qloo key it runs on clearly labelled sample data for Pune, so anyone can try the app

## Run it locally

You need Node.js 20.12 or newer.

```bash
git clone https://github.com/Blop77/Qloo.git ridetaste
cd ridetaste
npm install
cp .env.example .env      # add your keys (optional, see below)
npm start                 # http://localhost:3000
```

| Variable | Needed for | Without it |
|---|---|---|
| `OPENAI_API_KEY` | The chat agent on ChatGPT | Uses Claude if `ANTHROPIC_API_KEY` is set, otherwise only the quick-plan form works |
| `OPENAI_MODEL` | Which ChatGPT model to use | Defaults to `gpt-4.1` |
| `ANTHROPIC_API_KEY` | The chat agent on Claude (used when no OpenAI key is set) | Only the quick-plan form works |
| `QLOO_API_KEY` | Real taste-matched places | Uses **sample data** for Pune (shown with a "Demo data" badge) |
| `QLOO_BASE_URL` | The Qloo API host given with your key | Defaults to `https://hackathon.api.qloo.com` |

Run the tests (no network or keys needed):

```bash
npm test
```

## Deploy

The repo includes a [Render](https://render.com) blueprint (`render.yaml`):

1. In Render, choose **New → Blueprint** and pick this repository.
2. Enter `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) and `QLOO_API_KEY` when asked.
3. Render builds and gives you a public URL. Use it as the demo link on Devpost.

Any Node host works: run `npm ci && npm start` and set `PORT`.

## Project layout

| File | What it does |
|---|---|
| `src/agent.js` | Agent loop for ChatGPT or Claude, system prompt, the `find_places` / `build_ride` / `show_ride` tools and the ride checks |
| `src/planner.js` | The pipeline (`gatherCandidates` + `assembleRide`) and the stop-picking algorithm |
| `src/qloo.js` | Qloo client (`/search`, `/v2/insights`) with tolerant response parsing |
| `src/geo.js` | Distances, geocoding, bike routing, with offline fallbacks |
| `src/demo-data.js` | Sample data for demo mode (not from Qloo) |
| `src/server.js` | HTTP server and JSON API |
| `public/` | Web app (plain HTML/CSS/JS + Leaflet) |
| `tests/` | Unit and API tests (`node --test`) |

## Limitations

- Qloo's place coverage varies by city. If results look thin, try a bigger city.
- Distances are approximate when the public routing service is unavailable. The app says when that happens.
- The public OpenStreetMap geocoder and router have fair-use limits. Fine for a demo, not for heavy traffic.
- Chat sessions are kept in memory and reset when the server restarts.
- Always check the route yourself before riding. RideTaste doesn't know about traffic, road works or closures.

## Credits

- Taste data: [Qloo](https://www.qloo.com) Taste AI
- AI agent: [ChatGPT](https://openai.com) by OpenAI (also runs on [Claude](https://www.anthropic.com) by Anthropic)
- Maps, geocoding and routing: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  [Nominatim](https://nominatim.org), [OSRM](https://project-osrm.org) (bike profile hosted by FOSSGIS)
- Map library: [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause, bundled in `public/vendor/leaflet`)

## License

MIT. See [LICENSE](LICENSE).
