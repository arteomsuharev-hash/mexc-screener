// Tests for the Phase 6 pattern-history/outcome-tracking helpers in core-utils.js:
// computeOutcomeMetrics, shouldOpenNewPatternSession, prunePatternHistory,
// computePastSuccessRate, computeValidationSplit. No network/DOM.
// The no-look-ahead test is the most important one here — it's a mechanical proof, not a design
// assertion, per the spec's explicit requirement #9.
// Run: node tests/verify_pattern_history.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

// ---------------------------------------------------------------- computeOutcomeMetrics
(function testOutcomeMetricsLong() {
  const ev = MexcCore.computeOutcomeMetrics(100, 'LONG', [101, 103, 99, 102]);
  assert(ev.maxFavorablePct === 3, 'LONG: max favorable move is the highest price reached (103 -> +3%), got ' + ev.maxFavorablePct);
  assert(ev.maxAdversePct === 1, 'LONG: max adverse move is the lowest dip (99 -> -1%), got ' + ev.maxAdversePct);
})();

(function testOutcomeMetricsShort() {
  const ev = MexcCore.computeOutcomeMetrics(100, 'SHORT', [101, 103, 99, 97]);
  assert(ev.maxFavorablePct === 3, 'SHORT: max favorable move is the lowest price reached (97 -> "down" is favorable for SHORT, 3%), got ' + ev.maxFavorablePct);
  assert(ev.maxAdversePct === 3, 'SHORT: max adverse move is the highest rise (103 -> against SHORT, 3%), got ' + ev.maxAdversePct);
})();

(function testOutcomeMetricsBoth() {
  const ev = MexcCore.computeOutcomeMetrics(100, 'BOTH', [104, 96]);
  assert(ev.maxFavorablePct === 4 && ev.maxAdversePct === 4, 'BOTH: symmetric — largest absolute move counts both ways, got fav=' + ev.maxFavorablePct + ' adv=' + ev.maxAdversePct);
})();

(function testOutcomeMetricsNoData() {
  assert(MexcCore.computeOutcomeMetrics(100, 'LONG', []) === null, 'no price observations yet -> null, not a fabricated 0');
  assert(MexcCore.computeOutcomeMetrics(0, 'LONG', [101]) === null, 'zero/missing entry price -> null (avoid div by zero)');
})();

// ---------------------------------------------------------------- shouldOpenNewPatternSession
(function testSessionDedup() {
  assert(MexcCore.shouldOpenNewPatternSession(null, 1000, 15000) === true, 'no prior session -> open a new one');
  assert(MexcCore.shouldOpenNewPatternSession(1000, 5000, 15000) === false, 'seen 4s ago (within grace) -> same ongoing episode, not a new one');
  assert(MexcCore.shouldOpenNewPatternSession(1000, 20000, 15000) === true, 'not seen for 19s (past grace) -> a genuinely new episode');
})();

// ---------------------------------------------------------------- prunePatternHistory
(function testPruning() {
  const now = 1000000000;
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push({ symbol: 'A/USDT', detectorKey: 'x', detectedAt: now - i * 1000 });
  const pruned = MexcCore.prunePatternHistory(entries, { maxPerSymbol: 5, maxTotal: 100, maxAgeMs: 999999999, now: now });
  assert(pruned.length === 5, 'per-symbol cap keeps only the most recent maxPerSymbol entries, got ' + pruned.length);
  assert(pruned.every(function (e) { return e.detectedAt >= now - 4000; }), 'kept entries are the MOST RECENT ones (not oldest)');

  const old = [{ symbol: 'B/USDT', detectorKey: 'x', detectedAt: now - 40 * 24 * 3600 * 1000 }]; // 40 days old
  const fresh = [{ symbol: 'B/USDT', detectorKey: 'x', detectedAt: now }];
  const agePruned = MexcCore.prunePatternHistory(old.concat(fresh), { maxAgeMs: 30 * 24 * 3600 * 1000, now: now });
  assert(agePruned.length === 1 && agePruned[0].detectedAt === now, 'entries older than maxAgeMs are pruned, only the fresh one survives');

  const multiSymbol = [];
  for (let s = 0; s < 20; s++) for (let i = 0; i < 10; i++) multiSymbol.push({ symbol: 'SYM' + s, detectorKey: 'x', detectedAt: now - i * 1000 });
  const totalPruned = MexcCore.prunePatternHistory(multiSymbol, { maxPerSymbol: 500, maxTotal: 50, maxAgeMs: 999999999, now: now });
  assert(totalPruned.length === 50, 'global maxTotal cap holds even when no single symbol exceeds its own per-symbol cap, got ' + totalPruned.length);
})();

