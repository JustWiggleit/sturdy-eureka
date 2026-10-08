/* ============================================================================
 * MYTHOS — browser UI (v1). Classic script. Renders engine state, handles
 * hotseat + vs-AI interaction. No game logic lives here — all rules calls
 * go through window.MYTHOS.
 * ========================================================================== */
(function () {
'use strict';
var E = window.MYTHOS, AI = window.MYTHOS_AI, DATA = window.MYTHOS_DATA;

var S = null;                 // engine state
var mode = 'hotseat';         // 'hotseat' | 'ai'
var aiIdx = 1;                // in ai mode, the AI's seat
var deckChoice = ['cult', 'board'];
var selHand = null;           // selected hand card uid
var targeting = null;         // {kind, uid, spec, extra}
var blockSel = null;          // blocker uid picked, awaiting attacker click
var discardMode = false;
var declaringDone = false;    // hotseat: attacker finished declaring
var logOpen = false;
var flipped = {};             // uid -> true: card is showing its back (persists across re-renders)

/* v2 pre-game config */
var REPORT_EMAIL = 'trollsquadproductions+technicalissues@gmail.com';
var WIX_LOGIN_URL = 'https://sites.google.com/view/mythosportal/'; // TODO: point at Wix membership site when built
var isGuest = false;

function reportIssue(context) {
  var errs = (window.__mythosErrors || []).join(' | ') || 'none captured';
  var body = 'What happened:\n\n\n--- diagnostics ---\n' +
    'context: ' + (context || 'manual report') + '\n' +
    'errors: ' + errs + '\n' +
    'url: ' + location.href + '\n' +
    'time: ' + new Date().toISOString() + '\n' +
    'browser: ' + navigator.userAgent;
  location.href = 'mailto:' + REPORT_EMAIL +
    '?subject=' + encodeURIComponent('MYTHOS issue report') +
    '&body=' + encodeURIComponent(body);
}
function hideLoader() {
  var l = el('loader'); if (l) l.style.display = 'none';
  var s = el('start-screen'); if (s) s.style.display = 'block';
}

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function Dd(uid) { return cardDef(S.inst[uid].def); }
function cardDef(id) {
  for (var i = 0; i < DATA.cards.length; i++) if (DATA.cards[i].id === id) return DATA.cards[i];
  return null;
}
function imgFor(uid) { var it = S.inst[uid]; return DATA.imgDir + '/' + (it.img || cardDef(it.def).img); }
function imgForDef(id) { return DATA.imgDir + '/' + cardDef(id).img; }
function cname(uid) { var d = Dd(uid); return d.name; }

/* ---------------- boot ---------------- */
function boot() {
  renderStart();
  el('start-hotseat').onclick = function () { mode = 'hotseat'; isGuest = false; newMatch(); };
  el('start-ai').onclick = function () { mode = 'ai'; isGuest = false; newMatch(); };
  el('start-guest').onclick = function () { mode = 'ai'; isGuest = true; newMatch(); }; // guest: default deck vs AI
  el('start-login').onclick = function () { location.href = WIX_LOGIN_URL; };
  el('start-report').onclick = function () { reportIssue('start screen'); };
  var lr = el('loader-report');
  if (lr) lr.onclick = function () { reportIssue('loader error'); };
  hideLoader();
}
function newMatch() {
  setupDone = false; blockSel = null;
  var decks = [DATA.decks[deckChoice[0]].cards.slice(), DATA.decks[deckChoice[1]].cards.slice()];
  S = E.newGame(decks, { mode: mode, names: [DATA.decks[deckChoice[0]].name, DATA.decks[deckChoice[1]].name] });
  if (mode === 'ai' && AI.mulliganDecision(S, 1)) E.mulligan(S, 1);
  el('start-screen').style.display = 'none';
  el('game-screen').style.display = 'block';
  renderSetup();
}

/* ---------------- start / setup screens ---------------- */
function renderStart() {
  el('deck-a-name').textContent = DATA.decks.cult.name;
  el('deck-b-name').textContent = DATA.decks.board.name;
}

function renderSetup() {
  var p = setupPlayer();
  var html = '<div class="setup-box"><h2>' + esc(S.players[p].name) + ' — opening hand</h2>';
  if (mode === 'hotseat' && p === 1) html += '<p class="pass-note">Pass the device to ' + esc(S.players[p].name) + '.</p>';
  html += '<div class="hand">' + S.players[p].hand.map(handCardHTML).join('') + '</div>';
  html += '<div class="row"><button id="btn-mulligan">Mulligan (once, free)</button>' +
    '<button id="btn-keep">Keep hand</button></div></div>';
  el('board').innerHTML = html;
  el('btn-mulligan').onclick = function () { E.mulligan(S, p); renderSetup(); };
  el('btn-keep').onclick = function () {
    // vs AI: the AI mulligans silently (decided in newMatch) — the human
    // never sees or confirms the AI's hand. Hotseat still shows both.
    if (p === 0 && mode === 'hotseat') renderSetup2(); else { E.startGame(S); refresh(); }
  };
  bindFlipButtons(el('board'));
  bindCardZoom();
}
function setupPlayer() { return setupDone ? 1 : 0; }
var setupDone = false;
function renderSetup2() { setupDone = true; renderSetup(); }

/* ---------------- main render ---------------- */
function refresh() {
  if (!S) return;
  if (S.winner) return renderGameOver();
  if (S.pending && S.pending.player !== undefined && mode === 'ai' && S.pending.player === aiIdx) {
    AI.decide(S); return refresh();
  }
  renderBoard();
  renderLog();
  renderPending();
  maybeAI();
}

function phaseLabel() {
  var map = { setup: 'Setup', draw: 'Draw', upkeep: 'Upkeep', main: 'Main', offense: 'Offense', end: 'End' };
  return map[S.phase] || S.phase;
}

function renderBoard() {
  var me = S.active, foe = 1 - S.active;
  var h = '';
  h += '<div id="topbar"><span class="game-title">MYTHOS</span>' +
    '<span class="turn-info">Turn ' + S.turn + ' · ' + esc(S.players[me].name) + ' · <b>' + phaseLabel() + '</b></span>' +
    '<span class="topbtns"><button id="btn-log">Log</button><button id="btn-restart">Restart</button>' +
    '<button id="btn-next">Next phase →</button></span></div>';
  h += '<div id="phase-banner">' + phaseBanner() + '</div>';
  h += playerZoneHTML(foe, true);
  h += '<div id="midbar">' + midBarHTML() + '</div>';
  h += playerZoneHTML(me, false);
  el('board').innerHTML = h;
  el('btn-log').onclick = function () { logOpen = !logOpen; el('log').style.display = logOpen ? 'block' : 'none'; };
  el('btn-restart').onclick = function () { if (confirm('Restart the match?')) location.reload(); };
  el('btn-next').onclick = onNextPhase;
  bindBoard();
  bindCardZoom();
}

function phaseBanner() {
  var p = S.active, n = esc(S.players[p].name);
  if (S.phase === 'upkeep') return n + ': pay or skip each abomination\'s upkeep. Unpaid goes <b>feral</b>.';
  if (S.phase === 'main') return n + ': play cards, set traps, perform a ritual (1/turn), use abilities.';
  if (S.phase === 'offense') return n + ': declare attackers, then ' + esc(S.players[1 - p].name) + ' assigns blockers.';
  if (S.phase === 'end') return n + ': discard down to 7, then end turn.';
  if (S.phase === 'draw') return n + ' draws.';
  return '';
}

function playerZoneHTML(pi, isFoe) {
  var pl = S.players[pi];
  var h = '<div class="pzone' + (isFoe ? ' foe' : ' me') + '">';
  h += '<div class="phead"><b>' + esc(pl.name) + '</b>' +
    ' <span class="sanity">◈ ' + pl.sanity + ' sanity</span>' +
    ' <span class="deckpile" title="Deck: ' + pl.deck.length + ' cards"><img class="dpile-img" src="' + DATA.cardBack + '" alt="deck"><span class="dpile-count">' + pl.deck.length + '</span></span>' +
    ' <span class="counts">Hand ' + (isFoe ? '🂠×' + pl.hand.length : pl.hand.length) +
    ' · Discard ' + pl.discard.length + '</span>' +
    (pl.ritualsDone.length ? ' <span class="rituals">☽ ' + pl.ritualsDone.length + '/3</span>' : '') +
    (pl.shield ? ' <span class="shield">🛡' + pl.shield + '</span>' : '') + '</div>';
  // characters + their leashed abominations
  h += '<div class="chars">' + pl.chars.map(function (u) { return charHTML(u, isFoe); }).join('') + '</div>';
  // unassigned/feral abominations
  var loose = pl.aboms.filter(function (u) { return !S.inst[u].leashedTo || S.inst[u].feral; });
  if (loose.length) h += '<div class="aboms-loose">' + loose.map(function (u) { return boardCardHTML(u, isFoe); }).join('') + '</div>';
  // permanents row
  var perms = pl.locs.concat(pl.arts, pl.effs);
  if (perms.length) h += '<div class="perms">' + perms.map(function (u) { return boardCardHTML(u, isFoe); }).join('') + '</div>';
  // traps
  if (pl.traps.length) {
    h += '<div class="traps">' + pl.traps.map(function () {
      return '<img class="mini facedown" src="' + DATA.cardBack + '" alt="face-down trap" title="Face-down trap">';
    }).join('') + '<span class="trap-note">' + pl.traps.length + ' trap(s) set</span></div>';
  }
  // hand
  if (isFoe) {
    h += '<div class="hand foe-hand">' + pl.hand.map(function () {
      return '<img class="mini facedown" src="' + DATA.cardBack + '" alt="card back">';
    }).join('') + '</div>';
  } else {
    h += '<div class="hand">' + pl.hand.map(handCardHTML).join('') + '</div>';
  }
  // upkeep panel
  if (!isFoe && S.phase === 'upkeep' && S.active === pi) h += upkeepHTML(pi);
  h += '</div>';
  return h;
}

function statLine(uid) {
  var d = Dd(uid), it = S.inst[uid], parts = [];
  if (d.type === 'Character') parts.push('Cost ' + d.cost, 'Ctl ' + E.effControl(S, uid), 'San ' + it.psan + '/' + it.maxPsan);
  if (d.type === 'Abomination') parts.push('Cost ' + d.cost, 'P ' + E.effPower(S, uid), 'F ' + E.effFlesh(S, uid), 'Upk ' + E.effUpkeep(S, uid));
  if (d.cost != null && d.type !== 'Character' && d.type !== 'Abomination') parts.push('Cost ' + d.cost);
  return parts.join(' · ');
}

/* 3D flip-card wrapper: front face = card art, back face = card back.
   Flip state persists in `flipped` across re-renders. The flip button
   stop-propagates so it never triggers the card's click handler. */
function flipWrap(uid, zone, frontHTML, extraCls) {
  return '<div class="card3d ' + extraCls + (flipped[uid] ? ' flipped' : '') + '" data-uid="' + uid + '" data-zone="' + zone + '">' +
    '<div class="card3d-inner">' +
      '<div class="card3d-face card3d-front">' + frontHTML + '</div>' +
      '<div class="card3d-face card3d-back"><img src="' + DATA.cardBack + '" alt="card back"></div>' +
    '</div>' +
    '<button class="flipbtn" data-flip="' + uid + '" title="Flip card" aria-label="Flip card">⟲</button>' +
  '</div>';
}
function bindFlipButtons(root) {
  root.querySelectorAll('[data-flip]').forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      var uid = b.getAttribute('data-flip');
      if (flipped[uid]) delete flipped[uid]; else flipped[uid] = true;
      var card = b.closest('.card3d');
      if (card) card.classList.toggle('flipped', !!flipped[uid]);
    };
  });
}

