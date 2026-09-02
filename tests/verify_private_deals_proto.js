// Pure schema test (no network) for the PrivateDealsV3Api addition to app.js's inlined
// MEXC_PROTO_SRC (spot@private.deals.v3.api.pb, wrapper field 306) — added to auto-discover which
// symbols a scalping/day-trading account has ever traded (see startPrivateDealsStream/handlePrivateDeal
// in app.js), without relying on the user manually searching each symbol on the "Сделки" tab first.
//
// Field numbers/message shape are taken from MEXC's own proto repo (mexcdevelop/websocket-proto:
// PrivateDealsV3Api.proto, PushDataV3ApiWrapper.proto) and cross-checked against the sample payload
// on MEXC's public API docs (Websocket User Data Streams → Spot Account Deals). This file intentionally
// duplicates the schema (same convention as verify_depth_proto.js) rather than importing it — app.js
// runs as one big DOM-bound IIFE and isn't requireable from Node. Keep this in sync with MEXC_PROTO_SRC
// in app.js if that schema changes.
// Run: node tests/verify_private_deals_proto.js

const protobuf = require('protobufjs');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

const PROTO_SRC = [
  'syntax = "proto3";',
  'message PublicMiniTickerV3Api {',
  '  string symbol = 1;',
  '  string price = 2;',
  '}',
  'message PrivateDealsV3Api {',
  '  string price = 1;',
  '  string quantity = 2;',
  '  string amount = 3;',
  '  int32 tradeType = 4;',
  '  bool isMaker = 5;',
  '  bool isSelfTrade = 6;',
  '  string tradeId = 7;',
  '  string clientOrderId = 8;',
  '  string orderId = 9;',
  '  string feeAmount = 10;',
  '  string feeCurrency = 11;',
  '  int64 time = 12;',
  '}',
  'message PushDataV3ApiWrapper {',
  '  string channel = 1;',
  '  oneof body {',
  '    PrivateDealsV3Api privateDeals = 306;',
  '    PublicMiniTickerV3Api publicMiniTicker = 309;',
  '  }',
  '  optional string symbol = 3;',
  '  optional string symbolId = 4;',
  '  optional int64 createTime = 5;',
  '  optional int64 sendTime = 6;',
  '}'
].join('\n');

const root = protobuf.parse(PROTO_SRC, { keepCase: true }).root;
const Wrapper = root.lookupType('PushDataV3ApiWrapper');

(function testSchemaParsesAndFieldNumberIsCorrect() {
  const field = Wrapper.fields.privateDeals;
  assert(!!field, 'PushDataV3ApiWrapper has a "privateDeals" field at all');
  assert(field && field.id === 306, 'privateDeals field number is exactly 306 (per PushDataV3ApiWrapper.proto), got ' + (field && field.id));
})();

// Matches the exact sample payload from MEXC's own docs (Websocket User Data Streams → Spot Account
// Deals), so a decode mismatch here means our field layout genuinely disagrees with MEXC's real wire format.
(function testRoundTripsMexcSampleDeal() {
  const payload = {
    channel: 'spot@private.deals.v3.api.pb',
    symbol: 'MXUSDT',
    sendTime: 1736417034332,
    privateDeals: {
      price: '3.6962',
      quantity: '1',
      amount: '3.6962',
      tradeType: 2, // 1=Buy, 2=Sell per MEXC docs
      isMaker: false,
      isSelfTrade: false,
      tradeId: '505979017439002624X1',
      clientOrderId: '',
      orderId: 'C02__505979017439002624115',
      feeAmount: '0.0003998377369698171',
      feeCurrency: 'MX',
      time: 1736417034280
    }
  };
  const err = Wrapper.verify(payload);
  assert(!err, 'MEXC sample payload is valid against our schema, got: ' + err);

  const encoded = Wrapper.encode(Wrapper.create(payload)).finish();
  const decoded = Wrapper.toObject(Wrapper.decode(encoded), { longs: Number, defaults: false });

  assert(decoded.symbol === 'MXUSDT', 'symbol round-trips, got ' + decoded.symbol);
  assert(!!decoded.privateDeals, 'privateDeals sub-message round-trips at all');
  assert(decoded.privateDeals.price === '3.6962', 'price round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.price));
  assert(decoded.privateDeals.quantity === '1', 'quantity round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.quantity));
  assert(decoded.privateDeals.tradeType === 2, 'tradeType (2=Sell) round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.tradeType));
  assert(decoded.privateDeals.tradeId === '505979017439002624X1', 'tradeId round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.tradeId));
  assert(decoded.privateDeals.orderId === 'C02__505979017439002624115', 'orderId round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.orderId));
  assert(decoded.privateDeals.feeAmount === '0.0003998377369698171', 'feeAmount round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.feeAmount));
  assert(decoded.privateDeals.feeCurrency === 'MX', 'feeCurrency round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.feeCurrency));
  assert(decoded.privateDeals.isMaker === false, 'isMaker round-trips, got ' + (decoded.privateDeals && decoded.privateDeals.isMaker));
})();

// Regression check: adding privateDeals=306 to the oneof must not disturb decoding of the pre-existing
// public channels that share the same wrapper (e.g. publicMiniTicker=309) — a oneof field number typo
// colliding with an existing one would silently corrupt unrelated market-data decoding.
(function testExistingPublicChannelStillDecodesUnaffected() {
  const payload = { channel: 'spot@public.miniTicker.v3.api.pb@BTCUSDT', symbol: 'BTCUSDT', publicMiniTicker: { symbol: 'BTCUSDT', price: '65000.5' } };
  const err = Wrapper.verify(payload);
  assert(!err, 'existing publicMiniTicker payload still valid against the extended schema, got: ' + err);
  const decoded = Wrapper.toObject(Wrapper.decode(Wrapper.encode(Wrapper.create(payload)).finish()), { longs: Number, defaults: false });
  assert(decoded.publicMiniTicker && decoded.publicMiniTicker.price === '65000.5', 'publicMiniTicker still round-trips correctly after adding privateDeals to the oneof, got ' + JSON.stringify(decoded.publicMiniTicker));
  assert(!decoded.privateDeals, 'a publicMiniTicker frame does not spuriously populate privateDeals (oneof — only one body member set at a time)');
})();

// A frame with an unrecognized/garbage body (e.g. a channel this app doesn't handle yet) must decode
// to "no privateDeals present" rather than throw — handlePrivateDeal()'s callers rely on this to just
// silently ignore it (see decodeProtoFrame's try/catch and the `if (!obj || !obj.privateDeals...)` guard).
(function testMissingBodyDoesNotThrow() {
  const payload = { channel: 'spot@public.miniTicker.v3.api.pb@BTCUSDT' };
  let decoded = null, threw = null;
  try {
    decoded = Wrapper.toObject(Wrapper.decode(Wrapper.encode(Wrapper.create(payload)).finish()), { longs: Number, defaults: false });
  } catch (e) { threw = e; }
  assert(!threw, 'a wrapper frame with no oneof body set decodes without throwing, got: ' + (threw && threw.message));
  assert(decoded && !decoded.privateDeals, 'no privateDeals on a frame that never set it');
})();

if (failures) {
  console.error('\n' + failures + ' assertion(s) FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
  process.exit(0);
}
