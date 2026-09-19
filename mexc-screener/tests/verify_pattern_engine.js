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

// ============================================================================
// Помощники для стакана (Лестница/Переставляш/SINGLE LARGE WALL сценариев ниже).
// ============================================================================
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
  // Плотность на уровне усыхает до ~5% от исходной — общая механика и для поглощения (с
  // совпадающими сделками), и для отмены (без них), см. отдельные сценарии ниже.
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

// ============================================================================
// 2. ЛЕСТНИЦА — стена на уровне СЪЕДЕНА потоком (объём в стакане ушёл, реальные сделки у уровня
// это подтверждают), и следующая похожая стена появляется ДАЛЬШЕ по направлению движения —
// повторяется minRepeats(3) раз подряд -> CONFIRMED (п.10 ТЗ).
// ============================================================================
(function testLadderPatternDetected() {
  const SYM = 'TEST/LADDER';
  const Q = 100;
  let price = 10.0, now = 1000000;
  let r = staticWallSnaps(now, price, Q, 6, 5000);
  let res = PatternEngine.__replay(SYM, [], r.snaps, r.endT, true);
  now = r.endT + 500;
  for (let cycle = 0; cycle < 3; cycle++) {
    const a = shrinkWallSnaps(now, price, Q, 6, 3000);
    const tr = absorbTrades(now, a.endT, price, Q * 0.9, 5); // подавляющая часть исчезнувшего объёма реально исполнилась -> поглощение, не отмена
    res = PatternEngine.__replay(SYM, tr, a.snaps, a.endT);
    now = a.endT + 500;
    price = price * 0.998; // следующая стена дальше по направлению падения цены
    const w = staticWallSnaps(now, price, Q * 1.1, 6, 5000);
    res = PatternEngine.__replay(SYM, [], w.snaps, w.endT);
    now = w.endT + 500;
  }
  assert(res[1] !== null, 'стена съедается потоком и переставляется дальше по направлению 3 раза подряд -> ЛЕСТНИЦА подтверждена');
  if (res[1]) {
    assert(res[1].metrics.repeats >= 3, 'repeats >= minRepeats, получено ' + res[1].metrics.repeats);
    assert(res[1].direction === 'LONG', 'стена на BID съедается -> направление LONG, получено ' + res[1].direction);
  }
})();

// ============================================================================
// 3. ПЕРЕСТАВЛЯШ — та же стена ОТМЕНЯЕТСЯ (исчезает без соответствующих сделок), а следующая
// похожая стена появляется РЯДОМ (не далеко) — повторяется minMoves(2) раз -> CONFIRMED (п.11 ТЗ).
// ============================================================================
(function testRepositionPatternDetected() {
  const SYM = 'TEST/REPOS';
  const Q = 100;
  let price = 10.0, now = 1000000;
  let r = staticWallSnaps(now, price, Q, 6, 1000);
  let res = PatternEngine.__replay(SYM, [], r.snaps, r.endT, true);
  now = r.endT + 500;
  for (let cycle = 0; cycle < 2; cycle++) {
    const a = shrinkWallSnaps(now, price, Q, 6, 1000);
    // НИКАКИХ сделок у этого уровня — плотность пропала без исполнения -> отмена, не поглощение.
    res = PatternEngine.__replay(SYM, [], a.snaps, a.endT);
    now = a.endT + 500;
    price = price * 1.0005; // новая стена совсем рядом (в пределах maxLevelDistancePct), не далеко
    const w = staticWallSnaps(now, price, Q, 6, 1000);
    res = PatternEngine.__replay(SYM, [], w.snaps, w.endT);
    now = w.endT + 500;
  }
  assert(res[2] !== null, 'стена отменяется (без исполнения) и появляется рядом заново 2 раза подряд -> ПЕРЕСТАВЛЯШ подтверждён');
  if (res[2]) assert(res[2].metrics.moves >= 2, 'moves >= minMoves, получено ' + res[2].metrics.moves);
})();

// ============================================================================
// 6. ПРОДАВАШ — зеркало ПОКУПАША (side='sell'), направление SHORT.
// ============================================================================
(function testSellerPatternDetected() {
  const trades = [];
  let t = 1000000;
  for (let i = 0; i < 4; i++) { trades.push(trade(t, 10, 1 + (i % 3) * 0.3, 'buy')); t += 4000; }
  for (let i = 0; i < 10; i++) {
    const jitter = 1 + ((i % 3) - 1) * 0.08;
    trades.push(trade(t, 10 - i * 0.01, 15 * jitter, 'sell'));
    t += 3000 + (i % 2) * 200;
  }
  const results = PatternEngine.__replay('TEST/SELLER', trades, [], t);
  const seller = results[4];
  assert(seller !== null, 'устойчивая серия из 10 агрессивных похожих продаж подряд ДЕТЕКТИРУЕТСЯ как ПРОДАВАШ');
  if (seller) assert(seller.direction === 'SHORT', 'направление ПРОДАВАША — SHORT, получено ' + seller.direction);
})();