function boardCardHTML(uid, isFoe) {
  var it = S.inst[uid], d = Dd(uid);
  var cls = 'bcard' + (it.feral ? ' feral' : '') + (it.psan <= 0 && d.type === 'Character' ? ' burned' : '') +
    (it.asleepUntil >= S.turn ? ' asleep' : '');
  if (S.phase === 'offense' && S.attackers.some(function (a) { return a.uid === uid; })) cls += ' attacking';
  if (S.blockers && Object.keys(S.blockers).some(function (k) { return S.blockers[k] === uid; })) cls += ' blocking';
  var front = '<img src="' + imgFor(uid) + '" alt="' + esc(d.name) + '">' +
    '<div class="bstats">' + esc(statLine(uid)) + '</div>' +
    (it.feral ? '<div class="flag">FERAL</div>' : '') +
    (it.psan <= 0 && d.type === 'Character' ? '<div class="flag">BURNED OUT</div>' : '') +
    (it.asleepUntil >= S.turn ? '<div class="flag">ASLEEP</div>' : '');
  return flipWrap(uid, 'board', front, cls);
}

function charHTML(uid, isFoe) {
  var it = S.inst[uid];
  var leashed = S.players[it.controller].aboms.filter(function (a) {
    return S.inst[a].leashedTo === uid && !S.inst[a].feral;
  });
  return '<div class="char-group">' + boardCardHTML(uid, isFoe) +
    (leashed.length ? '<div class="leashed">' + leashed.map(function (a) { return boardCardHTML(a, isFoe); }).join('') + '</div>' : '') +
    '</div>';
}

