# Devpost submission draft: RideTaste

Paste-ready text for https://qloo.devpost.com. Read it through before pasting and change anything that
doesn't sound like you. Don't claim anything you haven't checked.

---

## Project name (≤ 60)

```
RideTaste: AI Bike Rides Planned Around Your Taste
```

## Elevator pitch (≤ 200)

```
Tell the agent the films, music and food you love. It plans a bike ride with café and food stops picked by Qloo's taste AI, and explains why each stop fits you.
```

## About the project (Markdown)

```markdown
## Inspiration
I ride my bike a lot around Pune, and the hardest part of a weekend ride isn't the route, it's deciding *where to stop*. Map apps show me the nearest café, not the one I'd actually like. I wanted a riding buddy who knows my taste: if I love lo-fi music, Studio Ghibli films and South Indian food, the ride should go past places that fit that vibe.

## What it does
RideTaste is an AI agent that plans bike rides around your taste.
1. You chat with it: say where you're starting, roughly how far you want to ride, and a few films, artists, foods or books you love.
2. The agent turns your favourites into Qloo entities and taste tags and asks **Qloo's Taste AI** for places near you that people with your taste enjoy.
3. It builds a ride with 1–6 stops, routes it for a bike, and **checks its own work**: if the ride misses your distance, has only one kind of stop, or Qloo found too few places, it changes the plan and tries again.
4. It shows the ride on a map with a short reason for each stop, and the chat shows **"What the agent did"**: every Qloo search, check and fix.
5. You can change it: "shorter", "more food, less sightseeing", "end near a lake".
6. **Ride with a friend:** add what your friend loves, and RideTaste asks Qloo for each of you separately, then picks stops you'd *both* enjoy, showing each rider's match on every stop.
7. You can download the ride as **GPX** for Strava, Komoot or a bike computer.

## Who it's for, and why Qloo
**Riders who ride for the outing, not the commute.** On a weekend ride the stops are half the point, but today's tools don't help pick them. Route planners optimise distance, elevation and road surface; map apps rank cafés by distance and rating, the same list for everyone. Neither knows that *I* love Studio Ghibli and filter coffee.

**Two riders with different tastes** have it worse: someone always settles. RideTaste asks Qloo for each rider separately and only ranks a stop high if it suits *both*.

**Why this needs Qloo, not just a chatbot.** Ask a plain LLM for "cafés a Ghibli fan would like near FC Road" and it guesses from vibes, and may name places that are closed or made up. RideTaste's stops come from Qloo's taste graph: real places with coordinates and an affinity score that links what you like in *films, music and food* to *places*. The agent may only use that tool data, and every stop shows its Qloo match. Without Qloo the app has nothing to recommend.

## How I built it
- **Qloo Insights API:** `/search` resolves each favourite to a Qloo entity, `/v2/tags` turns foods and drinks into taste tags, and `/v2/insights` with `filter.type=urn:entity:place`, `signal.interests.entities`, `signal.interests.tags` and `filter.location` returns nearby places with an affinity score. Qloo is the core of the app: without it there's no link from "I love Spirited Away" to "this café".
- **Agent:** ChatGPT (OpenAI API, `gpt-6.1-terra` with function calling) plans in steps and checks its own work. The same tools also run on Claude (Anthropic API). `find_places` asks Qloo for places and reports problems (a favourite Qloo didn't recognise, too few places, no cafés or food), which the agent fixes by retrying with other wording or a wider search. `build_ride` picks the stops, routes the ride and checks it against the request (distance, number of stops, a mix of stop types, preferences); when a check fails, the agent changes the plan and builds again. `show_ride` writes a grounded one-line reason for each stop. Every search, check and fix is shown in the chat under "What the agent did". The system prompt tells it to use only tool data, never invent opening hours, prices or road conditions, and say when data is sample or approximate. If the AI model is ever unavailable, the app falls back to the same planner without the chat, and the Shorter, More food and Only cafés buttons still re-plan the ride, so Qloo still picks every stop.
- **Choosing stops:** a greedy planner inserts each stop at its cheapest point in the ride and scores candidates by taste and distance fit:

$$\text{score} = \text{affinity} \times \text{preference} \times 0.75^{\text{repeats}} - \lambda \cdot \Delta\lvert L - T \rvert$$

where *L* is the current ride length, *T* the requested distance and \\( \lambda = 0.6/T \\). While the ride is too short a detour helps; once it's long enough a detour costs. The 0.75 repeat factor mixes cafés, food and sights.
- **Maps:** OpenStreetMap geocoding (Nominatim), bike routing (OSRM bike profile) and Leaflet.
- **Stack:** Node.js with no framework, plain HTML/CSS/JS and 70 automated tests (`node --test`).

## Challenges I ran into
- **Rides came out far too short.** My first scoring rule just penalised detours, so a 15 km request gave a 5 km ride, because the best-matching places were all close together. Scoring by how much a stop moves the ride *towards the requested distance* fixed it.
- **Honest explanations.** Qloo's affinity says how much people with your taste like a place, not *which* favourite caused it. I had to stop the agent from claiming "because you like X".
- **Working without keys.** I built a clearly labelled demo mode and offline fallbacks for geocoding and routing, so the app and its tests run anywhere.
- **Food isn't an entity.** "Filter coffee" or "momos" aren't films or artists, so they don't fit Qloo's entity search. In Qloo they're *tags*, so food tastes now go through `/v2/tags` and are sent as `signal.interests.tags`.
- **Rate limits in friend mode.** Riding with a friend doubles the Qloo calls, and my first version hit HTTP 429. I added a small client that keeps at most two Qloo requests in flight, retries 429/503 with backoff (honouring `Retry-After`) and caches lookups privately on the server.
- **Real data, odd stops.** Live results included places that aren't good ride stops: a whole district ("Pune city"), a hotel and a cosmetics shop. I wrote a categoriser that reads Qloo's tags and the place name with whole-word matching, and skips areas, hotels and errands by default.

## Accomplishments that I'm proud of
- It runs on live Qloo data in Pune, where I ride, and in New York, with real bike routes and "at km X" for every stop.
- **Ride with a friend** really blends two tastes: a stop only ranks high if Qloo says it suits both of you, and each stop shows both matches (e.g. German Bakery: you 79%, friend 81%).
- **The agent fixes its own plans.** In a live test it built an 18.7 km ride for a 15 km request; its own distance check rejected it twice, and it rebuilt it into a 16.5 km loop with a viewpoint and two food stops. All of that is visible in the chat.
- Every recommendation is explainable: the "How Qloo picked these stops" panel shows the Qloo matches, how many places came back and how the stops were chosen.
- 70 automated tests run in GitHub Actions on Node 20 and 22, and there's a demo mode so anyone can run it without keys.

## What I learned
- **How Qloo's taste graph links domains.** A film and a singer can point to a café. The affinity score says how much people with your taste like a place, but not *which* favourite caused it, so the explanations have to stay honest.
- **Designing tools for an agent.** One big "plan the ride" tool made the agent a form-filler. Splitting it into search, build and show tools, each returning problems and checks the agent can act on, let it notice and fix its own mistakes, while a system prompt keeps every claim grounded in tool data.
- **Being a good API citizen.** One click in my app fans out into several API calls, so throttling, retries and caching matter early.
- **Shipping for real users.** CI, hosting on Render, keeping the server awake and writing for judges who use the app directly.

## What's next for RideTaste
- Group rides with more than two riders
- Opening hours, elevation and traffic-aware routing
- Save and share favourite rides
```

## How to test (add to the end of "About the project")

```markdown
## Try it in 30 seconds
1. Open the live demo: https://ridetaste.onrender.com. If the first load is slow, the free server is waking up; give it up to a minute.
2. Click one of the **"Try one"** examples (e.g. *Ghibli & filter coffee · Pune*, or *Ride with a friend · Pune*). The agent plans a ride with Qloo.
3. Open **"How Qloo picked these stops"** under the map to see the Qloo entities, the places Qloo returned, and how the stops were chosen.
4. In the chat, open **"What the agent did"** to see each Qloo search, check and fix. Then tap **More food** or type *"make it shorter and end near a lake"* to watch the agent re-plan.
5. Click **Download GPX** to take the ride into Strava, Komoot or a bike computer.
```

## Built with

```
javascript, node.js, qloo, openai, chatgpt, claude, anthropic-api, leaflet, openstreetmap, osrm, nominatim, html5, css3, render
```

## Try it out links

- GitHub: https://github.com/Blop77/Qloo
- Live demo: https://ridetaste.onrender.com

## Media

- Image gallery (3:2, in this order): cover, ride with a friend, how Qloo picked, change it by chat, how it works, try it
- Video demo link: https://youtu.be/au5etS24uRk
