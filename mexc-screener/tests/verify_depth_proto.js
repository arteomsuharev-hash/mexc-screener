// LIVE / MANUAL ONLY — needs real network access to wbs-api.mexc.com.
// Not part of `npm test` (run_all.js), because it depends on live market data and MEXC being reachable.
// Run manually: node tests/verify_depth_proto.js
//
// Purpose (Phase 0 of the pattern-engine plan): confirm, against one real frame, that MEXC's
// partial-depth WebSocket channel (spot@public.limit.depth.v3.api.pb@<symbol>@20) and the
// wrapper field number we intend to add to app.js's MEXC_PROTO_SRC (publicLimitDepths = 303)
// actually match what the server sends today, before any app.js code depends on it.

const protobuf = require('protobufjs');

if (typeof WebSocket === 'undefined') {
  console.error('FAIL: no global WebSocket in this Node runtime (need Node >= 21). Node version:', process.version);
  process.exit(1);
}

const PROTO_SRC = [
  'syntax = "proto3";',
  'message PublicLimitDepthV3ApiItem {',
  '  string price = 1;',
  '  string quantity = 2;',
  '}',
  'message PublicLimitDepthsV3Api {',
  '  repeated PublicLimitDepthV3ApiItem asks = 1;',
  '  repeated PublicLimitDepthV3ApiItem bids = 2;',
  '  string eventType = 3;',
  '  string version = 4;',
  '  int64 lastOrderCreateTime = 5;',
  '}',
  'message PushDataV3ApiWrapper {',
  '  string channel = 1;',
  '  oneof body {',
  '    PublicLimitDepthsV3Api publicLimitDepths = 303;',
  '  }',
  '  optional string symbol = 3;',
  '  optional string symbolId = 4;',
  '  optional int64 createTime = 5;',
  '  optional int64 sendTime = 6;',
  '}'
].join('\n');

const root = protobuf.parse(PROTO_SRC, { keepCase: true }).root;
const Wrapper = root.lookupType('PushDataV3ApiWrapper');

const SYMBOL = 'BTCUSDT';
const CHANNEL = `spot@public.limit.depth.v3.api.pb@${SYMBOL}@20`;
const TIMEOUT_MS = 15000;

let settled = false;
const ws = new WebSocket('wss://wbs-api.mexc.com/ws');
ws.binaryType = 'arraybuffer';

const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  console.error(`FAIL: no depth frame received for ${SYMBOL} within ${TIMEOUT_MS}ms.`);
  try { ws.close(); } catch (e) {}
  process.exit(1);
}, TIMEOUT_MS);

ws.addEventListener('open', () => {
  console.log('WS open, subscribing to', CHANNEL);
  ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: [CHANNEL] }));
});

ws.addEventListener('message', (event) => {
  if (settled) return;
  const data = event.data;
  if (typeof data === 'string') {
    // control/ack/text frame
    console.log('control frame:', data);
    return;
  }
  let msg;
  try {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    msg = Wrapper.decode(buf);
  } catch (e) {
    settled = true;
    clearTimeout(timer);
    console.error('FAIL: could not decode a binary frame with the proposed schema:', e.message);
    try { ws.close(); } catch (e2) {}
    process.exit(1);
    return;
  }
  if (!msg.publicLimitDepths) {
    // probably some other push type slipping through before subscription confirms; keep waiting
    return;
  }
  settled = true;
  clearTimeout(timer);
  const d = msg.publicLimitDepths;
  console.log('Decoded publicLimitDepths frame:', JSON.stringify({
    channel: msg.channel,
    symbol: msg.symbol,
    eventType: d.eventType,
    version: d.version,
    asksCount: (d.asks || []).length,
    bidsCount: (d.bids || []).length,
    sampleAsk: d.asks && d.asks[0],
    sampleBid: d.bids && d.bids[0]
  }, null, 2));

  const asks = d.asks || [];
  const bids = d.bids || [];
  const ok =
    (asks.length > 0 || bids.length > 0) &&
    [...asks, ...bids].every(item =>
      typeof item.price === 'string' && !isNaN(parseFloat(item.price)) &&
      typeof item.quantity === 'string' && !isNaN(parseFloat(item.quantity))
    );

  try { ws.close(); } catch (e) {}
  if (ok) {
    console.log('PASS: field 303 (publicLimitDepths) decodes with parseable price/quantity strings.');
    process.exit(0);
  } else {
    console.error('FAIL: frame decoded but asks/bids missing or not parseable as price/quantity.');
    process.exit(1);
  }
});

ws.addEventListener('error', (event) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.error('FAIL: WebSocket error:', (event && event.message) || event);
  process.exit(1);
});
