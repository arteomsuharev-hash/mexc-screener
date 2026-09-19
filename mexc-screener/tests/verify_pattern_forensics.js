// Regression-тесты для Forensic Event Recorder (2026-09): доказывают, что forensic record реально
// содержит raw evidence (trades/depth/features), полную последовательность state transitions и
// detector-specific evidence — а НЕ просто confidence/metrics, которые уже были в event. Детекторы
// НЕ менялись для этой задачи — все 40 существующих тестов (tests/run_all.js) проходят без изменений
// поведения, эти тесты добавляют только проверку НОВОГО, чисто наблюдающего слоя.
// Run: node tests/verify_pattern_forensics.js

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
function depthSnap(t, bestBid, bestAsk, bids, asks) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, bids: bids, asks: asks, bidVol: bids.reduce(function (a, l) { return a + l.q; }, 0), askVol: asks.reduce(function (a, l) { return a + l.q; }, 0) };
}
function smallLevels(baseP, step, n, qty) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ p: baseP - step * i, q: qty });
  return out;
}
function staticWallSnaps(tStart, price, qty, n, stepMs) {
  const out = []; let t = tStart;
  for (let i = 0; i < n; i++) {
    const bids = [{ p: price, q: qty }].concat(smallLevels(price - 0.01, 0.01, 3, qty / 20));
    const asks = smallLevels(price + 0.02, 0.01, 4, qty / 20);
    out.push(depthSnap(t, price, asks[0].p, bids, asks));
    t += stepMs;
  }
  return { snaps: out, endT: t };
}
function shrinkWallSnaps(tStart, price, qty, n, stepMs) {
  const out = []; let t = tStart;
  for (let i = 0; i < n; i++) {
    const frac = 1 - (i / (n - 1)) * 0.95;
    const bids = [{ p: price, q: qty * frac }].concat(smallLevels(price - 0.01, 0.01, 3, qty / 20));
    const asks = smallLevels(price + 0.02, 0.01, 4, qty / 20);
    out.push(depthSnap(t, price, asks[0].p, bids, asks));
    t += stepMs;
  }
  return { snaps: out, endT: t };
}
function absorbTrades(tStart, tEnd, price, totalQty, count) {
  const out = [];
  const step = (tEnd - tStart) / (count + 1);
  const per = totalQty / count;
  for (let i = 1; i <= count; i++) out.push(trade(Math.round(tStart + step * i), price, per, i % 2 === 0 ? 'buy' : 'sell'));
  return out;
}
function buildBuyerTrades(tStart) {
  const trades = [];
  let t = tStart;
  for (let i = 0; i < 4; i++) { trades.push(trade(t, 10, 1 + (i % 3) * 0.3, 'sell')); t += 4000; }
  for (let i = 0; i < 10; i++) {
    const jitter = 1 + ((i % 3) - 1) * 0.08;
    trades.push(trade(t, 10 + i * 0.01, 15 * jitter, 'buy'));
    t += 3000 + (i % 2) * 200;
  }
  return { trades: trades, endT: t };
}
function buildBaselineAndSpike(spikePrice) {
  const trades = [];
  let t = 0, seed = 99;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  while (t < 300000) { trades.push(trade(t, 10.0 + (rnd() - 0.5) * 0.01, 0.1 + rnd() * 0.05, rnd() > 0.5 ? 'buy' : 'sell')); t += 2000; }
  t = 301000;
  for (let i = 0; i < 8; i++) { trades.push(trade(t, 10.0 + (spikePrice - 10.0) * ((i + 1) / 8), 40 + rnd() * 5, 'buy')); t += 1000; }
  return { trades: trades, endT: t };
}

// Каждый требует независимый PatternEngine (Forensics хранит state в module scope) — свежий require
// с очисткой require.cache между сценариями, чтобы forensic-история одного теста не просачивалась в другой.
function freshEngine() {
  const p = require.resolve('../web/js/pattern-engine.js');
  delete require.cache[p];
  return require('../web/js/pattern-engine.js');
}

