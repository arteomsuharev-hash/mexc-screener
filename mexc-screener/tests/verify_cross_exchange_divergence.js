// Synthetic-data tests for detectCrossExchangeDivergence (core-utils.js) — Algorithm #15. A real
// price divergence net of estimated fees/slippage, persisting across several DISTINCT updates
// (not just one stale snapshot re-evaluated), only from candidates actually supplied by the
// caller — if no candidates are supplied (no other exchange connected/matched), it must return
// null rather than fabricate a signal (spec's explicit requirement).
// Run: node tests/verify_cross_exchange_divergence.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

const OPTS = { minNetSpreadPct: 0.003, minPersistMs: 8000, minDistinctUpdates: 2, staleMs: 20000 };

(function testPersistentDivergenceIsDetected() {
  let state = {};
  let t0 = 1000000;
  // Binance price is ~1% above MEXC — well above fees+slippage (~0.25%) — across 3 distinct updates over >8s.
  let r = MexcCore.detectCrossExchangeDivergence(100, [{ exchange: 'binance', price: 101.0 }], Object.assign({ now: t0 }, OPTS), state);
  state = r.state;
  assert(r.event === null, 'first observation just starts the persistence timer, no event yet');
  r = MexcCore.detectCrossExchangeDivergence(100, [{ exchange: 'binance', price: 101.05 }], Object.assign({ now: t0 + 5000 }, OPTS), state);
  state = r.state;
  assert(r.event === null, 'still under the minimum persistence window, no event yet');
  r = MexcCore.detectCrossExchangeDivergence(100, [{ exchange: 'binance', price: 101.02 }], Object.assign({ now: t0 + 9000 }, OPTS), state);
  assert(r.event !== null, 'a divergence persisting across several distinct updates beyond the minimum window IS detected');
  if (r.event) {
    assert(r.event.detectorKey === 'crossExchangeDivergence', 'event carries the correct detectorKey');
    assert(r.event.eventType === 'CROSS_EXCHANGE_DIVERGENCE', 'carries the correct eventType');
    assert(r.event.exchange === 'binance', 'reports which exchange the divergence is against, got ' + r.event.exchange);
    assert(r.event.direction === 'LONG', 'MEXC priced below the other exchange -> LONG (expected convergence upward), got ' + r.event.direction);
    assert(r.event.netSpreadPct > 0, 'reports a positive net spread after fees/slippage, got ' + r.event.netSpreadPct);
  }
})();

(function testSpreadBelowFeesDoesNotFire() {
  let state = {};
  const t0 = 2000000;
  let r = MexcCore.detectCrossExchangeDivergence(100, [{ exchange: 'binance', price: 100.05 }], Object.assign({ now: t0 }, OPTS), state);
  state = r.state;
  r = MexcCore.detectCrossExchangeDivergence(100, [{ exchange: 'binance', price: 100.06 }], Object.assign({ now: t0 + 12000 }, OPTS), state);
  assert(r.event === null, 'a tiny spread that would be eaten by fees/slippage never fires');
})();

(function testNoCandidatesReturnsNullNotFakeSignal() {
  const r = MexcCore.detectCrossExchangeDivergence(100, [], OPTS, {});
  assert(r.event === null, 'no other exchange connected/matched -> null, never a fabricated signal');
  const r2 = MexcCore.detectCrossExchangeDivergence(100, null, OPTS, {});
  assert(r2.event === null, 'null candidates list is handled the same way -> null');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