// ============================================================================
// 7/10. ПРОКИД / ПРОСТРЕЛ — импульс + confirmation window, классификация ТОЛЬКО после его закрытия
// (п.14/15 ТЗ). Один и тот же импульс, два разных исхода: полный возврат в диапазон -> ПРОКИД;
// движение остаётся расширенным -> ПРОСТРЕЛ.
// ============================================================================
function buildBaselineAndSpike(spikePrice) {
  const trades = [];
  let t = 0, seed = 99;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  while (t < 300000) { trades.push(trade(t, 10.0 + (rnd() - 0.5) * 0.01, 0.1 + rnd() * 0.05, rnd() > 0.5 ? 'buy' : 'sell')); t += 2000; }
  t = 301000;
  for (let i = 0; i < 8; i++) { trades.push(trade(t, 10.0 + (spikePrice - 10.0) * ((i + 1) / 8), 40 + rnd() * 5, 'buy')); t += 1000; }
  return { trades: trades, endT: t };
}
(function testProkidDetected() {
  const SYM = 'TEST/PROKID';
  const b = buildBaselineAndSpike(10.6);
  PatternEngine.__replay(SYM, b.trades, [], b.endT, true);
  const t2 = b.endT + 10000;
  PatternEngine.__replay(SYM, [trade(t2, 10.8, 5, 'buy')], [], t2); // пик импульса
  const t3 = b.endT + 31000;
  const res = PatternEngine.__replay(SYM, [trade(t3, 10.005, 3, 'sell')], [], t3); // цена вернулась в исходный диапазон
  assert(res[5] !== null, 'резкий импульс с адаптивным z-score, ЗАТЕМ полный возврат в исходный диапазон после окна подтверждения -> ПРОКИД');
  if (res[5]) assert(res[5].direction === 'LONG', 'направление импульса — LONG, получено ' + res[5].direction);
})();
(function testProstrelDetected() {
  const SYM = 'TEST/PROSTREL';
  const b = buildBaselineAndSpike(10.6);
  PatternEngine.__replay(SYM, b.trades, [], b.endT, true);
  const t2 = b.endT + 10000;
  PatternEngine.__replay(SYM, [trade(t2, 10.8, 5, 'buy')], [], t2);
  const t3 = b.endT + 31000;
  const res = PatternEngine.__replay(SYM, [trade(t3, 10.75, 3, 'buy')], [], t3); // почти не откатилась, движение осталось расширенным
  assert(res[6] !== null, 'резкий импульс, ЗАТЕМ движение остаётся расширенным (нет возврата в диапазон) после окна подтверждения -> ПРОСТРЕЛ');
})();

// ============================================================================
// 11. SINGLE LARGE WALL — одна крупная стена появилась и была съедена ОДИН раз — ниже minRepeats/
// minMoves, НЕ должна создавать ни ЛЕСТНИЦУ, ни ПЕРЕСТАВЛЯШ (anti-noise, п.34 ТЗ: "прострелов быть
// не должно на единичном событии").
// ============================================================================
(function testSingleLargeWallDoesNotTrigger() {
  const SYM = 'TEST/SINGLEWALL';
  const Q = 100, price = 10.0;
  let now = 1000000;
  let r = staticWallSnaps(now, price, Q, 6, 5000);
  let res = PatternEngine.__replay(SYM, [], r.snaps, r.endT, true);
  now = r.endT + 500;
  const a = shrinkWallSnaps(now, price, Q, 6, 3000);
  const tr = absorbTrades(now, a.endT, price, Q * 0.9, 5);
  res = PatternEngine.__replay(SYM, tr, a.snaps, a.endT);
  assert(res[1] === null, 'единичная съеденная стена (repeats=1 < minRepeats=3) НЕ создаёт событие ЛЕСТНИЦА');
  assert(res[2] === null, 'единичная съеденная стена НЕ создаёт событие ПЕРЕСТАВЛЯШ');
})();

console.log('\n' + (failures === 0 ? 'All assertions PASSED' : failures + ' assertion(s) FAILED'));
process.exit(failures === 0 ? 0 : 1);
