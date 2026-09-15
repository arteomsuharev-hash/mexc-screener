// Synthetic-data tests for detectLiquidityWithdrawal (core-utils.js) — Algorithm #13. Sudden
// disappearance of TOTAL visible liquidity on one book side (not a single wall) near price, with
// a confirming aggressive-flow reaction on the vacuum side. Deliberately never called "spoofing"
// (spec's explicit requirement) — see eventType: 'LIQUIDITY_WITHDRAWAL'.
// Run: node tests/verify_liquidity_withdrawal.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function snap(t, bestBid, bestAsk, bidVol, askVol) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, bidVol: bidVol, askVol: askVol, bids: [{ p: bestBid, q: 10 }], asks: [{ p: bestAsk, q: 10 }] };
}
function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

(function testAskWithdrawalWithConfirmingBuyFlowIsDetected() {
  const snaps = [];
  let t = 0;
  for (let i = 0; i < 10; i++) { snaps.push(snap(t, 99.9, 100.1, 100000, 100000)); t += 1000; }
  for (let i = 0; i < 15; i++) {
    const askVol = 100000 * (1 - (i / 14) * 0.8); // withdraws down to 20% of original
    snaps.push(snap(t, 99.9, 100.1, 100000, askVol));
    t += 1000;
  }
  const t0 = snaps[9].t, t1 = snaps[snaps.length - 1].t;
  const trades = [];
  for (let tt = t0; tt <= t1; tt += 500) trades.push(trade(tt, 100.05, 3, 'buy'));

  const ev = MexcCore.detectLiquidityWithdrawal(snaps, trades, {});
  assert(ev !== null, 'a sharp ask-side liquidity withdrawal with confirming buy flow IS detected');
  if (ev) {
    assert(ev.detectorKey === 'liquidityWithdrawal', 'event carries the correct detectorKey');
    assert(ev.eventType === 'LIQUIDITY_WITHDRAWAL', 'never called spoofing — eventType is LIQUIDITY_WITHDRAWAL, got ' + ev.eventType);
    assert(ev.side === 'ask', 'reports the ask side as the one that vanished, got ' + ev.side);
    assert(ev.direction === 'LONG', 'ask vacuum + buy flow reports LONG (bullish breakout probability), got ' + ev.direction);
    assert(ev.withdrawalRatioPct >= 50, 'reports a large withdrawal ratio, got ' + ev.withdrawalRatioPct);
  }
})();

(function testWithdrawalWithoutConfirmingFlowDoesNotFire() {
  const snaps = [];
  let t = 0;
  for (let i = 0; i < 10; i++) { snaps.push(snap(t, 99.9, 100.1, 100000, 100000)); t += 1000; }
  for (let i = 0; i < 15; i++) {
    const askVol = 100000 * (1 - (i / 14) * 0.8);
    snaps.push(snap(t, 99.9, 100.1, 100000, askVol));
    t += 1000;
  }
  const t0 = snaps[9].t, t1 = snaps[snaps.length - 1].t;
  const trades = [];
  // Flow is sell-dominant, not buy — no confirmation that anything is filling the vacuum upward.
  for (let tt = t0; tt <= t1; tt += 500) trades.push(trade(tt, 100.05, 3, 'sell'));
  const ev = MexcCore.detectLiquidityWithdrawal(snaps, trades, {});
  assert(ev === null, 'liquidity vanished but flow does not confirm the vacuum direction -> no event');
})();

(function testStableBookDoesNotFire() {
  const snaps = [];
  let t = 0;
  for (let i = 0; i < 25; i++) { snaps.push(snap(t, 99.9, 100.1, 100000, 98000 + (i % 3) * 500)); t += 1000; }
  const ev = MexcCore.detectLiquidityWithdrawal(snaps, [], {});
  assert(ev === null, 'a book with only normal minor fluctuation does not produce a false positive');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
