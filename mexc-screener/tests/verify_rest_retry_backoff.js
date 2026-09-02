// Pure logic test, no network — exercises the real withRetry() from web/js/core-utils.js
// (the same function app.js uses to wrap the Finrez /api/v3/myTrades calls).
// Run: node tests/verify_rest_retry_backoff.js

const MexcCore = require('../web/js/core-utils.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

// Use tiny delays so the test runs fast, but still exercises real setTimeout-based backoff.
const DELAYS = [5, 10, 20];

async function testEventualSuccess() {
  let calls = 0;
  const result = await MexcCore.withRetry(function () {
    calls++;
    if (calls < 3) return Promise.reject(new Error('transient failure #' + calls));
    return Promise.resolve('ok-on-attempt-' + calls);
  }, 3, DELAYS, 'test:eventual');
  assert(result === 'ok-on-attempt-3', 'succeeds on the 3rd attempt after 2 transient failures, result=' + result);
  assert(calls === 3, 'made exactly 3 attempts (not fewer, not more), calls=' + calls);
}

async function testGivesUpAfterCap() {
  let calls = 0;
  let caught = null;
  try {
    await MexcCore.withRetry(function () {
      calls++;
      return Promise.reject(new Error('always fails'));
    }, 3, DELAYS, 'test:capped');
  } catch (e) { caught = e; }
  assert(calls === 3, 'gives up after exactly 3 attempts (bounded, never retries forever), calls=' + calls);
  assert(caught && caught.message === 'always fails', 'surfaces the underlying error after giving up');
}

async function testNonRetryableFailsFast() {
  let calls = 0;
  let caught = null;
  const start = Date.now();
  try {
    await MexcCore.withRetry(function () {
      calls++;
      return Promise.reject(new Error('Invalid symbol.'));
    }, 3, DELAYS, 'test:nonretryable', function shouldRetry(err) {
      return !/invalid symbol/i.test(err.message);
    });
  } catch (e) { caught = e; }
  const elapsed = Date.now() - start;
  assert(calls === 1, 'a non-retryable error (Invalid symbol) makes exactly 1 attempt, not ' + calls);
  assert(elapsed < DELAYS[0], 'fails fast, no backoff delay incurred for a non-retryable error (elapsed=' + elapsed + 'ms)');
  assert(caught && /invalid symbol/i.test(caught.message), 'still surfaces the original error message');
}

async function testDelaysAreIncreasing() {
  let calls = 0;
  const timestamps = [];
  try {
    await MexcCore.withRetry(function () {
      timestamps.push(Date.now());
      calls++;
      return Promise.reject(new Error('fail'));
    }, 3, DELAYS, 'test:backoff-shape');
  } catch (e) { /* expected */ }
  const gap1 = timestamps[1] - timestamps[0];
  const gap2 = timestamps[2] - timestamps[1];
  assert(gap1 >= DELAYS[0] - 2 && gap2 >= DELAYS[1] - 2, 'delay between attempt 1->2 (' + gap1 + 'ms) and 2->3 (' + gap2 + 'ms) respect the configured backoff schedule ' + JSON.stringify(DELAYS));
  assert(gap2 > gap1, 'backoff actually increases between attempts (' + gap1 + 'ms -> ' + gap2 + 'ms)');
}

(async function main() {
  await testEventualSuccess();
  await testGivesUpAfterCap();
  await testNonRetryableFailsFast();
  await testDelaysAreIncreasing();
  if (failures) {
    console.error('\n' + failures + ' assertion(s) FAILED');
    process.exit(1);
  } else {
    console.log('\nAll assertions PASSED');
    process.exit(0);
  }
})();
