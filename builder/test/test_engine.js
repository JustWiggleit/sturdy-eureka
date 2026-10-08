/* MYTHOS v1 — headless engine smoke test (node).
 * Plays full AI-vs-AI games through the public engine API, asserting
 * invariants and catching crashes. Run: node test/test_engine.js
 */
'use strict';
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
const cards = require('../site/cards.json');
const decks = require('../site/decks.json');

E.setDefs(cards);
AI.setDefs(cards);

let failures = 0;
function assert(c, msg) {
  if (!c) { failures++; console.error('FAIL:', msg); }
}

function cardCount(st, p) {
  const pl = st.players[p];
  let n = pl.deck.length + pl.hand.length + pl.discard.length + pl.removed.length +
    pl.chars.length + pl.aboms.length + pl.locs.length + pl.arts.length +
    pl.effs.length + pl.traps.length;
  return n;
}

function checkInvariants(st, where) {
  for (let p = 0; p < 2; p++) {
    assert(cardCount(st, p) === 45, `card conservation p${p} at ${where}: got ${cardCount(st, p)}`);
    assert(Number.isFinite(st.players[p].sanity), `sanity finite p${p} at ${where}`);
  }
  // every uid referenced exists
  for (const uid of Object.keys(st.inst)) {
    assert(st.inst[uid].uid === uid, `uid key match at ${where}`);
  }
  // JSON round-trip (network seam)
  const snap = E.snapshot(st);
  const back = E.restore(JSON.parse(JSON.stringify(snap)));
  assert(back.turn === st.turn, `snapshot round-trip at ${where}`);
}

function mustOk(r, what) {
  if (!r.ok) throw new Error(`action failed [${what}]: ${r.error}`);
}

function playGame(seed) {
  const st = E.newGame([decks.cult.cards.slice(), decks.board.cards.slice()],
    { seed, names: ['Cult', 'Board'] });
  for (let p = 0; p < 2; p++) if (AI.mulliganDecision(st, p)) E.mulligan(st, p);
  E.startGame(st);
  let steps = 0;
  const seenPhases = new Set();
  while (!st.winner && steps++ < 6000) {
    if (st.pending) { AI.decide(st); continue; }
    const p = st.active;
    const ph = st.phase;
    seenPhases.add(ph);
    if (ph === 'draw') mustOk(E.nextPhase(st), 'draw->upkeep');
    else if (ph === 'upkeep') { AI.upkeep(st, p); if (!st.winner && !st.pending) mustOk(E.nextPhase(st), 'upkeep->main'); }
    else if (ph === 'main') { AI.main(st, p); if (!st.winner && !st.pending) mustOk(E.nextPhase(st), 'main->offense'); }
    else if (ph === 'offense') {
      AI.declareAttacks(st, p);
      if (st.winner) break;
      if (st.pending) continue;
      AI.assignBlockers(st, 1 - p);
      mustOk(E.resolveCombat(st), 'resolve');
      if (!st.winner && !st.pending) mustOk(E.nextPhase(st), 'offense->end');
    }
    else if (ph === 'end') { AI.discardDown(st, p); if (!st.winner) mustOk(E.nextPhase(st), 'end->draw'); }
    else throw new Error('unknown phase ' + ph);
    if (steps % 200 === 0) checkInvariants(st, `seed ${seed} step ${steps}`);
  }
  checkInvariants(st, `seed ${seed} final`);
  return { winner: st.winner, reason: st.winReason, turns: st.turn, steps, phases: [...seenPhases] };
}

console.log('cards:', cards.length, '| decks:', Object.keys(decks).join(','));
assert(cards.length === 60, '60 cards in cards.json');
assert(new Set(cards.map(c => c.id)).size === 60, 'unique card ids');
assert(cards.every(c => c.img && c.name && c.type && c.cost != null), 'card fields present');
assert(cards.every(c => c.rules && c.rules.length > 0), 'all cards have rules text');

const results = [];
for (const seed of [11, 22, 33, 44, 55]) {
  const r = playGame(seed);
  results.push(r);
  console.log(`seed ${seed}: winner=${r.winner} turns=${r.turns} steps=${r.steps} reason=${r.reason}`);
}
assert(results.every(r => r.winner !== null), 'all games terminated with a winner');
assert(results.some(r => r.turns > 6), 'games lasted multiple turns');

// determinism: same seed -> same result
const a = playGame(77), b = playGame(77);
assert(a.winner === b.winner && a.turns === b.turns, 'deterministic replays');

// exercise rituals explicitly: force a ritual scenario
(function ritualTest() {
  const st = E.newGame([decks.cult.cards.slice(), decks.board.cards.slice()], { seed: 9 });
  E.startGame(st);
  // fast-forward: give p0 an Altar, a burned-out char, and Burn Rate in hand
  const p = st.active;
  const altarUid = Object.keys(st.inst).find(u => st.inst[u].def === 43 && st.inst[u].owner === p && st.inst[u].zone === 'deck');
  const burnUid = Object.keys(st.inst).find(u => st.inst[u].def === 39 && st.inst[u].owner === p && st.inst[u].zone === 'deck');
  const charUid = Object.keys(st.inst).find(u => st.inst[u].def === 54 && st.inst[u].owner === p && st.inst[u].zone === 'deck');
  for (const [u, zone, arr] of [[altarUid, 'board', 'locs'], [burnUid, 'hand', 'hand'], [charUid, 'board', 'chars']]) {
    const pl = st.players[p], inst = st.inst[u];
    pl.deck.splice(pl.deck.indexOf(u), 1);
    inst.zone = zone === 'board' ? 'board' : 'hand';
    inst.controller = p; inst.owner = p;
    pl[arr].push(u);
  }
  st.inst[charUid].psan = 0; // burned out
  st.phase = 'main';
  const info = E.ritualInfo(st, p, burnUid);
  assert(info.ok, 'ritual legal: ' + (info.error || 'ok'));
  const r = E.performRitual(st, p, burnUid, { sac: charUid });
  assert(r.ok, 'perform Burn Rate: ' + (r.error || 'ok'));
  assert(st.players[p].ritualsDone.length === 1, 'ritual counted');
  console.log('ritual path OK');
})();

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log('\nALL SMOKE TESTS PASSED');
