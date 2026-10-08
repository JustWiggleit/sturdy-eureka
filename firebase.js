// MYTHOS Firebase client — player identity, collections, stats, member auth.
// Loaded by index.html after the Firebase SDK compat scripts.
// Works offline-first: localStorage cache, Firestore sync when online.

(function () {
  'use strict';

  var DB = null;
  var AUTH = null;
  var currentUid = null;
  var currentIsAnon = true;
  var currentSerial = null;
  var profile = null;             // cached player profile doc
  var ready = false;
  var readyCbs = [];

  var MEMBER_TIERS = ['cultist', 'operative', 'overlord'];

  // Serial ID ranges: AI 1-999, members 100000+, guests 900000+.
  function serialFor(kind) {
    if (kind === 'ai') return 1 + Math.floor(Math.random() * 999);
    if (kind === 'guest') return 900000 + Math.floor(Math.random() * 99999);
    // members: assigned server-side from a counter in production; fallback random
    return 100000 + Math.floor(Math.random() * 899999);
  }

  function onReady(cb) {
    if (ready) cb();
    else readyCbs.push(cb);
  }

  function setReady() {
    ready = true;
    var cbs = readyCbs; readyCbs = [];
    cbs.forEach(function (cb) { try { cb(); } catch (e) {} });
  }

  function waitReady() {
    return new Promise(function (res) { onReady(res); });
  }

  // Apply a Firebase user: set identity, ensure the profile doc exists.
  function applyUser(user) {
    currentUid = user.uid;
    currentIsAnon = !!user.isAnonymous;
    return ensureProfile().then(function (p) {
      profile = p;
      setReady();
      return p;
    }, function () {
      setReady();
      return null;
    });
  }

  // Initialize Firebase. config comes from firebase/config.js (generated).
  function init(config) {
    if (!window.firebase) {
      console.warn('[mythos] Firebase SDK not loaded; running offline.');
      setReady();
      return;
    }
    try {
      firebase.initializeApp(config);
      AUTH = firebase.auth();
      DB = firebase.firestore();
      AUTH.onAuthStateChanged(function (user) {
        if (user) { applyUser(user); }
        else {
          currentUid = null; currentIsAnon = true;
          currentSerial = null; profile = null;
          setReady();
        }
      });
      // Only auto-anonymous when there is no persisted session —
      // otherwise we'd clobber a returning member's sign-in.
      if (!AUTH.currentUser) {
        AUTH.signInAnonymously().catch(function (err) {
          console.warn('[mythos] anonymous sign-in failed:', err);
        });
      }
    } catch (e) {
      console.warn('[mythos] Firebase init failed, offline mode:', e);
      setReady();
    }
  }

  // Get or create the player profile doc. Doc ID = auth UID.
  function ensureProfile() {
    var ref = DB.collection('players').doc(currentUid);
    return ref.get().then(function (snap) {
      if (snap.exists) {
        currentSerial = snap.data().serialId;
        return snap.data();
      }
      // New player: member serial for email accounts, guest serial otherwise.
      currentSerial = currentIsAnon ? serialFor('guest') : serialFor('member');
      var isMemberAcct = !currentIsAnon;
      var prof = {
        playerId: currentUid,
        serialId: currentSerial,
        displayName: isMemberAcct
          ? 'Member-' + String(currentSerial).slice(-4)
          : 'Guest-' + String(currentSerial).slice(-4),
        memberTier: 'none',   // upgraded later by the Gumroad membership sync
        memberStatus: 'none',
        gumroadId: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        wins: 0, losses: 0, aiWins: 0, aiLosses: 0
      };
      return ref.set(prof).then(function () { return prof; });
    });
  }

  // ---- Member auth (email/password) ----
  // Graceful when the provider isn't enabled: Firebase returns a plain
  // error (auth/operation-not-allowed) which the UI shows as-is.

  function signInEmail(email, pw) {
    if (!AUTH) return Promise.reject(new Error('Firebase not available (offline).'));
    return AUTH.signInWithEmailAndPassword(email, pw)
      .then(function (cred) { return applyUser(cred.user); });
  }

  function signUpEmail(email, pw) {
    if (!AUTH) return Promise.reject(new Error('Firebase not available (offline).'));
    return AUTH.createUserWithEmailAndPassword(email, pw)
      .then(function (cred) { return applyUser(cred.user); });
  }

  function signOut() {
    if (!AUTH) return Promise.resolve();
    // Back to anonymous guest so the game keeps working.
    return AUTH.signOut().then(function () { return AUTH.signInAnonymously(); });
  }

  function getProfile() { return profile; }

  function refreshProfile() {
    if (!DB || !currentUid) return Promise.resolve(profile);
    return DB.collection('players').doc(currentUid).get().then(function (snap) {
      if (snap.exists) { profile = snap.data(); }
      return profile;
    });
  }

  function isMember() {
    return !!profile && !currentIsAnon &&
      MEMBER_TIERS.indexOf(profile.memberTier) >= 0;
  }

  // ---- Collections ----
  // Returns the player's owned-cards as the local JSON format (see
  // ownership/schema.md). Empty array = nothing owned yet.
  function getCollection() {
    if (!DB || !currentUid) return Promise.resolve([]);
    return DB.collection('players').doc(currentUid)
      .collection('ownedCards').get()
      .then(function (qs) {
        var cards = [];
        qs.forEach(function (d) { cards.push(d.data()); });
        return cards;
      });
  }

  // Grant cards (starter/booster/promo). Each entry: {cardId, edition, quantity, source}.
  function grantCards(entries) {
    if (!DB || !currentUid) return Promise.reject(new Error('offline'));
    var batch = DB.batch();
    var now = new Date().toISOString();
    entries.forEach(function (e) {
      var id = e.cardId + '_' + e.edition;
      var ref = DB.collection('players').doc(currentUid)
        .collection('ownedCards').doc(id);
      batch.set(ref, {
        cardId: e.cardId, edition: e.edition,
        quantity: e.quantity || 1, source: e.source || 'promo',
        acquiredAt: now, claimCode: e.claimCode || null
      }, { merge: true });
    });
    return batch.commit();
  }

  // ---- Stats ----
  function recordResult(won, vsAI) {
    if (!DB || !currentUid) return Promise.resolve();
    var field = won ? (vsAI ? 'aiWins' : 'wins')
                    : (vsAI ? 'aiLosses' : 'losses');
    var upd = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    upd[field] = firebase.firestore.FieldValue.increment(1);
    return DB.collection('players').doc(currentUid).update(upd)
      .catch(function () {});
  }

  // ---- Claim codes ----
  // Marks a claim code redeemed. The code's HMAC is verified client-side
  // first (see ownership/claim-codes.js); the rules enforce single-use.
  function redeemClaimCode(code) {
    if (!DB || !currentUid) return Promise.reject(new Error('offline'));
    var ref = DB.collection('claimCodes').doc(code);
    return ref.update({
      redeemed: true,
      redeemedBy: currentUid,
      redeemedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // Public API
  window.MYTHOS_FIREBASE = {
    init: init,
    onReady: onReady,
    getUid: function () { return currentUid; },
    getSerial: function () { return currentSerial; },
    isOnline: function () { return !!(DB && currentUid); },
    isAnonymous: function () { return currentIsAnon; },
    signInEmail: signInEmail,
    signUpEmail: signUpEmail,
    signOut: signOut,
    getProfile: getProfile,
    refreshProfile: refreshProfile,
    isMember: isMember,
    getCollection: getCollection,
    grantCards: grantCards,
    recordResult: recordResult,
    redeemClaimCode: redeemClaimCode
  };
})();
