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
var logOpen = false;
var flipped = {};             // uid -> true: card is showing its back (persists across re-renders)

/* v2 pre-game config */
var REPORT_EMAIL = 'trollsquadproductions+technicalissues@gmail.com';
var WIX_LOGIN_URL = 'https://thenamelesscompany.wixsite.com/mythos-1/membership';
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
  el('start-login').onclick = function () { openAuthModal(); };
  el('start-report').onclick = function () { reportIssue('start screen'); };
  var lr = el('loader-report');
  if (lr) lr.onclick = function () { reportIssue('loader error'); };
  // auth modal wiring
  el('auth-close').onclick = closeAuthModal;
  el('auth-submit').onclick = submitAuth;
  el('auth-toggle').onclick = function (e) { e.preventDefault(); authMode = (authMode === 'signin') ? 'signup' : 'signin'; syncAuthModal(); authErr(''); };
  el('auth-guest').onclick = function (e) { e.preventDefault(); closeAuthModal(); };
  el('auth-email').onkeydown = function (e) { if (e.key === 'Enter') submitAuth(); };
  el('auth-pass').onkeydown = function (e) { if (e.key === 'Enter') submitAuth(); };
  // pop-up wiring
  el('popup-info').onclick = togglePopupInfo;
  if (window.MYTHOS_FIREBASE) window.MYTHOS_FIREBASE.onReady(refreshMemberBadge);
  hideLoader();
}
function newMatch() {
  setupDone = false; blockSel = null;
  seenPhasePopups = {}; lastPhaseKey = null;
  drawQueue.length = 0; drawAnimating = false;
  closePopup();
  var decks = [DATA.decks[deckChoice[0]].cards.slice(), DATA.decks[deckChoice[1]].cards.slice()];
  S = E.newGame(decks, { mode: mode, names: [DATA.decks[deckChoice[0]].name, DATA.decks[deckChoice[1]].name] });
  if (mode === 'ai' && AI.mulliganDecision(S, 1)) E.mulligan(S, 1);
  el('start-screen').style.display = 'none';
  el('game-screen').style.display = 'block';
  renderSetup();
  showFlipHintOnce();
}

/* ---------------- start / setup screens ---------------- */
function renderStart() {
  el('deck-a-name').textContent = DATA.decks.cult.name;
  el('deck-b-name').textContent = DATA.decks.board.name;
  refreshMemberBadge();
}

/* ---------------- member auth modal + badge ---------------- */
var authMode = 'signin'; // 'signin' | 'signup'

function openAuthModal() {
  authMode = 'signin';
  el('auth-email').value = '';
  el('auth-pass').value = '';
  el('auth-wix').href = WIX_LOGIN_URL;
  authErr('');
  syncAuthModal();
  el('auth-modal').style.display = 'block';
  setTimeout(function () { el('auth-email').focus(); }, 50);
}
function closeAuthModal() { el('auth-modal').style.display = 'none'; }
function syncAuthModal() {
  el('auth-title').textContent = authMode === 'signin' ? '🔑 Member sign in' : '📝 Create account';
  el('auth-sub') && (el('auth-sub').textContent = authMode === 'signin'
    ? 'Sign in with your MYTHOS member account.'
    : 'Create a free MYTHOS account. Membership tiers are added after purchase.');
  el('auth-submit').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
  el('auth-toggle').textContent = authMode === 'signin' ? 'Create a new account' : 'Already have an account? Sign in';
}
function authErr(msg) {
  var d = el('auth-error');
  if (msg) { d.textContent = msg; d.style.display = 'block'; }
  else { d.style.display = 'none'; d.textContent = ''; }
}
function friendlyAuthError(err) {
  var code = (err && err.code) || '';
  var map = {
    'auth/user-not-found': 'No account found for that email.',
    'auth/wrong-password': 'Wrong password.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/invalid-email': 'That email address looks invalid.',
    'auth/email-already-in-use': 'That email is already registered — sign in instead.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/operation-not-allowed': 'Email sign-in is not enabled yet. Play as guest for now.',
    'auth/too-many-requests': 'Too many attempts — try again later.',
    'auth/network-request-failed': 'Network error. Check your connection.'
  };
  return map[code] || (err && err.message) || 'Sign-in failed.';
}
function submitAuth() {
  var FB = window.MYTHOS_FIREBASE;
  if (!FB || !FB.isOnline()) { authErr('Not connected to the server. Check your connection and try again.'); return; }
  var email = el('auth-email').value.trim();
  var pw = el('auth-pass').value;
  if (!email || !pw) { authErr('Enter your email and password.'); return; }
  el('auth-submit').disabled = true;
  var p = authMode === 'signin' ? FB.signInEmail(email, pw) : FB.signUpEmail(email, pw);
  p.then(function () {
    el('auth-submit').disabled = false;
    closeAuthModal();
    refreshMemberBadge();
  }, function (err) {
    el('auth-submit').disabled = false;
    authErr(friendlyAuthError(err));
  });
}

