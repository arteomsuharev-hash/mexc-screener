// Pure logic test for the screener table's "hover-freeze" row-order bug fix (rebuildList() in
// app.js). app.js runs as one big DOM-bound IIFE, not requireable from Node, so this mirrors the
// exact rebuildList()/applySortOnly() algorithm byte-for-byte (see the same lines in app.js) rather
// than importing it — keep the two in sync if that logic changes.
//
// The bug: while the user's mouse hovers a table row (tableHoverFreezeSymbol set, meant to keep the
// row under the cursor from jumping around), applySortOnly() correctly skips re-sorting — but the
// OLD rebuildList() unconditionally did `allCoins = Array.from(coinMap.values())` first, which is
// Map insertion order, not the previously-sorted order. So every WS tick while hovering silently
// scrambled the whole table into insertion order, even though the sort-column header still showed
// its arrow — exactly the "sort works, then randomly stops working" report.
// Run: node tests/verify_table_sort_freeze.js

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function applySortOnly(state) {
  state.allCoins.sort(function (a, b) {
    const va = a[state.sortField], vb = b[state.sortField];
    if (va < vb) return state.sortAsc ? -1 : 1;
    if (va > vb) return state.sortAsc ? 1 : -1;
    return 0;
  });
}

// Current (fixed) implementation — mirrors app.js rebuildList().
function rebuildListFixed(state) {
  if (state.tableHoverFreezeSymbol) {
    const known = new Set();
    state.allCoins = state.allCoins.map(function (c) {
      const fresh = state.coinMap.get(c.symbol);
      if (fresh) known.add(c.symbol);
      return fresh || c;
    });
    state.coinMap.forEach(function (c, symbol) { if (!known.has(symbol)) state.allCoins.push(c); });
  } else {
    state.allCoins = Array.from(state.coinMap.values());
  }
  applySortOnly(state);
}

function applySortOnlyGuarded(state) {
  if (state.tableHoverFreezeSymbol) return;
  applySortOnly(state);
}

function rebuildListFixedGuarded(state) {
  if (state.tableHoverFreezeSymbol) {
    const known = new Set();
    state.allCoins = state.allCoins.map(function (c) {
      const fresh = state.coinMap.get(c.symbol);
      if (fresh) known.add(c.symbol);
      return fresh || c;
    });
    state.coinMap.forEach(function (c, symbol) { if (!known.has(symbol)) state.allCoins.push(c); });
  } else {
    state.allCoins = Array.from(state.coinMap.values());
  }
  applySortOnlyGuarded(state);
}

// The OLD (buggy) implementation, kept here only to prove the test actually catches the bug.
function rebuildListBuggy(state) {
  state.allCoins = Array.from(state.coinMap.values());
  applySortOnlyGuarded(state);
}

function makeCoin(symbol, change24) {
  return { symbol: symbol, change24: change24 };
}

function freshState() {
  const coinMap = new Map();
  ['E', 'D', 'C', 'B', 'A'].forEach(function (s, i) { coinMap.set(s, makeCoin(s, i)); }); // deliberately NOT insertion-sorted by value
  return { coinMap: coinMap, allCoins: [], sortField: 'change24', sortAsc: false, tableHoverFreezeSymbol: null };
}

(function testInitialSortWorks() {
  const state = freshState();
  rebuildListFixedGuarded(state);
  const order = state.allCoins.map(function (c) { return c.symbol; });
  assert(JSON.stringify(order) === JSON.stringify(['A', 'B', 'C', 'D', 'E']), 'unfrozen: sorts descending by change24, got ' + order.join(','));
})();

(function testFreezePreservesOrderAcrossTicks() {
  const state = freshState();
  rebuildListFixedGuarded(state); // sorted: A,B,C,D,E
  const frozenOrder = state.allCoins.map(function (c) { return c.symbol; });
  state.tableHoverFreezeSymbol = 'C'; // user hovers row C

  // Several WS ticks land while frozen — values change (even flip the "true" sort order upside down)
  // and one new coin arrives.
  state.coinMap.set('A', makeCoin('A', -50));
  state.coinMap.set('D', makeCoin('D', 999));
  state.coinMap.set('F', makeCoin('F', 500)); // brand-new coin, never seen before
  rebuildListFixedGuarded(state);
  rebuildListFixedGuarded(state);
  rebuildListFixedGuarded(state);

  const orderAfter = state.allCoins.map(function (c) { return c.symbol; });
  assert(JSON.stringify(orderAfter.slice(0, 5)) === JSON.stringify(frozenOrder),
    'frozen: the 5 pre-existing rows keep their exact pre-freeze position across multiple ticks, got ' + orderAfter.join(','));
  assert(orderAfter[5] === 'F', 'frozen: a genuinely new coin is appended at the end, not spliced into the middle, got position of F=' + orderAfter.indexOf('F'));
  assert(orderAfter.length === 6, 'frozen: no coin silently dropped, got length=' + orderAfter.length);

  const freshA = state.allCoins.filter(function (c) { return c.symbol === 'A'; })[0];
  assert(freshA.change24 === -50, 'frozen: row VALUES still update live (A.change24=-50), only ORDER is frozen, got ' + freshA.change24);
})();

(function testUnfreezeResortsCorrectly() {
  const state = freshState();
  rebuildListFixedGuarded(state);
  state.tableHoverFreezeSymbol = 'C';
  state.coinMap.set('A', makeCoin('A', -50));
  state.coinMap.set('D', makeCoin('D', 999));
  rebuildListFixedGuarded(state);
  state.tableHoverFreezeSymbol = null; // mouse leaves the table
  rebuildListFixedGuarded(state);
  const order = state.allCoins.map(function (c) { return c.symbol; });
  assert(JSON.stringify(order) === JSON.stringify(['D', 'B', 'C', 'E', 'A']), 'unfrozen again: immediately re-sorts by the latest values, got ' + order.join(','));
})();

(function testOldImplementationWasActuallyBroken() {
  const state = freshState();
  rebuildListBuggy(state);
  state.tableHoverFreezeSymbol = 'C';
  rebuildListBuggy(state);
  const order = state.allCoins.map(function (c) { return c.symbol; });
  // coinMap insertion order was E,D,C,B,A (see freshState) — the old code collapses to exactly that
  // the instant the freeze engages, regardless of what was actually on screen before.
  assert(JSON.stringify(order) === JSON.stringify(['E', 'D', 'C', 'B', 'A']),
    'sanity check: the OLD buggy rebuildList really does collapse to raw Map insertion order while frozen (proves this test would have caught the real bug), got ' + order.join(','));
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