function handCardHTML(uid) {
  var d = Dd(uid), it = S.inst[uid];
  var cls = 'hcard' + (selHand === uid ? ' sel' : '');
  var playable = false;
  if (S.phase === 'main' && S.active === meIndex()) {
    if (d.type === 'Trap') playable = true;
    else { var c = E.canPlay(S, meIndex(), uid); playable = c.ok; }
    if (d.type === 'Ritual') { var ri = E.ritualInfo(S, meIndex(), uid); playable = ri.ok; }
  }
  return flipWrap(uid, 'hand',
    '<img src="' + imgFor(uid) + '" alt="' + esc(d.name) + '" title="' + esc(d.name) + '">',
    cls + (playable ? ' playable' : ''));
}

function meIndex() { return mode === 'ai' ? 0 : S.active; }
function defenderIndex() { return mode === 'ai' ? 0 : 1 - S.active; }

function upkeepHTML(pi) {
  var list = E.upkeepList(S, pi);
  if (!list.length) return '<div class="upkeep">No upkeeps due. <button id="btn-next2">Next →</button></div>';
  var hasStaple = S.players[pi].arts.some(function (a) { return S.inst[a].def === 49; });
  var h = '<div class="upkeep"><b>Upkeep — pay or let it go feral:</b><div class="urow">';
  list.forEach(function (u) {
    var c = E.effUpkeep(S, u);
    h += '<span class="uitem"><img class="mini" src="' + imgFor(u) + '"> ' + esc(cname(u)) + ' (' + c + '◈) ' +
      '<button data-act="pay" data-uid="' + u + '">Pay</button>' +
      '<button data-act="skip" data-uid="' + u + '">Feral</button>' +
      (hasStaple && !S.players[pi].staplerUsed && c > 0 ? '<button data-act="staple" data-uid="' + u + '">📎 −1</button>' : '') +
      '</span>';
  });
  return h + '</div></div>';
}

