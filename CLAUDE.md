# Notes for Claude

## About the owner
Ishaan Singh, 2nd-year student at MIT-WPU, Pune. Codes mostly in C; likes cycling and football.
Keep Devpost/marketing copy plain: no asterisks or emojis unless asked, and never claim
work or results that didn't happen.

## Hackathon lessons (from the Qloo Agentic Hackathon, Nov 2026)
RideTaste (this repo) was a solid, live, well-tested entry but did not place in a field of
2,991. The winners:

- **1st, Undertow:** an AI campaign strategist for the 2026 US elections. It used Qloo
  heatmaps (about 4,000 calls) to predict votes from local taste, with a leave-one-state-out
  model, backtests against 2020/2024 (including the ones that failed), a scroll-driven
  newspaper-style map story, and a tool-calling agent that turns a budget into a ZIP-code ad
  plan with validated outputs.
- **2nd, Backline:** an AI travel agent that books flights and hotels, pays from a demo
  wallet and phones restaurants, driven by Qloo taste data, shown on a 3D globe.
- **3rd, Roomful:** type what you love; Qloo picks the decor, art and music, an agent designs
  and paints the room, and you walk inside it in 3D/VR. It proves Qloo's value with a
  side-by-side test: an LLM alone got 0 of 8 picks matching Qloo for the same taste.
  (Its stack was close to RideTaste's: Node with no build step, Qloo search plus insights,
  shared-word matching, tests against fakes. The difference was the proof and the wow.)

What separated them from RideTaste:

1. **Prove the sponsor's API adds value, with evidence.** Backtests and an honest
   scorecard (Undertow), or "with vs without Qloo" (Roomful). Not just "we used it".
2. **Use the API in a surprising, non-obvious way.** Taste predicting elections, taste
   becoming a room. Use the deeper endpoints (heatmaps, demographics), not only search
   and insights.
3. **An agent must act or produce a real deliverable**: bookings, payments and calls
   (Backline); a ZIP-code ad plan as a CSV (Undertow); a walkable room (Roomful).
   Ask early: "what can the agent finish for the user?"
4. **One memorable demo moment**: a scrollytelling map, a 3D globe, VR.
5. **Pick a big, obviously valuable domain** (elections, travel, home design) over a
   niche hobby.
6. **Trust features:** every claim traced to its source, invented items flagged,
   failed tests shown openly.
7. **Fake risky parts safely** (test-mode payments, sandbox bookings, calls to your own
   phone) so the full flow works for judges.
8. Keep what RideTaste did well: live hosted demo, public repo with tests and CI,
   graceful fallback when an AI API fails, one-click examples, short video.

Check the finals format early: here the top 3 presented live on Nov 5, and finalists were
contacted beforehand, so no message by then meant not selected.