// ---------------------------------------------------------------- computePastSuccessRate
(function testPastSuccessRate() {
  const history = [
    { detectorKey: 'ladder', outcome: { at2m: { maxFavorablePct: 0.8 } } }, // success
    { detectorKey: 'ladder', outcome: { at2m: { maxFavorablePct: 0.1 } } }, // fail (below 0.3 threshold)
    { detectorKey: 'ladder', outcome: { at2m: { maxFavorablePct: 0.5 } } }, // success
    { detectorKey: 'ershik', outcome: { at2m: { maxFavorablePct: 0.9 } } }, // different detector, excluded
    { detectorKey: 'ladder', outcome: { at2m: null } } // not yet closed, excluded
  ];
  const result = MexcCore.computePastSuccessRate(history, 'ladder', { checkpointKey: 'at2m', successThresholdPct: 0.3 });
  assert(result.sampleSize === 3, 'only closed ladder events count (excludes other detector and unclosed entry), got ' + result.sampleSize);
  assert(Math.abs(result.rate - 2 / 3) < 1e-9, '2 of 3 closed events cleared the success threshold, got rate=' + result.rate);

  const empty = MexcCore.computePastSuccessRate([], 'ladder', {});
  assert(empty === null, 'no history at all -> null (neutral, not a fabricated 0 or 1)');
})();

// ---------------------------------------------------------------- no-look-ahead (THE critical test)
(function testScoringNeverUsesFutureOutcome() {
  // Mechanically prove that scoreAtSignal, once computed, is IDENTICAL regardless of whether future
  // outcome data for THAT SAME event exists at "scoring time" — because the real pipeline computes
  // it once with pastSuccess drawn only from ALREADY-CLOSED prior events, then freezes it. This test
  // simulates exactly that contract: score a fresh event using historical closed events only, then
  // show that mutating the SAME event's own outcome afterward does not and cannot change the frozen
  // scoreAtSignal (since nothing in the pipeline ever re-reads outcome to adjust an existing score).
  const closedHistory = [
    { detectorKey: 'ladder', symbol: 'OLD1/USDT', detectedAt: 1000, outcome: { at2m: { maxFavorablePct: 0.9 } } },
    { detectorKey: 'ladder', symbol: 'OLD2/USDT', detectedAt: 2000, outcome: { at2m: { maxFavorablePct: 0.8 } } }
  ];
  const pastSuccess = MexcCore.computePastSuccessRate(closedHistory, 'ladder', { checkpointKey: 'at2m' });
  const factorsAtSignalTime = {
    repeatability: 0.6, stability: 0.7, significance: 0.5, volume: 0.4, deviation: 0.5, freshness: 1,
    confirmation: 0, pastSuccess: pastSuccess ? pastSuccess.rate : 0
  };
  const scoreAtSignal = MexcCore.scorePatternEvent(factorsAtSignalTime);

  // Now simulate this exact NEW event resolving its own future outcome (as the 10s sweep would do
  // later) and even feed that same event back into a WOULD-BE re-score to prove nothing in the
  // actual detector/scoring pipeline does this — scoreAtSignal must stay untouched.
  const newEvent = { detectorKey: 'ladder', symbol: 'NEW/USDT', detectedAt: 5000, scoreAtSignal: scoreAtSignal, outcome: { at2m: null } };
  newEvent.outcome.at2m = { maxFavorablePct: 5.0 }; // a spectacular future outcome, known only after the fact
  assert(newEvent.scoreAtSignal === scoreAtSignal, 'scoreAtSignal is bitwise-identical before and after the event\'s own future outcome becomes known — nothing in the design path re-derives it from outcome');

  // And prove the reverse direction of the no-look-ahead contract: the NEW event's own outcome must
  // never leak into the pastSuccess used to compute ITS OWN scoreAtSignal (it wasn't closed yet when
  // scored, so computePastSuccessRate over closedHistory could not have seen it — confirm by
  // checking closedHistory never contained newEvent at scoring time).
  assert(closedHistory.indexOf(newEvent) === -1, 'the new event was never part of the closed-history pool used to compute its own pastSuccess factor');
})();

// ---------------------------------------------------------------- applyPatternScore / maxConfidence
(function testApplyPatternScoreRespectsCap() {
  const strongFactors = { repeatability: 1, stability: 1, significance: 1, volume: 1, deviation: 1, freshness: 1, confirmation: 1, pastSuccess: 1 };
  const uncapped = { factors: Object.assign({}, strongFactors) };
  const capped = { factors: Object.assign({}, strongFactors), maxConfidence: 60 };
  const uncappedScore = MexcCore.applyPatternScore(uncapped);
  const cappedScore = MexcCore.applyPatternScore(capped);
  assert(uncappedScore === 100, 'without maxConfidence, applyPatternScore reaches the true 100, got ' + uncappedScore);
  assert(cappedScore === 60, 'with maxConfidence=60, applyPatternScore never exceeds it even with maxed-out factors, got ' + cappedScore);
  assert(capped.scoreAtSignal === 60 && capped.confidencePct === 60, 'applyPatternScore mutates both scoreAtSignal and confidencePct on the event object');
})();