function midBarHTML() {
  var h = '';
  if (S.attackers.length) {
    h += '<div class="combat">Attackers: ' + S.attackers.map(function (a) {
      var t = a.target.kind === 'player' ? esc(S.players[a.target.player].name) + "'s sanity" : esc(cname(a.target.uid));
      var blk = S.blockers[a.uid];
      return '<span class="atk" data-uid="' + a.uid + '">' + esc(cname(a.uid)) + ' → ' + t +
        (blk ? ' <b>blocked by ' + esc(cname(blk)) + '</b>' : ' <i>unblocked</i>') + '</span>';
    }).join(' · ') + '</div>';
  }
  if (targeting) h += '<div class="target-banner">Choose a target for <b>' + esc(targeting.label) + '</b> (click a highlighted card) <button id="btn-cancel-target">Cancel</button></div>';
  if (discardMode) h += '<div class="target-banner">Discard down to 7 — click cards in your hand.</div>';
  return h;
}

/* ---------------- events ---------------- */
function bindBoard() {
  var cards = el('board').querySelectorAll('[data-uid]');
  cards.forEach(function (c) {
    c.onclick = function (ev) { ev.stopPropagation(); onCardClick(c.getAttribute('data-uid'), c.getAttribute('data-zone')); };
  });
  bindFlipButtons(el('board'));
  var ups = el('board').querySelectorAll('[data-act]');
  ups.forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      var u = b.getAttribute('data-uid'), act = b.getAttribute('data-act');
      if (act === 'staple') E.upkeepAction(S, S.active, u, true, true);
      else E.upkeepAction(S, S.active, u, act === 'pay', false);
      afterAction();
    };
  });
  var nb = el('btn-next2'); if (nb) nb.onclick = onNextPhase;
  var ct = el('btn-cancel-target'); if (ct) ct.onclick = function () { targeting = null; refresh(); };
}

function bindCardZoom() {
  // shift-click or long-press shows zoom; simple: double-click zooms
  el('board').querySelectorAll('img').forEach(function (img) {
    img.ondblclick = function (ev) { ev.stopPropagation(); zoomCard(img.getAttribute('src')); };
  });
}
function zoomCard(src) {
  el('zoom-img').setAttribute('src', src);
  el('zoom').style.display = 'flex';
}
function closeZoom() { el('zoom').style.display = 'none'; }

function attackWhyNot(uid) {
  var it = S.inst[uid];
  if (it.zone !== 'board' || it.feral) return 'It\'s feral — re-leash it during your Main phase.';
  if (it.justEntered) return 'Summoning sickness — it just entered play this turn.';
  if (E.effPower(S, uid) <= 0) return 'It has 0 power and cannot attack.';
  return 'It cannot attack right now.';
}

