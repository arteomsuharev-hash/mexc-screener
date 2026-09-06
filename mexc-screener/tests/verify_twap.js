// Synthetic-data tests for detectTwap (core-utils.js) — Algorithm #17. A real TWAP order slices
// volume into similarly-sized pieces at similarly-spaced intervals, predominantly on one side —
// combines the existing repeatSize/repeatInterval ideas with a side-consistency and duration
// requirement. {event, state} contract: reports TWAP_ACTIVE once when the pattern starts, then
// stays quiet while it continues, then reports TWAP_STOPPED once when it genuinely stops — never
// silently dropping the end of the episode.
// Run: node tests/verify_twap.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

function buildTwapSlices(startT, count, side) {
  const trades = [];
  let t = startT, price = 100;
  for (let i = 0; i < count; i++) {
    price += side === 'buy' ? 0.01 : -0.01;
    trades.push(trade(t, price, 10 + (i % 2 === 0 ? 0.3 : -0.3), side));
    t += 10000; // ~10s между слайсами, стабильно
  }
  return { trades: trades, lastT: t };
}

const OPTS = { windowMs: 120000, minRepeats: 6, sizeTolerance: 0.3, intervalTolerance: 0.35, minSideRatio: 0.75, graceMs: 60000 };

(function testTwapStartIsDetectedOnce() {
  // Old, unrelated two-sided noise, well outside the detector's own 120s lookback window by the
  // time the TWAP run ends — must not contaminate the side-ratio/size/interval checks below.
  const noise = [];
  let t = 0;
  for (let i = 0; i < 20; i++) { noise.push(trade(t, 100, 1, i % 2 === 0 ? 'buy' : 'sell')); t += 3000; }
  const slices = buildTwapSlices(t + 150000, 14, 'buy');
  const trades = noise.concat(slices.trades);

  let state = {};
  let r = MexcCore.detectTwap(trades, OPTS, state);
  state = r.state;
  assert(r.event !== null, 'a repeating same-size/same-interval one-sided run of trades IS detected as TWAP');
  if (r.event) {
    assert(r.event.detectorKey === 'twap', 'event carries the correct detectorKey');
    assert(r.event.eventType === 'TWAP_ACTIVE', 'reports TWAP_ACTIVE on start, got ' + r.event.eventType);
    assert(r.event.direction === 'LONG', 'buy-side TWAP reports LONG, got ' + r.event.direction);
    assert(r.event.repeatCount >= OPTS.minRepeats, 'reports the real repeat count, got ' + r.event.repeatCount);
  }

  // One more matching slice arrives — still the SAME ongoing TWAP, must not re-fire.
  const more = trades.concat([trade(slices.lastT, 100.5, 10, 'buy')]);
  const r2 = MexcCore.detectTwap(more, OPTS, state);
  assert(r2.event === null, 'an already-active TWAP does not re-report on every matching cycle');
})();

(function testTwapStopIsReportedAfterGrace() {
  let t = 0;
  const slices = buildTwapSlices(t, 14, 'sell');
  let state = {};
  let r = MexcCore.detectTwap(slices.trades, OPTS, state);
  state = r.state;
  assert(r.event !== null && r.event.eventType === 'TWAP_ACTIVE', 'sanity: sell-side TWAP starts first');

  // Time passes with no more matching trades (just one ordinary trade far past the grace window).
  const laterTrades = slices.trades.concat([trade(slices.lastT + OPTS.graceMs + 5000, 99, 1, 'buy')]);
  const r2 = MexcCore.detectTwap(laterTrades, Object.assign({ now: slices.lastT + OPTS.graceMs + 5000 }, OPTS), state);
  assert(r2.event !== null, 'once the pattern genuinely stops (grace period elapsed), TWAP_STOPPED IS reported — not silently dropped');
  if (r2.event) {
    assert(r2.event.eventType === 'TWAP_STOPPED', 'reports TWAP_STOPPED, got ' + r2.event.eventType);
    assert(r2.event.direction === 'SHORT', 'stop event keeps the direction of the TWAP that ended, got ' + r2.event.direction);
  }
  assert(r2.state.active === false, 'state is cleared after reporting the stop, so it will not report stop again');
})();

(function testOrdinaryTwoSidedNoiseDoesNotFire() {
  const trades = [];
  let t = 0, seed = 3;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  for (let i = 0; i < 40; i++) { trades.push(trade(t, 100 + (rnd() - 0.5) * 0.1, 1 + rnd() * 3, rnd() < 0.5 ? 'buy' : 'sell')); t += 2000 + rnd() * 4000; }
  const r = MexcCore.detectTwap(trades, OPTS, {});
  assert(r.event === null, 'ordinary randomized two-sided trading does not look like a TWAP');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
