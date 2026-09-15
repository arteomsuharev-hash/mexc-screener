// Synthetic-data test for MexcCore.detectLadder — plants a genuine monotonic "ladder" price run
// (must trigger) alongside a random-walk noise control (must NOT trigger). The noise control is run
// across many seeds, since a random walk CAN occasionally produce a long run by chance — the
// log2(N)-based significance gate is specifically what's supposed to filter that out, not luck.
// Run: node tests/verify_ladder_detector.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

(function testPlantedLadderUpTriggers() {
  let price = 100;
  const trades = [];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    price *= 1.0015; // ~0.15% per step, consistent
    trades.push(trade(t, price, 1, 'buy'));
    t += 2000;
  }
  const ev = MexcCore.detectLadder(trades, { tolerance: 0.3, minRepeats: 8 });
  assert(ev !== null, 'a planted 10-step monotonic ladder (consistent ~0.15% steps) IS detected');
  if (ev) {
    assert(ev.detectorKey === 'ladder', 'event carries the correct detectorKey');
    assert(ev.direction === 'LONG', 'a rising ladder is reported as LONG, got ' + ev.direction);
    assert(ev.repeatCount >= 8, 'reports at least minRepeats steps, got ' + ev.repeatCount);
    assert(ev.avgStepPct > 0.1 && ev.avgStepPct < 0.2, 'reports the correct average step size (~0.15%), got ' + ev.avgStepPct + '%');
    assert(ev.confidencePct >= 55, 'a clean, textbook ladder clears the display cutoff, got ' + ev.confidencePct);
  }
})();

(function testPlantedLadderDownIsShort() {
  let price = 100;
  const trades = [];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    price *= 0.9985;
    trades.push(trade(t, price, 1, 'sell'));
    t += 2000;
  }
  const ev = MexcCore.detectLadder(trades, { tolerance: 0.3, minRepeats: 8 });
  assert(ev !== null && ev.direction === 'SHORT', 'a falling ladder is detected and reported as SHORT, got ' + (ev && ev.direction));
})();

(function testRandomWalkNoiseDoesNotTrigger() {
  // Run across 20 different deterministic seeds (LCG) — a random walk CAN occasionally produce a
  // long monotonic run purely by chance, so testing one seed would be a weak, potentially flaky
  // guarantee. The significance gate (run length vs the classical expected-longest-run-in-N-random-
  // steps baseline, ~log2(N)) is what's actually supposed to filter this out consistently.
  let falsePositives = 0;
  for (let seedBase = 1; seedBase <= 20; seedBase++) {
    let seed = seedBase * 991;
    function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    let p = 100;
    const trades = [];
    let t = 0;
    for (let i = 0; i < 200; i++) {
      p *= (1 + (next() - 0.5) * 0.004);
      trades.push(trade(t, p, 1, 'buy'));
      t += 2000;
    }
    const ev = MexcCore.detectLadder(trades, { tolerance: 0.3, minRepeats: 8 });
    if (ev) falsePositives++;
  }
  assert(falsePositives === 0, 'a random-walk price series produces ZERO false-positive ladders across 20 different seeds, got ' + falsePositives + '/20');
})();

(function testChoppyNonMonotonicStepsDoNotTrigger() {
  // Steps alternate up/down every trade — never a genuine monotonic run of any real length.
  const trades = [];
  let price = 100;
  let t = 0;
  for (let i = 0; i < 60; i++) {
    price *= (i % 2 === 0) ? 1.002 : 0.998;
    trades.push(trade(t, price, 1, i % 2 === 0 ? 'buy' : 'sell'));
    t += 2000;
  }
  const ev = MexcCore.detectLadder(trades, { tolerance: 0.3, minRepeats: 8 });
  assert(ev === null, 'a choppy up-down-up-down price series (never a real monotonic run) does not trigger a ladder');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
