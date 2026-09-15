// Synthetic-data tests for detectPumpReversal (core-utils.js) — Algorithm #7. An extreme short
// return (z-score, not a fixed %) alone is never enough — must also show deceleration AND declining
// buy pressure to be reported PUMP_REVERSAL; if flow keeps accelerating instead, it's reported
// PUMP_CONTINUATION (capped confidence, informational) — never silently dropped, never
// "every pump = short".
// Run: node tests/verify_pump_reversal.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
let seed = 3;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
const OPTS = { lookback: 400, minReturnZ: 2.5 };

function calmBaseline(n) {
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < n; i++) {
    price += (rnd() - 0.5) * 0.02;
    trades.push(trade(t, price, 2, rnd() < 0.5 ? 'buy' : 'sell'));
    t += 3000;
  }
  return { trades: trades, lastT: t, lastPrice: price };
}

(function testDeceleratingPumpWithDecliningBuyPressureIsReversal() {
  const base = calmBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  for (let i = 0; i < 15; i++) { price += 0.15; trades.push(trade(t, price, 5, 'buy')); t += 2000; } // strong buy-driven push
  for (let i = 0; i < 15; i++) { price += 0.02; trades.push(trade(t, price, 3, i % 2 === 0 ? 'sell' : 'buy')); t += 2000; } // weak, mixed -> new high barely holds

  const ev = MexcCore.detectPumpReversal(trades, OPTS);
  assert(ev !== null, 'a pump that decelerates with declining buy pressure IS detected');
  if (ev) {
    assert(ev.detectorKey === 'pumpReversal', 'event carries the correct detectorKey');
    assert(ev.pumpType === 'PUMP_REVERSAL', 'reports PUMP_REVERSAL when exhaustion is confirmed, got ' + ev.pumpType);
    assert(ev.direction === 'SHORT', 'a confirmed pump reversal is reported SHORT, got ' + ev.direction);
    assert(ev.movePct > 0, 'reports a positive move percentage for the pump itself, got ' + ev.movePct);
  }
})();

(function testAcceleratingPumpIsContinuationNotSilent() {
  const base = calmBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  // Both halves keep accelerating with dominant buy flow - no exhaustion signal at all.
  for (let i = 0; i < 15; i++) { price += 0.15; trades.push(trade(t, price, 5, 'buy')); t += 2000; }
  for (let i = 0; i < 15; i++) { price += 0.15; trades.push(trade(t, price, 5, 'buy')); t += 2000; }
  const ev = MexcCore.detectPumpReversal(trades, OPTS);
  assert(ev !== null, 'an extreme pump with NO exhaustion signal is still reported (never silently dropped)');
  if (ev) {
    assert(ev.pumpType === 'PUMP_CONTINUATION', 'reports PUMP_CONTINUATION, not a reversal, when flow keeps accelerating, got ' + ev.pumpType);
    assert(ev.direction === 'LONG', 'a continuation keeps the LONG direction (never "every pump = short"), got ' + ev.direction);
    assert(ev.confidencePct <= 40, 'continuation carries a capped, informational confidence, got ' + ev.confidencePct);
  }
})();

(function testOrdinaryCalmMarketDoesNotFire() {
  const base = calmBaseline(200);
  const ev = MexcCore.detectPumpReversal(base.trades, OPTS);
  assert(ev === null, 'an ordinary calm market with no extreme return does not produce a false positive');
})();

(function testNegativeMoveIsNotAPump() {
  const base = calmBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  for (let i = 0; i < 15; i++) { price -= 0.15; trades.push(trade(t, price, 5, 'sell')); t += 2000; }
  const ev = MexcCore.detectPumpReversal(trades, OPTS);
  assert(ev === null, 'a negative move is not a pump at all (that is dump-reversal\'s job, not this detector\'s)');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
