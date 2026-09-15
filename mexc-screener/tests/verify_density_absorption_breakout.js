// Synthetic-data tests for detectDensityAbsorptionBreakout (core-utils.js) — Algorithm #6, a
// stronger variant of density break requiring the SAME level to be tested multiple times across
// several separate calls (minutes apart) before a final break counts. Unlike the other detectors,
// this one has a {event, state} contract — state must be threaded back in by the caller across
// calls (mirrors app.js's per-symbol state Map).
// Run: node tests/verify_density_absorption_breakout.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
function ladder(basePrice, step, wallIdx, wallQty) {
  const arr = [];
  for (let i = 0; i < 20; i++) arr.push({ p: Math.round((basePrice + step * i) * 10000) / 10000, q: (i === wallIdx ? wallQty : 10) });
  return arr;
}
function snap(t, bestBid, bestAsk, asks, bids) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, asks: asks, bids: bids, bidVol: 0, askVol: 0 };
}
const OPTS = { minWallRatio: 5, priceTolerance: 0.002, maxDistancePct: 1.0, testGapMs: 15000, minTestCount: 3 };
const flatBids = ladder(99.80, -0.01, -1, 0);

(function testRepeatedTestsThenBreakIsDetected() {
  const wallAsks = ladder(100.01, 0.01, 14, 120); // wall at 100.15
  const shrunkAsks = ladder(100.01, 0.01, 14, 20); // same level, mostly depleted (remaining 20/120 ~17%)
  let state = {};
  let event = null;
  let t = 0;
  // 4 separate "test" snapshots of the same wall, >= testGapMs apart, price staying just below it.
  for (let i = 0; i < 4; i++) {
    const r = MexcCore.detectDensityAbsorptionBreakout([snap(t, 100.095, 100.105, wallAsks, flatBids)], [], OPTS, state);
    state = r.state; event = r.event;
    t += 20000; // > testGapMs (15000) apart -> each counts as a distinct test
  }
  assert(event === null, 'not enough tests yet / wall still intact -> no event before the final break');
  assert(state.trackedLevel && state.trackedLevel.testCount >= 3, 'test_count accumulated across separate calls, got ' + (state.trackedLevel && state.trackedLevel.testCount));

  // Now the wall depletes and price crosses it, with confirming buy trades.
  const trades = [trade(t - 500, 100.14, 20, 'buy'), trade(t - 250, 100.16, 10, 'buy')];
  const r2 = MexcCore.detectDensityAbsorptionBreakout([snap(t, 100.155, 100.165, shrunkAsks, flatBids)], trades, OPTS, state);
  assert(r2.event !== null, 'after >= minTestCount tests and final depletion + crossing + confirming flow, a breakout event IS emitted');
  if (r2.event) {
    assert(r2.event.detectorKey === 'densityAbsorptionBreakout', 'event carries the correct detectorKey');
    assert(r2.event.direction === 'LONG', 'ask-wall breakout is reported LONG, got ' + r2.event.direction);
    assert(r2.event.testCount >= 3, 'reports the accumulated test count, got ' + r2.event.testCount);
  }
  assert(r2.state.trackedLevel === null, 'tracked level is reset after firing, so the same break is not reported twice');
})();

(function testTooFewTestsDoesNotFire() {
  const wallAsks = ladder(100.01, 0.01, 14, 120);
  const shrunkAsks = ladder(100.01, 0.01, 14, 20);
  let state = {};
  let t = 0;
  // Only 2 tests (below minTestCount=3).
  for (let i = 0; i < 2; i++) {
    const r = MexcCore.detectDensityAbsorptionBreakout([snap(t, 100.095, 100.105, wallAsks, flatBids)], [], OPTS, state);
    state = r.state;
    t += 20000;
  }
  const trades = [trade(t - 500, 100.14, 20, 'buy')];
  const r2 = MexcCore.detectDensityAbsorptionBreakout([snap(t, 100.155, 100.165, shrunkAsks, flatBids)], trades, OPTS, state);
  assert(r2.event === null, 'fewer than minTestCount tests of the level -> no breakout event yet, even if it later depletes and crosses');
})();

(function testStaleTrackedLevelIsForgotten() {
  const wallAsks = ladder(100.01, 0.01, 14, 120);
  let state = {};
  const r1 = MexcCore.detectDensityAbsorptionBreakout([snap(0, 100.095, 100.105, wallAsks, flatBids)], [], OPTS, state);
  state = r1.state;
  assert(state.trackedLevel !== null, 'level tracked after first sighting');
  // Long gap (> staleMs default 600000ms) with no further tests -> forgotten, not stale-carried-forever.
  const r2 = MexcCore.detectDensityAbsorptionBreakout([snap(700000, 99.99, 100.00, ladder(100.01, 0.01, -1, 0), flatBids)], [], OPTS, state);
  assert(r2.state.trackedLevel === null || r2.state.trackedLevel.firstSeenAt === 700000, 'a level not re-tested within staleMs is forgotten (new tracking starts fresh, not an ancient one)');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
