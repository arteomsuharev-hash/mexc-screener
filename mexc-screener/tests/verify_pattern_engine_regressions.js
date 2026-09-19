// Regression-тесты для audit-фиксов Pattern Engine (2026-09): PERMANENT blacklist persistence,
// DATA_OK/DATA_DEGRADED/DATA_STALE, dedup, lifecycle ACTIVE->WEAKENING->ENDED (fake clock, без
// реального ожидания), и bounded-lookback фикс в core-utils.js computeFeatures (см. audit finding
// "computeFeatures может стоить сотни мс на символ со старым буфером").
// Run: node tests/verify_pattern_engine_regressions.js

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }

// ============================================================================
// 1. PERMANENT BLACKLIST PERSISTENCE — раньше Infinity сериализовался JSON.stringify как null,
// и после "перезапуска" (нового require модуля поверх той же localStorage) PERMANENT-запись
// пропадала. Симулируем localStorage вручную (в Node его нет) и требуем модуль ДВАЖДЫ — второй
// раз поверх ТОГО ЖЕ backing store, как реальный reload приложения.
// ============================================================================
(function testPermanentBlacklistSurvivesReload() {
  const store = {};
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); }
  };
  const peModulePath = require.resolve('../web/js/pattern-engine.js');
  delete require.cache[peModulePath];
  const PE1 = require('../web/js/pattern-engine.js');
  PE1.blacklist.add('TEST/PERMSAVE', 'PERMANENT');
  const rawStored = store['mexc_pe_blacklist'];
  assert(rawStored !== undefined, 'PERMANENT-запись реально попала в (симулированный) localStorage');
  assert(rawStored.indexOf('null') === -1, 'сохранённый JSON НЕ содержит null для PERMANENT-записи (был баг: Infinity -> JSON null), получено: ' + rawStored);
  assert(rawStored.indexOf('PERMANENT') !== -1, 'сохранённый JSON использует строковый sentinel "PERMANENT", получено: ' + rawStored);

  // "Перезапуск" — свежий require того же модуля поверх того же backing store (localStorage сам
  // модуль не трогает при загрузке, только читает при первом обращении к Blacklist IIFE).
  delete require.cache[peModulePath];
  const PE2 = require('../web/js/pattern-engine.js');
  assert(PE2.blacklist.isBlacklisted('TEST/PERMSAVE') === true, 'после "reload" (новый require поверх того же localStorage) PERMANENT-запись остаётся заблокированной — БЫЛ БАГ: становилась false');

  // Побочно: обычная 24H-запись по-прежнему работает как раньше (не задета фиксом).
  PE2.blacklist.add('TEST/24HSAVE', '24H');
  delete require.cache[peModulePath];
  const PE3 = require('../web/js/pattern-engine.js');
  assert(PE3.blacklist.isBlacklisted('TEST/24HSAVE') === true, '24H-запись тоже переживает reload (regression guard)');

  delete global.localStorage;
  delete require.cache[peModulePath];
})();

// Все тесты ниже используют чистый require БЕЗ localStorage-мока (обычное Node-окружение теста,
// как и в tests/verify_pattern_engine.js) — Blacklist переживёт without try/catch, это уже покрыто.
const PatternEngine = require('../web/js/pattern-engine.js');

// ============================================================================
// 2. DATA_OK / DATA_DEGRADED / DATA_STALE — контракт __replay(..., quality):
//    DATA_STALE   -> детекторы вообще не вызываются (0 debug-данных, 0 событий).
//    DATA_DEGRADED -> НЕ создаёт новое CONFIRMED/ACTIVE событие, но не ломает апдейт уже
//                      существующего активного события (lifecycle не страдает).
//    DATA_OK (или quality не передан) -> обычная работа, как раньше.
// ============================================================================
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

(function testDataOkCreatesEventNormally() {
  const b = buildBuyerTrades(1000000);
  const res = PatternEngine.__replay('TEST/DQ_OK', b.trades, [], b.endT, true, 'DATA_OK');
  assert(res[3] !== null, 'DATA_OK: устойчивая структура ПОКУПАША создаёт событие как обычно');
})();

