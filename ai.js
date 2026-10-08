/* ============================================================================
 * MYTHOS — simple heuristic AI (v1). Drives the engine through the same
 * public API the UI uses. Deliberately basic; heuristics documented in README.
 * ========================================================================== */
(function (global) {
'use strict';
var E = global.MYTHOS;
var AI = {};
global.MYTHOS_AI = AI;

// card def registry (ai-local; engine holds its own copy)
var DEFS = {};
AI.setDefs = function (defs) { DEFS = {}; defs.forEach(function (d) { DEFS[d.id] = d; }); };
function Dd(uid_or_id, st) {
  var id = typeof uid_or_id === 'string' ? st.inst[uid_or_id].def : uid_or_id;
  return DEFS[id];
}
function handOf(st, pi) { return st.players[pi].hand.slice(); }
/* Sanity buffer: keep enough to survive next upkeep + feral hits from own board. */
function sanityBuffer(st, pi) {
  var buf = 3; // base caution
  var pl = st.players[pi];
  pl.aboms.forEach(function (u) {
    var it = st.inst[u];
    if (!it.upkeepPaid) {
      try { buf += E.effUpkeep(st, u) || 0; } catch (e) {}
      if (it.feral) { try { buf += E.effPower(st, u) || 0; } catch (e) {} }
    }
  });
  return buf;
}
function afford(st, pi, cost) { return st.players[pi].sanity > cost + sanityBuffer(st, pi); }

AI.mulliganDecision = function (st, pi) {
  // mulligan if no character in opening hand
  return !handOf(st, pi).some(function (u) { return Dd(u, st).type === 'Character'; });
};

AI.upkeep = function (st, pi) {
  var list = E.upkeepList(st, pi);
  // Red Stapler on the most expensive upkeep first
  var hasStaple = st.players[pi].arts.some(function (a) { return st.inst[a].def === 49; });
  list.sort(function (a, b) { return E.effUpkeep(st, b) - E.effUpkeep(st, a); });
  list.forEach(function (u, i) {
    var uck = E.effUpkeep(st, u);
    var useStaple = hasStaple && i === 0 && uck > 0;
    var pay = uck === 0 || (st.players[pi].sanity - uck > 4);
    E.upkeepAction(st, pi, u, pay, useStaple);
    if (st.pending && st.pending.player === pi) AI.decide(st);
  });
};

function tryPlay(st, pi, uid, extra, played) {
  var chk = E.canPlay(st, pi, uid);
  if (!chk.ok) return false;
  var opts = extra || {};
  if (chk.need === 'leash' || chk.need === 'mole') {
    if (!chk.leashOptions.length) return false;
    // prefer own characters; first with room
    var own = chk.leashOptions.filter(function (o) { return !o.foe; });
    opts.leashTo = (own[0] || chk.leashOptions[0]).char;
  } else if (chk.need === 'boardsplit') {
    var chars = st.players[pi].chars.filter(function (c) { return E.freeControl(st, c) > 0; });
    if (!chars.length) return false;
    var split = [], rem = 3;
    chars.forEach(function (c) {
      if (rem <= 0) return;
      var n = Math.min(rem, E.freeControl(st, c));
      if (n > 0) { split.push({ char: c, n: n }); rem -= n; }
    });
    if (rem > 0) return false;
    opts.split = split;
  } else if (chk.need === 'target') {
    var tg = E.legalTargets(st, pi, chk.targetSpec);
    if (!tg.length) return false;
    opts.target = tg[0];
  }
  var r = E.playCard(st, pi, uid, opts);
  if (r.ok && played) played.push({ name: Dd(uid, st).name, cost: chk.cost });
  if (st.pending && st.pending.player === pi) AI.decide(st);
  return r.ok;
}

AI.main = function (st, pi) {
  var played = []; // cards played this main phase (for UI summaries)
  var guard = 0, acted = true;
  while (acted && guard++ < 40 && st.winner == null) {
    acted = false;
    var hand = handOf(st, pi);
    // 1. rituals
    for (var i = 0; i < hand.length && !acted; i++) {
      var d = Dd(hand[i], st);
      if (d.type !== 'Ritual') continue;
      var info = E.ritualInfo(st, pi, hand[i]);
      if (!info.ok) continue;
      var opts = { sac: info.fuel[0] };
      if (info.need) {
        var tg = E.legalTargets(st, pi, info.targetSpec);
        if (!tg.length) continue;
        if (hand[i] && st.inst[hand[i]].def === 40) {
          // Tender Offer: juiciest enemy abomination
          tg.sort(function (a, b) { return E.effPower(st, b) - E.effPower(st, a); });
        }
        opts.target = tg[0];
        if (st.inst[hand[i]].def === 55 && tg[1]) opts.target2 = tg[1];
        if (st.inst[hand[i]].def === 40) {
          var cs = st.players[pi].chars.filter(function (c) {
            return E.freeControl(st, c) >= (Dd(opts.target, st).leash || 0);
          });
          if (cs[0]) opts.leashTo = cs[0];
        }
      }
      var r = E.performRitual(st, pi, hand[i], opts);
      if (r.ok) { acted = true; played.push({ name: Dd(hand[i], st).name, cost: info.cost }); }
      if (st.pending && st.pending.player === pi) AI.decide(st);
    }
    if (acted || st.winner != null) continue;
    // 2. characters, cheapest first
    var chars = hand.filter(function (u) { return Dd(u, st).type === 'Character'; })
      .sort(function (a, b) { return E.playCost(st, pi, st.inst[a].def) - E.playCost(st, pi, st.inst[b].def); });
    for (var c = 0; c < chars.length && !acted; c++) {
      if (afford(st, pi, E.playCost(st, pi, st.inst[chars[c]].def)) && tryPlay(st, pi, chars[c], null, played)) acted = true;
    }
    if (acted) continue;
    // 3. locations / artifacts / effects
    var perm = hand.filter(function (u) {
      var t = Dd(u, st).type; return t === 'Location' || t === 'Artifact' || t === 'Effect';
    }).sort(function (a, b) { return E.playCost(st, pi, st.inst[a].def) - E.playCost(st, pi, st.inst[b].def); });
    for (var q = 0; q < perm.length && !acted; q++) {
      if (afford(st, pi, E.playCost(st, pi, st.inst[perm[q]].def)) && tryPlay(st, pi, perm[q], null, played)) acted = true;
    }
    if (acted) continue;
    // 4. traps (max 2 set)
    if (st.players[pi].traps.length < 2) {
      var traps = hand.filter(function (u) { return Dd(u, st).type === 'Trap'; });
      for (var t2 = 0; t2 < traps.length && !acted; t2++) {
        var tc = E.playCost(st, pi, st.inst[traps[t2]].def);
        if (afford(st, pi, tc) && E.setTrap(st, pi, traps[t2]).ok) {
          acted = true;
          played.push({ name: Dd(traps[t2], st).name + ' (trap set)', cost: tc });
        }
      }
    }
    if (acted) continue;
    // 5. abominations, best power-per-cost first
    var abs = hand.filter(function (u) { return Dd(u, st).type === 'Abomination'; });
    abs.sort(function (a, b) {
      var da = Dd(a, st), db = Dd(b, st);
      return ((db.power || 0) / Math.max(1, E.playCost(st, pi, db.id))) - ((da.power || 0) / Math.max(1, E.playCost(st, pi, da.id)));
    });
    for (var b2 = 0; b2 < abs.length && !acted; b2++) {
      if (afford(st, pi, E.playCost(st, pi, st.inst[abs[b2]].def)) && tryPlay(st, pi, abs[b2], null, played)) acted = true;
    }
    if (acted) continue;
    // 6. actions
    for (var a2 = 0; a2 < hand.length && !acted; a2++) {
      var dd = Dd(hand[a2], st);
      if (dd.type !== 'Action') continue;
      var id = st.inst[hand[a2]].def, cost = E.playCost(st, pi, id);
      if (!afford(st, pi, cost)) continue;
      if (id === 46 && !st.players[1 - pi].chars.length) continue;      // Reply All: needs targets
      if (id === 59) {                                                  // Downsizing
        var tg2 = E.legalTargets(st, pi, 'enemy_char_le2');
        if (!tg2.length) continue;
        if (tryPlay(st, pi, hand[a2], { target: tg2[0] }, played)) acted = true;
        continue;
      }
      if (id === 45) {                                                  // PIP: heal most damaged / buff
        var mine = st.players[pi].chars.slice().sort(function (x, y) {
          return (st.inst[x].psan / st.inst[x].maxPsan) - (st.inst[y].psan / st.inst[y].maxPsan);
        });
        if (!mine.length) continue;
        if (tryPlay(st, pi, hand[a2], { target: mine[0] }, played)) acted = true;
        continue;
      }
      if (tryPlay(st, pi, hand[a2], null, played)) acted = true;
    }
    if (acted) continue;
    // 7. activated abilities
    var myChars = st.players[pi].chars;
    for (var z = 0; z < myChars.length && !acted; z++) {
      var ab = E.activatedInfo(st, myChars[z]);
      if (!ab) continue;
      var idd = st.inst[myChars[z]].def;
      var base = { 1: 2, 2: 1, 3: 3, 4: 2, 5: 1, 7: 2 }[idd];
      if (!afford(st, pi, base + 1)) continue;
      if (idd === 3 || idd === 4) { if (E.activate(st, pi, myChars[z]).ok) acted = true; } // draw
      else if (idd === 1 || idd === 2) {
        var hurt = myChars.filter(function (x) { return st.inst[x].psan < st.inst[x].maxPsan; });
        if (hurt.length && E.activate(st, pi, myChars[z], hurt[0]).ok) acted = true;
      } else if (idd === 5) {
        var ec = st.players[1 - pi].chars;
        if (ec.length && st.players[pi].sanity > 10 && E.activate(st, pi, myChars[z], ec[0]).ok) acted = true;
      } else if (idd === 7) {
        var good = st.players[pi].discard.filter(function (x) {
          var t = Dd(x, st).type; return t === 'Character' || t === 'Abomination';
        });
        if (good.length && st.players[pi].sanity > 10 && E.activate(st, pi, myChars[z], good[0]).ok) acted = true;
      }
    }
    if (acted) continue;
    // 8. re-leash ferals
    var ferals = st.players[pi].aboms.filter(function (u) { return st.inst[u].feral; });
    for (var f = 0; f < ferals.length && !acted; f++) {
      var lc = Dd(ferals[f], st).leash || 0;
      var cs2 = st.players[pi].chars.filter(function (x) { return E.freeControl(st, x) >= lc; });
      if (cs2.length && st.players[pi].sanity > 4 && E.releash(st, pi, ferals[f], cs2[0]).ok) acted = true;
    }
  }
  return played;
};

AI.declareAttacks = function (st, pi) {
  var foe = 1 - pi;
  // slice(): declaring an attacker can trigger HR Complaint, and if the AI
  // sacrifices the attacker the aboms array mutates mid-loop (skipping the
  // next abomination — e.g. a Paper Jam that must attack).
  st.players[pi].aboms.slice().forEach(function (u) {
    if (!E.canAttack(st, u)) return;
    // v1: everything goes at the enemy sanity pool
    var r = E.declareAttacker(st, pi, u, { kind: 'player', player: foe });
    if (st.pending && st.pending.player === pi) AI.decide(st);
  });
};

AI.assignBlockers = function (st, pi) {
  // pi is the defender
  var mapping = {};
  st.attackers.forEach(function (a) {
    var apow = E.effPower(st, a.uid);
    var cands = st.players[pi].aboms.concat(st.players[pi].chars).filter(function (u) {
      return E.canBlock(st, u);
    });
    // prefer a blocker that survives and kills, else a death-trigger chump, else none
    var best = null;
    cands.forEach(function (u) {
      var d = Dd(u, st);
      var survives = d.type === 'Character' ? true : (E.effFlesh(st, u) > apow);
      var kills = d.type === 'Character' ? (E.effControl(st, u) >= E.effFlesh(st, a.uid)) : (E.effPower(st, u) >= E.effFlesh(st, a.uid));
      var score = (kills ? 3 : 0) + (survives ? 2 : 0) + ((d.id === 9 || d.id === 35 || d.id === 19) ? 1 : 0);
      if (!best || score > best.score) best = { u: u, score: score };
    });
    if (best && (best.score >= 2 || (best.score >= 1 && apow >= 4))) {
      var r = E.declareBlocker(st, pi, best.u, a.uid);
      if (r.ok) mapping[a.uid] = best.u;
    }
  });
  return mapping;
};

AI.discardDown = function (st, pi) {
  var pl = st.players[pi];
  while (pl.hand.length > 7) {
    var h = pl.hand.slice().sort(function (a, b) {
      return E.playCost(st, pi, st.inst[b].def) - E.playCost(st, pi, st.inst[a].def);
    });
    E.discard(st, pi, h[0]);
  }
};

AI.decide = function (st) {
  var pd = st.pending;
  if (!pd) return;
  var pi = pd.player, pl = st.players[pi];
  switch (pd.kind) {
    case 'temp':
      E.decide(st, pl.sanity > 8 ? 'pay' : 'return'); break;
    case 'hr':
      E.decide(st, pl.sanity > 10 ? 'pay' : 'sacrifice'); break;
    case 'wisp_discard': {
      var h = pl.hand.slice().sort(function (a, b) {
        return E.playCost(st, pi, st.inst[b].def) - E.playCost(st, pi, st.inst[a].def);
      });
      E.decide(st, { uid: h[0] }); break;
    }
    case 'coffee': {
      var hurt = pl.chars.filter(function (x) { return st.inst[x].psan < st.inst[x].maxPsan; });
      E.decide(st, { uid: hurt[0] || null }); break;
    }
    case 'fulltimer': E.decide(st, { take: true }); break;
    case 'restructurer': {
      var locs = st.players[1 - pi].locs.concat(pl.locs);
      E.decide(st, { uid: locs[0] || null }); break;
    }
    case 'mimic': E.decide(st, { toBottom: false }); break;
    case 'auditor': E.decide(st, true); break;
    case 'sleep_pick': {
      var ec = st.players[1 - pi].chars.slice().sort(function (a, b) {
        return E.effControl(st, b) - E.effControl(st, a);
      });
      E.decide(st, { uid: ec[0] || null }); break;
    }
    default: E.decide(st, null);
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = AI;
})(typeof window !== 'undefined' ? window : global);
