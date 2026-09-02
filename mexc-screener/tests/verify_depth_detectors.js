// Synthetic-data tests for the 5 depth-buffer detectors added in Phase 5: imbalance, absorption,
// fakeLiquidity, exhaustion, zoneReturn. Each has a planted-signal case and a noise/cross-check
// control. No network/DOM — pure functions of (depthSnapshots, trades, opts).
// Run: node tests/verify_depth_detectors.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
function depthSnap(t, bestBid, bestAsk, bidQty, askQty) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, bidVol: bidQty * bestBid, askVol: askQty * bestAsk, bids: [{ p: bestBid, q: bidQty }], asks: [{ p: bestAsk, q: askQty }] };
}

// ---------------------------------------------------------------- imbalance
(function testImbalance() {
  // detectImbalance compares the CURRENT ratio against this coin's OWN recent history (z-score) —
  // it detects a SHIFT into imbalance, not just "the book happens to be imbalanced" in isolation
  // (that distinction matters: a coin that's always mildly bid-leaning isn't "an imbalance event"
  // every single tick). So the planted case needs a calm baseline period followed by a genuine
  // shift into a heavily skewed book, not uniform skew throughout.
  const snaps = [];
  let t = 0;
  for (let i = 0; i < 18; i++) { // calm baseline: roughly balanced book
    snaps.push(depthSnap(t, 100, 100.1, 45 + (((i * 7) % 5) - 2), 45 + (((i * 11) % 5) - 2)));
    t += 500;
  }
  for (let i = 0; i < 7; i++) { // shift: book becomes heavily bid-skewed
    snaps.push(depthSnap(t, 100, 100.1, 80 + (((i * 7) % 5) - 2), 15 + (((i * 11) % 5) - 2)));
    t += 500;
  }
  const ev = MexcCore.detectImbalance(snaps, { minSnapshots: 20, minZ: 2.5 });
  assert(ev !== null, 'imbalance: a shift from a balanced book into a heavily bid-skewed one IS detected');
  if (ev) {
    assert(ev.direction === 'LONG', 'imbalance: bid-heavy book is reported LONG, got ' + ev.direction);
    assert(ev.confidencePct >= 55, 'imbalance: strong persistent imbalance clears the display cutoff, got ' + ev.confidencePct);
  }

  let seed = 11;
  function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  const noise = [];
  let tn = 0;
  for (let i = 0; i < 25; i++) { noise.push(depthSnap(tn, 100, 100.1, 10 + next() * 80, 10 + next() * 80)); tn += 500; }
  const evNoise = MexcCore.detectImbalance(noise, { minSnapshots: 20, minZ: 2.5 });
  assert(evNoise === null, 'imbalance: a book with no persistent bid/ask bias does not trigger a false positive');
})();

// ---------------------------------------------------------------- absorption / fakeLiquidity
(function testAbsorptionVsFakeLiquidity() {
  const snaps = [];
  let t = 0;
  for (let i = 0; i < 25; i++) { snaps.push(depthSnap(t, 100, 100.1, Math.max(100 - i * 3.2, 20), 50)); t += 500; }

  const executedTrades = [];
  let te = 0;
  for (let i = 0; i < 20; i++) { executedTrades.push(trade(te, 100, 4, 'sell')); te += 600; } // ~80 qty executed AT the level

  const cancelledTrades = [];
  let tc = 0;
  for (let i = 0; i < 20; i++) { cancelledTrades.push(trade(tc, 105, 4, 'sell')); tc += 600; } // trading happens elsewhere, level just vanishes

  const absorptionEv = MexcCore.detectAbsorption(snaps, executedTrades, { minSnapshots: 20 });
  assert(absorptionEv !== null, 'absorption: shrinking bid level WITH matching executed volume at that price IS detected');
  if (absorptionEv) assert(absorptionEv.direction === 'LONG', 'absorption: a shrinking BID level (support being absorbed) is reported LONG, got ' + absorptionEv.direction);

  const absorptionFalseEv = MexcCore.detectAbsorption(snaps, cancelledTrades, { minSnapshots: 20 });
  assert(absorptionFalseEv === null, 'absorption: shrinking level WITHOUT matching executed volume does NOT count as absorption (that\'s the fakeLiquidity case instead)');

  const fakeEv = MexcCore.detectFakeLiquidity(snaps, cancelledTrades, { minSnapshots: 20 });
  assert(fakeEv !== null, 'fakeLiquidity: shrinking level with NO matching executed volume IS flagged as the heuristic');
  if (fakeEv) {
    assert(fakeEv.isHeuristic === true, 'fakeLiquidity: result is explicitly marked isHeuristic (never asserted as confirmed fact)');
    assert(fakeEv.confidencePct <= 60, 'fakeLiquidity: confidence is hard-capped (no ground truth available), got ' + fakeEv.confidencePct);
  }

  const fakeFalseEv = MexcCore.detectFakeLiquidity(snaps, executedTrades, { minSnapshots: 20 });
  assert(fakeFalseEv === null, 'fakeLiquidity: a level that WAS genuinely executed against is correctly NOT flagged as "fake" (that\'s real absorption instead)');
})();

