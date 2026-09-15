// Pure logic test for MexcCore.computeWatchlistTransitions — the hysteresis that decides which
// coins enter/leave the Tier-2 watchlist (deals+depth WebSocket connections). No network/DOM.
// The critical property under test: a coin oscillating right at the cutoff must NOT flap
// in/out every single evaluation cycle (that would mean opening/closing WS connections
// constantly) — see the plan's Phase 2 section.
// Run: node tests/verify_watchlist_hysteresis.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

const SIZE = 20;
const MARGIN = 10;
const ADD_STREAK = 2;
const EVICT_STREAK = 3;

function makeRanked(n, borderlineAt) {
  // n symbols ranked 0..n-1 by score (best first). If borderlineAt is given, that symbol
  // alternates between rank (SIZE-1) [comfortably in] and rank (SIZE+2) [just outside topN
  // but still inside topN+margin] every other call — simulates a coin whose score wobbles
  // right around the cutoff line.
  const base = [];
  for (let i = 0; i < n; i++) base.push('SYM' + i);
  return base;
}

(function testStableCoinAddedAfterStreak() {
  const candidateStreaks = new Map();
  const evictStreaks = new Map();
  const currentMembers = new Set();
  const forced = new Set();
  const ranked = makeRanked(30); // SYM0..SYM29, SYM15 always comfortably in top 20

  // Cycle 1: SYM15 in topN for the first time -> streak=1, not yet added.
  let res = MexcCore.computeWatchlistTransitions({
    rankedSymbols: ranked, currentMembers: currentMembers, candidateStreaks: candidateStreaks,
    evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN,
    addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced
  });
  assert(res.toAdd.indexOf('SYM15') === -1, 'cycle 1: a newly-qualifying coin is NOT added immediately (needs ' + ADD_STREAK + ' consecutive cycles)');

  // Cycle 2: still in topN -> streak=2, now added.
  res = MexcCore.computeWatchlistTransitions({
    rankedSymbols: ranked, currentMembers: currentMembers, candidateStreaks: candidateStreaks,
    evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN,
    addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced
  });
  assert(res.toAdd.indexOf('SYM15') !== -1, 'cycle 2: coin decisively in top-' + SIZE + ' for ' + ADD_STREAK + ' consecutive cycles IS added');
})();

(function testBorderlineCoinDoesNotFlap() {
  const candidateStreaks = new Map();
  const evictStreaks = new Map();
  const currentMembers = new Set();
  const forced = new Set();
  let addedCount = 0;
  let evictedCount = 0;

  // Simulate 20 evaluation cycles where BORDER's rank oscillates between just-inside-topN (rank 19)
  // and just-outside-but-within-margin (rank 25) every other cycle — it should never sustain
  // addStreakNeeded consecutive in-range cycles, so it should NEVER be added at all under this
  // adversarial oscillation, let alone flap in and out of the watchlist repeatedly.
  for (let cycle = 0; cycle < 20; cycle++) {
    const others = [];
    for (let i = 0; i < 29; i++) others.push('OTHER' + i);
    const inTopThisCycle = (cycle % 2 === 0);
    const ranked = others.slice(0, 19).concat(inTopThisCycle ? ['BORDER'] : []).concat(others.slice(19)).concat(inTopThisCycle ? [] : ['BORDER']);
    // Ensure BORDER lands at rank 19 (inside top 20) on even cycles, rank ~25 (inside margin, outside topN) on odd cycles.
    const finalRanked = inTopThisCycle
      ? others.slice(0, 19).concat(['BORDER']).concat(others.slice(19))
      : others.slice(0, 25).concat(['BORDER']).concat(others.slice(25));

    const res = MexcCore.computeWatchlistTransitions({
      rankedSymbols: finalRanked, currentMembers: currentMembers, candidateStreaks: candidateStreaks,
      evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN,
      addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced
    });
    res.toAdd.forEach(function (s) { if (s === 'BORDER') { addedCount++; currentMembers.add(s); } });
    res.toEvict.forEach(function (s) { if (s === 'BORDER') { evictedCount++; currentMembers.delete(s); } });
  }
  assert(addedCount === 0, 'a coin oscillating every single cycle between rank 19 and rank 25 is NEVER added (streak never sustains ' + ADD_STREAK + ' in a row) — actual adds: ' + addedCount);
  assert(evictedCount === 0, 'never added, so also never evicted — actual evicts: ' + evictedCount);
})();

(function testMemberEvictedAfterSustainedDropOutsideMargin() {
  const candidateStreaks = new Map();
  const evictStreaks = new Map();
  const currentMembers = new Set(['DROPPED']);
  const forced = new Set();
  const others = [];
  for (let i = 0; i < 40; i++) others.push('OTHER' + i);
  // DROPPED falls all the way to rank 35 — outside topN(20)+margin(10)=30 — and stays there.
  const rankedFarOutside = others.slice(0, 35).concat(['DROPPED']).concat(others.slice(35));

  let res;
  for (let cycle = 1; cycle <= EVICT_STREAK; cycle++) {
    res = MexcCore.computeWatchlistTransitions({
      rankedSymbols: rankedFarOutside, currentMembers: currentMembers, candidateStreaks: candidateStreaks,
      evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN,
      addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced
    });
    if (cycle < EVICT_STREAK) {
      assert(res.toEvict.indexOf('DROPPED') === -1, 'cycle ' + cycle + '/' + EVICT_STREAK + ': not evicted yet (needs ' + EVICT_STREAK + ' consecutive cycles outside margin)');
    }
  }
  assert(res.toEvict.indexOf('DROPPED') !== -1, 'evicted after exactly ' + EVICT_STREAK + ' consecutive cycles outside topN+margin');
})();