// ============================================================================
// 1. ПЕРЕСТАВЛЯШ — доказать: wall created -> persisted -> cancelled (not absorbed) -> new comparable
// wall nearby -> repetition, с полным forensic evidence (не только итоговые moves/wallSizeUsd).
// ============================================================================
(function testRepositionForensicRecord() {
  const PatternEngine = freshEngine();
  const SYM = 'TEST/REPOS_FORENSIC';
  const Q = 100;
  let price = 10.0, now = 1000000;
  let r = staticWallSnaps(now, price, Q, 6, 1000);
  let res = PatternEngine.__replay(SYM, [], r.snaps, r.endT, true);
  now = r.endT + 500;
  for (let cycle = 0; cycle < 2; cycle++) {
    const a = shrinkWallSnaps(now, price, Q, 6, 1000);
    res = PatternEngine.__replay(SYM, [], a.snaps, a.endT); // без сделок -> отмена, не поглощение
    now = a.endT + 500;
    price = price * 1.0005; // новая стена рядом
    const w = staticWallSnaps(now, price, Q, 6, 1000);
    res = PatternEngine.__replay(SYM, [], w.snaps, w.endT);
    now = w.endT + 500;
  }
  const ev = res[2];
  assert(ev !== null, 'ПЕРЕСТАВЛЯШ подтверждён (предпосылка для проверки forensic record)');
  if (!ev) return;

  const records = PatternEngine.__forensics();
  const rec = PatternEngine.__forensicById(ev.id);
  assert(records.length >= 1, 'forensic record реально сохранён в хранилище, получено записей: ' + records.length);
  assert(rec !== null, 'forensic record находится по eventId');
  if (!rec) return;

  assert(rec.pattern === 'REPOSITION' && rec.exchange && rec.symbol === SYM, 'general-поля (pattern/exchange/symbol) верны');
  assert(Array.isArray(rec.stateTransitions) && rec.stateTransitions.length >= 4, 'state transitions содержат полную цепочку (WATCHING->WALL_ACTIVE->AWAITING_NEXT->WALL_ACTIVE...), получено переходов: ' + rec.stateTransitions.length);
  const hasWallActive = rec.stateTransitions.some(function (tr) { return tr.to === 'WALL_ACTIVE'; });
  const hasAwaitingNext = rec.stateTransitions.some(function (tr) { return tr.to === 'AWAITING_NEXT'; });
  assert(hasWallActive, 'среди transitions есть переход в WALL_ACTIVE (wall created/persisted)');
  assert(hasAwaitingNext, 'среди transitions есть переход в AWAITING_NEXT (wall cancelled, кандидат в reposition)');
  const cancelledEntry = rec.stateTransitions.find(function (tr) { return tr.extra && tr.extra.wall; });
  assert(!!cancelledEntry, 'хотя бы один transition несёт реальные данные стены (price/size), не просто статус');

  assert(rec.detectorEvidence && rec.detectorEvidence.moves === ev.metrics.moves, 'detectorEvidence.moves совпадает с фактическим event.metrics.moves (' + ev.metrics.moves + '), не выведено из confidence');
  assert(rec.detectorEvidence.finalWall && typeof rec.detectorEvidence.finalWall.p === 'number', 'сохранена РЕАЛЬНАЯ цена финальной стены (finalWall.p), не только сумма в $');
  assert(rec.thresholds && rec.thresholds.minMoves === PatternEngine.CFG.reposition.minMoves, 'thresholds сохранены и совпадают с реальным CFG.reposition.minMoves');
  assert(typeof rec.confirmationReason === 'string' && rec.confirmationReason.length > 10, 'confirmationReason — не пустая строка, объясняет ИМЕННО почему подтвердилось');
  assert(Array.isArray(rec.rawDepth) && rec.rawDepth.length > 0, 'rawDepth (снимки стакана) реально сохранены, не пустой массив');
})();

