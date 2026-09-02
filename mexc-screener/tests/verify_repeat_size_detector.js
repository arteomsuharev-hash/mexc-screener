// Synthetic-data test for MexcCore.detectRepeatedTradeSizes — plants a genuine repeated-size
// cluster (must trigger) alongside a pure-noise control (must NOT trigger), per the plan's
// "synthetic + noise control" testing standard for every Tier-2 detector.
// Run: node tests/verify_repeat_size_detector.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

(function testWeakPlantedClusterIsDetectedButNotNecessarilyHighConfidence() {
  // A modest, borderline case (only just above minRepeats, loose tolerance usage) — should be
  // DETECTED (the raw pattern is real) even if its score doesn't clear the display cutoff, which is
  // a separate, intentionally stricter bar (ТЗ #8/#9: show ~5 genuinely interesting situations, not
  // every borderline blip).
  const trades = [];
  let t = 1000000;
  for (let i = 0; i < 8; i++) {
    const jitter = 1 + (((i * 13) % 9) - 4) / 100; // deterministic +-4%-ish jitter
    trades.push(trade(t, 100, 2 * jitter, i % 2 === 0 ? 'buy' : 'sell')); // price*qty ~ $200
    t += 3000;
  }
  [15, 4200, 88, 630].forEach(function (usd, idx) { trades.push(trade(t + idx * 500, 1, usd, 'buy')); });
  const ev = MexcCore.detectRepeatedTradeSizes(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  assert(ev !== null, 'a modest planted cluster of 8 similarly-sized trades (~$200) IS detected at all');
  if (ev) {
    assert(ev.repeatCount === 8, 'reports the correct repeat count (8), got ' + ev.repeatCount);
    assert(ev.sizeRangeUsd[0] >= 185 && ev.sizeRangeUsd[1] <= 215, 'reported size range brackets the planted ~$200 cluster, got ' + JSON.stringify(ev.sizeRangeUsd));
    assert(ev.confidencePct > 0 && ev.confidencePct <= 100, 'confidence is a sane percentage, got ' + ev.confidencePct);
    assert(ev.detectorKey === 'repeatSize', 'event carries the correct detectorKey');
  }
})();

(function testStrongPlantedClusterClearsDisplayCutoff() {
  // A clear, tight, well-populated pattern (12 repeats, ±2%) — this is the kind of thing the spec's
  // own worked examples describe ("Repetitions 8", "Confidence 91%") and MUST clear the >=55 display
  // cutoff, otherwise the whole "show only genuinely interesting patterns" mechanism is too strict
  // to ever surface anything.
  const trades = [];
  let t = 1000000;
  for (let i = 0; i < 12; i++) {
    const jitter = 1 + (((i * 7) % 5) - 2) / 100; // deterministic +-2%-ish jitter
    trades.push(trade(t, 100, 2 * jitter, i % 2 === 0 ? 'buy' : 'sell'));
    t += 3000;
  }
  [15, 4200, 88, 630].forEach(function (usd, idx) { trades.push(trade(t + idx * 500, 1, usd, 'buy')); });
  const ev = MexcCore.detectRepeatedTradeSizes(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  assert(ev !== null, 'a strong, tight, 12-repeat cluster is detected');
  if (ev) {
    assert(ev.repeatCount === 12, 'reports the correct repeat count (12), got ' + ev.repeatCount);
    assert(ev.confidencePct >= 55, 'a genuinely strong pattern clears the display cutoff (>=55), got ' + ev.confidencePct);
  }
})();

(function testPureNoiseDoesNotTrigger() {
  const trades = [];
  let t = 1000000;
  // Deterministic (not Math.random — a flaky test that only sometimes catches a false positive is
  // worse than useless) geometric progression with ratio 1.22, safely above the 15% tolerance: by
  // construction NO two values in this sequence can ever land within 15% of each other, so no
  // cluster of any size can form — this is a structurally guaranteed noise control, not a lucky draw.
  // A small +-3% jitter is layered on top (market noise isn't perfectly geometric) — still safely
  // below the margin needed to bridge a 22% gap under a 15% tolerance.
  let usd = 4;
  for (let i = 0; i < 40; i++) {
    const jitter = 1 + (((i * 37) % 7) - 3) / 100; // deterministic pseudo-jitter, +-3%, no Math.random
    trades.push(trade(t, 1, usd * jitter, i % 2 === 0 ? 'buy' : 'sell'));
    t += 1500;
    usd *= 1.22;
  }
  const ev = MexcCore.detectRepeatedTradeSizes(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  assert(ev === null, 'a trade tape with no genuine size cluster (each value >15% from every other) does NOT trigger a false positive');
})();

(function testDirectionReporting() {
  const trades = [];
  let t = 1000000;
  for (let i = 0; i < 10; i++) { trades.push(trade(t, 50, 4, 'buy')); t += 2000; } // all BUY, $200 each, >=10 total so the length gate passes
  const ev = MexcCore.detectRepeatedTradeSizes(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  assert(ev !== null && ev.direction === 'LONG', 'a cluster made entirely of BUY trades is reported as LONG direction, got ' + (ev && ev.direction));
})();

(function testBelowMinRepeatsDoesNotTrigger() {
  const trades = [];
  let t = 1000000;
  for (let i = 0; i < 4; i++) { trades.push(trade(t, 50, 4, 'buy')); t += 2000; } // only 4 repeats, minRepeats=5
  const ev = MexcCore.detectRepeatedTradeSizes(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  assert(ev === null, 'a cluster with fewer repeats than minRepeats does not trigger (4 < 5)');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
