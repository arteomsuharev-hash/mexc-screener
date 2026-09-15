// Synthetic-data tests for detectDensityAbsorption (core-utils.js) — Algorithm #2. Returns a STATE
// (ABSORBING/HOLDING/BREAKING/REJECTED), never an automatic directional signal by itself — the
// spec explicitly forbids "absorption happened -> auto LONG".
// Run: node tests/verify_density_absorption.js

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
const OPTS = { minSnapshots: 30, lookback: 60, minWallRatio: 5, minAbsorptionRatio: 3, maxDistancePct: 1.5 };

(function testHighAggressiveVolumeLittlePriceProgressIsAbsorbing() {
  // Ask wall at 100.15, price stays pinned right at ~100.10 the WHOLE window (barely moves) while
  // heavy buy volume repeatedly hits near the wall — classic "buy flow up, price response down".
  const wallAsks = ladder(100.01, 0.01, 14, 120);
  const flatBids = ladder(99.80, -0.01, -1, 0);
  const depthSnapshots = [];
  for (let i = 0; i < 60; i++) depthSnapshots.push(snap(i * 500, 100.095, 100.105, wallAsks, flatBids));
  const trades = [];
  let tt = 0;
  for (let i = 0; i < 60; i++) { trades.push(trade(tt, 100.10 + (i % 2) * 0.005, 8, 'buy')); tt += 500; }

  const ev = MexcCore.detectDensityAbsorption(depthSnapshots, trades, OPTS);
  assert(ev !== null, 'heavy aggressive buy volume with almost no price progress near a wall IS detected as absorption');
  if (ev) {
    assert(ev.detectorKey === 'densityAbsorption', 'event carries the correct detectorKey');
    assert(['ABSORBING', 'HOLDING', 'BREAKING', 'REJECTED'].indexOf(ev.state) !== -1, 'reports one of the four defined states, got ' + ev.state);
    assert(ev.state === 'ABSORBING' || ev.state === 'HOLDING', 'wall still mostly intact -> ABSORBING or HOLDING, got ' + ev.state);
  }
})();

(function testWallDepletedReportsBreaking() {
  const flatBids = ladder(99.80, -0.01, -1, 0);
  const depthSnapshots = [];
  for (let i = 0; i < 60; i++) {
    // Wall present early (first third), nearly gone by the end -> low remaining liquidity ratio.
    const asks = i < 20 ? ladder(100.01, 0.01, 14, 120) : ladder(100.01, 0.01, 14, 5);
    depthSnapshots.push(snap(i * 500, 100.095, 100.105, asks, flatBids));
  }
  const trades = [];
  let tt = 0;
  for (let i = 0; i < 60; i++) { trades.push(trade(tt, 100.10, 8, 'buy')); tt += 500; }
  const ev = MexcCore.detectDensityAbsorption(depthSnapshots, trades, OPTS);
  assert(ev !== null, 'absorption with a mostly-depleted wall is detected');
  if (ev) assert(ev.state === 'BREAKING', 'a wall reduced to a small fraction of its original size is reported BREAKING, got ' + ev.state);
})();

(function testTinyVolumeOnBigCoinIsNotAnEvent() {
  // Wall exists, price is near it, but the "aggressive" trades are trivially small relative to the
  // book's own typical trade size at that level (the spec's "$10 on a $1M-volume coin" example).
  const wallAsks = ladder(100.01, 0.01, 14, 120);
  const flatBids = ladder(99.80, -0.01, -1, 0);
  const depthSnapshots = [];
  for (let i = 0; i < 60; i++) depthSnapshots.push(snap(i * 500, 100.095, 100.105, wallAsks, flatBids));
  const trades = [];
  let tt = 0;
  // Establish a "normal" trade size baseline of ~500 qty elsewhere in time, then only 2 tiny buys near the wall.
  for (let i = 0; i < 20; i++) { trades.push(trade(tt, 100.10, 500, 'buy')); tt += 500; }
  trades.push(trade(tt, 100.10, 0.5, 'buy')); tt += 500;
  trades.push(trade(tt, 100.10, 0.5, 'buy'));
  const ev = MexcCore.detectDensityAbsorption(depthSnapshots, trades, OPTS);
  assert(ev === null, 'trivially small aggressive volume relative to this level\'s typical trade size is not flagged as absorption');
})();

(function testNoWallNoAbsorption() {
  const flatAsks = ladder(100.01, 0.01, -1, 0);
  const flatBids = ladder(99.80, -0.01, -1, 0);
  const depthSnapshots = [];
  for (let i = 0; i < 60; i++) depthSnapshots.push(snap(i * 500, 99.99, 100.00, flatAsks, flatBids));
  const ev = MexcCore.detectDensityAbsorption(depthSnapshots, [], OPTS);
  assert(ev === null, 'no wall present -> nothing to absorb, no false positive');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