function onCardClick(uid, zone) {
  if (S.winner) return;
  var me = meIndex();
  // pending decision modals handle their own clicks
  if (S.pending && S.pending.player === me) return; // modal is up
  if (targeting) {
    var spec = targeting.spec;
    var ok = E.legalTargets(S, me, spec).indexOf(uid) >= 0;
    if (ok) return fireTargeted(uid);
    targeting = null; refresh(); return;
  }
  if (discardMode && zone === 'hand' && S.inst[uid].owner === me) {
    E.discard(S, me, uid);
    if (S.players[me].hand.length <= 7) { discardMode = false; }
    return afterAction();
  }
  // offense: declare attackers / assign blockers
  if (S.phase === 'offense' && zone === 'board' && !S.combatResolved) {
    var it = S.inst[uid], di = defenderIndex();
    var canDeclare = S.active === me && (mode === 'ai' || !declaringDone);
    var canDefend = S.attackers.length && (mode === 'ai' ? S.active === aiIdx : declaringDone);
    if (canDeclare && it.controller === me && Dd(uid).type === 'Abomination') {
      // toggle: click a declared attacker to stand it down
      var already = S.attackers.some(function (a) { return a.uid === uid; });
      if (already) {
        var ru = E.undeclareAttacker(S, me, uid);
        if (!ru.ok) return toast(ru.error);
        return afterAction();
      }
      if (E.canAttack(S, uid)) {
        var r = E.declareAttacker(S, me, uid, { kind: 'player', player: 1 - me });
        if (!r.ok) return toast(r.error);
        return afterAction();
      }
      return toast(attackWhyNot(uid));
    }
    if (canDefend) {
      // 1. click one of your own creatures to select it as the blocker
      if (it.controller === di && E.canBlock(S, uid)) {
        blockSel = uid;
        toast('Blocker selected — now click an attacker.');
        refresh(); return;
      }
      // 2. click an attacker to assign the selected blocker to it
      if (it.controller === S.active && blockSel) {
        var atk = S.attackers.filter(function (a) { return a.uid === uid; })[0];
        if (atk && E.canBlock(S, blockSel)) {
          var r2 = E.declareBlocker(S, di, blockSel, uid);
          blockSel = null;
          if (!r2.ok) return toast(r2.error);
          return afterAction();
        }
      }
    }
  }
  openDetail(uid, zone);
}

function fireTargeted(targetUid) {
  var t = targeting; targeting = null;
  var me = meIndex(), r;
  if (t.kind === 'play') r = E.playCard(S, me, t.uid, { target: targetUid });
  else if (t.kind === 'activate') r = E.activate(S, me, t.uid, targetUid);
  else if (t.kind === 'ritual') {
    var extra = t.extra || {}; extra.target = targetUid;
    r = E.performRitual(S, me, t.uid, extra);
  }
  if (!r.ok) toast(r.error);
  afterAction();
}

/* detail modal */
function openDetail(uid, zone) {
  var d = Dd(uid), it = S.inst[uid], me = meIndex();
  var h = flipWrap(uid, 'detail',
    '<img class="zoomable" src="' + imgFor(uid) + '" alt="' + esc(d.name) + '">', 'dcard');
  h += '<div class="dinfo"><h3>' + esc(d.name) + '</h3>';
  if (d.title) h += '<div class="dtitle">' + esc(d.title) + '</div>';
  h += '<div class="dtype">' + esc(d.type) + ' · ' + esc(statLine(uid)) + '</div>';
  h += '<p class="drules">' + esc(d.rules || '—') + '</p>';
  if (d.flavor) h += '<p class="dflavor">' + esc(d.flavor) + '</p>';
  h += '<div class="dbtns">';
  var mine = it.controller === me || (zone === 'hand' && it.owner === me);
  if (zone === 'hand' && it.owner === me && S.phase === 'main' && S.active === me) {
    if (d.type === 'Trap') h += '<button data-m="settrap">Set trap (' + d.cost + '◈)</button>';
    else if (d.type === 'Ritual') { var ri = E.ritualInfo(S, me, uid); h += '<button data-m="ritual"' + (ri.ok ? '' : ' disabled') + '>Perform ritual</button>'; }
    else { var c = E.canPlay(S, me, uid); h += '<button data-m="play"' + (c.ok ? '' : ' disabled') + '>Play (' + E.playCost(S, me, d.id) + '◈)</button>'; }
  }
  if (zone === 'board' && it.controller === me) {
    var ab = E.activatedInfo(S, uid);
    if (ab && S.phase === 'main' && S.active === me) h += '<button data-m="activate">Use: ' + esc(ab.name) + '</button>';
    if (it.feral && S.phase === 'main') h += '<button data-m="releash">Re-leash (2◈)</button>';
    if (d.type === 'Abomination' && S.phase === 'offense' && S.active === me && E.canAttack(S, uid))
      h += '<button data-m="attack">Attack</button>';
  }
  h += '<button data-m="close">Close</button></div></div>';
  el('detail-body').innerHTML = h;
  el('detail').style.display = 'flex';
  bindFlipButtons(el('detail-body'));
  el('detail-body').querySelectorAll('[data-m]').forEach(function (b) {
    b.onclick = function () { detailAction(b.getAttribute('data-m'), uid, zone); };
  });
  el('detail-body').querySelector('.zoomable').ondblclick = function (e) { e.stopPropagation(); zoomCard(imgFor(uid)); };
}
function closeDetail() { el('detail').style.display = 'none'; }