// ============================================================================
// 2. ЛЕСТНИЦА — доказать: wall -> consumed (absorption) -> displacement -> next wall -> consumed ->
// repeat, с evidence на каждом шаге (не только финальный repeats).
// ============================================================================
(function testLadderForensicRecord() {
  const PatternEngine = freshEngine();
  const SYM = 'TEST/LADDER_FORENSIC';
  const Q = 100;
  let price = 10.0, now = 1000000;
  let r = staticWallSnaps(now, price, Q, 6, 5000);
  let res = PatternEngine.__replay(SYM, [], r.snaps, r.endT, true);
  now = r.endT + 500;
  // В реальном processOneSymbol "trades" — это ВСЕГДА полный роллинг-буфер (до 2000 сделок), не
  // только сделки текущего тика — накапливаем так же, чтобы rawTrades на confirming-тике не был
  // артефактно пустым (в проде буфер эксклюзивно пустым не бывает при eligibility-гейте >=15 сделок).
  let allTrades = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const a = shrinkWallSnaps(now, price, Q, 6, 3000);
    const tr = absorbTrades(now, a.endT, price, Q * 0.9, 5); // реально исполнилось -> поглощение
    allTrades = allTrades.concat(tr);
    res = PatternEngine.__replay(SYM, allTrades, a.snaps, a.endT);
    now = a.endT + 500;
    price = price * 0.998;
    const w = staticWallSnaps(now, price, Q * 1.1, 6, 5000);
    res = PatternEngine.__replay(SYM, allTrades, w.snaps, w.endT);
    now = w.endT + 500;
  }
  const ev = res[1];
  assert(ev !== null, 'ЛЕСТНИЦА подтверждена (предпосылка)');
  if (!ev) return;

  const rec = PatternEngine.__forensicById(ev.id);
  assert(rec !== null, 'forensic record найден для ЛЕСТНИЦЫ');
  if (!rec) return;
  const consumedSteps = rec.stateTransitions.filter(function (tr) { return tr.to === 'AWAITING_NEXT'; });
  const nextWallSteps = rec.stateTransitions.filter(function (tr) { return tr.to === 'WALL_ACTIVE' && tr.extra && tr.extra.repeats; });
  assert(consumedSteps.length >= 3, 'минимум 3 отдельных шага "wall consumed" (AWAITING_NEXT) записаны, получено: ' + consumedSteps.length);
  assert(nextWallSteps.length >= 3, 'минимум 3 отдельных шага "next wall found" записаны с repeats, получено: ' + nextWallSteps.length);
  const absorptionEvidence = consumedSteps.length ? rec.stateTransitions.find(function (tr) { return tr.extra && tr.extra.absorption; }) : null;
  assert(!!absorptionEvidence, 'сохранён реальный результат coreDetectAbsorption (не просто факт перехода)');
  assert(rec.detectorEvidence.repeats === ev.metrics.repeats, 'detectorEvidence.repeats совпадает с event.metrics.repeats (' + ev.metrics.repeats + ')');
  assert(Array.isArray(rec.rawTrades) && rec.rawTrades.length > 0, 'rawTrades (сделки поглощения) сохранены');
})();

// ============================================================================
// 3. ПОКУПАШ — доказать: repeated aggressive buys + time clustering + size consistency +
// directional persistence, с сохранёнными РЕАЛЬНЫМИ сделками (не только агрегаты).
// ============================================================================
(function testBuyerForensicRecord() {
  const PatternEngine = freshEngine();
  const b = buildBuyerTrades(1000000);
  const res = PatternEngine.__replay('TEST/BUYER_FORENSIC', b.trades, [], b.endT, true);
  const ev = res[3];
  assert(ev !== null, 'ПОКУПАШ подтверждён (предпосылка)');
  if (!ev) return;

  const rec = PatternEngine.__forensicById(ev.id);
  assert(rec !== null, 'forensic record найден для ПОКУПАША');
  if (!rec) return;
  assert(Array.isArray(rec.rawTrades) && rec.rawTrades.length === ev.metrics.repeats, 'rawTrades содержит РОВНО те сделки, что вошли в repeats (' + ev.metrics.repeats + '), получено: ' + rec.rawTrades.length);
  assert(rec.rawTrades.every(function (t) { return t.side === 'buy'; }), 'все сохранённые raw trades — реально BUY (directional persistence подтверждена на уровне сырых данных, не только метрики)');
  assert(rec.detectorEvidence && typeof rec.detectorEvidence.dominance === 'number' && rec.detectorEvidence.dominance >= PatternEngine.CFG.aggro.dominanceMin, 'detectorEvidence.dominance >= dominanceMin, реальное число: ' + rec.detectorEvidence.dominance);
  assert(typeof rec.detectorEvidence.sizeCv === 'number' && typeof rec.detectorEvidence.intervalCv === 'number', 'sizeCv/intervalCv сохранены как реальные числа');
  assert(typeof rec.detectorEvidence.medianSizeUsd === 'number' && rec.detectorEvidence.medianSizeUsd > 0, 'median trade size сохранён');
  assert(rec.confirmationReason.indexOf('dominance') !== -1, 'confirmationReason явно ссылается на dominance-условие');
})();

