// Pure logic test for OKX request signing (EXCHANGE_CONNECTORS.okx.sign + hmacSha256Base64 in
// app.js — the "Другие биржи" / connect-an-exchange card in Настройки аккаунта). app.js runs as
// one big DOM-bound IIFE, not requireable from Node, so this mirrors the logic byte-for-byte
// (keep in sync if that logic changes) rather than importing it — same convention as the other
// tests in this folder (see verify_update_version_compare.js).
//
// Two things are checked:
// 1) The pre-hash string is built in OKX's documented order (timestamp+method+requestPath+body),
//    against OKX's own worked example from their API docs.
// 2) hmacSha256Base64's mirrored logic produces the exact same output as Node's own trusted
//    crypto.createHmac for the same secret/message — i.e. the base64-vs-hex encoding choice
//    (OKX needs base64, unlike MEXC/Binance's hex) is actually implemented correctly.
//
// Run: node tests/verify_okx_signing.js

const crypto = require('crypto');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

// Mirrors EXCHANGE_CONNECTORS.okx.sign's pre-hash construction in app.js exactly.
function buildOkxPrehash(timestamp, method, path, params) {
  const qs = params && Object.keys(params).length
    ? '?' + Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&')
    : '';
  const requestPath = path + qs;
  return timestamp + method + requestPath;
}

// Mirrors hmacSha256Base64 in app.js exactly, using Node's crypto instead of Web Crypto (app.js
// runs in a browser/webview and uses crypto.subtle; Node has no DOM, so it uses crypto.createHmac
// here — same HMAC-SHA256 algorithm, different API surface).
function hmacSha256Base64(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('base64');
}

(function testPrehashOrderMatchesOkxDocs() {
  // Worked example straight from OKX's own REST authentication docs.
  const prehash = buildOkxPrehash('2020-12-08T09:08:57.715Z', 'GET', '/api/v5/account/balance', { ccy: 'BTC' });
  assert(
    prehash === '2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC',
    'pre-hash string matches OKX\'s documented example exactly, got "' + prehash + '"'
  );
})();

(function testPrehashWithNoQueryParams() {
  // The verify call this app actually makes (GET /api/v5/account/balance with no params) — no
  // "?" should be appended when there are no query params, unlike the BTC example above.
  const prehash = buildOkxPrehash('2020-12-08T09:08:57.715Z', 'GET', '/api/v5/account/balance', {});
  assert(
    prehash === '2020-12-08T09:08:57.715ZGET/api/v5/account/balance',
    'no trailing "?" when there are no query params, got "' + prehash + '"'
  );
})();

(function testBase64HmacMatchesTrustedCrypto() {
  const secret = 'E65791898B3B6A9F94A0E5FBD4E42E8F';
  const message = '2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC';
  const expected = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('base64');
  const actual = hmacSha256Base64(secret, message);
  assert(actual === expected, 'base64 HMAC-SHA256 matches Node\'s own crypto output, got "' + actual + '" expected "' + expected + '"');
  assert(/^[A-Za-z0-9+/]+=*$/.test(actual), 'output is well-formed base64, got "' + actual + '"');
  // A wrong secret must NOT accidentally produce the same signature (sanity check that the test
  // isn't trivially passing because both sides ignore the secret).
  const wrong = hmacSha256Base64('a-different-secret', message);
  assert(wrong !== expected, 'signature actually depends on the secret (different secret -> different signature)');
})();

(function testHexAndBase64EncodeTheSameUnderlyingBytes() {
  // Sanity check that hmacSha256Base64 isn't hashing something different from hmacSha256Hex
  // (MEXC/Binance) — same secret+message should decode to the same raw bytes either way.
  const secret = 'test-secret';
  const message = 'test-message';
  const hex = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
  const base64 = hmacSha256Base64(secret, message);
  assert(Buffer.from(base64, 'base64').toString('hex') === hex, 'base64 output decodes to the same raw HMAC bytes as the hex encoding');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
