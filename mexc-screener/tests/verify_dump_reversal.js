// Synthetic-data tests for detectDumpReversal (core-utils.js) — Algorithm #8, the mirror of
// PUMP_REVERSAL: an extreme negative return alone is never enough — needs deceleration AND
// declining sell pressure to be reported DUMP_REVERSAL; otherwise DUMP_CONTINUATION.
// Run: node tests/verify_dump_reversal.js

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

(function testDeceleratingDumpWithDecliningSellPressureIsReversal() {
  const base = calmBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  for (let i = 0; i < 15; i++) { price -= 0.15; trades.push(trade(t, price, 5, 'sell')); t += 2000; }
  for (let i = 0; i < 15; i++) { price -= 0.02; trades.push(trade(t, price, 3, i % 2 === 0 ? 'buy' : 'sell')); t += 2000; }

  const ev = MexcCore.detectDumpReversal(trades, OPTS);
  assert(ev !== null, 'a dump that decelerates with declining sell pressure IS detected');
  if (ev) {
    assert(ev.detectorKey === 'dumpReversal', 'event carries the correct detectorKey');
    assert(ev.dumpType === 'DUMP_REVERSAL', 'reports DUMP_REVERSAL when exhaustion is confirmed, got ' + ev.dumpType);
    assert(ev.direction === 'LONG', 'a confirmed dump reversal is reported LONG, got ' + ev.direction);
    assert(ev.movePct < 0, 'reports a negative move percentage for the dump itself, got ' + ev.movePct);
  }
})();

(function testAcceleratingDumpIsContinuationNotSilent() {
  const base = calmBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  for (let i = 0; i < 15; i++) { price -= 0.15; trades.push(trade(t, price, 5, 'sell')); t += 2000; }
  for (let i = 0; i < 15; i++) { price -= 0.15; trades.push(trade(t, price, 5, 'sell')); t += 2000; }
  const ev = MexcCore.detectDumpReversal(trades, OPTS);
  assert(ev !== null, 'an extreme dump with NO exhaustion signal is still reported (never silently dropped)');
  if (ev) {
    assert(ev.dumpType === 'DUMP_CONTINUATION', 'reports DUMP_CONTINUATION, not a reversal, when sell flow keeps accelerating, got ' + ev.dumpType);
    assert(ev.direction === 'SHORT', 'a continuation keeps the SHORT direction (never "every dump = long"), got ' + ev.direction);
    assert(ev.confidencePct <= 40, 'continuation carries a capped, informational confidence, got ' + ev.confidencePct);
  }
})();

(function testOrdinaryCalmMarketDoesNotFire() {
  const base = calmBaseline(200);
  const ev = MexcCore.detectDumpReversal(base.trades, OPTS);
  assert(ev === null, 'an ordinary calm market with no extreme return does not produce a false positive');
})();

(function testPositiveMoveIsNotADump() {
  const base = calmBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  for (let i = 0; i < 15; i++) { price += 0.15; trades.push(trade(t, price, 5, 'buy')); t += 2000; }
  const ev = MexcCore.detectDumpReversal(trades, OPTS);
  assert(ev === null, 'a positive move is not a dump at all (that is pump-reversal\'s job, not this detector\'s)');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
