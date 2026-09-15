// Synthetic-data tests for detectVolumeAnomaly (core-utils.js) — Algorithm #11. Unusual volume
// ALONE is never a trading signal (spec's explicit requirement) — the event always carries a
// classification (BULLISH/BEARISH/ABSORPTION_NEUTRAL) based on whether the volume spike is
// confirmed by proportional, directional price movement, or absorbed with flat price.
// Run: node tests/verify_volume_anomaly.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
let seed = 5;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }

function calmBaseline(n) {
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < n; i++) {
    price += (rnd() - 0.5) * 0.02;
    trades.push(trade(t, price, 2, rnd() < 0.5 ? 'buy' : 'sell'));
    t += 2000;
  }
  return { trades: trades, lastT: t, lastPrice: price };
}

(function testBullishVolumeEvent() {
  const base = calmBaseline(200);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  for (let i = 0; i < 20; i++) { price += 0.05; trades.push(trade(t, price, 30, 'buy')); t += 2000; }
  const ev = MexcCore.detectVolumeAnomaly(trades, null, {});
  assert(ev !== null, 'a strong buy-dominant volume burst with confirming price rise IS detected');
  if (ev) {
    assert(ev.detectorKey === 'volumeAnomaly', 'event carries the correct detectorKey');
    assert(ev.eventType === 'BULLISH_VOLUME_EVENT', 'classified BULLISH (buy-dominant + price up), got ' + ev.eventType);
    assert(ev.direction === 'LONG', 'bullish volume event reports LONG, got ' + ev.direction);
    assert(ev.volumeZ > 0, 'reports a positive volume z-score, got ' + ev.volumeZ);
  }
})();

(function testAbsorptionNeutralEvent() {
  const base = calmBaseline(200);
  const trades = base.trades.slice();
  let t = base.lastT, price = base.lastPrice;
  // Same huge volume, but balanced buy/sell and flat price -> absorbed, not directional.
  for (let i = 0; i < 20; i++) { price += (rnd() - 0.5) * 0.01; trades.push(trade(t, price, 30, i % 2 === 0 ? 'buy' : 'sell')); t += 2000; }
  const ev = MexcCore.detectVolumeAnomaly(trades, null, {});
  assert(ev !== null, 'a huge but balanced/flat volume burst IS still reported as an event (volume anomaly itself is real)');
  if (ev) {
    assert(ev.eventType === 'ABSORPTION_NEUTRAL_EVENT', 'classified ABSORPTION_NEUTRAL (balanced flow, flat price), got ' + ev.eventType);
    assert(ev.direction === 'BOTH', 'neutral/absorption event is not claimed as a directional signal, got ' + ev.direction);
  }
})();

(function testOrdinaryCalmMarketDoesNotFire() {
  const base = calmBaseline(220);
  const ev = MexcCore.detectVolumeAnomaly(base.trades, null, {});
  assert(ev === null, 'an ordinary calm market with no volume anomaly does not produce a false positive');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