function memberBadgeHTML() {
  var FB = window.MYTHOS_FIREBASE;
  if (!FB || !FB.isOnline()) return '';
  if (FB.isMember()) {
    var t = String(FB.getProfile().memberTier).toUpperCase();
    return '👑 Membership: <b>' + esc(t) + '</b> · <a id="badge-signout" href="#">Sign out</a>';
  }
  if (!FB.isAnonymous()) return 'Signed in (free account) · <a id="badge-signout" href="#">Sign out</a>';
  return 'Guest';
}
function refreshMemberBadge() {
  var b = el('member-badge');
  if (!b) return;
  var h = memberBadgeHTML();
  if (h) { b.innerHTML = h; b.style.display = 'block'; bindBadgeSignout(b); }
  else { b.style.display = 'none'; b.innerHTML = ''; }
  var chip = el('member-chip');
  if (chip) { chip.innerHTML = h || 'Guest'; bindBadgeSignout(chip); }
}
function bindBadgeSignout(root) {
  var s = root.querySelector('#badge-signout');
  if (s) s.onclick = function (e) {
    e.preventDefault();
    window.MYTHOS_FIREBASE.signOut().then(function () { refreshMemberBadge(); });
  };
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
  bindDrag(el('board'));
  bindCardZoom();
}
function setupPlayer() { return setupDone ? 1 : 0; }
var setupDone = false;
function renderSetup2() { setupDone = true; renderSetup(); }

/* ---------------- main render ---------------- */
function refresh() {
  if (!S) return;
  if (S.winner != null) return renderGameOver();
  announceDraws();
  if (S.pending && S.pending.player !== undefined && mode === 'ai' && S.pending.player === aiIdx) {
    AI.decide(S); return refresh();
  }
  renderBoard();
  renderLog();
  renderPending();
  maybePhasePopup();
  maybeAI();
}

function phaseLabel() {
  var map = { setup: 'Setup', draw: 'Draw', upkeep: 'Upkeep', main: 'Main',
              attack: 'Attack', defend: 'Defend', resolve: 'Resolve', end: 'End' };
  return map[S.phase] || S.phase;
}

function renderBoard() {
  var me = S.active, foe = 1 - S.active;
  var h = '';
  h += '<div id="topbar"><span class="game-title">MYTHOS</span>' +
    '<span id="member-chip" class="member-chip"></span>' +
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
  refreshMemberBadge();
}