(function testDataStaleNeverCallsDetectors() {
  const b = buildBuyerTrades(1000000);
  const res = PatternEngine.__replay('TEST/DQ_STALE', b.trades, [], b.endT, true, 'DATA_STALE');
  assert(res.every(function (r) { return r === null; }), 'DATA_STALE: ни один детектор не создаёт событие');
  const dbg = PatternEngine.getDebugInfo('TEST/DQ_STALE');
  assert(!dbg || !dbg.buyer, 'DATA_STALE: debug.buyer вообще не заполнен -- детектор физически не вызывался, получено: ' + JSON.stringify(dbg));
})();

(function testDataDegradedBlocksNewEventButNotExistingUpdate() {
  const SYM = 'TEST/DQ_DEGRADED';
  const b1 = buildBuyerTrades(1000000);
  // Первый тик с DEGRADED -- структура уже подтверждающая, но НОВОЕ событие создаваться не должно.
  const res1 = PatternEngine.__replay(SYM, b1.trades, [], b1.endT, true, 'DATA_DEGRADED');
  assert(res1[3] === null, 'DATA_DEGRADED: устойчивая структура ПОКУПАША НЕ создаёт новое событие');
  const dbgAfterDegraded = PatternEngine.getDebugInfo(SYM);
  assert(dbgAfterDegraded && dbgAfterDegraded.buyer && dbgAfterDegraded.buyer.repeats != null, 'DATA_DEGRADED: детектор всё равно ВЫПОЛНЯЕТСЯ (debug заполнен) -- отличие от DATA_STALE, просто не публикует событие');

  // Тот же символ, качество восстановилось -- та же структура теперь ДОЛЖНА создать событие.
  const b2 = buildBuyerTrades(b1.endT + 1000);
  const res2 = PatternEngine.__replay(SYM, b2.trades, [], b2.endT, false, 'DATA_OK');
  assert(res2[3] !== null, 'после восстановления DATA_OK та же структура создаёт событие (не заблокирована навсегда)');
  const eventId = res2[3].id;

  // Существующее АКТИВНОЕ событие продолжает получать апдейты (repetition/confidence) даже при
  // DEGRADED -- lifecycle уже созданного события не ломается, ломается только СОЗДАНИЕ нового.
  const beforeUpdateAt = PatternEngine.getEventById(eventId).lastUpdateAt;
  const b3 = buildBuyerTrades(b2.endT + 1000);
  const res3 = PatternEngine.__replay(SYM, b3.trades, [], b3.endT, false, 'DATA_DEGRADED');
  assert(res3[3] !== null, 'DATA_DEGRADED на СУЩЕСТВУЮЩЕМ активном событии -- апдейт не блокируется, событие по-прежнему возвращается');
  assert(res3[3].id === eventId, 'это ТО ЖЕ событие (тот же id), не новое -- апдейт, не пересоздание');
  assert(PatternEngine.getEventById(eventId).lastUpdateAt >= beforeUpdateAt, 'lastUpdateAt существующего события обновляется даже при DEGRADED (lifecycle не заморожен)');
})();

// ============================================================================
// 3. DEDUP — несколько подряд идущих положительных тиков одного (symbol,pattern) не создают
// новых карточек, только обновляют одну и ту же по id.
// ============================================================================
(function testDedupSingleEventAcrossTicks() {
  const SYM = 'TEST/DEDUP2';
  let t = 1000000;
  const ids = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    const b = buildBuyerTrades(t);
    const res = PatternEngine.__replay(SYM, b.trades, [], b.endT, cycle === 0);
    t = b.endT + 1000;
    if (res[3]) ids.push(res[3].id);
  }
  assert(ids.length === 6, 'все 6 тиков подтвердили ПОКУПАША (' + ids.length + '/6)');
  assert(new Set(ids).size === 1, 'все 6 тиков ссылаются на ОДИН и тот же event id, получено уникальных: ' + new Set(ids).size + ' (' + JSON.stringify(ids) + ')');
  const active = PatternEngine.getActiveEvents(['BUYER'], 'ALL').filter(function (e) { return e.symbol === SYM; });
  assert(active.length === 1, 'getActiveEvents() отдаёт РОВНО одну карточку для этого symbol+pattern, получено ' + active.length);
})();