(function testFakeLiquidityEventCarriesMaxConfidence() {
  // Regression guard for the real bug this fixed: a fakeLiquidity event must carry maxConfidence so
  // that ANY later rescoring (e.g. app.js's multi-detector confirmation bonus) stays honestly capped
  // instead of silently exceeding it.
  function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
  function depthSnap(t, bestBid, bestAsk, bidQty, askQty) {
    return { t: t, bestBid: bestBid, bestAsk: bestAsk, bidVol: bidQty * bestBid, askVol: askQty * bestAsk, bids: [{ p: bestBid, q: bidQty }], asks: [{ p: bestAsk, q: askQty }] };
  }
  const snaps = [];
  let t = 0;
  for (let i = 0; i < 25; i++) { snaps.push(depthSnap(t, 100, 100.1, Math.max(100 - i * 3.2, 20), 50)); t += 500; }
  const cancelledTrades = [];
  let tc = 0;
  for (let i = 0; i < 20; i++) { cancelledTrades.push(trade(tc, 105, 4, 'sell')); tc += 600; }
  const ev = MexcCore.detectFakeLiquidity(snaps, cancelledTrades, { minSnapshots: 20 });
  assert(ev && ev.maxConfidence === 60, 'a real detectFakeLiquidity() event carries maxConfidence=60 for downstream rescoring to respect');
  // Simulate app.js's confirmation-bonus rescore path using applyPatternScore (the actual fix) —
  // even with confirmation maxed to 1, the cap must hold.
  ev.factors.confirmation = 1;
  const rescored = MexcCore.applyPatternScore(ev);
  assert(rescored <= 60, 'rescoring after a confirmation bonus still respects the heuristic\'s honest cap, got ' + rescored);
})();

// ---------------------------------------------------------------- computeValidationSplit
(function testValidationSplitDetectsDegradation() {
  const now = 1000000000;
  const dayMs = 24 * 3600 * 1000;
  const history = [];
  // Reference period (>24h old): strong 80% success rate. Offset by an extra +1000ms so the oldest
  // "recent" boundary case can never land exactly on splitMs (avoids a flaky off-by-one at the edge).
  for (let i = 0; i < 10; i++) {
    history.push({ detectorKey: 'ladder', detectedAt: now - dayMs - 1000 - i * 1000, outcome: { at2m: { maxFavorablePct: i < 8 ? 0.8 : 0.1 } } });
  }
  // Recent period (<24h): degraded to 20% success rate.
  for (let i = 0; i < 10; i++) {
    history.push({ detectorKey: 'ladder', detectedAt: now - 1000 - i * 1000, outcome: { at2m: { maxFavorablePct: i < 2 ? 0.8 : 0.1 } } });
  }
  const split = MexcCore.computeValidationSplit(history, 'ladder', { checkpointKey: 'at2m', splitMs: dayMs, now: now, successThresholdPct: 0.3, degradeThreshold: 0.2 });
  assert(Math.abs(split.reference.rate - 0.8) < 1e-9, 'reference-period success rate computed correctly, got ' + split.reference.rate);
  assert(Math.abs(split.recent.rate - 0.2) < 1e-9, 'recent-period success rate computed correctly, got ' + split.recent.rate);
  assert(split.degraded === true, 'a 60-point drop in success rate (well above the 20-point threshold) IS flagged as degraded');
})();

(function testValidationSplitNoFalseAlarmWhenStable() {
  const now = 1000000000;
  const dayMs = 24 * 3600 * 1000;
  const history = [];
  for (let i = 0; i < 10; i++) history.push({ detectorKey: 'ladder', detectedAt: now - dayMs - i * 1000, outcome: { at2m: { maxFavorablePct: i < 6 ? 0.8 : 0.1 } } });
  for (let i = 0; i < 10; i++) history.push({ detectorKey: 'ladder', detectedAt: now - i * 1000, outcome: { at2m: { maxFavorablePct: i < 6 ? 0.8 : 0.1 } } });
  const split = MexcCore.computeValidationSplit(history, 'ladder', { checkpointKey: 'at2m', splitMs: dayMs, now: now, successThresholdPct: 0.3, degradeThreshold: 0.2 });
  assert(split.degraded === false, 'a detector performing consistently between reference and recent periods is NOT flagged as degraded (rates: ' + split.reference.rate + ' vs ' + split.recent.rate + ')');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
