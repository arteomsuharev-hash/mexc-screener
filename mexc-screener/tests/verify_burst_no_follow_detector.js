// Synthetic-data test for MexcCore.detectBurstNoFollowThrough — plants a genuine volume burst
// without proportional price movement (must trigger), and two controls: (a) a burst WITH normal
// price follow-through, which is a legitimate breakout and must NOT be flagged as an inefficiency,
// and (b) uniform quiet activity with no burst at all.
// Run: node tests/verify_burst_no_follow_detector.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

const BUCKET_MS = 10000;

// Builds `bucketCount` quiet 10s buckets (small, steady volume, tiny price wobble) followed by one
// "event" bucket whose volume and price-move behavior are controlled by the caller.
function buildTape(bucketCount, eventVolumeMultiplier, eventMoveFraction) {
  const trades = [];
  let t = 0;
  let price = 100;
  for (let b = 0; b < bucketCount; b++) {
    const isEvent = b === bucketCount - 1;
    const tradesInBucket = isEvent ? 12 : 4; // quiet buckets: 4 small trades; event bucket: 12 trades (more volume)
    const bucketStart = t;
    for (let i = 0; i < tradesInBucket; i++) {
      const qty = isEvent ? (2 * eventVolumeMultiplier) : 2; // scales the event bucket's USD volume
      if (isEvent && i === tradesInBucket - 1) {
        price = price * (1 + eventMoveFraction); // apply the controlled move at the end of the event bucket
      } else if (!isEvent) {
        price = price * (1 + (((b * 3 + i) % 5) - 2) / 4000); // tiny deterministic wobble, quiet buckets
      }
      trades.push(trade(bucketStart + i * 700, price, qty, i % 2 === 0 ? 'buy' : 'sell'));
    }
    t = bucketStart + BUCKET_MS;
  }
  return trades;
}

(function testBurstWithoutFollowThroughTriggers() {
  // 7 quiet buckets, then one bucket with ~6x the volume but price barely moves (0.05%).
  const trades = buildTape(7, 6, 0.0005);
  const ev = MexcCore.detectBurstNoFollowThrough(trades, { bucketMs: BUCKET_MS, minRepeats: 3, lookback: 300 });
  assert(ev !== null, 'a genuine volume burst with flat price (no follow-through) IS detected');
  if (ev) {
    assert(ev.detectorKey === 'burstNoFollow', 'event carries the correct detectorKey');
    assert(ev.priceMovePct < 0.01, 'reported price move is small, matching the planted flat price, got ' + (ev.priceMovePct * 100).toFixed(3) + '%');
    assert(ev.repeatCount === 12, 'reports the correct trade count in the burst bucket, got ' + ev.repeatCount);
  }
})();

(function testBurstWithFollowThroughDoesNotTrigger() {
  // Same volume burst, but this time price genuinely moves a lot too (5%) — a real breakout, not
  // an inefficiency. Must NOT be flagged by THIS detector (a different one, e.g. density breakout
  // in a later phase, would be the right place for that).
  const trades = buildTape(7, 6, 0.05);
  const ev = MexcCore.detectBurstNoFollowThrough(trades, { bucketMs: BUCKET_MS, minRepeats: 3, lookback: 300 });
  assert(ev === null, 'a volume burst WITH proportional price follow-through (a real breakout) is NOT flagged as "no follow-through"');
})();

(function testNoBurstAtAllDoesNotTrigger() {
  // All 8 buckets, INCLUDING the last, have identical trade count/size/price wobble — genuinely no
  // burst anywhere (buildTape() always gives the "event" bucket 3x the trade count of quiet ones by
  // design, which would itself look like a mild burst — so build a uniform tape directly here
  // instead of reusing that helper).
  const trades = [];
  let t = 0, price = 100;
  for (let b = 0; b < 8; b++) {
    for (let i = 0; i < 4; i++) {
      price = price * (1 + (((b * 3 + i) % 5) - 2) / 4000);
      trades.push(trade(t + i * 700, price, 2, i % 2 === 0 ? 'buy' : 'sell'));
    }
    t += BUCKET_MS;
  }
  const ev = MexcCore.detectBurstNoFollowThrough(trades, { bucketMs: BUCKET_MS, minRepeats: 3, lookback: 300 });
  assert(ev === null, 'uniform quiet activity with no volume spike at all does not trigger a false positive');
})();

(function testInsufficientHistoryReturnsNull() {
  const trades = buildTape(3, 6, 0.0005); // only 3 buckets, detector requires >=6 for a baseline
  const ev = MexcCore.detectBurstNoFollowThrough(trades, { bucketMs: BUCKET_MS, minRepeats: 3, lookback: 300 });
  assert(ev === null, 'too little history to establish this coin\'s own normal baseline -> no detection attempted (avoids a meaningless comparison)');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