function detailAction(m, uid, zone) {
  var me = meIndex(), r;
  if (m === 'close') return closeDetail();
  if (m === 'settrap') { r = E.setTrap(S, me, uid); if (!r.ok) toast(r.error); closeDetail(); return afterAction(); }
  if (m === 'play') {
    var c = E.canPlay(S, me, uid);
    if (!c.ok) { toast(c.error); return; }
    if (c.need === 'target') { targeting = { kind: 'play', uid: uid, spec: c.targetSpec, label: cname(uid) }; closeDetail(); return refresh(); }
    if (c.need === 'leash' || c.need === 'mole' || c.need === 'boardsplit') return leashModal(uid, c);
    r = E.playCard(S, me, uid, {});
    if (!r.ok) toast(r.error);
    closeDetail(); return afterAction();
  }
  if (m === 'activate') {
    var ab = E.activatedInfo(S, uid);
    if (ab.target) { targeting = { kind: 'activate', uid: uid, spec: ab.target, label: ab.name }; closeDetail(); return refresh(); }
    r = E.activate(S, me, uid);
    if (!r.ok) toast(r.error);
    closeDetail(); return afterAction();
  }
  if (m === 'ritual') return ritualModal(uid);
  if (m === 'releash') {
    var chars = S.players[me].chars.filter(function (x) {
      return E.freeControl(S, x) >= (Dd(uid).leash || 0);
    });
    if (!chars.length) { toast('No character with free Control.'); return; }
    // pick first with room (v1)
    r = E.releash(S, me, uid, chars[0]);
    if (!r.ok) toast(r.error);
    closeDetail(); return afterAction();
  }
  if (m === 'attack') {
    closeDetail();
    r = E.declareAttacker(S, me, uid, { kind: 'player', player: 1 - me });
    if (!r.ok) toast(r.error);
    return afterAction();
  }
}

function leashModal(uid, chk) {
  var opts = chk.leashOptions;
  if (opts.length === 1 && chk.need !== 'boardsplit') {
    var r = E.playCard(S, meIndex(), uid, { leashTo: opts[0].char });
    if (!r.ok) toast(r.error);
    closeDetail(); return afterAction();
  }
  var h = '<h3>Leash ' + esc(cname(uid)) + ' to…</h3><div class="dbtns">';
  opts.forEach(function (o, i) {
    h += '<button data-i="' + i + '">' + esc(cname(o.char)) + (o.foe ? ' (ENEMY — infiltration)' : '') + ' [' + E.freeControl(S, o.char) + ' free]</button>';
  });
  h += '<button data-i="x">Cancel</button></div>';
  el('detail-body').innerHTML = h;
  el('detail').style.display = 'flex';
  el('detail-body').querySelectorAll('[data-i]').forEach(function (b) {
    b.onclick = function () {
      var i = b.getAttribute('data-i');
      if (i === 'x') { closeDetail(); return; }
      var r = E.playCard(S, meIndex(), uid, { leashTo: opts[+i].char });
      if (!r.ok) toast(r.error);
      closeDetail(); afterAction();
    };
  });
}

function ritualModal(uid) {
  var me = meIndex(), info = E.ritualInfo(S, me, uid);
  if (!info.ok) { toast(info.error); return; }
  var h = '<h3>Perform ' + esc(cname(uid)) + ' (' + info.cost + '◈)</h3>';
  h += '<p>Site: <b>' + esc(cname(info.site)) + '</b></p>';
  h += '<p>Sacrifice which burned-out character?</p><div class="dbtns">';
  info.fuel.forEach(function (f, i) { h += '<button data-f="' + i + '">' + esc(cname(f)) + '</button>'; });
  h += '</div><div class="dbtns"><button data-f="x">Cancel</button></div>';
  el('detail-body').innerHTML = h;
  el('detail').style.display = 'flex';
  el('detail-body').querySelectorAll('[data-f]').forEach(function (b) {
    b.onclick = function () {
      var i = b.getAttribute('data-f');
      if (i === 'x') { closeDetail(); return; }
      var extra = { sac: info.fuel[+i] };
      if (info.need) {
        var tg = E.legalTargets(S, me, info.targetSpec);
        if (!tg.length) { toast('No legal target.'); return; }
        // Tender Offer: pick juiciest; Pivot: first two (v1 simplification)
        extra.target = tg[0];
        if (info.targetSpec === 'any_abom' && tg[1]) extra.target2 = tg[1];
        // Tender Offer leash: first char with room
        var lc = 0;
        try { lc = cardDef(S.inst[extra.target].def).leash || 0; } catch (e) {}
        var cs = S.players[me].chars.filter(function (x) { return E.freeControl(S, x) >= lc; });
        if (cs[0]) extra.leashTo = cs[0];
      }
      var r = E.performRitual(S, me, uid, extra);
      if (!r.ok) toast(r.error);
      closeDetail(); afterAction();
    };
  });
}

