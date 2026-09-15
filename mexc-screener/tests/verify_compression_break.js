// Synthetic-data tests for detectCompressionBreak (core-utils.js) — Algorithm #9: volatility at a
// low percentile of THIS coin's own recent history (never a fixed "vol<1%" cutoff), followed by a
// genuine expansion trigger (volume spike + range breakout).
// Run: node tests/verify_compression_break.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
let seed = 11;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
const OPTS = { lookback: 400, compressionPercentile: 0.2 };

function moderateVolBaseline(n) {
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < n; i++) {
    price += (rnd() - 0.5) * 0.3;
    trades.push(trade(t, price, 2, rnd() < 0.5 ? 'buy' : 'sell'));
    t += 2500;
  }
  return { trades: trades, lastT: t, lastPrice: price };
}

(function testCompressionThenExpansionIsDetected() {
  const base = moderateVolBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT;
  const calmStart = base.lastPrice;
  // Compression: tight range for ~30s, well below the coin's own recent volatility.
  for (let i = 0; i < 15; i++) { const price = calmStart + (rnd() - 0.5) * 0.01; trades.push(trade(t, price, 1, rnd() < 0.5 ? 'buy' : 'sell')); t += 2000; }
  // Expansion: volume spike + breakout above the compressed range.
  let price = calmStart;
  for (let i = 0; i < 8; i++) { price += 0.05; trades.push(trade(t, price, 20, 'buy')); t += 2000; }

  const ev = MexcCore.detectCompressionBreak(trades, null, OPTS);
  assert(ev !== null, 'a genuine compression phase followed by a volume-confirmed range breakout IS detected');
  if (ev) {
    assert(ev.detectorKey === 'compressionBreak', 'event carries the correct detectorKey');
    assert(ev.direction === 'LONG', 'an upward breakout after compression is reported LONG, got ' + ev.direction);
    assert(ev.volatilityPercentile <= 20, 'reports a low volatility percentile for the compression phase, got ' + ev.volatilityPercentile);
    assert(ev.volumeZ > 1.5, 'reports a real volume z-score for the expansion trigger, got ' + ev.volumeZ);
  }
})();

(function testUniformlyVolatileMarketHasNoCompressionPhase() {
  const base = moderateVolBaseline(200);
  const ev = MexcCore.detectCompressionBreak(base.trades, null, OPTS);
  assert(ev === null, 'a market with no genuinely quiet phase at all does not produce a false positive');
})();

(function testCompressedButNoExpansionTriggerYet() {
  const base = moderateVolBaseline(150);
  const trades = base.trades.slice();
  let t = base.lastT;
  const calmStart = base.lastPrice;
  // Stays calm/tight the WHOLE time — no volume spike or range break at the end yet.
  for (let i = 0; i < 23; i++) { const price = calmStart + (rnd() - 0.5) * 0.01; trades.push(trade(t, price, 1, rnd() < 0.5 ? 'buy' : 'sell')); t += 2000; }
  const ev = MexcCore.detectCompressionBreak(trades, null, OPTS);
  assert(ev === null, 'compression without an actual expansion trigger yet does not fire prematurely');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
