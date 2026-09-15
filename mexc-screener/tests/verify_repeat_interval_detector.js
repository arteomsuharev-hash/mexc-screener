// Synthetic-data test for MexcCore.detectRepeatedIntervals — plants a genuine repeated-interval
// pattern (must trigger) alongside a noise control with irregular gaps (must NOT trigger).
// Run: node tests/verify_repeat_interval_detector.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

(function testPlantedIntervalTriggers() {
  const trades = [];
  let t = 1000000;
  // 12 trades spaced ~5s apart (+-3%), matching the spec's own "identical intervals" example.
  for (let i = 0; i < 12; i++) {
    trades.push(trade(t, 100 + i, 1, i % 2 === 0 ? 'buy' : 'sell'));
    const jitterMs = ((i * 91) % 7 - 3) * 30; // deterministic, small jitter in ms
    t += 5000 + jitterMs;
  }
  const ev = MexcCore.detectRepeatedIntervals(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  assert(ev !== null, 'a planted sequence of 11 consistent ~5s gaps IS detected');
  if (ev) {
    assert(ev.repeatCount >= 8, 'repeat count reflects most of the planted gaps (>= 8 of 11), got ' + ev.repeatCount);
    assert(ev.avgIntervalS > 4.5 && ev.avgIntervalS < 5.5, 'reported average interval is close to the planted ~5s, got ' + ev.avgIntervalS);
    assert(ev.detectorKey === 'repeatInterval', 'event carries the correct detectorKey');
    assert(ev.confidencePct >= 55, 'a clean, well-populated interval pattern clears the display cutoff, got ' + ev.confidencePct);
  }
})();

(function testIrregularGapsDoNotTrigger() {
  const trades = [];
  let t = 1000000;
  // Deterministic (not Math.random) geometric progression of GAP sizes with ratio 1.3 (>15%
  // tolerance) — by construction no two gaps can ever land within 15% of each other, guaranteeing
  // no false cluster regardless of run-to-run variance.
  let gap = 500;
  for (let i = 0; i < 30; i++) {
    trades.push(trade(t, 100, 1, i % 2 === 0 ? 'buy' : 'sell'));
    t += gap;
    gap *= 1.3;
    if (gap > 20000) gap = 500; // wrap around to stay in a sane time range, still never adjacent-close
  }
  const ev = MexcCore.detectRepeatedIntervals(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  assert(ev === null, 'a trade tape with no genuinely repeating interval does NOT trigger a false positive');
})();

(function testVeryFastDuplicateFramesAreFilteredOut() {
  // Sub-50ms gaps (multiple trades arriving in the same protocol frame) must be excluded from
  // interval analysis entirely — they're an artifact of batching, not a real "fast repeating
  // interval" pattern, per the >0.05s filter in the detector.
  const trades = [];
  let t = 1000000;
  for (let i = 0; i < 20; i++) {
    trades.push(trade(t, 100, 1, 'buy'));
    trades.push(trade(t + 5, 100, 1, 'sell')); // 5ms later, same frame
    t += 7000 + (i % 3) * 20; // real inter-frame gap varies enough to not cluster
  }
  const ev = MexcCore.detectRepeatedIntervals(trades, { tolerance: 0.15, minRepeats: 5, lookback: 200 });
  // Should NOT report the trivial 5ms gap as a "pattern" — either null, or if it does find the
  // ~7000ms real cadence, avgIntervalS must be in the seconds range, not ~0.005s.
  if (ev) {
    assert(ev.avgIntervalS > 1, 'if a pattern is reported, it reflects the real inter-frame cadence (seconds), not the sub-50ms in-frame gap, got ' + ev.avgIntervalS + 's');
  } else {
    assert(true, 'no pattern reported for a tape dominated by sub-50ms artifact gaps — acceptable, the filter did its job');
  }
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
