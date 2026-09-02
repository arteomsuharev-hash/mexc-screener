// Pure logic test for the "switching MEXC accounts must not bleed the previous account's
// portfolio history / known-symbols list into the new account" fix (scopeAccountStorageToKey in
// app.js, built on MexcCore.computeApiKeyFingerprint). No DOM/network — a tiny fake localStorage
// is enough since the fingerprinting itself is pure.
// Run: node tests/verify_account_switch_scoping.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function makeFakeLocalStorage() {
  const store = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _dump: function () { return Object.assign({}, store); }
  };
}

// Re-implements the exact decision logic of scopeAccountStorageToKey (app.js) against a fake
// localStorage + fake knownSymbols, using the REAL MexcCore.computeApiKeyFingerprint.
function scopeAccountStorageToKey(localStorage, state, apiKey) {
  const FP_KEY = 'mexc_account_key_fingerprint';
  const fingerprint = MexcCore.computeApiKeyFingerprint(apiKey);
  const prev = localStorage.getItem(FP_KEY);
  let cleared = false;
  if (prev && prev !== fingerprint) {
    localStorage.removeItem('mexc_balance_history');
    localStorage.removeItem('mexc_known_trade_symbols');
    state.knownSymbols = {};
    cleared = true;
  }
  localStorage.setItem(FP_KEY, fingerprint);
  return cleared;
}

(function testFirstConnectNeverClears() {
  const ls = makeFakeLocalStorage();
  ls.setItem('mexc_balance_history', '[{"t":1,"v":100}]');
  const state = { knownSymbols: { BTC: 'BTCUSDT' } };
  const cleared = scopeAccountStorageToKey(ls, state, 'AKIAABCD1234EFGH5678');
  assert(cleared === false, 'first-ever connect (no prior fingerprint) does not clear existing history');
  assert(ls.getItem('mexc_balance_history') !== null, 'balance history survives the first connect');
  assert(Object.keys(state.knownSymbols).length === 1, 'knownSymbols untouched on first connect');
})();

(function testSameKeyReconnectNeverClears() {
  const ls = makeFakeLocalStorage();
  const key = 'AKIAABCD1234EFGH5678';
  scopeAccountStorageToKey(ls, { knownSymbols: {} }, key); // first connect, sets fingerprint
  ls.setItem('mexc_balance_history', '[{"t":1,"v":100}]');
  const state = { knownSymbols: { BTC: 'BTCUSDT' } };
  const cleared = scopeAccountStorageToKey(ls, state, key); // reconnect, SAME key
  assert(cleared === false, 'reconnecting with the SAME API key never clears history (would be a real regression if it did)');
  assert(ls.getItem('mexc_balance_history') !== null, 'balance history survives a same-key reconnect');
})();

(function testDifferentKeyClears() {
  const ls = makeFakeLocalStorage();
  scopeAccountStorageToKey(ls, { knownSymbols: {} }, 'AKIAABCD1234EFGH5678'); // account A
  ls.setItem('mexc_balance_history', '[{"t":1,"v":100}]');
  ls.setItem('mexc_known_trade_symbols', '[{"asset":"BTC","raw":"BTCUSDT"}]');
  const state = { knownSymbols: { BTC: 'BTCUSDT' } };
  const cleared = scopeAccountStorageToKey(ls, state, 'ZZZZWXYZ9999QRST0000'); // account B, different key
  assert(cleared === true, 'switching to a DIFFERENT API key clears the previous account\'s stored data');
  assert(ls.getItem('mexc_balance_history') === null, 'previous account\'s portfolio value history is removed, not bled into the new account');
  assert(ls.getItem('mexc_known_trade_symbols') === null, 'previous account\'s known-symbols list is removed');
  assert(Object.keys(state.knownSymbols).length === 0, 'in-memory knownSymbols is also reset, not just localStorage');
})();

(function testFingerprintDistinguishesSimilarKeys() {
  const fpA = MexcCore.computeApiKeyFingerprint('AKIAABCD1234EFGH5678');
  const fpB = MexcCore.computeApiKeyFingerprint('AKIAABCD1234EFGH5679'); // differs only in last char
  assert(fpA !== fpB, 'fingerprints of two keys differing only in the last character are distinct (' + fpA + ' vs ' + fpB + ')');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