/* pending decisions */
function renderPending() {
  var pd = S.pending, me = meIndex();
  if (!pd || pd.player !== me) { el('pending').style.display = 'none'; return; }
  var h = '<div class="pending-box">';
  if (pd.kind === 'temp') {
    h += '<h3>The Temp\'s contract is up.</h3><div class="dbtns"><button data-p="pay">Pay 1◈ — stays</button><button data-p="ret">Return to hand</button></div>';
  } else if (pd.kind === 'hr') {
    h += '<h3>HR Complaint!</h3><p>Sacrifice ' + esc(cname(pd.attackerUid)) + ' or pay 3◈ settlement.</p><div class="dbtns"><button data-p="pay">Pay 3◈</button><button data-p="sac">Sacrifice</button></div>';
  } else if (pd.kind === 'wisp_discard') {
    h += '<h3>Reply-All Wisp: discard a card.</h3><div class="dbtns">' + S.players[me].hand.map(function (u) {
      return '<button data-p="w" data-u="' + u + '">' + esc(cname(u)) + '</button>';
    }).join('') + '</div>';
  } else if (pd.kind === 'coffee') {
    h += '<h3>Coffee Elemental: a character gains 1 personal sanity.</h3><div class="dbtns">' +
      S.players[me].chars.map(function (u) { return '<button data-p="c" data-u="' + u + '">' + esc(cname(u)) + '</button>'; }).join('') +
      '<button data-p="cskip">Skip</button></div>';
  } else if (pd.kind === 'fulltimer') {
    h += '<h3>Promote The Intern into The Full-Timer (+3/+3)?</h3><div class="dbtns"><button data-p="yes">Promote</button><button data-p="no">Decline</button></div>';
  } else if (pd.kind === 'restructurer') {
    var locs = S.players[0].locs.concat(S.players[1].locs);
    h += '<h3>The Restructurer: destroy a Location?</h3><div class="dbtns">' +
      locs.map(function (u) { return '<button data-p="r" data-u="' + u + '">' + esc(cname(u)) + '</button>'; }).join('') +
      '<button data-p="rskip">None</button></div>';
  } else if (pd.kind === 'mimic') {
    h += '<h3>Mailroom Mimic: top card of your deck?</h3><div class="dbtns"><button data-p="keep">Leave it</button><button data-p="bottom">File to bottom</button></div>';
  } else if (pd.kind === 'auditor') {
    h += '<h3>The Auditor reviews the enemy hand:</h3><div class="audit">' +
      S.players[1 - me].hand.map(function (u) { return '<img class="mini" src="' + imgFor(u) + '" title="' + esc(cname(u)) + '">'; }).join('') +
      '</div><div class="dbtns"><button data-p="ok">Noted</button></div>';
  } else if (pd.kind === 'sleep_pick') {
    var chars = S.players[0].chars.concat(S.players[1].chars);
    h += '<h3>Choose a character to fall asleep:</h3><div class="dbtns">' +
      chars.map(function (u) { return '<button data-p="s" data-u="' + u + '">' + esc(cname(u)) + '</button>'; }).join('') +
      '<button data-p="sskip">None</button></div>';
  }
  h += '</div>';
  var box = el('pending');
  box.innerHTML = h; box.style.display = 'block';
  box.querySelectorAll('[data-p]').forEach(function (b) {
    b.onclick = function () {
      var k = b.getAttribute('data-p'), u = b.getAttribute('data-u');
      var map = { pay: 'pay', ret: 'return', sac: 'sacrifice', yes: { take: true }, no: { take: false }, keep: { toBottom: false }, bottom: { toBottom: true }, ok: true, cskip: { uid: null }, rskip: { uid: null }, sskip: { uid: null } };
      var choice = map[k] !== undefined ? map[k] : { uid: u };
      E.decide(S, choice);
      afterAction();
    };
  });
}

/* ---------------- flow ---------------- */
function onNextPhase() {
  if (S.phase === 'offense' && S.active === meIndex() && S.attackers.length && !S.combatResolved) {
    // done declaring (hotseat: defender blocks next)
    if (mode === 'hotseat') { toast('Pass to ' + S.players[1 - S.active].name + ' to assign blockers, then Resolve.'); }
    return;
  }
  var r = E.nextPhase(S);
  if (!r.ok) { toast(r.error); return; }
  // entering end phase: may need discards
  if (S.phase === 'end' && S.players[S.active].hand.length > 7 && S.active === meIndex()) discardMode = true;
  afterAction();
}

function onResolveCombat() {
  if (mode === 'ai' && S.active === 0 && S.attackers.length) AI.assignBlockers(S, 1);
  var r = E.resolveCombat(S);
  if (!r.ok) { toast(r.error); return; }
  afterAction();
}