function phaseBanner() {
  var p = S.active, n = esc(S.players[p].name);
  if (S.phase === 'upkeep') return n + ': pay or skip each abomination\'s upkeep. Unpaid goes <b>feral</b>.';
  if (S.phase === 'main') return n + ': play cards, set traps, perform a ritual (1/turn), use abilities.';
  if (S.phase === 'attack') return n + ': declare attackers — click an abomination to toggle it in/out.';
  if (S.phase === 'defend') return esc(S.players[1 - p].name) + ': click one of your creatures, then the attacker it blocks.';
  if (S.phase === 'resolve') return 'Resolve combat — apply damage and outcomes, then continue.';
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
    ' <span class="discardpile" title="Discard pile: ' + pl.discard.length + ' cards"><span class="dpile-label">🗑</span><span class="dpile-count">' + pl.discard.length + '</span></span>' +
    ' <span class="counts">Hand ' + (isFoe ? '🂠×' + pl.hand.length : pl.hand.length) + '</span>' +
    (pl.ritualsDone.length ? ' <span class="rituals">☽ ' + pl.ritualsDone.length + '/3</span>' : '') +
    (pl.shield ? ' <span class="shield">🛡' + pl.shield + '</span>' : '') + '</div>';
  // ---- the playing field: a distinct, labeled zone (interactive in every phase)
  h += '<div class="field"><div class="field-label">' + (isFoe ? 'ENEMY FIELD' : 'YOUR FIELD') + '</div><div class="field-cards">';
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
  h += '</div></div>'; // .field-cards, .field
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
   Flip state persists in `flipped` across re-renders. Flip via the Flip
   button in the card detail modal; tap opens detail, double-tap zooms.
   actionHTML: optional overlay (e.g. the quick-play button on hand cards). */
function flipWrap(uid, zone, frontHTML, extraCls, actionHTML) {
  return '<div class="card3d ' + extraCls + (flipped[uid] ? ' flipped' : '') + '" data-uid="' + uid + '" data-zone="' + zone + '">' +
    '<div class="card3d-inner">' +
      '<div class="card3d-face card3d-front">' + frontHTML + '</div>' +
      '<div class="card3d-face card3d-back"><img src="' + DATA.cardBack + '" alt="card back"></div>' +
    '</div>' +
    (actionHTML || '') +
  '</div>';
}
function toggleFlip(uid) {
  if (flipped[uid]) delete flipped[uid]; else flipped[uid] = true;
  var card = document.querySelector('.card3d[data-uid="' + uid + '"]');
  if (card) card.classList.toggle('flipped', !!flipped[uid]);
}
/* ---------------- drag & drop (long-press to drag) ----------------
 * Long-press (500ms, touch or mouse) on one of your cards enters DRAG MODE:
 * the card lifts and follows the pointer. Drop targets highlight while
 * dragging: your FIELD (plays the card — same rules as the ▶ button) and
 * your DISCARD pile (discards — only when legal). Release elsewhere cancels.
 * The press that starts a drag sets suppressNextClick so the release-click
 * never selects/plays/opens the card. Buttons (▶, upkeep, etc.) opt out. */
var suppressNextClick = false;
var dragState = null; // {uid, zone, ghost, src}

function isDraggable(uid, zone) {
  if (!S || S.winner != null) return false;
  var me = meIndex(), it = S.inst[uid];
  if (!it) return false;
  if (zone === 'hand') return it.owner === me;
  if (zone === 'board') return it.controller === me;
  return false; // detail modal, setup screen, etc.
}

function bindDrag(root) {
  root.querySelectorAll('.card3d').forEach(function (card) {
    if (card._dragBound) return;
    card._dragBound = true;
    var uid = card.getAttribute('data-uid');
    var zone = card.getAttribute('data-zone');
    var timer = null, sx = 0, sy = 0;
    function onControl(t) { return t && t.closest && t.closest('[data-play], button, a'); }
    function start(x, y, t) {
      if (dragState) return;
      if (onControl(t)) return;
      if (!isDraggable(uid, zone)) return;
      sx = x; sy = y;
      clearTimeout(timer);
      timer = setTimeout(function () { beginDrag(uid, zone, card); }, 500);
    }
    function cancel() { clearTimeout(timer); timer = null; }
    function moved(x, y) { return Math.abs(x - sx) > 10 || Math.abs(y - sy) > 10; }
    card.addEventListener('touchstart', function (e) {
      var t = e.touches[0]; start(t.clientX, t.clientY, e.target);
    }, { passive: true });
    card.addEventListener('touchmove', function (e) {
      if (timer && moved(e.touches[0].clientX, e.touches[0].clientY)) cancel();
    }, { passive: true });
    card.addEventListener('touchend', cancel);
    card.addEventListener('touchcancel', cancel);
    card.addEventListener('mousedown', function (e) {
      if (e.button === 0) start(e.clientX, e.clientY, e.target);
    });
    card.addEventListener('mousemove', function (e) {
      if (timer && moved(e.clientX, e.clientY)) cancel();
    });
    card.addEventListener('mouseup', cancel);
    card.addEventListener('mouseleave', cancel);
    card.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });
}

function beginDrag(uid, zone, cardEl) {
  if (dragState || !isDraggable(uid, zone)) return;
  var rect = cardEl.getBoundingClientRect();
  var ghost = cardEl.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.classList.add('drag-ghost');
  ghost.classList.remove('just-drew');
  ghost.style.width = rect.width + 'px';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  // strip interactive children from the ghost so it never intercepts input
  ghost.querySelectorAll('button, a').forEach(function (b) { b.remove(); });
  document.body.appendChild(ghost);
  cardEl.classList.add('drag-src');
  dragState = { uid: uid, zone: zone, ghost: ghost, src: cardEl };
  document.body.classList.add('dragging');
  if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
  document.addEventListener('touchmove', docDragMove, { passive: false });
  document.addEventListener('touchend', docDragEnd);
  document.addEventListener('touchcancel', docDragCancel);
  document.addEventListener('mousemove', docDragMove);
  document.addEventListener('mouseup', docDragEnd);
}
function docDragMove(e) {
  if (!dragState) return;
  if (e.cancelable) e.preventDefault(); // stop scroll while dragging
  var x, y;
  if (e.touches && e.touches.length) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
  else { x = e.clientX; y = e.clientY; }
  var g = dragState.ghost;
  g.style.left = (x - g.offsetWidth / 2) + 'px';
  g.style.top = (y - g.offsetHeight / 2) + 'px';
  updateDropHighlight(x, y);
}
function docDragEnd(e) {
  if (!dragState) return;
  var x, y;
  if (e.changedTouches && e.changedTouches.length) { x = e.changedTouches[0].clientX; y = e.changedTouches[0].clientY; }
  else { x = e.clientX; y = e.clientY; }
  var ds = dragState;
  cleanupDrag();
  suppressNextClick = true; // swallow the release click
  var target = dropTargetAt(x, y);
  if (target === 'field' && ds.zone === 'hand') {
    quickPlay(ds.uid); // same rules as the ▶ button
  } else if (target === 'discard') {
    discardFromDrag(ds.uid, ds.zone);
  }
  // else: released elsewhere — snap back (re-render restores the card)
}
function docDragCancel() { cleanupDrag(); suppressNextClick = true; }
function cleanupDrag() {
  var ds = dragState;
  dragState = null;
  if (ds && ds.ghost.parentNode) ds.ghost.parentNode.removeChild(ds.ghost);
  if (ds && ds.src) ds.src.classList.remove('drag-src');
  document.body.classList.remove('dragging');
  document.querySelectorAll('.drop-over').forEach(function (n) { n.classList.remove('drop-over'); });
  document.removeEventListener('touchmove', docDragMove);
  document.removeEventListener('touchend', docDragEnd);
  document.removeEventListener('touchcancel', docDragCancel);
  document.removeEventListener('mousemove', docDragMove);
  document.removeEventListener('mouseup', docDragEnd);
}
function pointInRect(x, y, r) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
/* Drop targets live in the viewing player's zone ('.pzone.me' — in hotseat
   that's the active player, matching isDraggable). Field accepts hand cards;
   the discard pile accepts hand cards (when legal). */
function dropTargetAt(x, y) {
  var field = document.querySelector('.pzone.me .field');
  var pile = document.querySelector('.pzone.me .discardpile');
  if (pile && pointInRect(x, y, pile.getBoundingClientRect())) return 'discard';
  if (field && pointInRect(x, y, field.getBoundingClientRect())) return 'field';
  return null;
}
function updateDropHighlight(x, y) {
  var t = dropTargetAt(x, y);
  document.querySelectorAll('.pzone.me .field, .pzone.me .discardpile').forEach(function (n) {
    var isField = n.classList.contains('field');
    n.classList.toggle('drop-over', (t === 'field' && isField) || (t === 'discard' && !isField));
  });
}
/* Discard legality: hand cards only during end-phase discard-down;
   board cards have no legal drag-discard in v1 (card effects use their own UI). */
function discardFromDrag(uid, zone) {
  var me = meIndex();
  if (zone === 'hand' && discardMode && S.inst[uid].owner === me) {
    var nm = cname(uid);
    E.discard(S, me, uid);
    if (S.players[me].hand.length <= 7) discardMode = false;
    afterAction();
    popUp('Discarded <b>' + esc(nm) + '</b>.', null, { autoDismiss: 2000 });
    return;
  }
  popUp('You can only discard during your <b>end phase</b> (when you hold more than 7 cards) or when a card effect tells you to.', 'end');
}

/* One-time drag hint (replaces the old flip hint). */
function showFlipHintOnce() {
  try {
    if (localStorage.getItem('mythos_drag_hint')) return;
    localStorage.setItem('mythos_drag_hint', '1');
    setTimeout(function () {
      popUp('Tip: <b>long-press</b> a card in your hand, then drag it to your <b>field</b> to play it — or to the <b>discard pile</b>.', 'drag');
    }, 1500);
  } catch (e) {}
}

function boardCardHTML(uid, isFoe) {
  var it = S.inst[uid], d = Dd(uid);
  var cls = 'bcard' + (it.feral ? ' feral' : '') + (it.psan <= 0 && d.type === 'Character' ? ' burned' : '') +
    (it.asleepUntil >= S.turn ? ' asleep' : '');
  if (S.phase === 'attack' && S.attackers.some(function (a) { return a.uid === uid; })) cls += ' attacking';
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
  var playBtn = playable
    ? '<button class="playbtn" data-play="' + uid + '" title="Play now" aria-label="Play ' + esc(d.name) + ' now">▶</button>'
    : '';
  return flipWrap(uid, 'hand',
    '<img src="' + imgFor(uid) + '" alt="' + esc(d.name) + '" title="' + esc(d.name) + '">',
    cls + (playable ? ' playable' : ''), playBtn);
}

/* Tap ▶ on a hand card: play it immediately when no extra choices are needed.
   Cards needing targets, leash choices, or ritual setup fall back to the
   detail modal flow. */
function quickPlay(uid) {
  var me = meIndex(), d = Dd(uid);
  if (!(S.phase === 'main' && S.active === me)) { popUp('Play cards during your <b>Main phase</b>.', 'main'); return; }
  var r;
  if (d.type === 'Trap') {
    r = E.setTrap(S, me, uid);
    if (!r.ok) popUp(esc(r.error), 'traps');
    return afterAction();
  }
  if (d.type === 'Ritual') { openDetail(uid, 'hand'); return; }
  var c = E.canPlay(S, me, uid);
  if (!c.ok) { popUp(esc(c.error), 'main'); return; }
  if (c.need) { openDetail(uid, 'hand'); return; } // target/leash → modal choices
  r = E.playCard(S, me, uid, {});
  if (!r.ok) popUp(esc(r.error), null);
  afterAction();
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
  bindDrag(el('board'));
  // quick-play buttons: tap ▶ to play immediately (never flips — long-press opts out)
  el('board').querySelectorAll('[data-play]').forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      if (suppressNextClick) { suppressNextClick = false; return; }
      quickPlay(b.getAttribute('data-play'));
    };
  });
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
  if (suppressNextClick) { suppressNextClick = false; return; } // long-press release: swallow
  if (S.winner != null) return;
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
  // attack phase: active player declares attackers (click to toggle)
  if (S.phase === 'attack' && zone === 'board' && S.active === me) {
    var it = S.inst[uid];
    if (it.controller === me && Dd(uid).type === 'Abomination') {
      // toggle: click a declared attacker to stand it down
      var already = S.attackers.some(function (a) { return a.uid === uid; });
      if (already) {
        var ru = E.undeclareAttacker(S, me, uid);
        if (!ru.ok) { popUp(esc(ru.error), 'attack'); return; }
        return afterAction();
      }
      if (E.canAttack(S, uid)) {
        var r = E.declareAttacker(S, me, uid, { kind: 'player', player: 1 - me });
        if (!r.ok) { popUp(esc(r.error), 'attack'); return; }
        return afterAction();
      }
      popUp(esc(attackWhyNot(uid)), 'attack'); return;
    }
  }
  // defend phase: defender clicks own creature to select, then an attacker to assign
  if (S.phase === 'defend' && zone === 'board' && S.attackers.length) {
    var di = defenderIndex(), it2 = S.inst[uid];
    // 1. click one of the defender's creatures to select it as the blocker
    if (it2.controller === di && E.canBlock(S, uid)) {
      blockSel = uid;
      popUp('<b>' + esc(cname(uid)) + '</b> selected as blocker — now click an attacker.', 'defend');
      refresh(); return;
    }
    // 2. click an attacker to assign the selected blocker to it
    if (it2.controller === S.active && blockSel) {
      var atk = S.attackers.filter(function (a) { return a.uid === uid; })[0];
      if (atk && E.canBlock(S, blockSel)) {
        var r2 = E.declareBlocker(S, di, blockSel, uid);
        blockSel = null;
        if (!r2.ok) { popUp(esc(r2.error), 'defend'); return; }
        return afterAction();
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
  if (!r.ok) popUp(esc(r.error), t.kind === 'ritual' ? 'rituals' : null);
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
    if (d.type === 'Abomination' && S.phase === 'attack' && S.active === me && E.canAttack(S, uid))
      h += '<button data-m="attack">Attack</button>';
  }
  h += '<button data-m="flip">🔄 Flip</button>';
  h += '<button data-m="close">Close</button></div></div>';
  el('detail-body').innerHTML = h;
  el('detail').style.display = 'flex';
  bindDrag(el('detail-body'));
  el('detail-body').querySelectorAll('[data-m]').forEach(function (b) {
    b.onclick = function () { detailAction(b.getAttribute('data-m'), uid, zone); };
  });
  el('detail-body').querySelector('.zoomable').ondblclick = function (e) { e.stopPropagation(); zoomCard(imgFor(uid)); };
}
function closeDetail() { el('detail').style.display = 'none'; }

function detailAction(m, uid, zone) {
  var me = meIndex(), r;
  if (m === 'close') return closeDetail();
  if (m === 'flip') { toggleFlip(uid); return; } // stay open so they can see both sides
  if (m === 'settrap') { r = E.setTrap(S, me, uid); if (!r.ok) popUp(esc(r.error), 'traps'); closeDetail(); return afterAction(); }
  if (m === 'play') {
    var c = E.canPlay(S, me, uid);
    if (!c.ok) { popUp(esc(c.error), 'main'); return; }
    if (c.need === 'target') { targeting = { kind: 'play', uid: uid, spec: c.targetSpec, label: cname(uid) }; closeDetail(); return refresh(); }
    if (c.need === 'leash' || c.need === 'mole' || c.need === 'boardsplit') return leashModal(uid, c);
    r = E.playCard(S, me, uid, {});
    if (!r.ok) popUp(esc(r.error), null);
    closeDetail(); return afterAction();
  }
  if (m === 'activate') {
    var ab = E.activatedInfo(S, uid);
    if (ab.target) { targeting = { kind: 'activate', uid: uid, spec: ab.target, label: ab.name }; closeDetail(); return refresh(); }
    r = E.activate(S, me, uid);
    if (!r.ok) popUp(esc(r.error), null);
    closeDetail(); return afterAction();
  }
  if (m === 'ritual') return ritualModal(uid);
  if (m === 'releash') {
    var chars = S.players[me].chars.filter(function (x) {
      return E.freeControl(S, x) >= (Dd(uid).leash || 0);
    });
    if (!chars.length) { popUp('No character with free Control to leash to.', 'leash'); return; }
    // pick first with room (v1)
    r = E.releash(S, me, uid, chars[0]);
    if (!r.ok) popUp(esc(r.error), 'leash');
    closeDetail(); return afterAction();
  }
  if (m === 'attack') {
    closeDetail();
    r = E.declareAttacker(S, me, uid, { kind: 'player', player: 1 - me });
    if (!r.ok) popUp(esc(r.error), 'attack');
    return afterAction();
  }
}

function leashModal(uid, chk) {
  var opts = chk.leashOptions;
  if (opts.length === 1 && chk.need !== 'boardsplit') {
    var r = E.playCard(S, meIndex(), uid, { leashTo: opts[0].char });
    if (!r.ok) popUp(esc(r.error), 'leash');
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
      if (!r.ok) popUp(esc(r.error), 'leash');
      closeDetail(); afterAction();
    };
  });
}

