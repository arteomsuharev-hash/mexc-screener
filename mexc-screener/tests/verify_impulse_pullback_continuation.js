// Synthetic-data tests for detectImpulsePullbackContinuation (core-utils.js) — Algorithm #4: a
// three-phase window scan (impulse -> pullback -> continuation). Must only fire once continuation
// is actually observed, never mid-impulse or during the pullback itself.
// Run: node tests/verify_impulse_pullback_continuation.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
const OPTS = { impulseWindowMs: 30000, pullbackWindowMs: 60000, continuationWindowMs: 30000 };

// Builds: impulse phase (strong directional move + flow), pullback phase (smaller counter-move,
// lower volume, opposing flow contained), continuation phase (flow resumes, breaks pullback extreme).
function buildImpulsePullbackContinuation(direction) {
  const trades = [];
  let t = 0;
  const sign = direction === 'LONG' ? 1 : -1;
  const impulseSide = direction === 'LONG' ? 'buy' : 'sell';
  const oppositeSide = direction === 'LONG' ? 'sell' : 'buy';
  // Impulse: 16 trades over 30s, price moves +/-2.0 total, mostly impulseSide.
  let price = 100.0;
  for (let i = 0; i < 16; i++) {
    price += sign * 0.14;
    trades.push(trade(t, price, 5, i % 5 === 0 ? oppositeSide : impulseSide));
    t += 2000;
  }
  const impulseEnd = price; // ~102.1 for LONG
  // Pullback: 60s, smaller counter-move (~0.5, well under the 2.0 impulse), lower volume, opposing
  // flow present but NOT dominant (a clean 50/50 split, comfortably under the 70% cap).
  for (let i = 0; i < 12; i++) {
    price -= sign * 0.04;
    trades.push(trade(t, price, 1, i % 2 === 0 ? oppositeSide : impulseSide));
    t += 5000;
  }
  const pullbackExtreme = price; // the pullback's low (LONG) / high (SHORT)
  // Continuation: 30s, flow resumes in impulse direction, breaks the pullback extreme decisively.
  for (let i = 0; i < 12; i++) {
    price += sign * 0.05;
    trades.push(trade(t, price, 4, i % 5 === 0 ? oppositeSide : impulseSide));
    t += 2500;
  }
  return { trades: trades, impulseEnd: impulseEnd, pullbackExtreme: pullbackExtreme };
}

(function testPlantedLongContinuation() {
  const built = buildImpulsePullbackContinuation('LONG');
  const ev = MexcCore.detectImpulsePullbackContinuation(built.trades, OPTS);
  assert(ev !== null, 'a genuine impulse -> shallow pullback -> continuation sequence IS detected');
  if (ev) {
    assert(ev.detectorKey === 'impulsePullbackContinuation', 'event carries the correct detectorKey');
    assert(ev.direction === 'LONG', 'an upward impulse continuation is reported LONG, got ' + ev.direction);
    assert(ev.pullbackRatioPct < 100, 'reports a pullback smaller than the impulse, got ' + ev.pullbackRatioPct);
  }
})();

(function testPlantedShortContinuation() {
  const built = buildImpulsePullbackContinuation('SHORT');
  const ev = MexcCore.detectImpulsePullbackContinuation(built.trades, OPTS);
  assert(ev !== null, 'a genuine downward impulse -> pullback -> continuation sequence IS detected');
  if (ev) assert(ev.direction === 'SHORT', 'a downward impulse continuation is reported SHORT, got ' + ev.direction);
})();

(function testPullbackLargerThanImpulseIsNotContinuation() {
  const trades = [];
  let t = 0, price = 100.0;
  for (let i = 0; i < 16; i++) { price += 0.14; trades.push(trade(t, price, 5, 'buy')); t += 2000; }
  // Pullback EXCEEDS the impulse size entirely (structure broken, not a real pullback).
  for (let i = 0; i < 12; i++) { price -= 0.30; trades.push(trade(t, price, 3, 'sell')); t += 5000; }
  for (let i = 0; i < 12; i++) { price += 0.05; trades.push(trade(t, price, 4, 'buy')); t += 2500; }
  const ev = MexcCore.detectImpulsePullbackContinuation(trades, OPTS);
  assert(ev === null, 'a pullback larger than the original impulse is NOT treated as a valid continuation setup');
})();

(function testMidImpulseDoesNotFireAsContinuation() {
  // Only the impulse phase exists so far - no pullback, no continuation yet.
  const trades = [];
  let t = 0, price = 100.0;
  for (let i = 0; i < 45; i++) { price += 0.05; trades.push(trade(t, price, 5, 'buy')); t += 2000; }
  const ev = MexcCore.detectImpulsePullbackContinuation(trades, OPTS);
  assert(ev === null, 'a coin still mid-impulse (no pullback/continuation phase yet) does not fire');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
