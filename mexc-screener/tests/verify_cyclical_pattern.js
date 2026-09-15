// Synthetic-data tests for detectCyclicalPattern (core-utils.js) — Algorithm #12. Builds a
// per-symbol library of past CLOSED episodes (impulse -> pause -> move) and only fires once a
// current candidate matches enough of them (minObservations) with a real winrate — never on the
// very first occurrence, and never using an episode's own future (only outcomeMovePct entries
// filled in strictly after the fact by the caller, mimicking app.js's forward-only sweep).
// Run: node tests/verify_cyclical_pattern.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

// Builds a trade buffer ending in one clean impulse(+1.8%) -> pause -> move(+2.4%) episode.
function buildEpisode(baseT, basePrice, impulseSign) {
  const trades = [];
  let t = baseT, price = basePrice;
  for (let i = 0; i < 12; i++) { trades.push(trade(t, price, 2, 'buy')); t += 3000; } // filler so trades.length>=40 across full buffer
  const impulseStart = price;
  for (let i = 0; i < 10; i++) { price += impulseSign * (impulseStart * 0.018) / 10; trades.push(trade(t, price, 3, impulseSign > 0 ? 'buy' : 'sell')); t += 6000; }
  for (let i = 0; i < 8; i++) { trades.push(trade(t, price + (i % 2 === 0 ? 0.001 : -0.001), 1, i % 2 === 0 ? 'buy' : 'sell')); t += 7500; }
  const moveStart = price;
  for (let i = 0; i < 10; i++) { price += impulseSign * (moveStart * 0.024) / 10; trades.push(trade(t, price, 3, impulseSign > 0 ? 'buy' : 'sell')); t += 6000; }
  return { trades: trades, lastT: t, lastPrice: price };
}

const OPTS = { impulseWindowMs: 60000, pauseWindowMs: 60000, moveWindowMs: 60000, minObservations: 5, minWinrate: 0.55 };

(function testFirstEpisodeIsLoggedNotFired() {
  const ep = buildEpisode(0, 100, 1);
  const r = MexcCore.detectCyclicalPattern(ep.trades, [], OPTS);
  assert(r.event === null, 'the very first occurrence of a shape has no history to compare against -> no event');
  assert(r.library.length === 1, 'the closed-enough candidate is logged into the library for future comparison, got length ' + r.library.length);
  assert(r.library[0].outcomeMovePct == null, 'the newly logged episode has no outcome yet (filled in later by the caller, not here)');
})();

(function testEnoughHistoricalRepeatsWithGoodWinrateFires() {
  // Pre-populate a library of 6 past CLOSED episodes with a similar shape, 5 of which continued
  // in the same direction as their own move phase (a real winrate), before the candidate.
  const library = [];
  for (let i = 0; i < 6; i++) {
    library.push({ t: i * 1000, impulsePct: 0.018, movePct: 0.024, outcomeMovePct: (i < 5 ? 0.02 : -0.01) });
  }
  const ep = buildEpisode(10000000, 100, 1);
  const r = MexcCore.detectCyclicalPattern(ep.trades, library, OPTS);
  assert(r.event !== null, 'a candidate matching enough historical repeats with a good winrate IS detected');
  if (r.event) {
    assert(r.event.detectorKey === 'cyclicalPattern', 'event carries the correct detectorKey');
    assert(r.event.eventType === 'CYCLICAL_PATTERN', 'carries the correct eventType');
    assert(r.event.observedRepeats >= OPTS.minObservations, 'reports the real observed repeat count, got ' + r.event.observedRepeats);
    assert(r.event.direction === 'LONG', 'candidate move phase was positive -> LONG, got ' + r.event.direction);
  }
})();

(function testFewHistoricalRepeatsDoesNotFireYet() {
  const library = [
    { t: 1, impulsePct: 0.018, movePct: 0.024, outcomeMovePct: 0.02 },
    { t: 2, impulsePct: 0.018, movePct: 0.024, outcomeMovePct: 0.02 }
  ]; // only 2, below minObservations of 5
  const ep = buildEpisode(20000000, 100, 1);
  const r = MexcCore.detectCyclicalPattern(ep.trades, library, OPTS);
  assert(r.event === null, 'only 2 historical matches (below minObservations) -> not considered reliable yet, per spec');
})();

(function testOpenUnclosedEpisodesNeverCountAsMatches() {
  // A library entirely made of STILL-OPEN episodes (outcomeMovePct null) must never be usable as
  // evidence, no matter how many there are — using them would be look-ahead on their own future.
  const library = [];
  for (let i = 0; i < 8; i++) library.push({ t: i * 1000, impulsePct: 0.018, movePct: 0.024, outcomeMovePct: null });
  const ep = buildEpisode(30000000, 100, 1);
  const r = MexcCore.detectCyclicalPattern(ep.trades, library, OPTS);
  assert(r.event === null, 'a library of only still-open episodes contributes zero closed matches -> no event');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
