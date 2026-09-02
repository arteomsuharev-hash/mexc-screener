// Pure logic test for compareVersions() — the version-comparison function that decides whether the
// "Проверить обновления" button on the Settings page should offer a download (see checkForAppUpdate()
// in app.js). app.js runs as one big DOM-bound IIFE, not requireable from Node, so this mirrors the
// function byte-for-byte (keep in sync if that logic changes) rather than importing it — same
// convention as the other tests in this folder.
// Run: node tests/verify_update_version_compare.js

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

// Mirrors compareVersions() in app.js exactly.
function compareVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const pb = String(b || '0').replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

(function testEqualVersions() {
  assert(compareVersions('1.0.0', '1.0.0') === 0, 'identical versions compare equal');
  assert(compareVersions('v1.2.3', '1.2.3') === 0, 'a leading "v" (GitHub tag style) is stripped before comparing');
})();

(function testSimpleNewer() {
  assert(compareVersions('1.1.0', '1.0.0') === 1, 'minor bump is newer, got ' + compareVersions('1.1.0', '1.0.0'));
  assert(compareVersions('2.0.0', '1.9.9') === 1, 'major bump beats a higher minor/patch, got ' + compareVersions('2.0.0', '1.9.9'));
  assert(compareVersions('1.0.1', '1.0.0') === 1, 'patch bump is newer, got ' + compareVersions('1.0.1', '1.0.0'));
})();

(function testSimpleOlder() {
  assert(compareVersions('1.0.0', '1.1.0') === -1, 'older minor compares behind, got ' + compareVersions('1.0.0', '1.1.0'));
  assert(compareVersions('1.9.9', '2.0.0') === -1, 'older major compares behind despite higher minor/patch, got ' + compareVersions('1.9.9', '2.0.0'));
})();

(function testDifferentSegmentCounts() {
  // A release tagged "1.2" vs. an app version "1.2.0" (or vice versa) must not be treated as
  // "newer" just because it has fewer/more dot-separated parts — missing segments count as 0.
  assert(compareVersions('1.2', '1.2.0') === 0, '"1.2" and "1.2.0" are the same version, got ' + compareVersions('1.2', '1.2.0'));
  assert(compareVersions('1.2.1', '1.2') === 1, '"1.2.1" is newer than "1.2" (missing patch = 0), got ' + compareVersions('1.2.1', '1.2'));
  assert(compareVersions('1', '1.0.0') === 0, 'a bare major-only version equals its fully-padded form, got ' + compareVersions('1', '1.0.0'));
})();

(function testGarbageIsSafe() {
  // A malformed tag_name (or the update check running before APP_VERSION is ever set) must never
  // throw or produce NaN comparisons — checkForAppUpdate() has no other guard around this call.
  assert(compareVersions('', '1.0.0') === -1, 'empty string treated as 0.0.0 (older), got ' + compareVersions('', '1.0.0'));
  assert(compareVersions(undefined, '1.0.0') === -1, 'undefined treated as 0.0.0 (older), got ' + compareVersions(undefined, '1.0.0'));
  assert(compareVersions('abc', 'def') === 0, 'non-numeric junk on both sides compares equal (both parse to 0), got ' + compareVersions('abc', 'def'));
})();

(function testDoubleDigitSegmentsDontConfuseLexicalSort() {
  // A naive string comparison would say "1.9.0" > "1.10.0" (lexical '9' > '1') — this must not
  // happen since versions compare numerically per segment.
  assert(compareVersions('1.10.0', '1.9.0') === 1, '1.10.0 is numerically newer than 1.9.0, not lexically older, got ' + compareVersions('1.10.0', '1.9.0'));
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