function ritualModal(uid) {
  var me = meIndex(), info = E.ritualInfo(S, me, uid);
  if (!info.ok) { popUp(esc(info.error), 'rituals'); return; }
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
        if (!tg.length) { popUp('No legal target for this ritual.', 'rituals'); return; }
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
      if (!r.ok) popUp(esc(r.error), 'rituals');
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
  var r = E.nextPhase(S);
  if (!r.ok) { popUp(esc(r.error), S.phase || null); return; }
  if (r.tally) toast(r.tally); // stage-end tally: no silent stat changes
  // entering end phase: may need discards
  if (S.phase === 'end' && S.players[S.active].hand.length > 7 && S.active === meIndex()) discardMode = true;
  // vs AI: the AI defends for itself the moment the human's attack phase ends
  if (S.phase === 'defend' && mode === 'ai' && S.active !== aiIdx && S.attackers.length && !S.winner && !S.pending) {
    AI.assignBlockers(S, aiIdx);
  }
  afterAction();
}

function onResolveCombat() {
  if (mode === 'ai' && S.active === 0 && S.attackers.length) AI.assignBlockers(S, 1);
  var r = E.resolveCombat(S);
  if (!r.ok) { popUp(esc(r.error), 'resolve'); return; }
  afterAction();
}

function afterAction() {
  closeDetail();
  targeting = null;
  if (S.phase !== 'defend') blockSel = null;
  if (S.winner != null) return refresh();
  renderPending();
  if (S.pending && S.pending.player === meIndex()) { refresh(); return; } // modal up, wait
  refresh();
}

