// Synthetic-data test for MexcCore.detectRepeatingSequence — plants a genuine repeating BUY/SELL
// sub-sequence (must trigger) alongside a random-noise control (must NOT trigger). The noise
// control matters especially here: with only a 2-symbol alphabet (B/S), short sequences can recur
// by pure chance, so the significance gate is the actual thing under test, not just detection.
// Run: node tests/verify_sequence_detector.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

(function testPlantedSequenceTriggers() {
  // "BBSS" repeated 12 times cleanly — a textbook repeating sequence like density->absorption-style
  // alternation, not a homogeneous run.
  const trades = [];
  let t = 0;
  for (let k = 0; k < 12; k++) {
    ['B', 'B', 'S', 'S'].forEach(function (s) { trades.push(trade(t, 100, 1, s === 'B' ? 'buy' : 'sell')); t += 1000; });
  }
  const ev = MexcCore.detectRepeatingSequence(trades, { minLen: 3, maxLen: 6, minRepeats: 5 });
  assert(ev !== null, 'a genuine planted repeating BUY/SELL sub-sequence ("BBSS" x12) IS detected');
  if (ev) {
    assert(ev.detectorKey === 'sequence', 'event carries the correct detectorKey');
    assert(ev.repeatCount >= 5, 'reports at least minRepeats non-overlapping occurrences, got ' + ev.repeatCount);
    assert(/^[BS]+$/.test(ev.sequencePattern), 'reported pattern is composed only of B/S symbols, got ' + ev.sequencePattern);
    assert(!/^B+$/.test(ev.sequencePattern) && !/^S+$/.test(ev.sequencePattern), 'reported pattern is NOT a homogeneous run (that would be burstNoFollow/ineff\'s job, not sequence\'s), got ' + ev.sequencePattern);
    assert(ev.confidencePct >= 55, 'a clean, strongly-repeating sequence clears the display cutoff, got ' + ev.confidencePct);
  }
})();

(function testRandomNoiseDoesNotTrigger() {
  // Deterministic pseudo-random B/S sequence (LCG, not Math.random, for reproducibility). This is
  // the critical case for this detector: with only 2 symbols, short substrings recur by pure chance
  // reasonably often — the significance gate (observed vs expected-under-random-with-same-B/S-ratio)
  // must reject this, not just a raw "count >= minRepeats" check.
  let seed = 42;
  function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  const trades = [];
  let t = 0;
  for (let i = 0; i < 300; i++) {
    trades.push(trade(t, 100, 1, next() > 0.5 ? 'buy' : 'sell'));
    t += 1000;
  }
  const ev = MexcCore.detectRepeatingSequence(trades, { minLen: 3, maxLen: 6, minRepeats: 5 });
  assert(ev === null, 'a pseudo-random B/S tape with a genuinely 50/50 balance does NOT trigger a false positive despite short substrings recurring by chance');
})();

(function testSkewedButNonRepeatingNoiseDoesNotTrigger() {
  // A DIFFERENT noise shape: skewed 70/30 buy/sell ratio (still no real repeating structure) — the
  // detector's significance model compares against the OBSERVED B/S ratio, not an assumed 50/50, so
  // this must not be mistaken for "significant" just because BUY substrings are common overall.
  let seed = 999;
  function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  const trades = [];
  let t = 0;
  for (let i = 0; i < 300; i++) {
    trades.push(trade(t, 100, 1, next() > 0.3 ? 'buy' : 'sell')); // ~70% buy
    t += 1000;
  }
  const ev = MexcCore.detectRepeatingSequence(trades, { minLen: 3, maxLen: 6, minRepeats: 5 });
  assert(ev === null, 'a skewed-but-still-random 70/30 buy/sell tape does not trigger a false positive');
})();

(function testHomogeneousRunAloneDoesNotQualify() {
  // A long, pure "all BUY" run has no real B/S sequence structure — that's a different detector's
  // job (burstNoFollow/ineff), not this one.
  const trades = [];
  let t = 0;
  for (let i = 0; i < 60; i++) { trades.push(trade(t, 100, 1, 'buy')); t += 1000; }
  const ev = MexcCore.detectRepeatingSequence(trades, { minLen: 3, maxLen: 6, minRepeats: 5 });
  assert(ev === null, 'a purely homogeneous BUY run (no alternation at all) is explicitly excluded, not reported as a "sequence"');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