// ============================================================================
// 4/5. ПРОКИД / ПРОСТРЕЛ — доказать: impulse -> confirmation window -> retrace% -> backInRange, и
// что ИМЕННО эта комбинация объясняет классификацию (не просто "confidence такой-то").
// ============================================================================
(function testProkidForensicRecord() {
  const PatternEngine = freshEngine();
  const SYM = 'TEST/PROKID_FORENSIC';
  const b = buildBaselineAndSpike(10.6);
  PatternEngine.__replay(SYM, b.trades, [], b.endT, true);
  const t2 = b.endT + 10000;
  PatternEngine.__replay(SYM, [trade(t2, 10.8, 5, 'buy')], [], t2);
  const t3 = b.endT + 31000;
  const res = PatternEngine.__replay(SYM, [trade(t3, 10.005, 3, 'sell')], [], t3); // возврат в диапазон
  const ev = res[5];
  assert(ev !== null, 'ПРОКИД подтверждён (предпосылка)');
  if (!ev) return;

  const rec = PatternEngine.__forensicById(ev.id);
  assert(rec !== null, 'forensic record найден для ПРОКИДА');
  if (!rec) return;
  assert(rec.detectorEvidence.retracedPct >= PatternEngine.CFG.impulse.returnThresholdPct, 'retracedPct >= returnThresholdPct реально сохранён, получено: ' + rec.detectorEvidence.retracedPct.toFixed(1) + '%');
  assert(rec.detectorEvidence.backInRange === true, 'backInRange=true реально сохранён (не выведен из confidence)');
  assert(typeof rec.detectorEvidence.preRangeHi === 'number' && typeof rec.detectorEvidence.preRangeLo === 'number', 'pre-impulse range (high/low) сохранён');
  assert(typeof rec.detectorEvidence.amplitude === 'number' && rec.detectorEvidence.amplitude > 0, 'impulse magnitude (amplitude) сохранена и положительна');
  assert(rec.confirmationReason.indexOf('ПРОКИД') !== -1, 'confirmationReason явно объясняет выбор ИМЕННО ПРОКИДА, а не ПРОСТРЕЛА');
  assert(Array.isArray(rec.rawTrades) && rec.rawTrades.length > 0, 'rawTrades импульсного окна сохранены');
  assert(rec.features !== null, 'features (computeFeatures snapshot) сохранены');
})();

(function testProstrelForensicRecord() {
  const PatternEngine = freshEngine();
  const SYM = 'TEST/PROSTREL_FORENSIC';
  const b = buildBaselineAndSpike(10.6);
  PatternEngine.__replay(SYM, b.trades, [], b.endT, true);
  const t2 = b.endT + 10000;
  PatternEngine.__replay(SYM, [trade(t2, 10.8, 5, 'buy')], [], t2);
  const t3 = b.endT + 31000;
  const res = PatternEngine.__replay(SYM, [trade(t3, 10.75, 3, 'buy')], [], t3); // почти без отката
  const ev = res[6];
  assert(ev !== null, 'ПРОСТРЕЛ подтверждён (предпосылка)');
  if (!ev) return;

  const rec = PatternEngine.__forensicById(ev.id);
  assert(rec !== null, 'forensic record найден для ПРОСТРЕЛА');
  if (!rec) return;
  assert(rec.detectorEvidence.retracedPct < PatternEngine.CFG.impulse.returnThresholdPct || rec.detectorEvidence.backInRange === false,
    'ИЛИ retracedPct < threshold, ИЛИ backInRange=false реально зафиксированы (причина continuation, не выдумана)');
  assert(rec.confirmationReason.indexOf('ПРОСТРЕЛ') !== -1, 'confirmationReason явно объясняет выбор ИМЕННО ПРОСТРЕЛА, а не ПРОКИДА');
  assert(rec.stateTransitions.some(function (tr) { return tr.from === 'WATCHING' && tr.to === 'CONFIRMING'; }), 'зафиксирован переход WATCHING->CONFIRMING в момент обнаружения импульса (не только финальная классификация)');
})();

