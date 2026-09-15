// Synthetic-data tests for detectStandingWall (core-utils.js) — the forward-looking depth detector
// added for STRATEGY_DEFS.density ("Сайз") on watchlist coins: a resting order-book level noticeably
// bigger than its neighbors ("a wall"), close to the current price, that price has been approaching
// over the snapshot window. Unlike absorption/fakeLiquidity (retrospective — the level already
// shrank), this looks for the wall BEFORE it's touched.
// Run: node tests/verify_standing_wall_detector.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

// Builds a flat 20-level ladder of absolute prices with a single outsized "wall" level injected at
// wallIdx (qty wallQty, every other level qty=10). bestBid/bestAsk are set INDEPENDENTLY of the
// ladder prices — detectStandingWall only uses them to compute mid-price distance/approach, never
// cross-checks them against the ladder's own price values, so this is a faithful, simpler fixture.
function ladder(basePrice, step, wallIdx, wallQty) {
  const arr = [];
  for (let i = 0; i < 20; i++) {
    arr.push({ p: Math.round((basePrice + step * i) * 10000) / 10000, q: (i === wallIdx ? wallQty : 10) });
  }
  return arr;
}
function snap(t, bestBid, bestAsk, asks, bids) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, asks: asks, bids: bids, bidVol: 0, askVol: 0 };
}

const FLAT_BIDS = ladder(99.80, -0.01, -1, 0); // wallIdx -1 -> no bid wall, plain flat ladder

(function testPlantedAskWallWithApproachingPrice() {
  // Ask wall fixed at 100.15 (index 14 of a 100.01-step-0.01 ladder), 12x every other level.
  const asks = ladder(100.01, 0.01, 14, 120);
  const snaps = [];
  for (let i = 0; i < 20; i++) {
    // Mid price drifts from ~99.00 (far, ~1.15% away) to ~100.14 (right at the wall, ~0.01% away).
    const mid = 99.00 + (100.14 - 99.00) * (i / 19);
    snaps.push(snap(i * 500, mid - 0.005, mid + 0.005, asks, FLAT_BIDS));
  }
  const ev = MexcCore.detectStandingWall(snaps, { minSnapshots: 10, lookback: 20, minWallRatio: 3, maxDistancePct: 1.5 });
  assert(ev !== null, 'a genuine ask wall with price steadily approaching it IS detected');
  if (ev) {
    assert(ev.detectorKey === 'standingWall', 'event carries the correct detectorKey');
    assert(ev.side === 'ask', 'reports the correct side, got ' + ev.side);
    assert(ev.direction === 'LONG', 'an ask (resistance) wall about to break is reported LONG (breakout continues up), got ' + ev.direction);
    assert(Math.abs(ev.priceLevel - 100.15) < 1e-6, 'reports the actual wall price level, got ' + ev.priceLevel);
    assert(ev.wallRatio >= 3, 'reports a wall ratio at/above the configured minimum, got ' + ev.wallRatio);
    assert(ev.distancePct < 1.5, 'reports a distance within the configured max, got ' + ev.distancePct);
    assert(ev.confidencePct >= 0 && ev.confidencePct <= 100, 'confidence is a sane percentage, got ' + ev.confidencePct);
  }
})();

(function testPlantedBidWallReportsShort() {
  // Symmetric case on the bid side — a support wall about to break is bearish continuation (SHORT).
  const bids = ladder(100.14, -0.01, 14, 120); // wall at 100.14 - 14*0.01 = 100.00
  const flatAsks = ladder(101.00, 0.01, -1, 0);
  const snaps = [];
  for (let i = 0; i < 20; i++) {
    const mid = 101.10 - (101.10 - 100.01) * (i / 19); // drifts DOWN toward the bid wall at 100.00
    snaps.push(snap(i * 500, mid - 0.005, mid + 0.005, flatAsks, bids));
  }
  const ev = MexcCore.detectStandingWall(snaps, { minSnapshots: 10, lookback: 20, minWallRatio: 3, maxDistancePct: 1.5 });
  assert(ev !== null, 'a genuine bid wall with price steadily approaching it IS detected');
  if (ev) {
    assert(ev.side === 'bid', 'reports the correct side, got ' + ev.side);
    assert(ev.direction === 'SHORT', 'a bid (support) wall about to break is reported SHORT (breakout continues down), got ' + ev.direction);
  }
})();

(function testNoWallNoFalsePositive() {
  // Perfectly flat book on both sides — no level stands out, nothing to report.
  const flatAsks = ladder(100.01, 0.01, -1, 0);
  const flatBids = ladder(99.80, -0.01, -1, 0);
  const snaps = [];
  for (let i = 0; i < 20; i++) {
    snaps.push(snap(i * 500, 99.99, 100.00, flatAsks, flatBids));
  }
  const ev = MexcCore.detectStandingWall(snaps, { minSnapshots: 10, lookback: 20, minWallRatio: 3, maxDistancePct: 1.5 });
  assert(ev === null, 'a perfectly flat book (no outsized level on either side) does not trigger a false positive');
})();

(function testWallTooFarAwayIsIgnored() {
  // A genuine 12x wall exists, but it sits far from the current price the whole time — not
  // something that's plausibly getting tested "soon", so it should not be reported.
  const asks = ladder(150.01, 0.01, 14, 120); // wall around 150.15, nowhere near price ~100
  const snaps = [];
  for (let i = 0; i < 20; i++) {
    snaps.push(snap(i * 500, 99.99, 100.00, asks, FLAT_BIDS));
  }
  const ev = MexcCore.detectStandingWall(snaps, { minSnapshots: 10, lookback: 20, minWallRatio: 3, maxDistancePct: 1.5 });
  assert(ev === null, 'a large wall far outside maxDistancePct from the current price is ignored');
})();

(function testWallCloseButNotApproachingIsIgnored() {
  // A genuine, close-enough wall exists, but price is NOT trending toward it (stays at a roughly
  // constant distance the whole window) — no approach trend, so this is not "about to be tested soon".
  const asks = ladder(100.01, 0.01, 14, 120); // wall at 100.15
  const snaps = [];
  for (let i = 0; i < 20; i++) {
    const mid = 100.05 + (((i * 7) % 3) - 1) * 0.001; // tiny jitter around a constant distance from the wall
    snaps.push(snap(i * 500, mid - 0.005, mid + 0.005, asks, FLAT_BIDS));
  }
  const ev = MexcCore.detectStandingWall(snaps, { minSnapshots: 10, lookback: 20, minWallRatio: 3, maxDistancePct: 1.5 });
  assert(ev === null, 'a wall close to price but with no approach trend does not trigger (avoids flagging a wall that just sits there indefinitely)');
})();

(function testTooFewSnapshotsIsIgnored() {
  const asks = ladder(100.01, 0.01, 14, 120);
  const snaps = [];
  for (let i = 0; i < 5; i++) { // below minSnapshots
    const mid = 99.00 + (100.14 - 99.00) * (i / 4);
    snaps.push(snap(i * 500, mid - 0.005, mid + 0.005, asks, FLAT_BIDS));
  }
  const ev = MexcCore.detectStandingWall(snaps, { minSnapshots: 10, lookback: 20, minWallRatio: 3, maxDistancePct: 1.5 });
  assert(ev === null, 'too little snapshot history to establish an approach trend -> no detection attempted');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