function afterAction() {
  closeDetail();
  targeting = null;
  if (!S || S.phase !== 'offense') { declaringDone = false; blockSel = null; }
  if (S.winner) return refresh();
  renderPending();
  if (S.pending && S.pending.player === meIndex()) { refresh(); return; } // modal up, wait
  refresh();
}

function maybeAI() {
  if (!S || S.winner || mode !== 'ai') return;
  if (S.pending) {
    if (S.pending.player === aiIdx) { AI.decide(S); refresh(); }
    return;
  }
  if (S.active !== aiIdx) return;
  setTimeout(aiStep, 500);
}

function aiStep() {
  if (!S || S.winner || S.active !== aiIdx) return;
  if (S.phase === 'draw') E.nextPhase(S);
  else if (S.phase === 'upkeep') { AI.upkeep(S, aiIdx); E.nextPhase(S); }
  else if (S.phase === 'main') {
    var played = AI.main(S, aiIdx) || [];
    E.nextPhase(S);
    // the AI's whole main phase resolves instantly — summarize what it did
    // (and what it paid) so its plays aren't silent
    if (played.length && !S.winner) {
      var total = played.reduce(function (n, p) { return n + p.cost; }, 0);
      toast('AI played ' + played.map(function (p) { return p.name; }).join(', ') + ' (−' + total + '◈).');
    }
  }
  else if (S.phase === 'offense') { AI.declareAttacks(S, aiIdx); }
  else if (S.phase === 'end') { AI.discardDown(S, aiIdx); E.nextPhase(S); }
  if (S.pending && S.pending.player === aiIdx) AI.decide(S);
  refresh();
  // if AI declared attackers, human assigns blockers via board clicks + resolve button
  if (S.phase === 'offense' && S.active === aiIdx && S.attackers.length) {
    toast('Assign your blockers, then Resolve combat.');
  }
}

/* resolve button appears in midbar during offense */
function renderLog() {
  var h = S.log.slice(-60).map(function (e) { return '<div>[' + e.turn + '/' + e.phase + '] ' + esc(e.msg) + '</div>'; }).join('');
  el('log').innerHTML = h;
  el('log').scrollTop = el('log').scrollHeight;
}

function renderGameOver() {
  el('board').innerHTML = '<div class="setup-box"><h1>' + (S.winner === 0 && mode === 'ai' ? 'YOU WIN' : S.winner === 1 && mode === 'ai' ? 'THE AI WINS' : esc(S.players[S.winner].name) + ' WINS') + '</h1>' +
    '<p>' + esc(S.winReason) + '</p>' +
    '<p>Turns: ' + S.turn + '</p>' +
    '<button onclick="location.reload()">Play again</button></div>';
  renderLog();
}

function toast(msg) {
  var t = el('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 2600);
}

/* resolve-combat button injection: add to midbar when relevant */
var _renderBoard = null;

document.addEventListener('DOMContentLoaded', function () {
  try {
    E.setDefs(DATA.cards);
    AI.setDefs(DATA.cards);
  el('zoom-close').onclick = closeZoom;
  el('zoom').onclick = closeZoom;
  el('detail-close').onclick = closeDetail;
  boot();
  } catch (err) {
    if (window.__showLoadError) window.__showLoadError(err && err.message);
  }
  // inject resolve button into midbar area on each render
  setInterval(function () {
    if (!S || S.winner) return;
    var mid = document.getElementById('midbar');
    if (!mid) return;
    var need = S.phase === 'offense' && S.attackers.length && !S.combatResolved && !S.pending &&
      (mode === 'ai' || declaringDone);
    var btn = document.getElementById('btn-resolve');
    if (need && !btn) {
      var b = document.createElement('button');
      b.id = 'btn-resolve'; b.textContent = '⚔ Resolve combat'; b.className = 'resolve-btn';
      b.onclick = onResolveCombat;
      mid.appendChild(b);
    } else if (!need && btn) btn.remove();
    // offense "done declaring" button for attacker (hotseat)
    var btn2 = document.getElementById('btn-done-atk');
    var need2 = mode === 'hotseat' && S.phase === 'offense' && S.active === meIndex() && !declaringDone && !S.pending;
    if (need2 && !btn2) {
      var b2 = document.createElement('button');
      b2.id = 'btn-done-atk'; b2.textContent = 'Done declaring → defender blocks'; b2.className = 'resolve-btn';
      b2.onclick = function () {
        declaringDone = true;
        toast('Pass to ' + S.players[1 - S.active].name + ': click a blocker, then the attacker it blocks. Then Resolve.');
        refresh();
      };
      mid.appendChild(b2);
    } else if (!need2 && btn2) btn2.remove();
  }, 400);
});
})();