(function testMemberRecoveringWithinMarginResetsEvictStreak() {
  const candidateStreaks = new Map();
  const evictStreaks = new Map();
  const currentMembers = new Set(['RECOVERS']);
  const forced = new Set();
  const others = [];
  for (let i = 0; i < 40; i++) others.push('OTHER' + i);
  const rankedFarOutside = others.slice(0, 35).concat(['RECOVERS']).concat(others.slice(35));
  const rankedBackInMargin = others.slice(0, 22).concat(['RECOVERS']).concat(others.slice(22)); // rank 22, within topN(20)+margin(10)

  // 2 cycles outside margin (not yet evicted, streak=2 of 3 needed)
  MexcCore.computeWatchlistTransitions({ rankedSymbols: rankedFarOutside, currentMembers: currentMembers, candidateStreaks: candidateStreaks, evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN, addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced });
  MexcCore.computeWatchlistTransitions({ rankedSymbols: rankedFarOutside, currentMembers: currentMembers, candidateStreaks: candidateStreaks, evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN, addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced });
  assert(evictStreaks.get('RECOVERS') === 2, 'evict streak accumulated to 2 after 2 consecutive bad cycles');

  // Recovers within margin -> streak must reset to 0 (removed from map), not just pause.
  MexcCore.computeWatchlistTransitions({ rankedSymbols: rankedBackInMargin, currentMembers: currentMembers, candidateStreaks: candidateStreaks, evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN, addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced });
  assert(!evictStreaks.has('RECOVERS'), 'recovering within topN+margin resets the evict streak entirely, not just pauses it');
})();

(function testForcedSymbolsAddedImmediatelyAndNeverEvicted() {
  const candidateStreaks = new Map();
  const evictStreaks = new Map();
  const currentMembers = new Set();
  const forced = new Set(['MYFAV']);
  const others = [];
  for (let i = 0; i < 50; i++) others.push('OTHER' + i);
  const rankedFavVeryLow = others.concat(['MYFAV']); // rank 50, nowhere near top 20+10

  const res1 = MexcCore.computeWatchlistTransitions({ rankedSymbols: rankedFavVeryLow, currentMembers: currentMembers, candidateStreaks: candidateStreaks, evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN, addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced });
  assert(res1.toAdd.indexOf('MYFAV') !== -1, 'a forced symbol (favorite/open coin) is added on cycle 1 even ranked last, no streak required');
  currentMembers.add('MYFAV');

  // Many subsequent cycles ranked dead last -> must never be evicted while still forced.
  let everEvicted = false;
  for (let i = 0; i < 10; i++) {
    const res = MexcCore.computeWatchlistTransitions({ rankedSymbols: rankedFavVeryLow, currentMembers: currentMembers, candidateStreaks: candidateStreaks, evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN, addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced });
    if (res.toEvict.indexOf('MYFAV') !== -1) everEvicted = true;
  }
  assert(!everEvicted, 'a forced symbol is never evicted for rank while it stays forced, no matter how many bad cycles pass');
})();

(function testHardCapNeverExceededOnVolatileRankings() {
  // Regression test for a REAL bug caught in live testing: on a volatile market, the top-20 RANKING
  // can be occupied by a completely different set of symbols every cycle (scores fluctuate tick to
  // tick). Without an explicit maxSize, "is this candidate currently within rank 20" alone does NOT
  // bound the total watchlist SIZE — many different symbols can each individually qualify as "in
  // top-20 for 2 consecutive cycles" across a rolling window faster than the (slower, 3-cycle) evict
  // side can catch up, so the list can grow unboundedly. maxSize must hard-cap the total regardless.
  const candidateStreaks = new Map();
  const evictStreaks = new Map();
  const currentMembers = new Set();
  const forced = new Set();
  const MAX_SIZE = 25;
  const POOL = 200; // large pool of distinct symbols to rank from

  const pool = [];
  for (let i = 0; i < POOL; i++) pool.push('SYM' + i);

  let maxObservedSize = 0;
  for (let cycle = 0; cycle < 40; cycle++) {
    // Slide the top-N WINDOW steadily through a large pool (not a full reshuffle every cycle) —
    // this is what actually happened live: rankings drift gradually, so a symbol usually stays
    // within top-N (or top-N+margin) for SEVERAL consecutive cycles before rotating out, which is
    // exactly the condition that let addStreakNeeded (2 cycles) repeatedly outpace evictStreakNeeded
    // (3 cycles) in the real bug — a full random reshuffle every cycle (tried first) under-counts
    // consecutive-cycle membership and doesn't reproduce the growth pressure at all.
    const shift = (cycle * 3) % POOL;
    const ranked = pool.slice(shift).concat(pool.slice(0, shift));
    const res = MexcCore.computeWatchlistTransitions({
      rankedSymbols: ranked, currentMembers: currentMembers, candidateStreaks: candidateStreaks,
      evictStreaks: evictStreaks, size: SIZE, evictMargin: MARGIN,
      addStreakNeeded: ADD_STREAK, evictStreakNeeded: EVICT_STREAK, forced: forced, maxSize: MAX_SIZE
    });
    res.toAdd.forEach(function (s) { currentMembers.add(s); });
    res.toEvict.forEach(function (s) { currentMembers.delete(s); });
    maxObservedSize = Math.max(maxObservedSize, currentMembers.size);
    assert(currentMembers.size <= MAX_SIZE, 'cycle ' + cycle + ': watchlist size (' + currentMembers.size + ') never exceeds the hard cap (' + MAX_SIZE + ') even under constantly-shuffling rankings');
  }
  assert(maxObservedSize > SIZE, 'sanity check: the volatile-ranking scenario actually pressures the list toward growth (observed max ' + maxObservedSize + ' > target size ' + SIZE + '), so the hard cap is genuinely being exercised, not just trivially satisfied');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
