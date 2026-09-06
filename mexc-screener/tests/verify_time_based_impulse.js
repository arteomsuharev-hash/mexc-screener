// Synthetic-data tests for the time-bucket helpers (core-utils.js) — Algorithm #16. Never assumes
// a fixed cycle length up front (buckets are hour + 15-minute granularity, used as measurement
// resolution, not a hypothesis) and REQUIRES a minimum number of real observations before a
// bucket is considered reliable (spec's explicit requirement — "if there were only 2 matches, the
// pattern is not considered reliable").
// Run: node tests/verify_time_based_impulse.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

(function testBucketKeyGranularity() {
  const d1 = new Date(Date.UTC(2026, 0, 1, 10, 14, 0));
  const d2 = new Date(Date.UTC(2026, 0, 1, 10, 16, 0));
  const d3 = new Date(Date.UTC(2026, 0, 1, 11, 14, 0));
  assert(MexcCore.timeBucketKeyFromDate(d1) === '10:00', 'minute 14 falls into the :00 quarter-hour bucket, got ' + MexcCore.timeBucketKeyFromDate(d1));
  assert(MexcCore.timeBucketKeyFromDate(d2) === '10:15', 'minute 16 falls into the :15 quarter-hour bucket, got ' + MexcCore.timeBucketKeyFromDate(d2));
  assert(MexcCore.timeBucketKeyFromDate(d3) === '11:00', 'a different hour produces a different bucket key, got ' + MexcCore.timeBucketKeyFromDate(d3));
})();

(function testFewObservationsIsNotReliableYet() {
  let stats = null;
  stats = MexcCore.recordTimeBucketObservation(stats, { volumeUsd: 400000, movePct: 0.02 });
  stats = MexcCore.recordTimeBucketObservation(stats, { volumeUsd: 380000, movePct: 0.018 });
  const ev = MexcCore.detectTimeBasedImpulse(stats, 100000, 100, { minObservations: 10 });
  assert(ev === null, 'only 2 real observations (below minObservations) -> pattern not considered reliable yet, per spec');
})();

(function testEnoughObservationsWithStrongUpwardBiasAndVolumeFires() {
  let stats = null;
  for (let i = 0; i < 12; i++) {
    // 10 of 12 windows moved up with a much bigger volume than the coin's overall typical volume.
    stats = MexcCore.recordTimeBucketObservation(stats, { volumeUsd: 380000, movePct: i < 10 ? 0.02 : -0.01 });
  }
  const ev = MexcCore.detectTimeBasedImpulse(stats, 100000, 42.5, { minObservations: 10 });
  assert(ev !== null, 'enough real observations with a strong, consistent upward bias and volume multiplier IS detected');
  if (ev) {
    assert(ev.detectorKey === 'timeBasedImpulse', 'event carries the correct detectorKey');
    assert(ev.eventType === 'TIME_PATTERN_LONG', 'carries the correct eventType, got ' + ev.eventType);
    assert(ev.direction === 'LONG', 'consistent upward bias reports LONG, got ' + ev.direction);
    assert(ev.observations === 12, 'reports the real observation count, got ' + ev.observations);
    assert(ev.volumeMultiplier > 1, 'reports a real volume multiplier vs the coin\'s overall median, got ' + ev.volumeMultiplier);
  }
})();

(function testBalancedDirectionDoesNotFireDespiteEnoughObservations() {
  let stats = null;
  for (let i = 0; i < 12; i++) {
    stats = MexcCore.recordTimeBucketObservation(stats, { volumeUsd: 380000, movePct: i % 2 === 0 ? 0.02 : -0.02 });
  }
  const ev = MexcCore.detectTimeBasedImpulse(stats, 100000, 42.5, { minObservations: 10 });
  assert(ev === null, 'enough observations but no consistent directional bias (50/50) -> no signal');
})();

(function testNoVolumeAnomalyDoesNotFireDespiteBias() {
  let stats = null;
  for (let i = 0; i < 12; i++) {
    // Strong directional bias but ordinary volume (no real "this time slot is special" signal).
    stats = MexcCore.recordTimeBucketObservation(stats, { volumeUsd: 100000, movePct: i < 10 ? 0.02 : -0.01 });
  }
  const ev = MexcCore.detectTimeBasedImpulse(stats, 100000, 42.5, { minObservations: 10 });
  assert(ev === null, 'a directional bias without an unusual volume multiplier for this time bucket does not fire');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