/* ---------------- draw animations ----------------
 * Card backs fly from the drawing player's deck pile to their hand (~600ms),
 * queued so multiple draws play sequentially. The human's drawn card glows
 * on landing; opponent draws stay face-down — no identity leaks. */
var drawQueue = [];
var drawAnimating = false;
function uidHash(u) { var h = 0; u = String(u); for (var i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) | 0; return Math.abs(h); }

function announceDraws() {
  if (!S || !S.lastDrawn) return;
  var d = S.lastDrawn;
  S.lastDrawn = null;
  if (!d.uids || !d.uids.length) return;
  var isMe = d.player === meIndex();
  d.uids.forEach(function (uid) { drawQueue.push({ player: d.player, uid: uid, isMe: isMe }); });
  pumpDrawQueue();
}
function pumpDrawQueue() {
  if (drawAnimating || !drawQueue.length) return;
  drawAnimating = true;
  var d = drawQueue.shift();
  animateDraw(d, function () {
    drawAnimating = false;
    // brief beat before the next card so multiples read as a sequence
    setTimeout(pumpDrawQueue, 120);
  });
}
function animateDraw(d, done) {
  try {
    // '.pzone.me' is always the viewing player's zone; '.pzone.foe' the opponent's.
    // In hotseat meIndex() === S.active, so the active player's zone carries .me.
    var zoneSel = d.isMe ? '.pzone.me' : '.pzone.foe';
    var zone = document.querySelector(zoneSel);
    var deckImg = zone && zone.querySelector('.deckpile img');
    var handEl = zone && zone.querySelector('.hand');
    if (!deckImg || !handEl) { done(); return; }
    var dr = deckImg.getBoundingClientRect();
    var hr = handEl.getBoundingClientRect();
    var fly = document.createElement('div');
    fly.className = 'draw-fly';
    var img = document.createElement('img');
    img.src = DATA.cardBack; img.alt = '';
    fly.appendChild(img);
    fly.style.left = (dr.left + dr.width / 2) + 'px';
    fly.style.top = (dr.top + dr.height / 2) + 'px';
    document.body.appendChild(fly);
    // force reflow so the transition runs
    fly.getBoundingClientRect();
    var tx = (hr.left + hr.width / 2) - (dr.left + dr.width / 2);
    var ty = (hr.top + Math.min(hr.height, 90) / 2) - (dr.top + dr.height / 2);
    fly.style.transform = 'translate(' + tx + 'px,' + ty + 'px) rotate(' + (uidHash(d.uid) % 31 - 15) + 'deg)';
    setTimeout(function () {
      fly.remove();
      if (d.isMe) {
        var card = document.querySelector('.card3d[data-uid="' + d.uid + '"]');
        if (card) {
          card.classList.add('just-drew');
          setTimeout(function () { card.classList.remove('just-drew'); }, 1500);
        }
      }
      done();
    }, 650);
  } catch (e) { done(); }
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
  if (S.phase === 'draw') { S._aiAtkDone = false; S._aiResDone = false; var t0 = E.nextPhase(S); if (t0.tally) toast(t0.tally); }
  else if (S.phase === 'upkeep') { AI.upkeep(S, aiIdx); var t1 = E.nextPhase(S); if (!t1.ok) popUp(esc(t1.error), 'upkeep'); else if (t1.tally) toast(t1.tally); }
  else if (S.phase === 'main') {
    var played = AI.main(S, aiIdx) || [];
    var t2 = E.nextPhase(S);
    if (!t2.ok) popUp(esc(t2.error), 'main'); else if (t2.tally) toast(t2.tally);
    // the AI's whole main phase resolves instantly — summarize what it did
    // (and what it paid) so its plays aren't silent
    if (played.length && S.winner == null) {
      var total = played.reduce(function (n, p) { return n + p.cost; }, 0);
      toast('AI played ' + played.map(function (p) { return p.name; }).join(', ') + ' (−' + total + '◈).');
    }
  }
  else if (S.phase === 'attack') {
    // declare once per attack phase; the human advances with Next phase →
    if (!S._aiAtkDone) { S._aiAtkDone = true; AI.declareAttacks(S, aiIdx); }
  }
  else if (S.phase === 'defend') { /* AI is the attacker here; the human defends via the UI */ }
  else if (S.phase === 'resolve') {
    if (!S._aiResDone) {
      S._aiResDone = true;
      var rr = E.resolveCombat(S);
      if (!rr.ok) popUp(esc(rr.error), 'resolve');
    }
  }
  else if (S.phase === 'end') { AI.discardDown(S, aiIdx); var t3 = E.nextPhase(S); if (!t3.ok) popUp(esc(t3.error), 'end'); else if (t3.tally) toast(t3.tally); }
  if (S.pending && S.pending.player === aiIdx) AI.decide(S);
  refresh();
  // AI defends for itself when the human is the attacker
  if (S.phase === 'defend' && S.active !== aiIdx && S.attackers.length && !S.winner && !S.pending) {
    AI.assignBlockers(S, aiIdx);
    refresh();
  }
  // if AI declared attackers, the human assigns blockers via board clicks, then resolves
  if (S.phase === 'defend' && S.active === aiIdx && S.attackers.length) {
    popUp('The enemy attacks! <b>Assign your blockers</b>, then continue to Resolve.', 'defend');
  }
}

