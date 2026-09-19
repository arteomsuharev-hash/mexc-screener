// Synthetic/replay-тесты для web/js/pattern-engine.js (ТЗ п.33: replay/test infrastructure,
// synthetic test cases, "последние тесты должны проверять, что detector НЕ создаёт ложный alert
// просто из-за высокой активности"). Каждый сценарий прогоняется через PatternEngine.__replay(),
// который вызывает РЕАЛЬНЫЕ детекторные функции напрямую — не мок, не отдельная тестовая копия.
// Run: node tests/verify_pattern_engine.js

const PatternEngine = require('../web/js/pattern-engine.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
}

function trade(t, price, qty, side) { return { t: t, price: price, qty: qty, side: side }; }
function depthSnap(t, bestBid, bestAsk, bids, asks) {
  return { t: t, bestBid: bestBid, bestAsk: bestAsk, bids: bids, asks: asks, bidVol: bids.reduce(function (a, l) { return a + l.q; }, 0), askVol: asks.reduce(function (a, l) { return a + l.q; }, 0) };
}

// ============================================================================
// 8. RANDOM NOISE — детерминированный псевдослучайный поток сделок без всякой структуры. НИ ОДИН
// из 5 паттернов не должен сработать. Это главный "anti-noise" тест (п.34 ТЗ: precision > quantity).
// ============================================================================
(function testRandomNoiseProducesNoEvents() {
  const trades = [];
  let t = 1000000, price = 10;
  let seed = 42;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (let i = 0; i < 300; i++) {
    price += (rnd() - 0.5) * 0.02; // случайное блуждание, без тренда/структуры
    trades.push(trade(t, price, 1 + rnd() * 20, rnd() > 0.5 ? 'buy' : 'sell'));
    t += 200 + rnd() * 2000; // случайные интервалы
  }
  const now = t;
  const results = PatternEngine.__replay('TEST/NOISE', trades, [], now);
  assert(results.every(function (r) { return r === null; }), 'чистый случайный шум (300 сделок, псевдослучайный размер/сторона/интервал) НЕ создаёт ни одного события — получено: ' + results.filter(Boolean).map(function (r) { return r.pattern; }).join(',') || '(пусто, как и должно быть)');
})();

// ============================================================================
// 9. NORMAL HIGH VOLUME / SINGLE LARGE TRADE — высокая активность САМА ПО СЕБЕ не паттерн (п.5 ТЗ:
// "высокая активность != алгоритм"). Много сделок нормального рыночного вида без repeated-структуры.
// ============================================================================
(function testHighVolumeWithoutStructureProducesNoEvents() {
  const trades = [];
  let t = 1000000;
  // Один крупный выброс — единичный, без follow-through — не должен трактоваться как "покупаш".
  for (let i = 0; i < 40; i++) {
    const side = i % 3 === 0 ? 'buy' : 'sell'; // не устойчивое доминирование одной стороны
    const qty = 1 + (i % 7); // не однородные размеры
    trades.push(trade(t, 100 + Math.sin(i) * 0.3, qty, side));
    t += 500 + (i % 5) * 300;
  }
  trades.push(trade(t, 100, 500, 'buy')); // один большой единичный принт без продолжения
  const results = PatternEngine.__replay('TEST/BUSY', trades, [], t + 1000);
  assert(results.every(function (r) { return r === null; }), 'обычная активность + один единичный крупный принт без repeated-структуры НЕ создаёт событий');
})();

// ============================================================================
// 4/5. ПОКУПАШ / ПРОДАВАШ — устойчивая repeated-структура агрессивных сделок в одну сторону.
// ============================================================================
(function testBuyerPatternDetected() {
  const trades = [];
  let t = 1000000;
  // Baseline — фоновые sell (не buy!), чтобы не размывать CV целевой buy-серии ниже: детектор
  // считает dominance/sizeCv/intervalCv ПО ВСЕМ сделкам нужной стороны в окне lookback, а не только
  // по "явно предназначенным для теста" — смешивать туда buy-сделки с другим размером было багом
  // именно в тесте, не в детекторе (не искажаем реальную логику ради удобства теста).
  for (let i = 0; i < 4; i++) { trades.push(trade(t, 10, 1 + (i % 3) * 0.3, 'sell')); t += 4000; }
  // Устойчивая серия агрессивных покупок, похожего (не идентичного) размера, регулярный интервал.
  for (let i = 0; i < 10; i++) {
    const jitter = 1 + ((i % 3) - 1) * 0.08;
    trades.push(trade(t, 10 + i * 0.01, 15 * jitter, 'buy'));
    t += 3000 + (i % 2) * 200;
  }
  const results = PatternEngine.__replay('TEST/BUYER', trades, [], t);
  const buyer = results[3]; // порядок в __replay: ERSHIK, LADDER, REPOSITION, BUYER, SELLER, PROKID, PROSTREL
  assert(buyer !== null, 'устойчивая серия из 10 агрессивных похожих покупок подряд ДЕТЕКТИРУЕТСЯ как ПОКУПАШ');
  if (buyer) {
    assert(buyer.direction === 'LONG', 'направление ПОКУПАША — LONG, получено ' + buyer.direction);
    assert(buyer.metrics.repeats >= 5, 'repeats >= minRepeats, получено ' + buyer.metrics.repeats);
    assert(buyer.confidence > 0 && buyer.confidence <= 100, 'confidence — вменяемый процент, получено ' + buyer.confidence);
  }
})();

