// Synthetic-data tests for detectFailedBreakout (core-utils.js) — Algorithm #10: a range piercing
// is only remembered (state), never signaled immediately. The event fires ONLY after price actually
// returns inside the range with confirming opposing flow — the spec's explicit anti-noise
// requirement ("never on the first piercing"). Same {event, state} contract as
// detectDensityAbsorptionBreakout.
// Run: node tests/verify_failed_breakout.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
const OPTS = { rangeWindowMs: 180000, pierceGraceMs: 60000 };

function buildRange() {
  const trades = [];
  let t = 0;
  for (let i = 0; i < 40; i++) { trades.push(trade(t, 100.00 + (i % 10) * 0.02, 3, i % 2 === 0 ? 'buy' : 'sell')); t += 4500; }
  return { trades: trades, lastT: t };
}

(function testPierceThenReclaimFiresFailedBreakoutShort() {
  const base = buildRange();
  let state = {};
  const r1 = MexcCore.detectFailedBreakout(base.trades, OPTS, state);
  state = r1.state;
  assert(r1.event === null, 'price still inside the range -> no event yet');
  assert(!state.pierce, 'no pierce recorded while price stays inside the range');

  let t = base.lastT;
  const trades2 = base.trades.concat([trade(t, 100.30, 5, 'buy')]);
  t += 5000;
  const r2 = MexcCore.detectFailedBreakout(trades2, OPTS, state);
  state = r2.state;
  assert(r2.event === null, 'the FIRST piercing above the range is remembered, never signaled immediately');
  assert(!!state.pierce, 'a pierce is now tracked in state');
  assert(state.pierce.side === 'above', 'reports the correct pierce side, got ' + (state.pierce && state.pierce.side));

  const trades3 = trades2.concat([trade(t, 100.15, 4, 'sell'), trade(t + 1000, 100.10, 4, 'sell')]);
  const r3 = MexcCore.detectFailedBreakout(trades3, OPTS, state);
  assert(r3.event !== null, 'a return inside the range with confirming opposing (sell) flow DOES fire the event');
  if (r3.event) {
    assert(r3.event.detectorKey === 'failedBreakout', 'event carries the correct detectorKey');
    assert(r3.event.direction === 'SHORT', 'a failed upside breakout is reported SHORT, got ' + r3.event.direction);
  }
  assert(r3.state.pierce === null, 'the pierce state resets after firing, so the same failure is not reported twice');
})();

(function testGenuineBreakoutThatNeverReturnsDoesNotFire() {
  const base = buildRange();
  let state = {};
  const r1 = MexcCore.detectFailedBreakout(base.trades, OPTS, state);
  state = r1.state;
  let t = base.lastT;
  // Price pierces above and then just keeps going UP (a real breakout, never returns).
  const trades2 = base.trades.concat([
    trade(t, 100.30, 5, 'buy'), trade(t + 1000, 100.40, 5, 'buy'), trade(t + 2000, 100.50, 5, 'buy')
  ]);
  const r2 = MexcCore.detectFailedBreakout(trades2, OPTS, state);
  assert(r2.event === null, 'a genuine breakout that keeps extending (never returns inside the range) is NOT flagged as failed');
})();

(function testPierceWithoutConfirmingFlowDoesNotFireYet() {
  const base = buildRange();
  let state = {};
  const r1 = MexcCore.detectFailedBreakout(base.trades, OPTS, state);
  state = r1.state;
  let t = base.lastT;
  const trades2 = base.trades.concat([trade(t, 100.30, 5, 'buy')]);
  t += 5000;
  const r2 = MexcCore.detectFailedBreakout(trades2, OPTS, state);
  state = r2.state;
  // Price returns inside the range, but the flow since the pierce is still mostly BUY, not sell -> no real confirmation.
  const trades3 = trades2.concat([trade(t, 100.15, 4, 'buy'), trade(t + 1000, 100.10, 4, 'buy')]);
  const r3 = MexcCore.detectFailedBreakout(trades3, OPTS, state);
  assert(r3.event === null, 'price back inside the range WITHOUT confirming opposing flow does not fire a failed-breakout event');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
