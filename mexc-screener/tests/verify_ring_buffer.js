// Pure logic test for MexcCore.pushRing — the generic capped ring buffer used by the Tier-2
// pattern-engine buffers (tier2Trades / tier2Depth in app.js). No network/DOM.
// Run: node tests/verify_ring_buffer.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

(function testAppendsUnderCap() {
  const map = new Map();
  MexcCore.pushRing(map, 'BTCUSDT', 1, 5);
  MexcCore.pushRing(map, 'BTCUSDT', 2, 5);
  MexcCore.pushRing(map, 'BTCUSDT', 3, 5);
  assert(JSON.stringify(map.get('BTCUSDT')) === '[1,2,3]', 'appends in order while under cap');
})();

(function testEvictsOldestFirst() {
  const map = new Map();
  for (let i = 1; i <= 10; i++) MexcCore.pushRing(map, 'ETHUSDT', i, 5);
  const arr = map.get('ETHUSDT');
  assert(arr.length === 5, 'never exceeds cap (length=' + arr.length + ')');
  assert(JSON.stringify(arr) === '[6,7,8,9,10]', 'evicts oldest-first (FIFO), kept the 5 most recent: ' + JSON.stringify(arr));
})();

(function testIndependentKeys() {
  const map = new Map();
  MexcCore.pushRing(map, 'A', 'x', 3);
  MexcCore.pushRing(map, 'B', 'y', 3);
  assert(map.get('A').length === 1 && map.get('B').length === 1, 'different keys keep independent buffers');
})();

(function testExactlyAtCap() {
  const map = new Map();
  for (let i = 1; i <= 5; i++) MexcCore.pushRing(map, 'X', i, 5);
  assert(map.get('X').length === 5, 'exactly at cap keeps all items, no premature eviction');
  MexcCore.pushRing(map, 'X', 6, 5);
  assert(JSON.stringify(map.get('X')) === '[2,3,4,5,6]', 'one push past cap evicts exactly one (oldest)');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