(function testTwoOrThreeRandomBuysDoNotTriggerBuyer() {
  // п.16 ТЗ: "2-3 не считать" — единичные/пара агрессивных покупок без устойчивой серии не паттерн.
  const trades = [];
  let t = 1000000;
  for (let i = 0; i < 20; i++) { trades.push(trade(t, 10, 1, i % 2 === 0 ? 'buy' : 'sell')); t += 4000; }
  trades.push(trade(t, 10, 20, 'buy')); t += 3000;
  trades.push(trade(t, 10.01, 18, 'buy')); t += 3000;
  const results = PatternEngine.__replay('TEST/WEAKBUYER', trades, [], t);
  assert(results[3] === null, '2 агрессивные покупки подряд (меньше minRepeats=5) НЕ создают событие ПОКУПАШ');
})();

// ============================================================================
// 12. BTC-LIKE HIGH LIQUIDITY BEHAVIOR — много сделок, сбалансированный поток, без repeated-
// структуры (эмулирует то, что реально видно на топ-капе) — не должно создавать события.
// ============================================================================
(function testBtcLikeBehaviorProducesNoEvents() {
  const trades = [];
  let t = 1000000;
  let seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (let i = 0; i < 400; i++) {
    trades.push(trade(t, 90000 + (rnd() - 0.5) * 50, 0.01 + rnd() * 0.5, rnd() > 0.48 ? 'buy' : 'sell'));
    t += 50 + rnd() * 300; // очень частый поток (как на реально ликвидной паре)
  }
  const results = PatternEngine.__replay('TEST/BTCLIKE', trades, [], t);
  assert(results.every(function (r) { return r === null; }), 'высокочастотный сбалансированный поток без repeated-структуры (эмуляция топ-капа) НЕ создаёт событий — сам факт высокой ликвидности не паттерн (п.5 ТЗ)');
})();

// ============================================================================
// 1. ЁРШИК — узкий диапазон + плотное чередующееся структурированное чередование сделок.
// ============================================================================
(function testErshikPatternDetected() {
  const trades = [];
  let t = 1000000;
  const base = 5.0;
  for (let i = 0; i < 20; i++) {
    // Чередование buy/sell, похожие размеры, регулярные интервалы, цена не уходит из узкого диапазона.
    const side = i % 2 === 0 ? 'buy' : 'sell';
    const priceJit = base + ((i % 4) - 2) * 0.001; // диапазон ~0.04%, узко
    trades.push(trade(t, priceJit, 2 + (i % 3) * 0.1, side));
    t += 2000 + (i % 3) * 200;
  }
  const results = PatternEngine.__replay('TEST/ERSHIK', trades, [], t);
  // Ёршик требует cyclesToConfirm ПОДРЯД идущих положительных тиков одного recompute — один replay-
  // вызов даёт максимум один тик, поэтому здесь проверяем НЕ финальное событие (которое требует
  // нескольких вызовов __replay подряд, см. следующий тест), а то, что core-детектор в принципе
  // находит структуру на этих данных (без этого CONFIRMED в реальном цикле и подавно не наступит).
  const MexcCore = require('../web/js/core-utils.js');
  const raw = MexcCore.detectErshik(trades, { minRepeats: 8, structureThreshold: 0.6, tolerance: 0.2 });
  assert(raw !== null, 'узкий диапазон + плотное структурированное чередование ОБНАРУЖИВАЕТСЯ базовым detectErshik (сырой сигнал для state machine)');
})();

(function testErshikStateMachineNeedsMultipleConfirmations() {
  // Проверяем именно state machine: несколько ПОДРЯД идущих replay-вызовов с одинаковой
  // ершик-структурой должны в итоге дать CONFIRMED-событие, а один вызов — нет (п.9 ТЗ:
  // "нельзя показывать ЁРШИК после нескольких случайных сделок", нужна минимальная
  // последовательность подтверждений).
  function buildErshikTrades(tStart) {
    const trades = []; let t = tStart; const base = 8.0;
    for (let i = 0; i < 20; i++) {
      const side = i % 2 === 0 ? 'buy' : 'sell';
      trades.push(trade(t, base + ((i % 4) - 2) * 0.0015, 3 + (i % 3) * 0.15, side));
      t += 1800 + (i % 3) * 150;
    }
    return { trades: trades, endT: t };
  }
  let now = 2000000;
  let lastResults = null;
  for (let cycle = 0; cycle < 6; cycle++) {
    const built = buildErshikTrades(now - 40000);
    lastResults = PatternEngine.__replay('TEST/ERSHIK2', built.trades, [], built.endT);
    now = built.endT + 1200; // тот же ритм, что и CFG.recomputeIntervalMs
  }
  assert(lastResults[0] !== null, 'после нескольких (>= cyclesToConfirm) подряд идущих положительных тиков ЁРШИК переходит в подтверждённое событие');
  if (lastResults[0]) assert(lastResults[0].metrics.cycles >= PatternEngine.CFG.ershik.cyclesToConfirm, 'cycles >= cyclesToConfirm, получено ' + lastResults[0].metrics.cycles);
})();

console.log('\n' + (failures === 0 ? 'All assertions PASSED' : failures + ' assertion(s) FAILED'));
process.exit(failures === 0 ? 0 : 1);