/* resolve button appears in midbar during the resolve phase */
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

/* ---------------- pop-up system: instructional / action text ----------------
 * popUp(msg, infoKey, opts): modal with message + OK + Info buttons.
 * Info swaps to a concise rule explanation from RULE_INFO.
 * During AI turns pop-ups auto-dismiss after 2.5s so fast turns never hang.
 * opts: {autoDismiss: ms, onOk: fn} */
var RULE_INFO = {
  draw: { title: 'Draw phase',
    text: 'Draw 1 card at the start of your turn. The first player skips their very first draw. If you must draw from an empty deck, you lose — drowned in paperwork.' },
  upkeep: { title: 'Upkeep & going feral',
    text: 'Pay each abomination\'s upkeep cost from your sanity. Anything you don\'t pay goes <b>feral</b>: it stops obeying you, can\'t be leashed, and deals its power to YOUR sanity when combat starts. Paying upkeep keeps your workforce loyal.' },
  main: { title: 'Main phase',
    text: 'The heart of your turn. Play cards from your hand by paying their sanity cost, set traps face-down, perform one ritual per turn, or use activated abilities on cards you control. Tap ▶ on a card to play it instantly, or long-press and drag it to your field.' },
  attack: { title: 'Attack',
    text: 'Click your abominations to declare them as attackers — click again to stand one down. Only abominations attack; characters never attack (but they can block). Summoning-sick abominations (just played this turn) can\'t attack. Then advance to Defend.' },
  defend: { title: 'Defend & blocking',
    text: 'The defender assigns blockers: click one of your creatures, then click the attacker it blocks. Characters CAN block even though they can\'t attack. Each blocker stops one attacker. Unblocked attackers deal their power straight to the defending player\'s sanity.' },
  resolve: { title: 'Resolve combat',
    text: 'Damage is applied: blocked attackers trade blows with their blockers (power vs. flesh — destroyed at 0 flesh), and unblocked attackers hit the defending player\'s sanity directly. Surviving blockers stay on the field.' },
  end: { title: 'End phase & discarding',
    text: 'Discard down to 7 cards in your hand, then your turn ends. You can only discard when the rules say so — during this end-phase discard, or when a card effect tells you to. Dragging a card to the discard pile at any other time won\'t work.' },
  sanity: { title: 'Sanity',
    text: 'Your life AND your currency. You start at 40. Card costs are paid from it, combat damage reduces it. At 0 sanity you break and lose the game. Spend it wisely — everything costs a piece of your mind.' },
  rituals: { title: 'Rituals',
    text: 'Sacrifice a burned-out character (one at 0 personal sanity) at a ritual site (The Altar or The Grove) to complete a ritual. One ritual per turn. Complete 3 rituals to win the game outright.' },
  leash: { title: 'Leash',
    text: 'Abominations must be leashed to a character you control when played. Each character\'s Control stat limits the total leash cost they can hold. An abomination with no leash — or whose upkeep goes unpaid — goes feral.' },
  traps: { title: 'Traps',
    text: 'Set face-down during your Main phase by paying their cost. Traps trigger automatically when their condition is met — even on your opponent\'s turn. Your opponent sees that you have traps set, but not what they are.' },
  mulligan: { title: 'Mulligan',
    text: 'Once per match, before the game starts, you may shuffle your opening hand back into your deck and draw 7 new cards. No further mulligans — commit to what you get.' },
  flip: { title: 'Flipping cards',
    text: 'Cards can be flipped face-down to hide information from your opponent. Open a card\'s detail view (tap it) and use the Flip button. Flipping is cosmetic — it doesn\'t change what the card does.' },
  drag: { title: 'Drag & drop',
    text: 'Long-press (hold ½ second) a card in your hand, then drag it. Drop it on <b>your field</b> to play it (same rules as the ▶ button), or on the <b>discard pile</b> to discard it — but only when discarding is legal. Release anywhere else to cancel.' }
};

