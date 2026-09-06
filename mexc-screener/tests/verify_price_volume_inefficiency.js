// Synthetic-data tests for detectPriceVolumeInefficiency (core-utils.js) — Algorithm #5: price
// move whose z-score is high while the accompanying volume z-score stays low — both measured
// against THIS coin's own recent history, never a fixed percentage.
// Run: node tests/verify_price_volume_inefficiency.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
let seed = 7;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
const OPTS = { lookback: 400, minPriceZ: 2, maxVolumeZ: 0.5 };

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

(function testBigMoveTinyVolumeIsInefficiency() {
  const base = calmBaseline(190);
  const trades = base.trades.slice();
  let t = base.lastT;
  // Sharp ~2% jump via a couple of TINY trades — price moved, volume barely did.
  trades.push(trade(t, base.lastPrice + 1.0, 0.05, 'buy')); t += 5000;
  trades.push(trade(t, base.lastPrice + 2.0, 0.05, 'buy')); t += 5000;

  const ev = MexcCore.detectPriceVolumeInefficiency(trades, OPTS);
  assert(ev !== null, 'a big price move confirmed by almost no volume IS flagged as an inefficiency');
  if (ev) {
    assert(ev.detectorKey === 'priceVolumeInefficiency', 'event carries the correct detectorKey');
    assert(ev.direction === 'LONG', 'an upward inefficiency is reported LONG, got ' + ev.direction);
    assert(ev.inefficiencyType === 'BULLISH', 'reports BULLISH by default (no absorption signal supplied), got ' + ev.inefficiencyType);
    assert(ev.movePct > 0, 'reports a positive move percentage, got ' + ev.movePct);
  }
})();

(function testReversionCandidateOnlyWhenExplicitlyFlagged() {
  const base = calmBaseline(190);
  const trades = base.trades.slice();
  let t = base.lastT;
  trades.push(trade(t, base.lastPrice + 1.0, 0.05, 'buy')); t += 5000;
  trades.push(trade(t, base.lastPrice + 2.0, 0.05, 'buy')); t += 5000;
  const ev = MexcCore.detectPriceVolumeInefficiency(trades, { lookback: 400, minPriceZ: 2, maxVolumeZ: 0.5, absorptionAgainstMove: true });
  assert(ev !== null, 'same setup with an explicit absorption confirmation supplied by the caller still fires');
  if (ev) assert(ev.inefficiencyType === 'REVERSION_CANDIDATE', 'ONLY becomes REVERSION_CANDIDATE when the caller supplies a confirming absorption signal, got ' + ev.inefficiencyType);
})();

(function testMoveConfirmedByVolumeIsNotInefficiency() {
  const base = calmBaseline(190);
  const trades = base.trades.slice();
  let t = base.lastT;
  // Same-sized price move, but this time backed by a genuinely large, proportional burst of volume.
  for (let i = 0; i < 20; i++) { trades.push(trade(t, base.lastPrice + i * 0.1, 50, 'buy')); t += 500; }
  const ev = MexcCore.detectPriceVolumeInefficiency(trades, OPTS);
  assert(ev === null, 'a price move that IS confirmed by a proportional volume burst is not flagged as an inefficiency');
})();

(function testOrdinaryCalmMarketDoesNotFire() {
  const base = calmBaseline(220);
  const ev = MexcCore.detectPriceVolumeInefficiency(base.trades, OPTS);
  assert(ev === null, 'an ordinary calm market with no unusual move does not produce a false positive');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
