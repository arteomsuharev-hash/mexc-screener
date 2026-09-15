// Pure logic test for MexcCore's per-coin adaptive threshold math (median/MAD/robustZScore) — the
// mechanism behind spec requirement #10 ("adaptive thresholds per coin, not the same number for
// every coin"). No network/DOM.
// Run: node tests/verify_adaptive_threshold.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

(function testMedianBasic() {
  assert(MexcCore.median([1, 2, 3]) === 2, 'median of odd-length array is the middle element');
  assert(MexcCore.median([1, 2, 3, 4]) === 2.5, 'median of even-length array averages the two middle elements');
  assert(MexcCore.median([]) === 0, 'median of empty array is 0 (safe default, not NaN)');
})();

(function testMadRobustToOutliers() {
  // Spec's own example (#10): mostly ~$500 trades with a handful of $50,000 outliers.
  const mostlyNormal = [];
  for (let i = 0; i < 95; i++) mostlyNormal.push(480 + Math.random() * 40); // ~$480-520
  const withOutliers = mostlyNormal.concat([50000, 51000, 49500, 52000, 50500]); // 5 outliers

  const med = MexcCore.median(withOutliers);
  const mad = MexcCore.medianAbsoluteDeviation(withOutliers, med);

  // Naive mean/stdev comparison — demonstrates the robustness claim concretely, not just asserts it.
  const mean = withOutliers.reduce(function (a, b) { return a + b; }, 0) / withOutliers.length;
  const variance = withOutliers.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / withOutliers.length;
  const stdev = Math.sqrt(variance);

  assert(med > 400 && med < 600, 'median stays anchored near the typical $500 trade size despite 5% outliers, got ' + med.toFixed(0));
  assert(mean > 2000, 'for comparison: naive MEAN is dragged far above the typical size by the outliers, got ' + mean.toFixed(0) + ' (this is exactly the failure mode median/MAD avoids)');
  assert(mad < 100, 'MAD stays small (reflects the tight cluster of normal trades), got ' + mad.toFixed(0));
  assert(stdev > 5000, 'for comparison: naive STDEV is blown up by the outliers to ' + stdev.toFixed(0) + ' — a threshold built on this would barely ever trigger on the normal trades');
})();

(function testRobustZScoreDetectsOutlier() {
  const normal = [];
  for (let i = 0; i < 50; i++) normal.push(500 + (Math.random() - 0.5) * 20); // tight cluster ~490-510
  const zNormal = MexcCore.robustZScore(505, normal);
  const zOutlier = MexcCore.robustZScore(50000, normal);
  assert(Math.abs(zNormal) < 2, 'a value inside the normal cluster gets a low |z| score, got ' + zNormal.toFixed(2));
  assert(Math.abs(zOutlier) > 10, 'a genuine outlier (100x the median) gets a very high |z| score, got ' + zOutlier.toFixed(2));
})();

(function testDifferentCoinsGetDifferentThresholds() {
  // Spec's literal example: "volume > 4.2 x median_volume_for_this_coin" — same RULE, different
  // ABSOLUTE threshold per coin because each coin's own median differs.
  const quietCoinTrades = [10, 12, 9, 11, 10, 13, 8]; // median ~10
  const activeCoinTrades = [5000, 5200, 4800, 5100, 4900]; // median ~5000
  const quietMedian = MexcCore.median(quietCoinTrades);
  const activeMedian = MexcCore.median(activeCoinTrades);
  const quietThreshold = quietMedian * 4.2;
  const activeThreshold = activeMedian * 4.2;
  assert(quietThreshold !== activeThreshold, 'the same 4.2x-median rule produces a DIFFERENT absolute threshold per coin (' + quietThreshold.toFixed(0) + ' vs ' + activeThreshold.toFixed(0) + '), not one fixed number for the whole market');
  assert(quietThreshold < 100 && activeThreshold > 15000, 'each threshold is properly scaled to its own coin\'s typical activity level');
})();

(function testDegenerateAllIdenticalValues() {
  const z = MexcCore.robustZScore(5, [5, 5, 5, 5, 5]);
  assert(z === 0, 'zero variance + value equals the constant -> z-score is exactly 0, not NaN/Infinity, got ' + z);
  const zOff = MexcCore.robustZScore(10, [5, 5, 5, 5, 5]);
  assert(Number.isFinite(zOff) && zOff > 0, 'zero variance + a different value -> a large but FINITE z-score, not NaN/Infinity, got ' + zOff);
})();

(function testScorePatternEventWeightsSumToOne() {
  const total = Object.keys(MexcCore.PATTERN_SCORE_WEIGHTS).reduce(function (a, k) { return a + MexcCore.PATTERN_SCORE_WEIGHTS[k]; }, 0);
  assert(Math.abs(total - 1) < 1e-9, 'PATTERN_SCORE_WEIGHTS sum to exactly 1.0 (so scorePatternEvent with all factors=1 gives exactly 100), got ' + total);
})();

(function testScorePatternEventRange() {
  const allZero = MexcCore.scorePatternEvent({});
  const allOne = MexcCore.scorePatternEvent({ repeatability: 1, stability: 1, significance: 1, volume: 1, deviation: 1, freshness: 1, confirmation: 1, pastSuccess: 1 });
  assert(allZero === 0, 'no factors present -> score is 0, got ' + allZero);
  assert(allOne === 100, 'every factor maxed at 1.0 -> score is exactly 100, got ' + allOne);
  const clamped = MexcCore.scorePatternEvent({ repeatability: 5, stability: -3 }); // out-of-range inputs must be clamped, not break the formula
  assert(clamped >= 0 && clamped <= 100, 'out-of-range factor values (5, -3) are clamped into [0,1] before weighting, score stays in [0,100], got ' + clamped);
})();

(function testScorePatternEventMonotonic() {
  const low = MexcCore.scorePatternEvent({ repeatability: 0.2, stability: 0.2, significance: 0.2 });
  const high = MexcCore.scorePatternEvent({ repeatability: 0.9, stability: 0.9, significance: 0.9 });
  assert(high > low, 'increasing every factor strictly increases the score (' + low + ' -> ' + high + ')');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
