// Synthetic-data tests for detectPossibleMarketMakerBot (core-utils.js) — Algorithm #18. Public
// MEXC data can never prove WHOSE orders sit in the book, so this never claims a "bot rating" or
// identity — only a behavioral heuristic (many small trades, balanced both sides, calm volatility,
// tight/stable spread) with an honest confidence cap, same principle as fakeLiquidity/
// possibleHiddenAbsorption.
// Run: node tests/verify_possible_market_maker_bot.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
function snap(t, bestBid, bestAsk) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, bids: [{ p: bestBid, q: 50 }], asks: [{ p: bestAsk, q: 50 }] };
}
let seed = 11;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }

(function testBalancedCalmTightSpreadIsDetected() {
  // computeFeatures needs >=~150s of buffer span to build its own volatility-percentile history
  // (5 rolling 30s buckets) — 300 trades * 750ms = 225s comfortably covers that.
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < 300; i++) {
    price += (rnd() - 0.5) * 0.002; // почти не двигается
    trades.push(trade(t, price, 0.5 + rnd() * 0.5, i % 2 === 0 ? 'buy' : 'sell')); // строго поровну
    t += 750;
  }
  const snaps = [];
  for (let i = 0; i < 30; i++) { snaps.push(snap(i * 1000, 99.995, 100.005)); } // спред стабильный и узкий

  const ev = MexcCore.detectPossibleMarketMakerBot(trades, snaps, {});
  assert(ev !== null, 'many small balanced trades + calm volatility + stable tight spread IS flagged');
  if (ev) {
    assert(ev.detectorKey === 'possibleMarketMakerBot', 'event carries the correct detectorKey');
    assert(ev.eventType === 'POSSIBLE_MARKET_MAKER_BOT', 'carries the correct eventType, got ' + ev.eventType);
    assert(ev.isHeuristic === true, 'flagged as a heuristic — no counterparty identity claimed');
    assert(ev.direction === 'BOTH', 'not a directional signal, got ' + ev.direction);
    assert(ev.confidencePct <= ev.maxConfidence, 'confidence respects the honest cap, got ' + ev.confidencePct + ' vs ' + ev.maxConfidence);
    assert(Math.abs(ev.buyRatioPct - 50) < 15, 'reports a near-balanced buy ratio, got ' + ev.buyRatioPct);
  }
})();

(function testDirectionalFlowDoesNotFire() {
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < 80; i++) { price += 0.01; trades.push(trade(t, price, 0.5, 'buy')); t += 750; } // почти весь объём в одну сторону
  const snaps = [];
  for (let i = 0; i < 30; i++) snaps.push(snap(i * 1000, 99.995, 100.005));
  const ev = MexcCore.detectPossibleMarketMakerBot(trades, snaps, {});
  assert(ev === null, 'one-sided directional flow does not look like a market-maker/spreader');
})();

(function testWideUnstableSpreadDoesNotFire() {
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < 80; i++) { price += (rnd() - 0.5) * 0.002; trades.push(trade(t, price, 0.5, i % 2 === 0 ? 'buy' : 'sell')); t += 750; }
  const snaps = [];
  for (let i = 0; i < 30; i++) {
    const wobble = (i % 3 === 0) ? 0.05 : 0.005; // спред то узкий, то резко широкий - нестабилен
    snaps.push(snap(i * 1000, 100 - wobble / 2, 100 + wobble / 2));
  }
  const ev = MexcCore.detectPossibleMarketMakerBot(trades, snaps, {});
  assert(ev === null, 'an unstable, wildly varying spread does not look like a resting market-maker');
})();

(function testHighVolatilityDoesNotFire() {
  const trades = [];
  let t = 0, price = 100;
  for (let i = 0; i < 80; i++) { price += (rnd() - 0.5) * 3; trades.push(trade(t, price, 0.5, i % 2 === 0 ? 'buy' : 'sell')); t += 750; }
  const snaps = [];
  for (let i = 0; i < 30; i++) snaps.push(snap(i * 1000, 99.995, 100.005));
  const ev = MexcCore.detectPossibleMarketMakerBot(trades, snaps, {});
  assert(ev === null, 'high volatility (not calm) does not look like a resting market-maker');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
