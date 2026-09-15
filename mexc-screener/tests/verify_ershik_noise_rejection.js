// THE critical test for MexcCore.detectErshik, per the spec's own explicit requirement #5:
// "ёршик" (structured chaotic BUY/SELL alternation) must NOT be confused with ordinary market
// noise, which also alternates direction often. This is not "does the detector fire on
// alternation" — it's "does the detector distinguish STRUCTURED alternation (clustered sizes,
// regular intervals, contained price) from PURELY RANDOM alternation of the exact same raw
// flip-frequency/run-length". That distinction is the actual deliverable.
// Run: node tests/verify_ershik_noise_rejection.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

(function testStructuredAlternationTriggers() {
  // Clean alternation: similar sizes (clustered), similar intervals (clustered), price barely moves.
  // Satisfies all 3 structure signals, comfortably clears the >=2-of-3 gate.
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < 12; i++) {
    const jitter = 1 + (((i * 13) % 7) - 3) / 100;
    price += (i % 2 === 0 ? 1 : -1) * 0.02;
    trades.push(trade(t, price, 2 * jitter, i % 2 === 0 ? 'buy' : 'sell'));
    t += 2000 + (((i * 7) % 5) - 2) * 50;
  }
  const ev = MexcCore.detectErshik(trades, { tolerance: 0.2, minRepeats: 8 });
  assert(ev !== null, 'genuinely structured alternation (clustered sizes + regular intervals + contained price) IS detected');
  if (ev) {
    assert(ev.detectorKey === 'ershik', 'event carries the correct detectorKey');
    assert(ev.repeatCount >= 8, 'reports at least minRepeats alternating trades, got ' + ev.repeatCount);
    assert(ev.structureSignals >= 2, 'reports at least 2 confirmed structure signals, got ' + ev.structureSignals);
    assert(ev.confidencePct >= 55, 'a clean, fully-structured alternation clears the display cutoff, got ' + ev.confidencePct);
  }
})();

(function testPureRandomAlternationOfSameRunLengthDoesNotTrigger() {
  // THE core assertion: build an alternation run of the EXACT SAME LENGTH (12 flips) as the
  // structured case above, so raw "how much does it alternate" is identical — but sizes, intervals,
  // and price moves are all genuinely random (no clustering, no regularity, no containment). Run
  // across 20 different seeds because a single random draw proves nothing; the gate must hold
  // consistently, not just get lucky once.
  let falsePositives = 0;
  const details = [];
  for (let seedBase = 1; seedBase <= 20; seedBase++) {
    let seed = seedBase * 773;
    function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    const trades = [];
    let t = 0, p = 100;
    for (let i = 0; i < 12; i++) {
      p *= (1 + (next() - 0.5) * 0.05); // large, unstructured price swings
      trades.push(trade(t, p, 0.5 + next() * 20, i % 2 === 0 ? 'buy' : 'sell')); // random size 0.5-20.5x
      t += 200 + next() * 15000; // random interval 0.2-15.2s
    }
    const ev = MexcCore.detectErshik(trades, { tolerance: 0.2, minRepeats: 8 });
    if (ev) { falsePositives++; details.push('seed ' + seedBase + ': ' + JSON.stringify(ev)); }
  }
  assert(falsePositives === 0, 'pure random alternation (identical 12-flip run length, zero structure) is REJECTED across all 20 seeds, got ' + falsePositives + '/20 false positives' + (details.length ? ' — ' + details[0] : ''));
})();

(function testOnlyOneStructureSignalIsNotEnough() {
  // Deliberately construct a run with EXACTLY ONE structure signal (clustered sizes) but random
  // intervals AND large uncontained price moves — must still be rejected, since the spec requires
  // >=2 of 3, not >=1.
  const trades = [];
  let seed = 55;
  function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  let t = 0, p = 100;
  for (let i = 0; i < 12; i++) {
    p *= (1 + (next() - 0.5) * 0.06); // large random price moves -> NOT contained
    trades.push(trade(t, p, 2 + (((i * 13) % 7) - 3) / 100, i % 2 === 0 ? 'buy' : 'sell')); // clustered size ~2 (ONE signal)
    t += 200 + next() * 15000; // random interval -> NOT regular
  }
  const ev = MexcCore.detectErshik(trades, { tolerance: 0.2, minRepeats: 8 });
  assert(ev === null, 'only 1 of 3 structure signals (clustered size alone) is explicitly NOT sufficient — the spec requires >=2');
})();

(function testShortAlternationBelowMinRepeatsDoesNotTrigger() {
  const trades = [];
  let t = 0;
  for (let i = 0; i < 6; i++) { trades.push(trade(t, 100, 2, i % 2 === 0 ? 'buy' : 'sell')); t += 2000; } // only 6 < minRepeats=8
  const ev = MexcCore.detectErshik(trades, { tolerance: 0.2, minRepeats: 8 });
  assert(ev === null, 'an alternating run shorter than minRepeats does not trigger, regardless of structure');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
