// Synthetic-data tests for detectLiquiditySweep (core-utils.js) — Algorithm #3: LIQUIDITY TAKEN +
// EXTREME + FLOW EXHAUSTION + RECLAIM. Must exclude an ordinary continuing dump/pump by requiring
// the pierced extreme to stop updating.
// Run: node tests/verify_liquidity_sweep.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
const OPTS = { extremeWindowMs: 120000, reclaimWindowMs: 20000 };

(function testPlantedLowSweepWithReclaim() {
  const trades = [];
  let t = 0;
  // Prior range: price oscillates 100.00-100.20 for 100s (the "local range" before the sweep).
  for (let i = 0; i < 100; i++) { trades.push(trade(t, 100.00 + (i % 20) * 0.01, 3, i % 2 === 0 ? 'buy' : 'sell')); t += 1000; }
  // Sweep: a burst of sell trades takes price below the prior low (100.00) -> new local low.
  for (let i = 0; i < 6; i++) { trades.push(trade(t, 99.90 - i * 0.01, 8, 'sell')); t += 1000; }
  // Exhaustion + reclaim: sell flow dies down, buy flow takes price back above the old low.
  for (let i = 0; i < 8; i++) { trades.push(trade(t, 99.95 + i * 0.02, 6, 'buy')); t += 1000; }

  // Tighter reclaimWindowMs here (13500ms, just above the 13000ms sweep+reclaim span) so the
  // exhaustion comparison isn't diluted by pre-sweep oscillation trades bleeding into the window.
  const ev = MexcCore.detectLiquiditySweep(trades, null, { extremeWindowMs: 120000, reclaimWindowMs: 13500 });
  assert(ev !== null, 'a low sweep with flow exhaustion and reclaim above the swept level IS detected');
  if (ev) {
    assert(ev.detectorKey === 'liquiditySweep', 'event carries the correct detectorKey');
    assert(ev.direction === 'LONG', 'a low sweep with reclaim is reported LONG, got ' + ev.direction);
    assert(ev.reclaimPct >= 0, 'reports a non-negative reclaim percentage, got ' + ev.reclaimPct);
  }
})();

(function testContinuingDumpIsNotASweep() {
  const trades = [];
  let t = 0;
  for (let i = 0; i < 100; i++) { trades.push(trade(t, 100.00 + (i % 20) * 0.01, 3, i % 2 === 0 ? 'buy' : 'sell')); t += 1000; }
  // Price keeps making new lows the whole time (no reclaim, extreme keeps updating) - an ordinary dump.
  for (let i = 0; i < 14; i++) { trades.push(trade(t, 99.90 - i * 0.02, 8, 'sell')); t += 1000; }
  const ev = MexcCore.detectLiquiditySweep(trades, null, OPTS);
  assert(ev === null, 'a continuing dump that keeps making new lows (never reclaims) is NOT flagged as a sweep');
})();

(function testNoExtremePiercedIsNotASweep() {
  const trades = [];
  let t = 0;
  // Price stays firmly inside the prior range the whole time - never pierces a local extreme.
  for (let i = 0; i < 130; i++) { trades.push(trade(t, 100.05 + (i % 5) * 0.005, 3, i % 2 === 0 ? 'buy' : 'sell')); t += 1000; }
  const ev = MexcCore.detectLiquiditySweep(trades, null, OPTS);
  assert(ev === null, 'no local extreme was ever pierced -> no sweep to report');
})();

(function testNoReclaimIsNotASweepYet() {
  const trades = [];
  let t = 0;
  for (let i = 0; i < 100; i++) { trades.push(trade(t, 100.00 + (i % 20) * 0.01, 3, i % 2 === 0 ? 'buy' : 'sell')); t += 1000; }
  for (let i = 0; i < 6; i++) { trades.push(trade(t, 99.90 - i * 0.01, 8, 'sell')); t += 1000; }
  // Price stays below the swept level (no reclaim yet) at the very end.
  for (let i = 0; i < 6; i++) { trades.push(trade(t, 99.85, 2, 'sell')); t += 1000; }
  const ev = MexcCore.detectLiquiditySweep(trades, null, OPTS);
  assert(ev === null, 'price swept the low but has not reclaimed it yet -> no signal until reclaim happens');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