var popupTimer = null;
var popupLastMsg = '';
var popupInfoKey = null;
var popupShowingInfo = false;

function isAITurn() { return mode === 'ai' && S && !S.winner && S.active === aiIdx; }

/* Phase instruction pop-ups: first time each phase is entered per match. */
var seenPhasePopups = {};
var lastPhaseKey = null;
var PHASE_INTRO = {
  draw: 'Draw phase — a card flies from your deck to your hand.',
  upkeep: 'Upkeep — pay each abomination\'s upkeep, or it goes <b>feral</b>.',
  main: 'Main phase — play cards, set traps, perform a ritual, use abilities.',
  attack: 'Attack — click your abominations to declare attackers.',
  defend: 'Defend — click one of your creatures, then the attacker it blocks.',
  resolve: 'Resolve — hit <b>⚔ Resolve combat</b> to apply damage and outcomes.',
  end: 'End phase — discard down to 7 cards, then end your turn.'
};
function maybePhasePopup() {
  if (!S || S.winner != null) return;
  var key = S.turn + ':' + S.active + ':' + S.phase;
  if (key === lastPhaseKey) return;
  lastPhaseKey = key;
  if (seenPhasePopups[S.phase] || !PHASE_INTRO[S.phase]) return;
  seenPhasePopups[S.phase] = true;
  // During AI turns the pop-up auto-dismisses (see popUp); on the human's
  // turn it waits for OK. Either way it never blocks the game loop.
  popUp(PHASE_INTRO[S.phase], S.phase);
}

