# MYTHOS: Hostile Takeover — Playable v1

A playable browser prototype of the MYTHOS: Hostile Takeover card game,
built from the real 060 card set. **Local play only** (2-player hotseat or
vs a simple AI). No server, no backend.

## Play it

Open `site/index.html` in any modern browser (double-click works — the game
is fully self-contained). For sharing/hosting, upload the entire `site/`
directory to any static host (GitHub Pages, Netlify, Cloudflare Pages…).

- **👥 2 Players (hotseat)** — pass-and-play on one screen.
- **🤖 Play vs AI** — you are Player 1; the AI drives Player 2.

## Controls

- **Main phase:** click a card in your hand → Play / Set trap / Perform ritual / Use ability.
  Cards that need a target (or a leash assignment) walk you through it.
- **Upkeep:** Pay each abomination's upkeep, or let it go **feral** (📎 = Red Stapler discount, once/turn).
- **Offense:** click your abominations to declare attackers (they hit enemy sanity by default),
  then **Done declaring →** the defender clicks a blocker, then the attacker it blocks,
  then **⚔ Resolve combat**.
- **Next phase →** advances Draw → Upkeep → Main → Offense → End.
- **Double-click** any card image to zoom it. The game log is behind the **Log** button.
- Rituals: click the ritual in hand, pick the burned-out character to sacrifice
  (you need a ritual site — Altar or Grove — in play first).

## Project layout

```
mythos-game/
  build.py          # reads the 060 spreadsheet + card images → generates site/
  card_data.py      # provisional Mothman stats + the 2 starter decks
  src/
    index.html      # page shell
    style.css       # dark corporate-horror styling
    data.js         # generated: cards + decks (inlined so file:// works)
    engine.js       # pure game logic, no DOM (the rules engine)
    ai.js           # heuristic AI driver (uses the same engine API as the UI)
    net.js          # network-adapter seam (LocalAdapter live, OnlineAdapter stub)
    ui.js           # DOM rendering + interaction
  test/
    test_engine.js  # headless AI-vs-AI smoke test (node)
  site/             # generated playable site (open site/index.html)
  README.md
```

## Rebuild the site

```bash
cd ~/workspace/mythos-game
python3 build.py           # or: python3 build.py --clean
node test/test_engine.js   # headless smoke test
```

`build.py` validates as it goes: 60 cards present (ids 001–060), all 60 images
found and copied, the official card back copied to `assets/card-back.png`,
and both starter decks legal (45 cards, ≥1 character, ≤3 copies, ≤1 per ritual).

## Rules implemented (v1)

Core loop is faithful to the Player's Guide v1.0: 40 sanity as life + currency,
45-card decks, 7-card hands with one free mulligan, first player skips the first
draw, Draw → Upkeep → Main → Offense → End, leash/control/feral abominations,
burnout, traps on either turn, and all three win conditions (0 sanity,
3 rituals, deck-out). All 60 cards' abilities are implemented, including
enter triggers, death triggers, activated abilities, cost modifiers
(Tess / Founder / Merger / Non-Compete / Meeting Elemental / NDA),
static buffs (Griselda / Grove / Micromanager / Glass Cliff / Synergy Hound…),
and the six rituals.

### Simplifications & judgment calls (v1)

1. **Mothman (008)** has provisional v1 stats (4 cost / 2 control / 5 sanity,
   "Enter: draw a card") — the spreadsheet row was still TBD. Pending Joshua's retune.
2. **Lethal costs are payable.** Per the guide ("at 0 sanity you break immediately,
   no last stands"), you may spend yourself to 0 and you lose on the spot — even
   mid-payment. Upkeep is the exception: you may always decline and go feral instead.
3. **No trample.** Excess combat damage does not carry over.
4. **One blocker per attacker, one attacker per blocker.** No gang-blocking.
5. **Feral abominations** can't block or be declared as attackers; at the start of
   your Offense each feral abomination hits *your* sanity automatically.
6. **Re-leashing** costs 2 sanity, Main phase only, auto-assigned to the first
   character with room (no manual reassignment UI in v1).
7. **Sleep** (Somnia/Aletheia): can't block or use abilities until your next turn.
8. **Scry** (Mailroom Mimic): simplified to keep-on-top / file-to-bottom.
9. **The Auditor** reveals the enemy hand in a modal (hotseat: both players can see —
   look away, honor system).
10. **The Mole's** upkeep is auto-deducted from the opponent, no choice.
11. **The Board's** 3 leash is auto-split across your characters with free Control.
12. **Tender Offer / The Pivot** auto-pick targets and leash spots in AI hands and
    in the quick ritual modal (juiciest legal target first).
13. **Layoff Swarm** at 0 burned-out characters is 0 power / 1 flesh (survives as a wall).
14. **Poison Pill** redirects *damage* only, not costs.
15. **Going Private** blocks enemy actions/traps from targeting you or your cards;
    HR Complaint still works (it targets the attacking abomination, not you).
16. **Vex's tax** triggers on any enemy action/ability/trap choice that targets Vex.
17. Cost reductions (Tess/Founder/Merger) floor at 0.
18. The **AI** is deliberately basic (see below). It mulligans a character-less hand,
    pays upkeep while comfortable, plays cheapest characters first, attacks
    everything at enemy sanity, and blocks only favorable-or-chump trades.

## Online-play seam (stubbed, not built)

`engine.js` never touches the DOM. `MYTHOS.snapshot(state)` /
`MYTHOS.restore(snapshot)` are JSON round-trips of the full game state
(including the seeded RNG), exercised by the smoke test. `net.js` defines the
adapter interface: `LocalAdapter` (used by v1) and `OnlineAdapter`, which throws
with instructions — wire it to Firebase RTDB (match state) + Firestore
(profiles/decks/W-L) when online play is built. No backend code ships in v1.

## Verification (done 2026-10-07)

- `build.py`: 60/60 cards, 60/60 images copied + referenced, card back copied,
  both decks pass legality checks.
- `node --check`: engine.js, ai.js, net.js, ui.js, data.js all parse.
- `node test/test_engine.js`: **all passed** — 5 AI-vs-AI games terminate with a
  winner (sanity / ritual / deck-out paths all observed across runs), card
  conservation holds (45 per player at all times), snapshot round-trips,
  deterministic replays, plus an explicit forced-ritual test (Burn Rate).
- ⚠️ **Not verified:** actual in-browser play (no browser available in this
  environment) — the UI is untested beyond syntax. Open `site/index.html`
  and click through a turn to confirm before sharing.
- ⚠️ **Balance:** untested, as the guide says. In AI-vs-AI games the aggro
  starter deck wins most games quickly; the ritual deck's plan needs a smarter
  pilot (or the end-of-set balance pass). Expect fast, bloody games in v1.