// ============================================================================
// 6. LIFECYCLE — ACTIVE -> WEAKENING -> ENDED реально дописывается В ТУ ЖЕ forensic-запись (не
// создаётся новая), через fake Date.now(), без реального ожидания.
// ============================================================================
(function testLifecycleAppendsToSameRecord() {
  const PatternEngine = freshEngine();
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = function () { return fakeNow; };
  try {
    const b = buildBuyerTrades(1000000);
    const res = PatternEngine.__replay('TEST/LIFECYCLE_FORENSIC', b.trades, [], b.endT, true, 'DATA_OK');
    const ev = res[3];
    assert(ev !== null, 'событие создано (предпосылка)');
    if (!ev) return;
    const recBefore = PatternEngine.__forensicById(ev.id);
    // У aggro (BUYER/SELLER) единственный pre-confirm переход — WATCHING->ACTIVE (нет отдельной
    // CONFIRMING-фазы, см. forensic-аудит ранее в сессии) — значит ровно 1 запись в stateTransitions
    // на этот момент, лишних lifecycle-переходов (WEAKENING/ENDED) ещё быть не должно.
    assert(recBefore.status === 'ACTIVE' && recBefore.stateTransitions.length === 1 && recBefore.stateTransitions[0].to === 'ACTIVE',
      'изначально запись в статусе ACTIVE ровно с одним pre-confirm переходом (WATCHING->ACTIVE), без lifecycle-переходов, получено: ' + recBefore.stateTransitions.length);

    fakeNow += PatternEngine.CFG.aggro.decayMs + 1000;
    PatternEngine.__sweepLifecycle();
    const recAfterWeaken = PatternEngine.__forensicById(ev.id);
    assert(recAfterWeaken.status === 'WEAKENING', 'forensic record.status обновлён на WEAKENING');
    assert(recAfterWeaken.stateTransitions.some(function (tr) { return tr.to === 'WEAKENING'; }), 'WEAKENING добавлен в stateTransitions ТОЙ ЖЕ записи');

    fakeNow += PatternEngine.CFG.aggro.endMs + 1000;
    PatternEngine.__sweepLifecycle();
    const recAfterEnd = PatternEngine.__forensicById(ev.id);
    assert(recAfterEnd.status === 'ENDED', 'forensic record.status обновлён на ENDED');
    assert(recAfterEnd.duration > 0, 'duration реально посчитан (> 0), получено: ' + recAfterEnd.duration);
    assert(PatternEngine.__forensics().length === 1, 'НЕ создалась вторая запись -- один eventId, одна forensic-запись, только дополненная');
  } finally {
    Date.now = realNow;
  }
})();

// ============================================================================
// 7. PERSISTENCE — forensic record переживает reload (новый require поверх того же localStorage).
// ============================================================================
(function testForensicsSurviveReload() {
  const store = {};
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); }
  };
  const p = require.resolve('../web/js/pattern-engine.js');
  delete require.cache[p];
  const PE1 = require('../web/js/pattern-engine.js');
  const b = buildBuyerTrades(1000000);
  const res = PE1.__replay('TEST/PERSIST_FORENSIC', b.trades, [], b.endT, true);
  const ev = res[3];
  assert(ev !== null, 'событие создано (предпосылка)');
  const savedRaw = store['mexc_pe_forensics'];
  assert(savedRaw !== undefined && savedRaw.indexOf('TEST/PERSIST_FORENSIC') !== -1, 'forensic record реально записан в (симулированный) localStorage');

  delete require.cache[p];
  const PE2 = require('../web/js/pattern-engine.js');
  const recAfterReload = PE2.__forensicById(ev.id);
  assert(recAfterReload !== null, 'после "reload" (новый require поверх того же localStorage) forensic record всё ещё доступен по eventId');
  if (recAfterReload) assert(recAfterReload.symbol === 'TEST/PERSIST_FORENSIC' && recAfterReload.pattern === 'BUYER', 'содержимое записи не повреждено после reload');

  delete global.localStorage;
  delete require.cache[p];
})();

// ============================================================================
// 8. BOUNDED RETENTION — не более FORENSIC_MAX_EVENTS записей одновременно (раздел 3 ТЗ).
// ============================================================================
(function testBoundedRetention() {
  const PatternEngine = freshEngine();
  const MAX = 100; // должно совпадать с FORENSIC_MAX_EVENTS в pattern-engine.js
  for (let i = 0; i < MAX + 10; i++) {
    const b = buildBuyerTrades(1000000 + i * 100000);
    PatternEngine.__replay('TEST/BOUND_' + i, b.trades, [], b.endT, true);
  }
  const all = PatternEngine.__forensics();
  assert(all.length <= MAX, 'количество хранимых forensic-записей ограничено ' + MAX + ', получено: ' + all.length + ' (создано событий: ' + (MAX + 10) + ')');
  assert(all.length > 0, 'при этом записи реально накапливаются, не обнуляются полностью');
})();

console.log('\n' + (failures === 0 ? 'All assertions PASSED' : failures + ' assertion(s) FAILED'));
process.exit(failures === 0 ? 0 : 1);