function popUp(msg, infoKey, opts) {
  opts = opts || {};
  popupLastMsg = msg;
  popupInfoKey = infoKey || null;
  popupShowingInfo = false;
  el('popup-msg').innerHTML = msg;
  var infoBtn = el('popup-info');
  infoBtn.style.display = (popupInfoKey && RULE_INFO[popupInfoKey]) ? '' : 'none';
  infoBtn.textContent = 'ⓘ Info';
  el('popup-ok').onclick = function () { closePopup(); if (opts.onOk) opts.onOk(); };
  el('popup-close').onclick = function () { closePopup(); if (opts.onOk) opts.onOk(); };
  el('popup').style.display = 'flex';
  clearTimeout(popupTimer);
  var ms = opts.autoDismiss || (isAITurn() ? 2500 : 0);
  if (ms) popupTimer = setTimeout(closePopup, ms);
}
function closePopup() {
  clearTimeout(popupTimer);
  el('popup').style.display = 'none';
  popupShowingInfo = false;
}
function togglePopupInfo() {
  if (!popupInfoKey || !RULE_INFO[popupInfoKey]) return;
  var info = RULE_INFO[popupInfoKey];
  if (!popupShowingInfo) {
    popupShowingInfo = true;
    el('popup-msg').innerHTML = '<h3>' + esc(info.title) + '</h3><p>' + info.text + '</p>';
    el('popup-info').textContent = '← Back';
  } else {
    popupShowingInfo = false;
    el('popup-msg').innerHTML = popupLastMsg;
    el('popup-info').textContent = 'ⓘ Info';
  }
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
    if (!S || S.winner != null) return;
    var mid = document.getElementById('midbar');
    if (!mid) return;
    // resolve button appears in midbar during the resolve phase, when combat awaits
    var need = S.phase === 'resolve' && S.attackers.length && !S.combatResolved && !S.pending;
    var btn = document.getElementById('btn-resolve');
    if (need && !btn) {
      var b = document.createElement('button');
      b.id = 'btn-resolve'; b.textContent = '⚔ Resolve combat'; b.className = 'resolve-btn';
      b.onclick = onResolveCombat;
      mid.appendChild(b);
    } else if (!need && btn) btn.remove();
  }, 400);
});

/* test hooks (browser testing) */
window.MYTHOS_TEST = {
  signInEmail: function (e, p) { return window.MYTHOS_FIREBASE.signInEmail(e, p); },
  signUpEmail: function (e, p) { return window.MYTHOS_FIREBASE.signUpEmail(e, p); },
  signOut: function () { return window.MYTHOS_FIREBASE.signOut(); },
  getProfile: function () { return window.MYTHOS_FIREBASE.getProfile(); },
  isMember: function () { return window.MYTHOS_FIREBASE.isMember(); }
};
})();
