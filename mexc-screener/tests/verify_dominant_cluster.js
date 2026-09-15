// Pure logic test for MexcCore.findDominantCluster — the shared tolerance-band clustering used by
// both the repeated-trade-size and repeated-interval detectors (same math, different input array).
// No network/DOM.
// Run: node tests/verify_dominant_cluster.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

(function testFindsObviousCluster() {
  // 8 trades around $200 (tight), plus scattered noise.
  const values = [200, 205, 198, 202, 195, 210, 199, 203, 15, 4200, 88, 630];
  const cluster = MexcCore.findDominantCluster(values, 0.15);
  assert(cluster.count === 8, 'finds all 8 clustered values (~$195-210, within ±15%), got count=' + cluster.count);
  assert(cluster.representative > 195 && cluster.representative < 210, 'representative value (median of cluster) is inside the cluster range, got ' + cluster.representative);
})();

(function testNoClusterInPureNoise() {
  // Values spread out so no window of 2+ stays within a 15% band of each other.
  const values = [10, 30, 90, 270, 810, 2430, 7290];
  const cluster = MexcCore.findDominantCluster(values, 0.15);
  assert(cluster.count === 1, 'geometrically spread-out values with no close pair -> largest "cluster" is just 1 value, got ' + cluster.count);
})();

(function testToleranceBandMatchesSpecExample() {
  // Spec's own example: 240s cycle -> tolerance band 210-270s (±12.5%, well within a 15% band).
  const intervals = [238, 241, 235, 244, 239, 237, 242, 240, 500, 12]; // 8 clustered near 240s + 2 outliers
  const cluster = MexcCore.findDominantCluster(intervals, 0.15);
  assert(cluster.count === 8, 'clusters the 8 intervals near 240s the same way the spec\'s own worked example expects, got ' + cluster.count);
  assert(cluster.min >= 235 && cluster.max <= 244, 'cluster bounds match the tight interval group, not the outliers (min=' + cluster.min + ', max=' + cluster.max + ')');
})();

(function testEmptyAndSingleValue() {
  assert(MexcCore.findDominantCluster([], 0.15) === null, 'empty array returns null, not a crash');
  assert(MexcCore.findDominantCluster([100], 0.15) === null, 'a single value returns null (nothing to cluster against)');
})();

(function testTighterToleranceFindsSmallerCluster() {
  const values = [100, 105, 110, 115, 120]; // each ~5% apart from its neighbor
  const loose = MexcCore.findDominantCluster(values, 0.25); // 25% band should catch all 5
  const tight = MexcCore.findDominantCluster(values, 0.04); // 4% band should only catch adjacent pairs
  assert(loose.count === 5, 'a generous tolerance clusters all 5 gradually-increasing values together, got ' + loose.count);
  assert(tight.count < 5, 'a tight tolerance does NOT lump values that are 5%+ apart into one cluster, got ' + tight.count);
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
