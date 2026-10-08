/* ============================================================================
 * MYTHOS — network adapter seam (v1: local only).
 *
 * The engine's GameState is plain JSON (see MYTHOS.snapshot / MYTHOS.restore),
 * so online play later only needs an adapter implementing this interface.
 * v1 ships LocalAdapter (hotseat / vs-AI, everything in this tab).
 * OnlineAdapter is a stub: it documents the intended Firebase-shaped contract
 * and throws until a real backend is wired up.
 * ========================================================================== */
(function (global) {
'use strict';

function LocalAdapter() {}
// Broadcast a state snapshot to all seats. Local: no-op (shared object).
LocalAdapter.prototype.publish = function (snapshot) { return snapshot; };
// Pull the latest snapshot. Local: the caller already holds it.
LocalAdapter.prototype.fetch = function () { return null; };
LocalAdapter.prototype.kind = 'local';

function OnlineAdapter(config) {
  this.config = config || {};
}
OnlineAdapter.prototype.kind = 'online (stub)';
function notReady() {
  throw new Error(
    'Online play is not implemented in v1. ' +
    'To enable it, implement OnlineAdapter.publish/fetch against your backend ' +
    '(e.g. Firebase Realtime Database for match state + Firestore for profiles) ' +
    'using MYTHOS.snapshot(state) / MYTHOS.restore(snapshot).'
  );
}
OnlineAdapter.prototype.publish = function () { notReady(); };
OnlineAdapter.prototype.fetch = function () { notReady(); };

global.MYTHOS_NET = {
  LocalAdapter: LocalAdapter,
  OnlineAdapter: OnlineAdapter,
};

if (typeof module !== 'undefined' && module.exports) module.exports = global.MYTHOS_NET;
})(typeof window !== 'undefined' ? window : global);
