// Synthetic-data tests for detectPossibleHiddenAbsorption (core-utils.js) — Algorithm #14. Never
// claims "ICEBERG FOUND" (spec's explicit requirement) — only POSSIBLE_HIDDEN_ABSORPTION, and only
// after the SAME level has been depleted-then-replenished multiple times (real state across
// calls, {event, state} contract like #6/#10) while price never actually breaks through it, and
// executed volume through the level far exceeds what was ever visible.
// Run: node tests/verify_possible_hidden_absorption.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function snap(t, bestBid, bestAsk, bidQty) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, bids: [{ p: bestBid, q: bidQty }], asks: [{ p: bestAsk, q: 50 }] };
}
function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
const OPTS = { minReplenishments: 2, executedOverVisibleRatio: 3 };

(function testRepeatedDepletionAndReplenishmentFiresPossibleHiddenAbsorption() {
  let state = {};
  let t = 0;
  const trades = [];
  // Cycle 1: seed the tracked bid level.
  let r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 100)], trades, OPTS, state);
  state = r.state;
  assert(r.event === null, 'first sighting of the level is just seeded into state, no event yet');

  // Two full deplete -> replenish cycles, each with heavy sell-side aggressive trades through the
  // bid (executed volume >> the visible 100-qty level), price never actually breaking below it.
  for (let cycle = 0; cycle < 2; cycle++) {
    t += 2000;
    for (let i = 0; i < 8; i++) { trades.push(trade(t, 100.00, 20, 'sell')); t += 200; }
    r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 15)], trades, OPTS, state); // depleted to 15% of initial
    state = r.state;
    t += 2000;
    r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 95)], trades, OPTS, state); // replenished back near initial
    state = r.state;
  }
  assert(state.tracked.replenishments >= 2, 'replenishment_count accumulated across the two cycles, got ' + state.tracked.replenishments);
  assert(r.event !== null, 'repeated replenishment + executed volume far exceeding visible depth -> POSSIBLE_HIDDEN_ABSORPTION');
  if (r.event) {
    assert(r.event.detectorKey === 'possibleHiddenAbsorption', 'event carries the correct detectorKey');
    assert(r.event.eventType === 'POSSIBLE_HIDDEN_ABSORPTION', 'never claims a confirmed iceberg, only POSSIBLE_HIDDEN_ABSORPTION, got ' + r.event.eventType);
    assert(r.event.isHeuristic === true, 'flagged as a heuristic (no direct proof possible from public book), per spec');
    assert(r.event.confidencePct <= r.event.maxConfidence, 'confidence respects the honest heuristic cap, got ' + r.event.confidencePct + ' vs cap ' + r.event.maxConfidence);
    assert(r.event.direction === 'LONG', 'bid-side absorption is reported LONG, got ' + r.event.direction);
  }
})();

(function testPriceBreakingTheLevelClearsTrackingInsteadOfFiring() {
  let state = {};
  let t = 0;
  let r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 100)], [], OPTS, state);
  state = r.state;
  t += 2000;
  r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 10)], [], OPTS, state);
  state = r.state;
  t += 2000;
  // Price actually breaks below the tracked bid level -> this is a real break, not absorption.
  r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 99.80, 99.90, 10)], [], OPTS, state);
  assert(r.event === null, 'once price actually breaks through the level, it is a real breakout, not hidden absorption');
  assert(r.state.tracked === null, 'tracking resets after a genuine break, not carried over as a false absorption count');
})();

(function testFewReplenishmentsDoesNotFireYet() {
  let state = {};
  let t = 0;
  let r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 100)], [], OPTS, state);
  state = r.state;
  const trades = [];
  t += 2000;
  for (let i = 0; i < 5; i++) { trades.push(trade(t, 100.00, 20, 'sell')); t += 200; }
  r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 15)], trades, OPTS, state);
  state = r.state;
  t += 2000;
  r = MexcCore.detectPossibleHiddenAbsorption([snap(t, 100.00, 100.10, 95)], trades, OPTS, state); // only ONE replenishment so far
  assert(r.event === null, 'a single replenishment (below minReplenishments) does not fire yet');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