// ---------------------------------------------------------------- exhaustion
(function testExhaustion() {
  const trades = [];
  let t = 0;
  for (let b = 0; b < 3; b++) { for (let i = 0; i < 3; i++) { trades.push(trade(t, 100, 1, 'buy')); t += 1000; } t = (b + 1) * 10000; }
  t = 3 * 10000;
  for (let i = 0; i < 15; i++) { trades.push(trade(t, 100, 3, 'buy')); t += 500; } // peak bucket
  const declineCounts = [10, 7, 4, 2];
  for (let b = 0; b < declineCounts.length; b++) {
    t = (4 + b) * 10000;
    for (let i = 0; i < declineCounts[b]; i++) { trades.push(trade(t, 100, 3, 'buy')); t += 500; }
  }
  const ev = MexcCore.detectExhaustion(trades, { bucketMs: 10000, minRepeats: 3 });
  assert(ev !== null, 'exhaustion: a peak bucket followed by monotonically declining volume IS detected');
  if (ev) assert(ev.volumeDeclinePct > 50, 'exhaustion: reports a substantial volume decline from peak, got ' + ev.volumeDeclinePct + '%');

  const trades2 = [];
  let t2 = 0;
  for (let b = 0; b < 8; b++) { for (let i = 0; i < 5 + b; i++) { trades2.push(trade(t2, 100, 2, 'buy')); t2 += 800; } t2 = (b + 1) * 10000; }
  const ev2 = MexcCore.detectExhaustion(trades2, { bucketMs: 10000, minRepeats: 3 });
  assert(ev2 === null, 'exhaustion: steadily GROWING volume (the opposite pattern) does not trigger');
})();

// ---------------------------------------------------------------- zoneReturn
(function testZoneReturn() {
  const trades = [];
  let t = 0;
  for (let cycle = 0; cycle < 8; cycle++) {
    trades.push(trade(t, 103, 1, 'sell')); t += 1000;
    trades.push(trade(t, 101.5, 1, 'sell')); t += 1000;
    trades.push(trade(t, 100.1, 1, 'sell')); t += 1000;
    trades.push(trade(t, 100.0, 1, 'sell')); t += 1000;
    trades.push(trade(t, 100.2, 1, 'buy')); t += 1000;
    trades.push(trade(t, 102, 1, 'buy')); t += 1000;
    trades.push(trade(t, 104, 1, 'buy')); t += 1000;
  }
  const ev = MexcCore.detectZoneReturn(trades, { tolerance: 0.005, minRepeats: 5 });
  assert(ev !== null, 'zoneReturn: a price zone touched 8 times with a consistent bounce reaction IS detected');
  if (ev) {
    assert(ev.direction === 'LONG', 'zoneReturn: a support zone (local min) that bounces up is reported LONG, got ' + ev.direction);
    assert(ev.repeatCount >= 5, 'zoneReturn: reports at least minRepeats touches, got ' + ev.repeatCount);
    assert(ev.confidencePct >= 55, 'zoneReturn: a clean repeated zone clears the display cutoff, got ' + ev.confidencePct);
  }

  const trend = [];
  let tt = 0, pt = 100;
  for (let i = 0; i < 60; i++) { pt += 0.3; trend.push(trade(tt, pt, 1, 'buy')); tt += 1000; }
  const evTrend = MexcCore.detectZoneReturn(trend, { tolerance: 0.005, minRepeats: 5 });
  assert(evTrend === null, 'zoneReturn: a pure one-directional trend (no zone ever revisited) does not trigger');

  let falsePositives = 0;
  for (let seedBase = 1; seedBase <= 40; seedBase++) {
    let seed = seedBase * 331;
    function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    const noise = [];
    let tn = 0, pn = 100;
    for (let i = 0; i < 80; i++) { pn *= (1 + (next() - 0.5) * 0.01); noise.push(trade(tn, pn, 1, next() > 0.5 ? 'buy' : 'sell')); tn += 1000; }
    if (MexcCore.detectZoneReturn(noise, { tolerance: 0.005, minRepeats: 5 })) falsePositives++;
  }
  assert(falsePositives === 0, 'zoneReturn: a random-walk price series produces ZERO false positives across 40 seeds, got ' + falsePositives + '/40');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