// ============================================================================
// 4. LIFECYCLE ACTIVE -> WEAKENING -> ENDED — через fake Date.now(), без реального ожидания
// decayMs/endMs (25с/45с у aggro). __sweepLifecycle() -- тестовый доступ к sweepEventLifecycle,
// которая в браузере крутится на своём setInterval, а под Node не запускается автоматически.
// ============================================================================
(function testLifecycleActiveWeakeningEnded() {
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = function () { return fakeNow; };
  try {
    const b = buildBuyerTrades(1000000);
    const res = PatternEngine.__replay('TEST/LIFECYCLE', b.trades, [], b.endT, true, 'DATA_OK');
    const buyer = res[3];
    assert(buyer !== null && buyer.status === 'ACTIVE', 'событие создано в статусе ACTIVE');
    const id = buyer.id;

    fakeNow += PatternEngine.CFG.aggro.decayMs + 1000;
    PatternEngine.__sweepLifecycle();
    let ev = PatternEngine.getEventById(id);
    assert(ev.status === 'WEAKENING', 'после decayMs (' + PatternEngine.CFG.aggro.decayMs + 'мс) без новых тиков -> WEAKENING, получено ' + ev.status);

    fakeNow += PatternEngine.CFG.aggro.endMs + 1000;
    PatternEngine.__sweepLifecycle();
    ev = PatternEngine.getEventById(id);
    assert(ev.status === 'ENDED', 'после decayMs+endMs без новых тиков -> ENDED, получено ' + ev.status);
  } finally {
    Date.now = realNow;
  }
})();

// ============================================================================
// 5. PERFORMANCE REGRESSION — computeFeatures на ЗАВЕДОМО старом (90 дней) буфере должно
// укладываться в разумное время (audit fix: FEATURE_HISTORY_LOOKBACK_MS в core-utils.js). Раньше
// цикл volHistory шёл от t первой сделки буфера, для такого буфера это были бы десятки тысяч
// итераций (измерено в аудите: 30 дней ~133мс НА ОДИН символ ТОЛЬКО от этого цикла).
// ============================================================================
(function testFeatureHistoryLookbackIsBounded() {
  const MexcCore = require('../web/js/core-utils.js');
  const now = Date.now();
  const spanMs = 90 * 24 * 3600000; // 90 дней -- заведомо больше FEATURE_HISTORY_LOOKBACK_MS (1 час)
  const n = 300;
  const trades = [];
  for (let i = 0; i < n; i++) {
    const tt = now - spanMs + Math.floor(spanMs * i / n);
    trades.push(trade(tt, 10 + Math.sin(i) * 0.01, 1 + (i % 5), i % 2 === 0 ? 'buy' : 'sell'));
  }
  const t0 = process.hrtime.bigint();
  const f = MexcCore.computeFeatures(trades, [], now);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  assert(f != null && typeof f === 'object', 'computeFeatures вернул результат на 90-дневном буфере, не упал');
  assert(ms < 500, 'computeFeatures на 90-дневном (заведомо старом, малочисленном) буфере укладывается в разумное время (<500мс, bounded lookback), получено ' + ms.toFixed(1) + 'мс');

  // Adaptive-поведение сохранено: при ДОСТАТОЧНОЙ плотности РЕАЛЬНЫХ недавних сделок (в пределах
  // bounded-окна) перцентиль волатильности всё ещё реально считается, не залипает в null.
  const denseTrades = [];
  let dt = now - 30 * 60000; // 30 минут плотной активности -- внутри 1-часового окна
  for (let i = 0; i < 400; i++) { denseTrades.push(trade(dt, 10 + Math.sin(i / 5) * 0.05, 1 + (i % 4), i % 2 === 0 ? 'buy' : 'sell')); dt += 4000; }
  const f2 = MexcCore.computeFeatures(denseTrades, [], dt);
  assert(f2.volatility_percentile !== null && f2.volatility_percentile !== undefined, 'adaptive-поведение сохранено: перцентиль волатильности реально считается при достаточной плотности недавних сделок внутри bounded-окна, получено ' + f2.volatility_percentile);
})();

console.log('\n' + (failures === 0 ? 'All assertions PASSED' : failures + ' assertion(s) FAILED'));
process.exit(failures === 0 ? 0 : 1);
