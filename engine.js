/* ============================================================================
 * MYTHOS: Hostile Takeover — game engine v1
 * Pure game logic. No DOM access. GameState is plain JSON-serializable data,
 * so it can later be shipped over a network adapter for online play.
 * Browser: loaded as a classic script, exposes window.MYTHOS.
 * Node:    module.exports guard at the bottom enables headless testing.
 * ========================================================================== */
(function (global) {
'use strict';

var MYTHOS = { version: '1.0.0' };

/* ---------------- Card definitions (injected by ui/boot or tests) -------- */
var DEFS = {}; // id -> def
MYTHOS.setDefs = function (defs) {
  DEFS = {};
  for (var i = 0; i < defs.length; i++) DEFS[defs[i].id] = defs[i];
};
function D(id) { return DEFS[id]; }

/* ---------------- Deterministic RNG (state lives inside GameState) ------- */
function rnd(st) {
  var a = st.rng | 0;
  a = (a + 0x6D2B79F5) | 0;
  var t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  st.rng = a;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rint(st, n) { return Math.floor(rnd(st) * n); }
function pick(st, arr) { return arr[rint(st, arr.length)]; }

/* ---------------- State --------------------------------------------------- */
function mkPlayer(name) {
  return {
    name: name, sanity: 40,
    deck: [], hand: [], discard: [], removed: [],
    chars: [], aboms: [], locs: [], arts: [], effs: [],
    traps: [],            // face-down trap instances (hidden from foe)
    ritualsDone: [],      // card ids of completed rituals
    shield: 0,            // Poison Pill: sanity redirected to foe
    privateUntil: -1,     // Going Private: untargetable until turn number
    ritualThisTurn: false,
    drewThisTurn: 0,
    staplerUsed: false,
  };
}

function mkInst(st, defId, owner) {
  var def = D(defId);
  var uid = 'c' + (st.nextUid++);
  var inst = {
    uid: uid, def: defId, owner: owner, controller: owner, zone: 'deck',
    justEntered: false, feral: false,
    psan: def.sanity || 0, maxPsan: def.sanity || 0,   // characters
    dmg: 0,                                            // abomination flesh damage
    leashedTo: null,
    pMod: 0, fMod: 0, cMod: 0,                         // until-end-of-turn / permanent mods
    asleepUntil: -1, noAbilUntil: -1,
    faceDown: false,
  };
  st.inst[uid] = inst;
  return inst;
}

MYTHOS.newGame = function (deckLists, opts) {
  opts = opts || {};
  var st = {
    seed: opts.seed != null ? opts.seed : ((Math.random() * 1e9) | 0),
    rng: 0, nextUid: 1,
    players: [mkPlayer(opts.names ? opts.names[0] : 'Player 1'),
              mkPlayer(opts.names ? opts.names[1] : 'Player 2')],
    inst: {},
    active: 0, phase: 'setup', turn: 0,
    firstSkipped: false,
    winner: null, winReason: null,
    pending: null,          // {kind, player, data} — awaiting a decision
    attackers: [],          // [{uid, target:{kind:'player',player}|{kind:'char',uid}}]
    blockers: {},           // attackerUid -> blockerUid
    log: [],
    mulliganUsed: [false, false],
  };
  st.rng = st.seed | 0;
  for (var p = 0; p < 2; p++) {
    var list = deckLists[p];
    for (var i = 0; i < list.length; i++) {
      var inst = mkInst(st, list[i], p);
      st.players[p].deck.push(inst.uid);
    }
    shuffle(st, st.players[p].deck);
    drawCards(st, p, 7, true); // opening hand, silent
  }
  // random first player
  st.active = rint(st, 2);
  log(st, 'First player: ' + st.players[st.active].name + ' (coin flip).');
  return st;
};

function shuffle(st, arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = rint(st, i + 1);
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}

function log(st, msg) {
  st.log.push({ turn: st.turn, phase: st.phase, msg: msg });
  if (st.log.length > 400) st.log.splice(0, st.log.length - 400);
}
MYTHOS.log = log;

function P(st, i) { return st.players[i]; }
function FOE(st, i) { return 1 - i; }
function instOf(st, uid) { return st.inst[uid]; }
function defOf(st, uid) { return D(st.inst[uid].def); }
function cname(st, uid) {
  var it = st.inst[uid], d = D(it.def);
  return d.name + (it.feral ? ' [FERAL]' : '');
}

/* ---------------- Effective stats ---------------------------------------- */
function burnedOutCount(st) {
  var n = 0, p;
  for (p = 0; p < 2; p++) {
    var cs = st.players[p].chars;
    for (var i = 0; i < cs.length; i++) if (st.inst[cs[i]].psan <= 0) n++;
  }
  return n;
}
function countType(st, pi, zone, type) {
  var n = 0, arr = st.players[pi][zone];
  for (var i = 0; i < arr.length; i++) if (D(st.inst[arr[i]].def).type === type) n++;
  return n;
}
function hasEff(st, pi, cardId) {
  var e = st.players[pi].effs;
  for (var i = 0; i < e.length; i++) if (st.inst[e[i]].def === cardId) return true;
  return false;
}
function hasLoc(st, pi, cardId) {
  var l = st.players[pi].locs;
  for (var i = 0; i < l.length; i++) if (st.inst[l[i]].def === cardId) return true;
  return false;
}
function hasAbom(st, pi, cardId) {
  var a = st.players[pi].aboms;
  for (var i = 0; i < a.length; i++) if (st.inst[a[i]].def === cardId) return true;
  return false;
}

function effPower(st, uid) {
  var it = st.inst[uid], d = D(it.def), p = it.controller, pow = (d.power || 0) + it.pMod;
  if (d.id === 16) { // Synergy Hound
    var n = 0, a = st.players[p].aboms;
    for (var i = 0; i < a.length; i++) if (a[i] !== uid) n++;
    pow += n;
  }
  if (d.id === 22) pow = burnedOutCount(st); // Layoff Swarm
  if (d.id === 30 && st.players[p].sanity < st.players[FOE(st, p)].sanity) pow += 3; // Glass Cliff
  if (it.leashedTo) {
    var ch = st.inst[it.leashedTo];
    if (ch && ch.def === 51) pow += 1; // Griselda
  }
  return Math.max(0, pow);
}

function effFlesh(st, uid) {
  var it = st.inst[uid], d = D(it.def), p = it.controller, f = (d.flesh || 0) + it.fMod;
  if (d.id === 22) f = Math.max(burnedOutCount(st), 1); // Layoff Swarm (min 1 so it can exist)
  if (hasLoc(st, p, 44)) f += 1;                       // The Grove
  if (hasAbom(st, p, 23)) f += 1;                      // Micromanager
  return Math.max(1, f);
}

function effControl(st, uid) {
  var it = st.inst[uid], d = D(it.def);
  var c = (d.control || 0) + it.cMod;
  if (hasAbom(st, it.controller, 23)) c -= 1;           // Micromanager undermines
  return Math.max(0, c);
}

// free leash capacity on a character for NEW leashes (Pax: +1 body)
function freeControl(st, charUid) {
  var ch = st.inst[charUid];
  if (ch.psan <= 0) return -99; // burned out: no new leashes
  var used = 0, p = ch.controller, extra = 0;
  var a = st.players[p].aboms;
  for (var i = 0; i < a.length; i++) {
    var ab = st.inst[a[i]];
    if (ab.leashedTo === charUid) used += (D(ab.def).leash || 0);
  }
  if (ch.def === 52) extra = 1; // Pax: one additional abomination
  return effControl(st, charUid) + extra - used;
}

function effUpkeep(st, uid) {
  var it = st.inst[uid], d = D(it.def);
  var u = d.upkeep || 0;
  if (it.stapleOff) u -= 1; // Red Stapler applied this turn
  return Math.max(0, u);
}

// sanity cost to play a card from hand (before paying)
function playCost(st, pi, defId) {
  var d = D(defId), c = d.cost || 0;
  if (d.type === 'Character') {
    if (defId === 54) { // Tess
      var others = st.players[pi].chars.length;
      c = Math.max(0, c - others);
    }
  }
  if (d.type === 'Abomination') {
    if (defId === 27) c = Math.max(0, c - st.players[pi].chars.filter(function (u) { return st.inst[u].psan <= 0; }).length); // Founder
    if (defId === 38) c = Math.max(0, c - 2 * st.players[pi].aboms.length); // Merger
    if (hasAbom(st, FOE(st, pi), 29)) c += 1; // Non-Compete Clause
  }
  if (d.type === 'Ritual' && (hasAbom(st, 0, 21) || hasAbom(st, 1, 21))) c += 1; // Meeting Elemental
  return Math.max(0, c);
}

function abilityCost(st, pi, charUid, base) {
  var c = base;
  if (hasAbom(st, FOE(st, pi), 58)) c += 1; // The NDA
  return c;
}

/* ---------------- Sanity / damage / win ---------------------------------- */
function checkWin(st) {
  if (st.winner) return;
  for (var p = 0; p < 2; p++) {
    if (st.players[p].sanity <= 0) {
      st.winner = FOE(st, p);
      st.winReason = st.players[FOE(st, p)].name + ' broke ' + st.players[p].name + ' (sanity reached 0).';
      return;
    }
    if (st.players[p].ritualsDone.length >= 3) {
      st.winner = p;
      st.winReason = st.players[p].name + ' completed 3 rituals — HOSTILE TAKEOVER OF REALITY.';
      return;
    }
  }
}

// damage to a player's sanity pool (Poison Pill redirect applies)
function damagePlayer(st, pi, amt, src) {
  if (amt <= 0 || st.winner) return;
  var me = st.players[pi], foe = st.players[FOE(st, pi)];
  if (me.shield > 0) {
    var redir = Math.min(amt, me.shield);
    me.shield -= redir; amt -= redir;
    if (redir > 0) {
      log(st, me.name + "'s Poison Pill redirects " + redir + ' sanity to ' + foe.name + '.');
      foe.sanity -= redir;
    }
  }
  if (amt > 0) {
    me.sanity -= amt;
    log(st, (src ? src + ' deals ' : '') + amt + ' sanity damage to ' + me.name + ' (' + Math.max(0, me.sanity) + ' left).');
  }
  checkWin(st);
}

function gainSanity(st, pi, amt, src) {
  if (amt <= 0 || st.winner) return;
  st.players[pi].sanity += amt;
  log(st, (src ? src + ': ' : '') + st.players[pi].name + ' gains ' + amt + ' sanity (' + st.players[pi].sanity + ').');
}

function damageChar(st, uid, amt, src) {
  if (amt <= 0 || st.winner) return;
  var it = st.inst[uid];
  var wasOut = it.psan <= 0;
  it.psan = Math.max(0, it.psan - amt);
  log(st, (src ? src + ' deals ' : '') + amt + ' damage to ' + cname(st, uid) + ' (' + it.psan + '/' + it.maxPsan + ' personal sanity).');
  if (!wasOut && it.psan <= 0) onBurnout(st, it);
}

function healChar(st, uid, amt, src) {
  if (amt <= 0 || st.winner) return;
  var it = st.inst[uid];
  if (it.psan >= it.maxPsan && it.psan > 0) return;
  var before = it.psan;
  it.psan = Math.min(it.maxPsan, it.psan + amt);
  if (it.psan > before) {
    log(st, (src ? src + ': ' : '') + cname(st, uid) + ' recovers ' + (it.psan - before) + ' personal sanity.');
    if (hasEff(st, it.controller, 50)) { // Synergy
      var cs = st.players[it.controller].chars;
      for (var i = 0; i < cs.length; i++) {
        if (cs[i] !== uid) {
          var o = st.inst[cs[i]];
          var b2 = o.psan;
          o.psan = Math.min(o.maxPsan, o.psan + 1);
          if (o.psan > b2) log(st, 'Synergy: ' + cname(st, cs[i]) + ' gains 1 personal sanity.');
        }
      }
    }
  }
}

function onBurnout(st, it) {
  var d = D(it.def);
  log(st, cname(st, it.uid) + ' BURNS OUT — abilities off, prime ritual fuel.');
  // Cinder: your characters burning out gains you 2 sanity
  var cs = st.players[it.controller].chars;
  for (var i = 0; i < cs.length; i++) {
    if (st.inst[cs[i]].def === 7 && cs[i] !== it.uid) {
      gainSanity(st, it.controller, 2, 'Cinder, VP of Salvage');
    }
  }
}

function damageAbom(st, uid, amt, src) {
  if (amt <= 0 || st.winner) return;
  var it = st.inst[uid];
  it.dmg += amt;
  log(st, (src ? src + ' deals ' : '') + amt + ' damage to ' + cname(st, uid) + ' (' + it.dmg + '/' + effFlesh(st, uid) + ').');
  if (it.def === 17) damagePlayer(st, FOE(st, it.controller), 1, 'Passive-Aggressive Golem'); // cc'd everyone
  if (it.dmg >= effFlesh(st, uid)) destroyAbom(st, uid, src);
}

function destroyAbom(st, uid, src) {
  var it = st.inst[uid];
  if (it.zone !== 'board') return;
  removeFromBoard(st, it);
  it.zone = 'discard';
  st.players[it.owner].discard.push(uid);
  log(st, cname(st, uid) + ' is destroyed' + (src ? ' by ' + src : '') + '.');
  // death triggers
  if (it.def === 9) gainSanity(st, it.controller, 1, 'The Intern');            // exit interview
  if (it.def === 35) drawCards(st, it.controller, 2);                            // Exit Interview
  if (it.def === 19) {                                                           // Whistleblower
    var foe = FOE(st, it.controller), h = st.players[foe].hand;
    if (h.length) {
      var di = rint(st, h.length), gone = h.splice(di, 1)[0];
      st.players[foe].discard.push(gone); st.inst[gone].zone = 'discard';
      log(st, 'The Whistleblower leaks: ' + st.players[foe].name + ' discards ' + D(st.inst[gone].def).name + ' at random.');
    }
  }
  if (src === 'The Liquidator' && it.controller !== undefined) {
    // handled by caller (needs controller of liquidator) — see resolveCombat
  }
}

function removeFromBoard(st, it) {
  var pl = st.players[it.controller];
  ['chars', 'aboms', 'locs', 'arts', 'effs'].forEach(function (z) {
    var i = pl[z].indexOf(it.uid);
    if (i >= 0) pl[z].splice(i, 1);
  });
}

// sacrifice a burned-out character (ritual fuel). Its abominations: reassign or feral.
function sacrificeChar(st, uid, why) {
  var it = st.inst[uid], p = it.controller;
  // find its abominations
  var mine = st.players[p].aboms.filter(function (a) { return st.inst[a].leashedTo === uid; });
  removeFromBoard(st, it);
  it.zone = 'removed';
  st.players[it.owner].removed.push(uid);
  log(st, cname(st, uid) + ' is sacrificed' + (why ? ' (' + why + ')' : '') + '.');
  mine.forEach(function (a) {
    var ab = st.inst[a];
    var placed = false;
    var cs = st.players[p].chars;
    for (var i = 0; i < cs.length && !placed; i++) {
      if (freeControl(st, cs[i]) >= (D(ab.def).leash || 0)) { ab.leashedTo = cs[i]; placed = true; }
    }
    if (!placed) goFeral(st, a, 'handler sacrificed');
  });
}

function goFeral(st, uid, why) {
  var it = st.inst[uid];
  if (it.feral || it.zone !== 'board') return;
  it.feral = true; it.leashedTo = null;
  var pow = effPower(st, uid);
  if (it.def === 36) pow *= 2; // Shadow IT was never approved
  log(st, cname(st, uid) + ' goes FERAL' + (why ? ' (' + why + ')' : '') + ' — leash snaps!');
  damagePlayer(st, it.controller, pow, cname(st, uid));
}

/* ---------------- Draw ---------------------------------------------------- */
function drawCards(st, pi, n, silent) {
  var pl = st.players[pi];
  for (var i = 0; i < n; i++) {
    if (!pl.deck.length) {
      if (!st.winner) {
        st.winner = FOE(st, pi);
        st.winReason = st.players[pi].name + ' must draw from an empty deck — drowned in paperwork. ' + st.players[FOE(st, pi)].name + ' wins.';
        log(st, st.winReason);
      }
      return;
    }
    var uid = pl.deck.pop();
    st.inst[uid].zone = 'hand';
    pl.hand.push(uid);
    if (!silent) {
      pl.drewThisTurn++;
      // Plica: enemies drawing cards lose 1 sanity
      var foe = FOE(st, pi);
      var fc = st.players[foe].chars;
      for (var k = 0; k < fc.length; k++) {
        if (st.inst[fc[k]].def === 5 && st.inst[fc[k]].psan > 0) {
          damagePlayer(st, pi, 1, 'Plica, Director of Red Tape');
          break;
        }
      }
      // Mandatory Fun check happens at trigger scan (drawsThisTurn>=2)
    }
  }
  if (!silent) {
    log(st, st.players[pi].name + ' draws ' + n + ' card' + (n > 1 ? 's' : '') + '.');
    scanTrap(st, 'draw', pi);
  }
}

/* ---------------- Phases --------------------------------------------------- */
var PHASES = ['draw', 'upkeep', 'main', 'offense', 'end'];

MYTHOS.startGame = function (st) {
  // setup mulligans are resolved via doAction mulligan/pass; begin turn 1
  st.phase = 'turnstart';
  MYTHOS.nextPhase(st);
};

MYTHOS.nextPhase = function (st) {
  if (st.winner || st.pending) return { ok: false, error: 'Resolve pending decision first.' };
  if (st.phase === 'end' && st.players[st.active].hand.length > 7)
    return { ok: false, error: 'Discard down to 7 cards first.' };
  if (st.phase === 'upkeep') {
    // any upkeep neither paid nor declined goes feral ("can't (or won't) pay")
    st.players[st.active].aboms.slice().forEach(function (u) {
      var it = st.inst[u];
      if (!it.feral && !it.upkeepPaid) {
        if (effUpkeep(st, u) <= 0) it.upkeepPaid = true;
        else { goFeral(st, u, 'upkeep unpaid'); it.upkeepPaid = true; }
      }
    });
  }
  if (st.phase === 'offense' && st.attackers.length && !st.combatResolved) {
    return { ok: false, error: 'Resolve combat first.' };
  }
  if (st.phase === 'offense') {
    // Paper Jam must attack if able
    var pj = st.players[st.active].aboms.filter(function (u) {
      return st.inst[u].def === 13 && canAttack(st, u) && !attackedThis(st, u);
    });
    if (pj.length) return { ok: false, error: 'Paper Jam must attack each turn if able.' };
  }
  var idx = PHASES.indexOf(st.phase);
  if (st.phase === 'turnstart' || idx < 0) { beginTurn(st); return { ok: true }; }
  if (st.phase === 'end') { beginTurn(st); return { ok: true }; }
  st.phase = PHASES[idx + 1];
  enterPhase(st);
  return { ok: true };
};

function beginTurn(st) {
  st.active = st.turn === 0 && !st.gameStarted ? st.active : FOE(st, st.active);
  st.gameStarted = true;
  st.turn++;
  var pl = st.players[st.active];
  pl.ritualThisTurn = false; pl.drewThisTurn = 0; pl.staplerUsed = false;
  st.attackers = []; st.blockers = {}; st.combatResolved = false;
  // reset justEntered / temp mods
  Object.keys(st.inst).forEach(function (uid) {
    var it = st.inst[uid];
    it.justEntered = false; it.stapleOff = false; it.upkeepPaid = false;
    it.pMod = 0; it.fMod = 0; it.cMod = 0;
  });
  // clear sleep/ability locks that expired
  Object.keys(st.inst).forEach(function (uid) {
    var it = st.inst[uid];
    if (it.asleepUntil < st.turn && it.asleepUntil !== -1) it.asleepUntil = -1;
    if (it.noAbilUntil < st.turn && it.noAbilUntil !== -1) it.noAbilUntil = -1;
  });
  log(st, '—— Turn ' + st.turn + ': ' + pl.name + ' ——');
  st.phase = 'draw';
  enterPhase(st);
}

function enterPhase(st) {
  var p = st.active, pl = st.players[p];
  if (st.phase === 'draw') {
    if (st.turn === 1 && !st.firstSkipped) {
      st.firstSkipped = true;
      log(st, pl.name + ' skips the first draw (first player).');
    } else {
      drawCards(st, p, 1);
    }
  } else if (st.phase === 'upkeep') {
    // Break Room: characters recover 1
    if (hasLoc(st, p, 60)) {
      pl.chars.forEach(function (u) { healChar(st, u, 1, 'The Break Room'); });
    }
    // Aletheia: asleep characters' controllers gain 2
    var asleep = [];
    for (var q = 0; q < 2; q++) {
      st.players[q].chars.forEach(function (u) {
        if (st.inst[u].asleepUntil >= st.turn) asleep.push(u);
      });
    }
    if (asleep.length && (hasAbom(st, 0, 6) || hasAbom(st, 1, 6))) {
      // each controller of an Aletheia gains 2 per asleep character — simplify: controller of Aletheia gains 2 per asleep char
      for (var a = 0; a < 2; a++) if (hasAbom(st, a, 6)) gainSanity(st, a, 2 * asleep.length, 'Aletheia, VP of Grand Reveals');
    }
    // upkeep payment order: UI/AI pays per abomination via pay_upkeep/skip_upkeep.
    // If no abominations, nothing to do.
    log(st, pl.name + ' upkeep: pay or skip each abomination.');
  } else if (st.phase === 'main') {
    log(st, pl.name + ' main phase.');
  } else if (st.phase === 'offense') {
    // feral abominations hit their owner's sanity
    pl.aboms.slice().forEach(function (u) {
      var it = st.inst[u];
      if (it.feral) {
        var pow = effPower(st, u);
        if (it.def === 36) pow *= 2;
        damagePlayer(st, p, pow, cname(st, u) + ' (feral)');
      }
    });
    // Performance Reviewer: 1 to each of YOUR characters, then +2 power
    pl.aboms.forEach(function (u) {
      if (st.inst[u].def === 28) {
        pl.chars.slice().forEach(function (c) { damageChar(st, c, 1, 'Performance Reviewer'); });
        st.inst[u].pMod += 2;
        log(st, 'Performance Reviewer gains +2 Power until end of turn (360 feedback).');
      }
    });
    log(st, pl.name + ' offense: declare attackers.');
  } else if (st.phase === 'end') {
    // The Temp
    pl.aboms.slice().forEach(function (u) {
      if (st.inst[u].def === 14 && st.inst[u].zone === 'board' && !st.pending) {
        st.pending = { kind: 'temp', player: p, uid: u };
        log(st, 'The Temp\'s contract is up — pay 1 sanity or it returns to hand.');
      }
    });
    // discard down to 7 handled by UI/AI via discard actions; auto-check:
    log(st, pl.name + ' end phase: discard down to 7.');
  }
}

/* upkeep helpers */
MYTHOS.upkeepList = function (st, pi) {
  return st.players[pi].aboms.filter(function (u) {
    var it = st.inst[u];
    return it.zone === 'board' && !it.feral && !it.upkeepPaid;
  });
};

function payUpkeep(st, pi, uid) {
  var it = st.inst[uid], u = effUpkeep(st, uid), pl = st.players[pi];
  if (pl.sanity < u) return { ok: false, error: 'Cannot afford upkeep.' };
  pl.sanity -= u;
  it.upkeepPaid = true;
  log(st, pl.name + ' pays ' + u + ' upkeep for ' + cname(st, uid) + '.');
  if (u > 0) {
    // Middle Manager: whenever you pay an upkeep, gain 1
    if (hasAbom(st, pi, 25) && uid !== undefined) {
      var mm = st.players[pi].aboms.filter(function (x) { return st.inst[x].def === 25 && x !== uid; });
      if (mm.length) gainSanity(st, pi, 1, 'Middle Manager');
    }
  }
  if (it.def === 11) { // Coffee Elemental: upkeep paid -> a character gains 1
    st.pending = { kind: 'coffee', player: pi, uid: uid };
  }
  if (pl.sanity <= 0) checkWin(st);
  return { ok: true };
}

/* ---------------- Combat --------------------------------------------------- */
function canAttack(st, uid) {
  var it = st.inst[uid];
  if (it.zone !== 'board' || it.feral) return false;
  if (it.controller !== st.active || st.phase !== 'offense') return false;
  if (effPower(st, uid) <= 0) return false;
  if (it.justEntered && it.def !== 18) return false; // summoning sickness (not Overtime Wraith)
  return true;
}
function attackedThis(st, uid) {
  return st.attackers.some(function (a) { return a.uid === uid; });
}
function canBlock(st, uid) {
  var it = st.inst[uid];
  if (it.zone !== 'board' || it.feral) return false;
  if (it.asleepUntil >= st.turn) return false;
  var d = D(it.def);
  if (d.type !== 'Abomination' && d.type !== 'Character') return false;
  // already blocking?
  for (var k in st.blockers) if (st.blockers[k] === uid) return false;
  return true;
}

function resolveCombat(st) {
  var atk = st.attackers.slice();
  st.combatResolved = true;
  log(st, 'Combat resolves: ' + atk.length + ' attacker(s).');
  atk.forEach(function (a) {
    var it = st.inst[a.uid];
    if (!it || it.zone !== 'board') return;
    // attack triggers
    if (it.def === 15) gainSanity(st, it.controller, 1, 'Cubicle Shambler'); // loose change
    if (it.def === 34) { // Hostile Elemental
      var n = st.players[FOE(st, it.controller)].arts.length;
      if (n) damagePlayer(st, FOE(st, it.controller), n, 'Hostile Elemental');
    }
    var pow = effPower(st, a.uid);
    var blkUid = st.blockers[a.uid];
    if (blkUid && st.inst[blkUid] && st.inst[blkUid].zone === 'board') {
      var b = st.inst[blkUid], bd = D(b.def);
      var bpow = bd.type === 'Character' ? effControl(st, blkUid) : effPower(st, blkUid);
      log(st, cname(st, blkUid) + ' blocks ' + cname(st, a.uid) + '.');
      // simultaneous
      if (bd.type === 'Character') damageChar(st, blkUid, pow, cname(st, a.uid));
      else damageAbom(st, blkUid, pow, cname(st, a.uid));
      // attacker takes blocker damage
      if (b.controller !== it.controller || true) {
        // Downsizer / Liquidator credit if THEIR damage destroys
        var before = st.inst[blkUid] ? st.inst[blkUid].zone : null;
        damageAbom(st, a.uid, bpow, cname(st, blkUid));
        creditDestroy(st, it, blkUid, bpow, bd);
      }
    } else {
      if (a.target.kind === 'player') damagePlayer(st, a.target.player, pow, cname(st, a.uid));
      else if (a.target.kind === 'char') {
        var t = st.inst[a.target.uid];
        if (t && t.zone === 'board') {
          var wasOut = t.psan <= 0;
          damageChar(st, a.target.uid, pow, cname(st, a.uid));
          if (it.def === 24 && !wasOut && t.psan <= 0) {
            // Downsizer destroyed a character via damage — but characters burn out, not destroyed...
          }
        }
      }
    }
  });
  st.attackers = []; st.blockers = {};
  checkWin(st);
}

// credit "when X destroys" triggers from combat damage
function creditDestroy(st, atkIt, targetUid, dmgDealt, targetDef) {
  var t = st.inst[targetUid];
  var destroyed = t && t.zone === 'discard'; // damageAbom moved it
  if (!destroyed) return;
  if (atkIt.def === 32 && targetDef.type === 'Abomination') { // Liquidator
    gainSanity(st, atkIt.controller, D(t.def).cost || 0, 'The Liquidator');
  }
  if (atkIt.def === 24 && targetDef.type === 'Character') { // Downsizer (edge: chars burn out, rarely destroyed)
    gainSanity(st, atkIt.controller, 2, 'The Downsizer');
  }
}

/* ---------------- Traps ---------------------------------------------------- */
function scanTrap(st, evt, pi) {
  // evt: 'draw' (pi drew), called after draws; HR handled at attack declaration
  if (evt === 'draw') {
    var foe = FOE(st, pi);
    st.players[foe].traps.slice().forEach(function (tuid) {
      var t = st.inst[tuid];
      if (t.def === 48 && st.players[pi].drewThisTurn >= 2) { // Mandatory Fun
        fireTrap(st, foe, tuid);
        var h = st.players[pi].hand;
        if (h.length) {
          var di = rint(st, h.length), gone = h.splice(di, 1)[0];
          st.players[pi].discard.push(gone); st.inst[gone].zone = 'discard';
          log(st, 'Mandatory Fun: ' + st.players[pi].name + ' discards ' + D(st.inst[gone].def).name + ' at random. Attendance was optional.');
        }
      }
    });
  }
}
function fireTrap(st, owner, tuid) {
  var t = st.inst[tuid], pl = st.players[owner];
  var i = pl.traps.indexOf(tuid); if (i >= 0) pl.traps.splice(i, 1);
  t.zone = 'discard'; pl.discard.push(tuid);
  log(st, 'TRAP TRIGGERED: ' + D(t.def).name + ' (' + pl.name + ').');
}
function checkHRTrap(st, attackerUid) {
  var atk = st.inst[attackerUid], def = FOE(st, atk.controller);
  var traps = st.players[def].traps;
  for (var i = 0; i < traps.length; i++) {
    if (st.inst[traps[i]].def === 47) { // HR Complaint
      fireTrap(st, def, traps[i]);
      st.pending = { kind: 'hr', player: atk.controller, attackerUid: attackerUid };
      log(st, 'HR Complaint: ' + st.players[atk.controller].name + ' must sacrifice ' + cname(st, attackerUid) + ' or pay 3 sanity (settlement).');
      return true;
    }
  }
  return false;
}

/* ---------------- Targeting helpers ---------------------------------------- */
function untargetable(st, pi) { return st.turn <= st.players[pi].privateUntil; }

function legalTargets(st, pi, spec) {
  // spec: 'enemy_char' | 'any_char' | 'own_char' | 'enemy_abom' | 'any_abom' | 'own_discard' | 'location' | 'enemy_char_le2'
  var out = [];
  function pushChar(q, filter) {
    st.players[q].chars.forEach(function (u) {
      if (untargetable(st, q) && q !== pi) return;
      if (filter && !filter(u)) return;
      out.push(u);
    });
  }
  function pushAbom(q) {
    st.players[q].aboms.forEach(function (u) {
      if (untargetable(st, q) && q !== pi) return;
      if (!st.inst[u].feral) out.push(u);
    });
  }
  var foe = FOE(st, pi);
  if (spec === 'enemy_char') pushChar(foe);
  else if (spec === 'own_char') pushChar(pi);
  else if (spec === 'any_char') { pushChar(pi); pushChar(foe); }
  else if (spec === 'enemy_char_le2') pushChar(foe, function (u) { return effControl(st, u) <= 2; });
  else if (spec === 'enemy_abom') pushAbom(foe);
  else if (spec === 'any_abom') { pushAbom(pi); pushAbom(foe); }
  else if (spec === 'own_discard') { return st.players[pi].discard.slice(); }
  else if (spec === 'location') {
    for (var q = 0; q < 2; q++) st.players[q].locs.forEach(function (u) { out.push(u); });
  }
  return out;
}

// which target spec a card needs when played/activated (null = none)
function targetSpecFor(st, pi, uid) {
  var it = st.inst[uid], id = it.def;
  switch (id) {
    case 45: return 'any_char';                       // PIP
    case 59: return 'enemy_char_le2';                 // Downsizing
    case 4: return 'any_char';                        // Somnia enter (handled via pending)
    case 6: return 'any_char';
    case 31: return 'location';                       // Restructurer
    case 40: return 'enemy_abom';                     // Tender Offer
    case 55: return 'any_abom';                       // Pivot (needs two — second via pending)
    case 1: return 'any_char';                        // Sermon (activate)
    case 2: return 'any_char';                        // Morning Routine
    case 5: return 'enemy_char';                       // Red Tape
    case 7: return 'own_discard';                      // Reclamation
    default: return null;
  }
}


/* ============================ PART 2: actions ============================= */

function abilReady(st, uid) {
  var it = st.inst[uid];
  return it.zone === 'board' && it.psan > 0 && !(it.asleepUntil >= st.turn) && !(it.noAbilUntil >= st.turn);
}

// What does playing this hand card need? null = cannot / no extra need.
MYTHOS.canPlay = function (st, pi, uid) {
  var it = st.inst[uid];
  if (!it || it.zone !== 'hand' || it.owner !== pi) return { ok: false, error: 'Not in your hand.' };
  if (st.phase !== 'main' || st.active !== pi) return { ok: false, error: 'Play cards in your Main phase.' };
  var d = D(it.def), cost = playCost(st, pi, it.def);
  if (st.players[pi].sanity < cost) return { ok: false, error: 'Cannot afford (' + cost + ' sanity).' };
  if (d.type === 'Abomination') {
    var opts = leashOptions(st, pi, it.def, uid);
    if (!opts.length) return { ok: false, error: 'No character with free Control to leash it.' };
    return { ok: true, cost: cost, need: it.def === 33 ? 'boardsplit' : (it.def === 37 ? 'mole' : 'leash'), leashOptions: opts };
  }
  if (d.type === 'Ritual') return { ok: false, error: 'Rituals are performed via the Ritual button (needs site + sacrifice).' };
  var spec = (it.def === 45 || it.def === 59) ? targetSpecFor(st, pi, uid) : null;
  if (spec && !legalTargets(st, pi, spec).length) return { ok: false, error: 'No legal target.' };
  return { ok: true, cost: cost, need: spec ? 'target' : null, targetSpec: spec };
};

function leashOptions(st, pi, defId, selfUid) {
  // returns list of {char, foe} available
  var out = [];
  var leash = D(defId).leash || 0;
  function consider(q, foe) {
    st.players[q].chars.forEach(function (c) {
      if (c === selfUid) return;
      if (defId === 33) { if (freeControl(st, c) > 0 || true) out.push({ char: c, foe: foe }); }
      else if (freeControl(st, c) >= leash) out.push({ char: c, foe: foe });
    });
  }
  consider(pi, false);
  if (defId === 37) consider(FOE(st, pi), true); // The Mole may infiltrate
  return out;
}

function payCost(st, pi, amt, what) {
  st.players[pi].sanity -= amt;
  log(st, st.players[pi].name + ' pays ' + amt + ' sanity' + (what ? ' (' + what + ')' : '') + ' — ' + Math.max(0, st.players[pi].sanity) + ' left.');
  checkWin(st);
}

function moveToBoard(st, it, zone) {
  it.zone = 'board'; it.justEntered = true;
  st.players[it.controller][zone].push(it.uid);
}

function onEnter(st, it) {
  var p = it.controller, id = it.def, d = D(id);
  log(st, cname(st, it.uid) + ' enters play.');
  switch (id) {
    case 1: { // Supreme Worshiper
      var others = st.players[p].chars.filter(function (u) { return u !== it.uid; }).length;
      if (others) gainSanity(st, p, 2 * others, 'Supreme Worshiper');
      break;
    }
    case 2: // Xochitl
      st.players[p].chars.forEach(function (u) { if (u !== it.uid) healChar(st, u, 2, 'Xochitl'); });
      break;
    case 4: case 6: // Somnia / Aletheia: target sleeps
      st.pending = { kind: 'sleep_pick', player: p, uid: it.uid };
      break;
    case 8: drawCards(st, p, 1); break; // Mothman (v1 provisional)
    case 10: st.pending = { kind: 'mimic', player: p, uid: it.uid }; break; // Mailroom Mimic
    case 12: // Reply-All Wisp
      drawCards(st, p, 1);
      st.pending = { kind: 'wisp_discard', player: p, uid: it.uid };
      break;
    case 20: st.pending = { kind: 'auditor', player: p, uid: it.uid }; break;
    case 26: drawCards(st, p, 2); break; // Consultant
    case 31: st.pending = { kind: 'restructurer', player: p, uid: it.uid }; break;
    case 53: { // Marrow
      var n = st.players[p].chars.filter(function (u) { return st.inst[u].psan <= 0; }).length;
      if (n) drawCards(st, p, n);
      break;
    }
    case 57: { // Full-Timer: may sacrifice own Intern
      var interns = st.players[p].aboms.filter(function (u) { return st.inst[u].def === 9 && u !== it.uid; });
      if (interns.length) st.pending = { kind: 'fulltimer', player: p, uid: it.uid, internUid: interns[0] };
      break;
    }
  }
}

// Vex tax: enemies targeting Vex lose 2 sanity
function vexTax(st, pi, targetUid) {
  var t = st.inst[targetUid];
  if (t && t.def === 3 && t.controller !== pi) {
    damagePlayer(st, pi, 2, 'Vex, VP of Wish Fulfillment');
  }
}

function playCard(st, pi, uid, opts) {
  opts = opts || {};
  var chk = MYTHOS.canPlay(st, pi, uid);
  if (!chk.ok) return chk;
  var it = st.inst[uid], d = D(it.def), pl = st.players[pi];
  var cost = chk.cost;
  // target validation
  var spec = (it.def === 45 || it.def === 59) ? targetSpecFor(st, pi, uid) : null;
  if (spec) {
    var tg = legalTargets(st, pi, spec);
    if (opts.target == null || tg.indexOf(opts.target) < 0) return { ok: false, error: 'Choose a legal target.' };
    vexTax(st, pi, opts.target);
  }
  payCost(st, pi, cost, d.name);
  if (st.winner) return { ok: true, paidAndDied: true };
  // remove from hand
  pl.hand.splice(pl.hand.indexOf(uid), 1);

  if (d.type === 'Character') {
    moveToBoard(st, it, 'chars');
    onEnter(st, it);
  } else if (d.type === 'Abomination') {
    var leash = d.leash || 0;
    if (it.def === 33) { // The Board: split across characters
      var split = opts.split || [];
      var tot = 0, okAll = true;
      split.forEach(function (s) {
        if (freeControl(st, s.char) < s.n) okAll = false;
        tot += s.n;
      });
      if (!okAll || tot !== 3 || !split.length) { // refund: put back
        pl.hand.push(uid); it.zone = 'hand'; pl.sanity += cost;
        return { ok: false, error: 'The Board needs its 3 leash split across characters with free Control.' };
      }
      it.splitLeash = split.map(function (s) { return s.char; });
      it.leashedTo = split[0].char;
      moveToBoard(st, it, 'aboms');
    } else {
      var o = leashOptions(st, pi, it.def, uid).filter(function (x) { return x.char === opts.leashTo; })[0];
      if (!o) { pl.hand.push(uid); it.zone = 'hand'; pl.sanity += cost; return { ok: false, error: 'Choose a character to leash it to.' }; }
      if (o.foe) { // The Mole infiltration
        it.controller = FOE(st, pi);
        log(st, 'The Mole infiltrates ' + st.players[it.controller].name + "'s team.");
      }
      it.leashedTo = o.char;
      moveToBoard(st, it, 'aboms');
    }
    onEnter(st, it);
  } else if (d.type === 'Action') {
    it.zone = 'discard'; pl.discard.push(uid);
    resolveAction(st, pi, it, opts);
  } else if (d.type === 'Artifact') {
    moveToBoard(st, it, 'arts');
    log(st, d.name + ' stays in play.');
  } else if (d.type === 'Effect') {
    moveToBoard(st, it, 'effs');
    log(st, d.name + ' is ongoing.');
  } else if (d.type === 'Location') {
    moveToBoard(st, it, 'locs');
    log(st, d.name + ' established.');
  }
  checkWin(st);
  return { ok: true };
}

function resolveAction(st, pi, it, opts) {
  var id = it.def, foe = FOE(st, pi);
  if (id === 45) { // PIP
    var t = st.inst[opts.target];
    if (t.psan <= 0) healChar(st, opts.target, 2, 'Performance Improvement Plan');
    else { t.cMod += 2; log(st, cname(st, opts.target) + ' gets +2 Control until end of turn (PIP).'); }
  } else if (id === 46) { // Reply All
    st.players[foe].chars.slice().forEach(function (c) { damageChar(st, c, 1, 'Reply All'); });
  } else if (id === 59) { // Downsizing
    var v = st.inst[opts.target];
    removeFromBoard(st, v);
    v.zone = 'discard'; st.players[v.owner].discard.push(opts.target);
    log(st, cname(st, opts.target) + ' is DOWNSIZED (destroyed).');
    // its abominations: reassign or feral
    st.players[v.controller].aboms.slice().forEach(function (a) {
      var ab = st.inst[a];
      if (ab.leashedTo === opts.target) {
        var placed = false, cs = st.players[v.controller].chars;
        for (var i = 0; i < cs.length && !placed; i++) {
          if (freeControl(st, cs[i]) >= (D(ab.def).leash || 0)) { ab.leashedTo = cs[i]; placed = true; }
        }
        if (!placed) goFeral(st, a, 'handler downsized');
      }
    });
    // The Downsizer credit if our Downsizer... (action, not the abomination) — no credit
  }
}

MYTHOS.setTrap = function (st, pi, uid) {
  var it = st.inst[uid];
  if (!it || it.zone !== 'hand' || D(it.def).type !== 'Trap') return { ok: false, error: 'Not a trap in hand.' };
  if (st.phase !== 'main' || st.active !== pi) return { ok: false, error: 'Set traps in your Main phase.' };
  var cost = playCost(st, pi, it.def);
  if (st.players[pi].sanity < cost) return { ok: false, error: 'Cannot afford.' };
  payCost(st, pi, cost, D(it.def).name);
  st.players[pi].hand.splice(st.players[pi].hand.indexOf(uid), 1);
  it.zone = 'traps'; it.faceDown = true;
  st.players[pi].traps.push(uid);
  log(st, st.players[pi].name + ' sets a trap face-down.');
  return { ok: true };
};

/* Activated character abilities */
var ACTIVATED = {
  1: { cost: 2, name: 'Sermon', target: 'any_char' },
  2: { cost: 1, name: 'Morning Routine', target: 'any_char' },
  3: { cost: 3, name: 'Three Wishes', target: null },
  4: { cost: 2, name: 'Daydream', target: null },
  5: { cost: 1, name: 'Red Tape', target: 'enemy_char' },
  7: { cost: 2, name: 'Reclamation', target: 'own_discard' },
};
MYTHOS.activatedInfo = function (st, uid) { return ACTIVATED[st.inst[uid].def] || null; };

MYTHOS.activate = function (st, pi, uid, target) {
  var it = st.inst[uid];
  if (!it || it.zone !== 'board' || it.controller !== pi) return { ok: false, error: 'Not your card in play.' };
  if (st.phase !== 'main' || st.active !== pi) return { ok: false, error: 'Abilities in your Main phase.' };
  if (!abilReady(st, uid)) return { ok: false, error: 'That character cannot use abilities right now.' };
  if (it.lastActivatedTurn === st.turn) return { ok: false, error: 'Already used this turn (once per turn).' };
  var ab = ACTIVATED[it.def];
  if (!ab) return { ok: false, error: 'No activated ability.' };
  var cost = abilityCost(st, pi, uid, ab.cost);
  if (st.players[pi].sanity < cost) return { ok: false, error: 'Cannot afford ability.' };
  if (ab.target) {
    var tg = legalTargets(st, pi, ab.target);
    if (target == null || tg.indexOf(target) < 0) return { ok: false, error: 'Choose a legal target.' };
    if (ab.target !== 'own_discard') vexTax(st, pi, target);
  }
  payCost(st, pi, cost, ab.name);
  if (st.winner) return { ok: true };
  log(st, cname(st, uid) + ' uses ' + ab.name + '.');
  it.lastActivatedTurn = st.turn;
  if (it.def === 1 || it.def === 2) healChar(st, target, 2, ab.name);
  else if (it.def === 3) drawCards(st, pi, 2);
  else if (it.def === 4) drawCards(st, pi, 1);
  else if (it.def === 5) { st.inst[target].noAbilUntil = st.turn + 1; log(st, cname(st, target) + ' is buried in red tape (no abilities until ' + st.players[pi].name + "'s next turn)."); }
  else if (it.def === 7) {
    var di = st.players[pi].discard.indexOf(target);
    if (di >= 0) {
      st.players[pi].discard.splice(di, 1);
      st.inst[target].zone = 'hand'; st.players[pi].hand.push(target);
      log(st, 'Reclamation: ' + D(st.inst[target].def).name + ' returns to hand.');
    }
  }
  checkWin(st);
  return { ok: true };
};

/* Rituals */
MYTHOS.ritualInfo = function (st, pi, uid) {
  var it = st.inst[uid], pl = st.players[pi];
  if (!it || it.zone !== 'hand' || D(it.def).type !== 'Ritual') return { ok: false, error: 'Not a ritual in hand.' };
  if (st.phase !== 'main' || st.active !== pi) return { ok: false, error: 'Rituals in your Main phase.' };
  if (pl.ritualThisTurn) return { ok: false, error: 'One ritual per turn.' };
  var site = pl.locs.filter(function (u) { return st.inst[u].def === 43 || st.inst[u].def === 44; })[0];
  if (!site) return { ok: false, error: 'You need a ritual site (Altar or Grove).' };
  var fuel = pl.chars.filter(function (u) { return st.inst[u].psan <= 0; });
  if (!fuel.length) return { ok: false, error: 'You need a burned-out character to sacrifice.' };
  var cost = playCost(st, pi, it.def);
  if (pl.sanity < cost) return { ok: false, error: 'Cannot afford the ritual (' + cost + ').' };
  var spec = targetSpecFor(st, pi, uid);
  return { ok: true, cost: cost, site: site, fuel: fuel, need: spec ? 'target' : null, targetSpec: spec };
};

MYTHOS.performRitual = function (st, pi, uid, opts) {
  opts = opts || {};
  var info = MYTHOS.ritualInfo(st, pi, uid);
  if (!info.ok) return info;
  var it = st.inst[uid], d = D(it.def), pl = st.players[pi], foe = FOE(st, pi);
  // target validation
  if (info.need) {
    var tg = legalTargets(st, pi, info.targetSpec);
    if (opts.target == null || tg.indexOf(opts.target) < 0) return { ok: false, error: 'Choose a legal target.' };
    if (it.def === 55) { // Pivot needs two
      if (opts.target2 == null || tg.indexOf(opts.target2) < 0 || opts.target2 === opts.target)
        return { ok: false, error: 'The Pivot needs two different abominations.' };
    }
    vexTax(st, pi, opts.target);
  }
  if (opts.sac == null || info.fuel.indexOf(opts.sac) < 0) return { ok: false, error: 'Choose a burned-out character to sacrifice.' };
  payCost(st, pi, info.cost, 'ritual: ' + d.name);
  if (st.winner) return { ok: true };
  sacrificeChar(st, opts.sac, 'ritual fuel');
  pl.hand.splice(pl.hand.indexOf(uid), 1);
  it.zone = 'discard'; pl.discard.push(uid);
  pl.ritualThisTurn = true;
  pl.ritualsDone.push(it.def);
  log(st, '☽ RITUAL PERFORMED: ' + d.name + ' (' + pl.ritualsDone.length + '/3 toward takeover).');
  if (hasLoc(st, pi, 43)) gainSanity(st, pi, 2, 'The Altar'); // board approves

  if (it.def === 39) { // Burn Rate
    pl.chars.slice().forEach(function (c) { damageChar(st, c, 2, 'Burn Rate'); });
  } else if (it.def === 40) { // Tender Offer
    var t = st.inst[opts.target];
    var foePl = st.players[t.controller];
    foePl.aboms.splice(foePl.aboms.indexOf(opts.target), 1);
    t.controller = pi;
    var leash = D(t.def).leash || 0, placed = false;
    if (opts.leashTo) {
      var cs = st.players[pi].chars;
      for (var i = 0; i < cs.length && !placed; i++)
        if (cs[i] === opts.leashTo && freeControl(st, cs[i]) >= leash) { t.leashedTo = cs[i]; placed = true; }
    } else {
      var cs2 = st.players[pi].chars;
      for (var j = 0; j < cs2.length && !placed; j++)
        if (freeControl(st, cs2[j]) >= leash) { t.leashedTo = cs2[j]; placed = true; }
    }
    pl.aboms.push(opts.target);
    if (!placed) { t.feral = true; t.leashedTo = null; log(st, cname(st, opts.target) + ' enters feral under ' + pl.name + ' (no free Control).'); }
    else log(st, pl.name + ' gains control of ' + cname(st, opts.target) + '.');
  } else if (it.def === 41) { // Poison Pill
    pl.shield += 5;
    log(st, pl.name + ' is protected: the next 5 sanity they would lose hits ' + st.players[foe].name + ' instead.');
  } else if (it.def === 42) { // The Acquisition
    var all = [];
    for (var q = 0; q < 2; q++) all = all.concat(st.players[q].aboms.slice());
    var n = all.length;
    all.forEach(function (a) { var x = st.inst[a]; removeFromBoard(st, x); x.zone = 'discard'; st.players[x.owner].discard.push(a); });
    log(st, 'THE ACQUISITION destroys all ' + n + ' abominations.');
    if (n) gainSanity(st, pi, 2 * n, 'The Acquisition');
  } else if (it.def === 55) { // The Pivot
    var A = st.inst[opts.target], B = st.inst[opts.target2];
    var pa = A.controller, pb = B.controller;
    st.players[pa].aboms.splice(st.players[pa].aboms.indexOf(opts.target), 1);
    st.players[pb].aboms.splice(st.players[pb].aboms.indexOf(opts.target2), 1);
    A.controller = pb; B.controller = pa;
    st.players[pb].aboms.push(opts.target); st.players[pa].aboms.push(opts.target2);
    [opts.target, opts.target2].forEach(function (x) {
      var xi = st.inst[x], lc = D(xi.def).leash || 0, ok = false;
      st.players[xi.controller].chars.forEach(function (c) {
        if (!ok && freeControl(st, c) >= lc) { xi.leashedTo = c; ok = true; }
      });
      if (!ok) { xi.feral = true; xi.leashedTo = null; }
    });
    log(st, 'The Pivot: ' + D(A.def).name + ' and ' + D(B.def).name + ' swap controllers (strategic realignment).');
  } else if (it.def === 56) { // Going Private
    pl.privateUntil = st.turn + 1;
    log(st, pl.name + ' GOES PRIVATE — opponents cannot target them until their next upkeep.');
  }
  checkWin(st);
  return { ok: true };
};

/* Re-leash a feral abomination (corrective coaching, 2 sanity, main phase) */
MYTHOS.releash = function (st, pi, uid, charUid) {
  var it = st.inst[uid];
  if (!it || it.zone !== 'board' || it.controller !== pi || !it.feral) return { ok: false, error: 'Not a feral abomination of yours.' };
  if (st.phase !== 'main' || st.active !== pi) return { ok: false, error: 'Re-leash in your Main phase.' };
  if (st.players[pi].sanity < 2) return { ok: false, error: 'Need 2 sanity for corrective coaching.' };
  if (freeControl(st, charUid) < (D(it.def).leash || 0) || st.inst[charUid].controller !== pi)
    return { ok: false, error: 'That character has no free Control.' };
  payCost(st, pi, 2, 'corrective coaching');
  it.feral = false; it.leashedTo = charUid;
  log(st, cname(st, uid) + ' is re-leashed to ' + cname(st, charUid) + '.');
  return { ok: true };
};

/* Combat declarations */
MYTHOS.declareAttacker = function (st, pi, uid, target) {
  if (st.phase !== 'offense' || st.active !== pi) return { ok: false, error: 'Declare attackers in your Offense.' };
  if (!canAttack(st, uid)) return { ok: false, error: 'That abomination cannot attack.' };
  if (attackedThis(st, uid)) return { ok: false, error: 'Already attacking.' };
  var foe = FOE(st, pi);
  if (target.kind === 'player' && target.player !== foe) return { ok: false, error: 'Attack the enemy.' };
  if (target.kind === 'char') {
    var t = st.inst[target.uid];
    if (!t || t.zone !== 'board' || t.controller !== foe || D(t.def).type !== 'Character')
      return { ok: false, error: 'Attack an enemy character or their sanity.' };
    if (untargetable(st, foe)) return { ok: false, error: 'They went private — cannot target.' };
  }
  st.attackers.push({ uid: uid, target: target });
  log(st, cname(st, uid) + ' attacks ' + (target.kind === 'player' ? st.players[foe].name + "'s sanity" : cname(st, target.uid)) + '.');
  checkHRTrap(st, uid); // may set st.pending (HR Complaint)
  return { ok: true, pending: !!st.pending };
};

MYTHOS.declareBlocker = function (st, pi, uid, attackerUid) {
  if (st.phase !== 'offense' || st.active === pi) return { ok: false, error: 'The defender assigns blockers.' };
  var atk = st.attackers.filter(function (a) { return a.uid === attackerUid; })[0];
  if (!atk) return { ok: false, error: 'Not an attacker.' };
  if (st.blockers[attackerUid]) return { ok: false, error: 'Already blocked.' };
  var it = st.inst[uid];
  if (!it || it.controller !== pi || !canBlock(st, uid)) return { ok: false, error: 'Cannot block with that.' };
  st.blockers[attackerUid] = uid;
  log(st, cname(st, uid) + ' blocks ' + cname(st, attackerUid) + '.');
  return { ok: true };
};

MYTHOS.undeclareAttacker = function (st, pi, uid) {
  if (st.phase !== 'offense' || st.active !== pi) return { ok: false, error: 'Not your offense.' };
  var i = st.attackers.findIndex(function (a) { return a.uid === uid; });
  if (i < 0) return { ok: false, error: 'Not attacking.' };
  st.attackers.splice(i, 1);
  delete st.blockers[uid]; // any blocker assigned to it stands down too
  log(st, cname(st, uid) + ' stands down.');
  return { ok: true };
};

MYTHOS.resolveCombat = function (st) {
  if (st.phase !== 'offense') return { ok: false, error: 'Not offense.' };
  if (st.pending) return { ok: false, error: 'Resolve pending decision first.' };
  resolveCombat(st);
  return { ok: true };
};

/* Discard (end phase down to 7, or effects) */
MYTHOS.discard = function (st, pi, uid) {
  var pl = st.players[pi], i = pl.hand.indexOf(uid);
  if (i < 0) return { ok: false, error: 'Not in hand.' };
  pl.hand.splice(i, 1); st.inst[uid].zone = 'discard'; pl.discard.push(uid);
  log(st, pl.name + ' discards ' + D(st.inst[uid].def).name + '.');
  return { ok: true };
};

/* Pending decisions */
MYTHOS.decide = function (st, choice) {
  var pd = st.pending;
  if (!pd) return { ok: false, error: 'Nothing pending.' };
  var pi = pd.player, pl = st.players[pi];
  st.pending = null;
  switch (pd.kind) {
    case 'temp': {
      var t = st.inst[pd.uid];
      if (choice === 'pay' && pl.sanity >= 1) { payCost(st, pi, 1, 'contract renewal'); log(st, 'The Temp stays (contract renewed).'); }
      else {
        removeFromBoard(st, t); t.zone = 'hand'; pl.hand.push(pd.uid);
        log(st, 'The Temp returns to hand (contract ended).');
      }
      break;
    }
    case 'hr': {
      var a = st.inst[pd.attackerUid];
      if (choice === 'pay' && pl.sanity >= 3) { payCost(st, pi, 3, 'HR settlement'); log(st, 'HR Complaint settled for 3 sanity.'); }
      else {
        // remove from attackers too
        st.attackers = st.attackers.filter(function (x) { return x.uid !== pd.attackerUid; });
        destroyAbom(st, pd.attackerUid, 'HR Complaint');
      }
      break;
    }
    case 'wisp_discard': {
      var wi = pl.hand.indexOf(choice.uid);
      if (wi >= 0) { pl.hand.splice(wi, 1); st.inst[choice.uid].zone = 'discard'; pl.discard.push(choice.uid); log(st, pl.name + ' discards ' + D(st.inst[choice.uid].def).name + ' (Reply-All Wisp).'); }
      break;
    }
    case 'coffee': {
      if (choice.uid) healChar(st, choice.uid, 1, 'Coffee Elemental');
      break;
    }
    case 'fulltimer': {
      var f = st.inst[pd.uid];
      if (choice.take && st.inst[pd.internUid] && st.inst[pd.internUid].zone === 'board') {
        var gi = st.inst[pd.internUid];
        removeFromBoard(st, gi); gi.zone = 'discard'; pl.discard.push(pd.internUid);
        f.pMod += 3; f.fMod += 3;
        log(st, 'The Intern is PROMOTED into The Full-Timer (+3/+3).');
      }
      break;
    }
    case 'restructurer': {
      if (choice.uid) {
        var l = st.inst[choice.uid];
        var lp = st.players[l.controller];
        lp.locs.splice(lp.locs.indexOf(choice.uid), 1);
        l.zone = 'discard'; lp.discard.push(choice.uid);
        log(st, D(l.def).name + ' is REORGED away by The Restructurer.');
        gainSanity(st, pi, 2, 'The Restructurer');
      } else log(st, 'The Restructurer finds nothing worth reorganizing.');
      break;
    }
    case 'mimic': {
      var dk = pl.deck;
      if (dk.length) {
        var top = dk.pop();
        if (choice.toBottom) { dk.unshift(top); log(st, 'Mailroom Mimic files the top card to the bottom.'); }
        else { dk.push(top); log(st, 'Mailroom Mimic leaves the top card.'); }
      }
      break;
    }
    case 'auditor': log(st, st.players[pi].name + ' reviews the enemy hand (audited).'); break;
    case 'sleep_pick': {
      if (choice.uid) {
        var s = st.inst[choice.uid];
        s.asleepUntil = st.turn + 1;
        log(st, cname(st, choice.uid) + ' falls asleep (until ' + pl.name + "'s next turn).");
      }
      break;
    }
  }
  checkWin(st);
  return { ok: true };
};

/* Mulligan (setup phase, once per player) */
MYTHOS.mulligan = function (st, pi) {
  if (st.phase !== 'setup') return { ok: false, error: 'Setup is over.' };
  if (st.mulliganUsed[pi]) return { ok: false, error: 'Mulligan already used.' };
  st.mulliganUsed[pi] = true;
  var pl = st.players[pi];
  pl.hand.forEach(function (u) { st.inst[u].zone = 'deck'; pl.deck.push(u); });
  pl.hand = [];
  shuffle(st, pl.deck);
  drawCards(st, pi, 7, true);
  log(st, pl.name + ' takes the free mulligan.');
  return { ok: true };
};

/* Snapshot for the network seam: full state is already JSON-safe. */
MYTHOS.snapshot = function (st) { return JSON.parse(JSON.stringify(st)); };
MYTHOS.restore = function (snap) { return snap; };

/* Public API used by AI / UI / tests */
MYTHOS.playCard = playCard;
MYTHOS.effPower = effPower;
MYTHOS.effFlesh = effFlesh;
MYTHOS.effControl = effControl;
MYTHOS.effUpkeep = effUpkeep;
MYTHOS.playCost = playCost;
MYTHOS.freeControl = freeControl;
MYTHOS.legalTargets = legalTargets;
MYTHOS.canAttack = canAttack;
MYTHOS.canBlock = canBlock;
MYTHOS.targetSpecFor = targetSpecFor;
MYTHOS.upkeepAction = function (st, pi, uid, pay, useStaple) {
  var it = st.inst[uid];
  if (!it || it.zone !== 'board' || it.controller !== pi) return { ok: false, error: 'Not yours.' };
  if (st.phase !== 'upkeep' || st.active !== pi) return { ok: false, error: 'Upkeep phase only.' };
  if (it.feral || it.upkeepPaid) return { ok: false, error: 'Nothing to pay.' };
  if (useStaple) {
    var has = st.players[pi].arts.some(function (a) { return st.inst[a].def === 49; });
    if (!has) return { ok: false, error: 'No Red Stapler in play.' };
    if (st.players[pi].staplerUsed) return { ok: false, error: 'Stapler already used this turn.' };
    it.stapleOff = true; st.players[pi].staplerUsed = true;
    MYTHOS.log(st, 'The Red Stapler: ' + cname(st, uid) + "'s upkeep reduced by 1 (staples).");
  }
  if (pay) return payUpkeep(st, pi, uid);
  goFeral(st, uid, 'upkeep skipped');
  it.upkeepPaid = true;
  return { ok: true };
};

global.MYTHOS = MYTHOS;
if (typeof module !== 'undefined' && module.exports) module.exports = MYTHOS;
})(typeof window !== 'undefined' ? window : global);
