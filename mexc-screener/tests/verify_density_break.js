// Synthetic-data tests for detectDensityBreak (core-utils.js) — Algorithm #1 of the "АЛГОРИТМЫ"
// rebuild. Unlike the old tick-only STRATEGY_DEFS.density heuristic, this reads the real order
// book: a wall found early in the snapshot window must measurably shrink by the end of the window,
// price must have actually crossed the level, and the shrink must be corroborated by executed
// trade volume in the breakout direction (distinguishing "eaten by trades" from "just pulled").
// Run: node tests/verify_density_break.js

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
const OPTS = { minSnapshots: 30, lookback: 60, minWallRatio: 5, minShrinkRatio: 0.5 };

function buildDepth(wallPresentUntilFrac, midStart, midEnd, n) {
  const wallAsks = ladder(100.01, 0.01, 14, 120); // wall at 100.15, 12x neighbors
  const flatAsks = ladder(100.01, 0.01, -1, 0);
  const flatBids = ladder(99.80, -0.01, -1, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const mid = midStart + (midEnd - midStart) * (i / (n - 1));
    const asks = i < n * wallPresentUntilFrac ? wallAsks : flatAsks;
    out.push(snap(i * 500, mid - 0.005, mid + 0.005, asks, flatBids));
  }
  return out;
}

(function testPlantedAskDensityBreak() {
  const depthSnapshots = buildDepth(1 / 3, 100.05, 100.25, 60);
  const trades = [];
  let tt = 0;
  for (let i = 0; i < 40; i++) { trades.push(trade(tt, 100.14 + (i % 3) * 0.01, 5, 'buy')); tt += 500; }
  for (let i = 0; i < 6; i++) { trades.push(trade(tt, 100.20 + i * 0.01, 3, 'buy')); tt += 500; } // continues up, no revert

  const ev = MexcCore.detectDensityBreak(depthSnapshots, trades, OPTS);
  assert(ev !== null, 'a genuine ask-wall shrink with confirming buy flow and price past the level IS detected');
  if (ev) {
    assert(ev.detectorKey === 'densityBreak', 'event carries the correct detectorKey');
    assert(ev.direction === 'LONG', 'ask wall break is reported LONG, got ' + ev.direction);
    assert(ev.side === 'ask', 'reports the correct side, got ' + ev.side);
    assert(ev.shrinkPct > 50, 'reports a large shrink percentage, got ' + ev.shrinkPct);
    assert(ev.confidencePct >= 0 && ev.confidencePct <= 100, 'confidence is a sane percentage, got ' + ev.confidencePct);
  }
})();

(function testWallRemovedWithoutFlowIsNotABreak() {
  const depthSnapshots = buildDepth(1 / 3, 100.05, 100.25, 60);
  const trades = [];
  let tt = 0;
  for (let i = 0; i < 30; i++) { trades.push(trade(tt, 105.00, 5, 'buy')); tt += 500; } // volume exists but nowhere near the wall price
  const ev = MexcCore.detectDensityBreak(depthSnapshots, trades, OPTS);
  assert(ev === null, 'a wall that vanished without confirming executed volume near the level is NOT flagged as a break');
})();

(function testNoWallNoBreak() {
  const flatAsks = ladder(100.01, 0.01, -1, 0);
  const flatBids = ladder(99.80, -0.01, -1, 0);
  const depthSnapshots = [];
  for (let i = 0; i < 60; i++) depthSnapshots.push(snap(i * 500, 99.99, 100.00, flatAsks, flatBids));
  const ev = MexcCore.detectDensityBreak(depthSnapshots, [], OPTS);
  assert(ev === null, 'no wall ever present -> nothing to break, no false positive');
})();

(function testPriceHasNotCrossedYetIsNotABreak() {
  // Wall shrinks the same way, but price stays BELOW the wall the whole time (never crosses).
  const depthSnapshots = buildDepth(1 / 3, 100.05, 100.10, 60);
  const trades = [];
  let tt = 0;
  for (let i = 0; i < 40; i++) { trades.push(trade(tt, 100.14, 5, 'buy')); tt += 500; }
  const ev = MexcCore.detectDensityBreak(depthSnapshots, trades, OPTS);
  assert(ev === null, 'wall shrank but price never actually crossed it -> not a break yet');
})();

(function testImmediateRevertIsNotABreak() {
  const depthSnapshots = buildDepth(1 / 3, 100.05, 100.25, 60);
  const trades = [];
  let tt = 0;
  for (let i = 0; i < 40; i++) { trades.push(trade(tt, 100.14 + (i % 3) * 0.01, 5, 'buy')); tt += 500; }
  for (let i = 0; i < 6; i++) { trades.push(trade(tt, 100.20 - i * 0.02, 3, 'sell')); tt += 500; } // reverts back down immediately
  const ev = MexcCore.detectDensityBreak(depthSnapshots, trades, OPTS);
  assert(ev === null, 'an immediate revert against the breakout direction is NOT flagged as a sustained break');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
