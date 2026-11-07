# Notes for Claude

## About the owner
Ishaan Singh, 2nd-year student at MIT-WPU, Pune. Codes mostly in C; likes cycling and football.
Keep Devpost/marketing copy plain: no asterisks or emojis unless asked, and never claim
work or results that didn't happen.

## Hackathon lessons (from the Qloo Agentic Hackathon, Nov 2026)
RideTaste (this repo) was a solid, live, well-tested entry but did not place in a field of
2,991. Second place went to Backline, an AI travel agent that books flights and hotels, pays
from a demo wallet and phones restaurants, all driven by Qloo taste data. What separated it:

1. **An agent must act, not just recommend.** Judges ("Agents, but with taste") rewarded an
   agent that closes the loop: books, pays, calls, sends. RideTaste only planned and explained.
   Next time, ask early: "what can the agent finish for the user?"
2. **Pick a big, obviously valuable market** (travel, health, money) over a niche hobby.
3. **Build one memorable demo moment** (3D globe, live phone call, voice input).
4. **Make the sponsor's API visible** in the UI: scores, sources, "why this" panels.
5. **Fake the risky parts safely** (test-mode payments, sandbox bookings, calls to your own
   phone) so the whole flow works end to end for judges.
6. **Trust features count:** every price or claim has a source; show actions and failures.
7. Still do what RideTaste did well: live hosted demo, public repo with tests and CI,
   graceful fallback when an AI API fails, one-click examples for judges, short video.

Check finals format early: here the top 3 presented live on Nov 5, and finalists were
contacted beforehand, so no message by then meant not selected.
