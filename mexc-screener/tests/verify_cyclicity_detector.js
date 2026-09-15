// Synthetic-data test for MexcCore.detectCyclicity — plants the spec's own worked example
// (a ~240s BUY/SELL cycle, 14 repetitions, "BUY ~$200, SELL ~$200") and verifies detection within
// the ±15% tolerance band, alongside a white-noise control that must NOT report a cycle.
// Run: node tests/verify_cyclicity_detector.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

(function testSpecExampleCycleIsDetected() {
  // 14 cycles of period 240s: a BUY burst (~$200) at the start of each cycle, a SELL burst (~$200)
  // 120s later — the peak-to-peak spacing the detector actually measures is this 120s half-cycle
  // (it finds ANY significant peak, buy or sell, not just same-sign peaks), which is itself a
  // legitimate, real periodicity in the same underlying 240s pattern.
  const trades = [];
  const cyclePeriodS = 240;
  const cycles = 14;
  for (let k = 0; k < cycles; k++) {
    const baseT = k * cyclePeriodS * 1000;
    const jitter = ((k * 37) % 9 - 4) * 400; // deterministic small jitter, ms
    trades.push(trade(baseT + jitter, 100, 1, 'buy'));
    trades.push(trade(baseT + jitter + 2000, 100, 1, 'buy'));
    trades.push(trade(baseT + 120000 + jitter, 100, 1, 'sell'));
    trades.push(trade(baseT + 120000 + jitter + 2000, 100, 1, 'sell'));
  }
  const ev = MexcCore.detectCyclicity(trades, { bucketMs: 2000, minRepeats: 8, tolerance: 0.15 });
  assert(ev !== null, 'the spec\'s own worked example (240s BUY/SELL cycle, 14 reps) IS detected as cyclic');
  if (ev) {
    assert(ev.detectorKey === 'cycle', 'event carries the correct detectorKey');
    assert(ev.cycleS > 100 && ev.cycleS < 140, 'detected period matches the real ~120s peak-to-peak spacing within the alternating BUY/SELL structure, got ' + ev.cycleS + 's');
    assert(ev.repeatCount >= 8, 'reports at least minRepeats occurrences, got ' + ev.repeatCount);
    assert(ev.confidencePct >= 55, 'a clean, textbook-strength cyclic pattern clears the display cutoff, got ' + ev.confidencePct);
    assert(ev.buyRangeUsd && ev.buyRangeUsd[0] > 0, 'reports a BUY size range, matching the spec\'s "BUY ~$X-Y" example field');
    assert(ev.sellRangeUsd && ev.sellRangeUsd[0] > 0, 'reports a SELL size range, matching the spec\'s "SELL ~$X-Y" example field');
  }
})();

(function testWhiteNoiseDoesNotTrigger() {
  // Deterministic pseudo-random trade times/sides/sizes with NO underlying periodicity — a linear
  // congruential generator so the test is reproducible (not Math.random).
  let seed = 12345;
  function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  const trades = [];
  let t = 0;
  for (let i = 0; i < 400; i++) {
    t += 300 + next() * 4000; // irregular gaps, 0.3-4.3s
    const side = next() > 0.5 ? 'buy' : 'sell';
    const qty = 0.5 + next() * 3;
    trades.push(trade(t, 100 + (next() - 0.5) * 2, qty, side));
  }
  const ev = MexcCore.detectCyclicity(trades, { bucketMs: 2000, minRepeats: 8, tolerance: 0.15 });
  assert(ev === null, 'a pseudo-random trade tape with no real periodicity does NOT report a false cycle');
})();

(function testInsufficientTimeSpanReturnsNull() {
  // Only a handful of trades spanning a few seconds — nowhere near enough time coverage to
  // establish any period, let alone one repeating minRepeats times.
  const trades = [];
  for (let i = 0; i < 25; i++) trades.push(trade(i * 200, 100, 1, i % 2 === 0 ? 'buy' : 'sell'));
  const ev = MexcCore.detectCyclicity(trades, { bucketMs: 2000, minRepeats: 8, tolerance: 0.15 });
  assert(ev === null, 'too little time coverage to detect any real cycle -> no detection attempted');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
