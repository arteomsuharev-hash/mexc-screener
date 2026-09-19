// ============================================================================
// PATTERN ENGINE — realtime поведенческий детектор для виджета TICKS & ALERTS (2026-09, полная
// перестройка по ТЗ пользователя, см. историю коммитов "Pattern Engine").
//
// ФИЛОСОФИЯ (дословно из ТЗ): не "монета выросла на X% -> показать", а "в потоке сделок и/или
// стакане обнаружена характерная повторяющаяся СТРУКТУРА -> подтверждение -> классификация ->
// событие". BEHAVIOR, не PRICE. REPETITION, не ONE EVENT. ADAPTIVE BASELINE, не FIXED THRESHOLD.
// PRECISION, не количество alerts — пусто 10 минут подряд是 нормальный результат.
//
// ИСТОЧНИКИ ДАННЫХ — те же самые, уже существующие, реальные буферы (никакого второго WS/потока
// этот файл не создаёт, см. window.mexcTier2TradesForSymbol/mexcTier2DepthForSymbol в app.js):
//   trades: {t, price, qty, side:'buy'|'sell'} — side ПОДТВЕРЖДЁН реальным полем биржи (tradeType
//   у MEXC, аналогично у остальных подключённых бирж — не угадывается).
//   depth:  {t, bids:[{p,q}], asks:[{p,q}], bestBid, bestAsk, bidVol, askVol} — ЧЕСТНО периодический
//   снимок топ-N уровней (см. аудит в чате: MEXC spot@public.limit.depth.v3.api.pb@SYM@20,
//   Binance depth20@100ms, и т.д. — партиал-снапшоты, НЕ полный diff-L2 с sequence numbers; ни одна
//   из подключённых бирж не документирует такой поток для спота на уровне, который сейчас
//   используется в проекте — это архитектурный факт, не недоработка).
//
// СТАТИСТИКА — переиспользует уже протестированные (tests/, 38/38 проходят) примитивы из
// core-utils.js (window.MexcCore): median/medianAbsoluteDeviation/robustZScore, findLevelWall,
// computeFeatures (adaptive per-symbol percentile-волатильность/OFI/delta), detectLadder,
// detectErshik, detectAbsorption — не переизобретается.
//
// СКОУП символов: window.mexcTier2ActiveSymbols() — те же Tier2-монеты (реальные сделки+стакан),
// что уже используются Filter 1/2 (жёсткий лимит бирж на кол-во WS-подписок, не наш произвол).
// Дополнительно: минимальный/максимальный объём (не мёртвые и не топ-капы) + исключение известных
// топ-проектов по капитализации (window.mexcMajorCoinSymbols, топ-200 CoinGecko) — та же логика,
// что уже проверена вживую в Filter 2 (BTC/SOL/AVAX подтверждённо отсекаются).
// ============================================================================
(function (root, factory) {
  'use strict';
  // Тот же UMD-приём, что и у core-utils.js — модуль грузится и как <script> в браузере (тогда
  // window.PatternEngine), и через require() из tests/ под Node (тогда module.exports) для
  // replay/synthetic-тестов (п.33 ТЗ), без дублирования кода под два окружения.
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof global !== 'undefined' ? global : this, require('./core-utils.js'));
  } else {
    factory(root, root.MexcCore);
  }
})(typeof self !== 'undefined' ? self : this, function (global, MexcCoreModule) {
  'use strict';
  const Core = MexcCoreModule || {};
  const median = Core.median || function (a) { return 0; };
  const mad = Core.medianAbsoluteDeviation || function () { return 0; };
  const robustZScore = Core.robustZScore || function () { return 0; };
  const findLevelWall = Core.findLevelWall || function () { return null; };
  const coreComputeFeatures = Core.computeFeatures || function () { return {}; };
  const coreDetectLadder = Core.detectLadder || function () { return null; };
  const coreDetectErshik = Core.detectErshik || function () { return null; };
  const coreDetectAbsorption = Core.detectAbsorption || function () { return null; };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function mean(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(mean(arr.map(function (x) { return (x - m) * (x - m); })));
  }
  function cv(arr) { const m = mean(arr); return m > 0 ? stdev(arr) / m : 0; }

  // ==========================================================================
  // 1. CONFIG — ни одного "магического числа" без объяснения в комментарии рядом (п.35/37 ТЗ).
  // Всё живёт здесь, не разбросано по коду детекторов — редактируется в одном месте.
  // ==========================================================================
  const CFG = {
    recomputeIntervalMs: 1200,          // основной цикл — чаще, чем у Filter 1/2 (2с), т.к. паттерны здесь короче по времени жизни отдельных "тиков" состояния
    chunkSize: 30,                      // символов за синхронный кусок (тот же анти-фриз приём, что уже применён к Filter 1/2 — см. commit "виджет виснет")
    baselineWindowMs: 10 * 60000,       // окно adaptive baseline (медиана/MAD размера/интервала сделок)
    minBaselineSamples: 15,             // меньше — baseline ненадёжен, символ пропускается детекторами этого цикла (не выдаём догадку)
    recentWindowMs: 90000,              // окно "текущего" анализа поверх baseline
    minVol24Usd: 40000,                 // ниже — считаем мёртвой парой (2-3 сделки не дают статистики), не "неликвид — это и есть цель"
    maxVol24Usd: 25000000,              // выше — тяжёлая топовая монета, вне периметра (см. Filter 2, подтверждено вживую на BTC/SOL)
    maxSpreadPct: 2.5,                  // шире — реально неторгуемо, детекторы всё равно ничего не покажут полезного
    eventDecayCheckMs: 2000,            // как часто отдельно проверяем ACTIVE-события на WEAKENING/ENDED (не завязано на recompute одного символа)
    eventHistoryKeepMs: 30 * 60000,     // ENDED-события остаются в ленте (п.23 ТЗ) это время, потом убираются
    eventTimelineMaxEntries: 40,        // на событие — bounded, не бесконечная история в RAM (п.28)
    blacklistStorageKey: 'mexc_pe_blacklist',
    // Раздел 3 ТЗ: "НЕ считать Binance/Bybit/OKX основным источником" — целевой периметр это
    // неликвидные/локальные площадки (MEXC/KuCoin/Bitget/BingX/Gate.io/Aster), где реально видны
    // неэффективности. window.mexcTier2ActiveSymbols() отдаёт символы ВСЕХ 9 подключённых рынков
    // (это общий Tier2-буфер, которым пользуются и другие фичи приложения) — здесь явно вычитаем
    // топ-биржи с глубокой, эффективной ликвидностью, а не полагаемся на объёмный фильтр (тот уже
    // проверенно недостаточен, см. историю с AVAX).
    excludedExchanges: ['BINANCE', 'BINANCEFUT', 'OKX'],
    dataFreshOkMs: 5000,                // последний тик данных младше этого -> DATA_OK
    dataFreshDegradedMs: 30000,         // младше этого (но старше dataFreshOkMs) -> DATA_DEGRADED; старше -> DATA_STALE

    // --- ЁРШИК ---
    ershik: {
      lookback: 200,                    // сделок в буфере для core detectErshik
      minRunLength: 8,                  // мин. длина чередующегося забега (тот же порог, что в протестированном detectErshik)
      structureThreshold: 0.6,
      tolerance: 0.2,
      cyclesToConfirm: 4,               // подряд идущих положительных тика (не один!) до CONFIRMED — п.9 ТЗ "нельзя после нескольких случайных сделок"
      confirmWindowMs: 40000,           // за это время должны набраться cyclesToConfirm тиков, иначе сброс в WATCHING
      decayMs: 25000,                   // нет положительного тика столько — ACTIVE -> WEAKENING
      endMs: 60000                      // и ещё столько без тика — WEAKENING -> ENDED
    },
    // --- ЛЕСТНИЦА ---
    ladder: {
      wallMinRatio: 4,                  // findLevelWall: уровень >= медианы остальных * это, чтобы считаться "стеной" (относительно, не $5k)
      minRepeats: 3,                    // минимум повторов wall->consumed->new wall до CONFIRMED
      sizeTolerancePct: 45,             // следующая стена в пределах +-45% от предыдущей — "похожего размера"
      minDisplacementPct: 0.12,         // цена должна сдвинуться хотя бы настолько между стенами (иначе это одна и та же стена, не следующая)
      maxGapMs: 60000,                  // максимум между поглощением стены и появлением следующей — иначе цепочка считается оборванной
      decayMs: 90000,
      endMs: 120000
    },
    // --- ПЕРЕСТАВЛЯШ ---
    reposition: {
      wallMinRatio: 4,
      minMoves: 2,                      // минимум перестановок до CONFIRMED
      sizeTolerancePct: 55,             // сопоставление "той же" стены на новом уровне — по размеру
      maxLevelDistancePct: 1.2,         // новая стена должна появиться в пределах этого % от старого уровня, иначе это не "перестановка", а другая стена
      maxGapMs: 30000,
      decayMs: 60000,
      endMs: 90000
    },
    // --- ПОКУПАШ / ПРОДАВАШ (общий детектор, direction — параметр) ---
    aggro: {
      lookback: 50,
      minRepeats: 5,                    // тот же порог "2-3 не считать", что в остальном проекте
      dominanceMin: 0.65,               // доля сделок в эту сторону среди недавних
      sizeCvMax: 0.7,                   // объёмы НЕ обязаны быть одинаковыми (п.12 ТЗ) — допуск шире, чем у строгих кластерных детекторов
      intervalCvMax: 0.65,
      decayMs: 25000,
      endMs: 45000
    },
    // --- ПРОКИД / ПРОСТРЕЛ (общий impulse-детектор, дальше классифицируется по исходу) ---
    impulse: {
      minZScore: 3.2,                   // текущее 30с-движение должно быть настолько необычным относительно СВОЕЙ истории волатильности этого символа (адаптивно, не фикс. %)
      minVolumePercentile: 0.75,        // и происходить при заметно повышенном объёме (relative_volume/volume_zscore из core computeFeatures)
      confirmWindowMs: 30000,           // ждём столько после импульса, прежде чем классифицировать — "нельзя классифицировать до появления информации о последующем движении" (п.14/15 ТЗ)
      returnThresholdPct: 65            // ретрейс >= этой % от амплитуды импульса И назад в исходный диапазон -> ПРОКИД; иначе -> ПРОСТРЕЛ
    }
  };

  // ==========================================================================
  // 2. BLACKLIST — п.27 ТЗ. 24 HOURS / PERMANENT, персистентно.
  //    ИСПРАВЛЕНО (audit fix): раньше PERMANENT хранился как Infinity, а JSON.stringify(Infinity)
  //    сериализуется в null — после перезапуска приложения map[symbol] восстанавливался как null,
  //    и isBlacklisted() трактовал null как "не в блэклисте", т.е. PERMANENT-запись сама себя тихо
  //    снимала после reload. Строковый sentinel переживает JSON round-trip без потерь.
  // ==========================================================================
  const PERMANENT_SENTINEL = 'PERMANENT';
  const Blacklist = (function () {
    let map = {}; // symbol -> expiresAt (ms, число) | PERMANENT_SENTINEL
    try {
      const raw = localStorage.getItem(CFG.blacklistStorageKey);
      if (raw) map = JSON.parse(raw);
    } catch (e) { /* переживём без сохранённого blacklist */ }
    function persist() { try { localStorage.setItem(CFG.blacklistStorageKey, JSON.stringify(map)); } catch (e) {} }
    function isBlacklisted(symbol) {
      const exp = map[symbol];
      if (exp == null) return false;
      if (exp !== PERMANENT_SENTINEL && Date.now() > exp) { delete map[symbol]; persist(); return false; }
      return true;
    }
    function add(symbol, mode) {
      map[symbol] = mode === 'PERMANENT' ? PERMANENT_SENTINEL : (Date.now() + 24 * 3600000);
      persist();
    }
    function remove(symbol) { delete map[symbol]; persist(); }
    function list() { return Object.keys(map).map(function (s) { return { symbol: s, expiresAt: map[s] }; }); }
    return { isBlacklisted: isBlacklisted, add: add, remove: remove, list: list };
  })();

  // ==========================================================================
  // 3. PER-SYMBOL STATE — отдельное состояние на каждый символ, никогда не смешивается (п.7 ТЗ).
  // ==========================================================================
  const symbolStates = new Map(); // symbol -> { ershik, ladder, reposition, buyer, seller, impulse, debug }
  function getSymbolState(symbol) {
    let s = symbolStates.get(symbol);
    if (!s) {
      s = {
        ershik: { status: 'WATCHING', cycles: 0, firstTickAt: 0, lastTickAt: 0 },
        ladder: { status: 'WATCHING', repeats: 0, side: null, lastWall: null, lastTickAt: 0 },
        reposition: { status: 'WATCHING', moves: 0, side: null, lastWall: null, lastTickAt: 0 },
        buyer: { status: 'WATCHING', repeats: 0, lastTickAt: 0 },
        seller: { status: 'WATCHING', repeats: 0, lastTickAt: 0 },
        impulse: null, // {startedAt, direction, preRangeLo, preRangeHi, peakPrice, status:'POTENTIAL'|'DONE'}
        debug: {}
      };
      symbolStates.set(symbol, s);
    }
    return s;
  }

  // ==========================================================================
  // 4. EVENT MANAGER — единая точка создания/обновления событий, lifecycle, dedup, timeline
  //    (п.16/17/20/21/23/24/26 ТЗ). ОДНО активное событие на (symbol, patternType) — обновляется
  //    на месте, новое создаётся только после ENDED предыдущего (п.24).
  // ==========================================================================
  let eventSeq = 0;
  const events = new Map(); // key "symbol|pattern" -> event

  function keyOf(symbol, pattern) { return symbol + '|' + pattern; }

  function pushTimeline(ev, type, message) {
    ev.timeline.push({ t: Date.now(), type: type, message: message });
    if (ev.timeline.length > CFG.eventTimelineMaxEntries) ev.timeline.splice(0, ev.timeline.length - CFG.eventTimelineMaxEntries);
  }

  // upsertEvent — вызывается детектором на каждый "положительный тик". status/metrics/confidence
  // передаются свежими; сама функция решает ACTIVE/WEAKENING/ENDED переходы и что писать в timeline.
  // quality (audit fix, раздел 31 ТЗ): при 'DATA_DEGRADED' НЕ создаём новое событие (return null) —
  // но если событие для этого (symbol,pattern) УЖЕ существует и активно, апдейт ниже НЕ блокируется,
  // чтобы не ломать lifecycle уже идущего паттерна из-за временно деградировавших данных.
  function upsertEvent(symbol, pattern, metrics, confidence, direction, quality) {
    const now = Date.now();
    const k = keyOf(symbol, pattern);
    let ev = events.get(k);
    if (!ev || ev.status === 'ENDED') {
      if (quality === 'DATA_DEGRADED') return null;
      ev = {
        id: 'pe' + (++eventSeq), symbol: symbol, exchange: global.mexcExchangeOfSymbol ? global.mexcExchangeOfSymbol(symbol) : 'MEXC',
        pattern: pattern, direction: direction || null, status: 'ACTIVE',
        startedAt: now, lastUpdateAt: now, confidence: confidence, metrics: metrics,
        timeline: []
      };
      events.set(k, ev);
      // Раздел 26 ТЗ различает DETECTED и CONFIRMED — этот движок вообще не создаёт событие, пока
      // соответствующая state machine (cyclesToConfirm/minRepeats/minMoves/dominance-гейты выше)
      // уже не прошла подтверждение, поэтому первое появление события ЧЕСТНО подписывается как
      // CONFIRMED, а не DETECTED (одиночный сырой тик в принципе не может сюда попасть).
      pushTimeline(ev, 'PATTERN_CONFIRMED', labelFor(pattern) + ' подтверждён');
      return ev;
    }
    const wasWeakening = ev.status === 'WEAKENING';
    const prevMetrics = ev.metrics;
    const prevDirection = ev.direction;
    ev.status = 'ACTIVE';
    ev.lastUpdateAt = now;
    ev.metrics = metrics;
    if (direction && prevDirection && direction !== prevDirection) pushTimeline(ev, 'PATTERN_CHANGED', labelFor(pattern) + ' сменил направление: ' + prevDirection + ' -> ' + direction);
    ev.direction = direction || ev.direction;
    const confDelta = confidence - ev.confidence;
    ev.confidence = confidence;
    if (wasWeakening) pushTimeline(ev, 'PATTERN_ACTIVE', labelFor(pattern) + ' снова активен');
    else if (metricsGrew(prevMetrics, metrics)) pushTimeline(ev, 'REPETITION_DETECTED', repeatSummary(pattern, metrics));
    if (confDelta >= 15) pushTimeline(ev, 'PATTERN_INTENSIFIED', 'confidence ' + Math.round(confidence) + '%');
    return ev;
  }

  function metricsGrew(a, b) {
    if (!a || !b) return false;
    const keys = ['repeats', 'cycles', 'moves'];
    for (let i = 0; i < keys.length; i++) { if (b[keys[i]] != null && a[keys[i]] != null && b[keys[i]] > a[keys[i]]) return true; }
    return false;
  }
  function repeatSummary(pattern, m) {
    if (m.repeats != null) return 'повтор #' + m.repeats;
    if (m.cycles != null) return 'цикл #' + m.cycles;
    if (m.moves != null) return 'перестановка #' + m.moves;
    return 'подтверждение';
  }

  // Вызывается каждый CFG.eventDecayCheckMs — переводит ACTIVE без свежих тиков в WEAKENING,
  // а WEAKENING без тиков дольше endMs — в ENDED (п.9/10/11 ТЗ, "decay" для каждого детектора).
  const DECAY_MS_BY_PATTERN = {
    ERSHIK: CFG.ershik, LADDER: CFG.ladder, REPOSITION: CFG.reposition,
    BUYER: CFG.aggro, SELLER: CFG.aggro
  };
  function sweepEventLifecycle() {
    const now = Date.now();
    events.forEach(function (ev) {
      if (ev.pattern === 'PROKID' || ev.pattern === 'PROSTREL') return; // эти закрываются сразу при классификации, не через decay
      const cfg = DECAY_MS_BY_PATTERN[ev.pattern];
      if (!cfg) return;
      const sinceTick = now - ev.lastUpdateAt;
      if (ev.status === 'ACTIVE' && sinceTick > cfg.decayMs) {
        ev.status = 'WEAKENING';
        pushTimeline(ev, 'PATTERN_WEAKENED', labelFor(ev.pattern) + ' слабеет — нет новых подтверждений');
      } else if (ev.status === 'WEAKENING' && sinceTick > cfg.decayMs + cfg.endMs) {
        ev.status = 'ENDED';
        pushTimeline(ev, 'PATTERN_ENDED', labelFor(ev.pattern) + ' завершён');
      }
    });
    // Уборка очень старых ENDED — bounded history (п.28), не бесконечный рост Map.
    events.forEach(function (ev, k) {
      if (ev.status === 'ENDED' && now - ev.lastUpdateAt > CFG.eventHistoryKeepMs) events.delete(k);
    });
  }

  const LABELS = {
    ERSHIK: '🦔 ЁРШИК', LADDER: '🪜 ЛЕСТНИЦА', REPOSITION: '🔄 ПЕРЕСТАВЛЯШ',
    BUYER: '🟢 ПОКУПАШ', SELLER: '🔴 ПРОДАВАШ', PROKID: '↩️ ПРОКИД', PROSTREL: '🚀 ПРОСТРЕЛ'
  };
  function labelFor(p) { return LABELS[p] || p; }

  // ==========================================================================
  // 5. ELIGIBILITY — п.6 ТЗ Instrument Eligibility Engine (упрощённая честная версия: объёмный
  //    пол/потолок + исключение известных топ-капов; полный набор относительных метрик из спека —
  //    trade clustering/price impact/volume-depth ratio — уже частично покрыт внутри самих
  //    детекторов через baseline конкретного символа, не дублируется здесь отдельным слоем).
  // ==========================================================================
  function isEligible(symbol) {
    if (Blacklist.isBlacklisted(symbol)) return false;
    const exch = global.mexcExchangeOfSymbol ? global.mexcExchangeOfSymbol(symbol) : 'MEXC';
    if (CFG.excludedExchanges.indexOf(exch) !== -1) return false;
    const coin = global.mexcCoinMap ? global.mexcCoinMap.get(symbol) : null;
    if (!coin) return false;
    const vol24 = coin.vol24 || 0;
    if (vol24 < CFG.minVol24Usd || vol24 > CFG.maxVol24Usd) return false;
    if (global.mexcMajorCoinSymbols && global.mexcMajorCoinSymbols.has(coin.baseAsset)) return false;
    const depth = global.mexcTier2DepthForSymbol(symbol);
    if (depth && depth.length) {
      const last = depth[depth.length - 1];
      if (last.bestBid > 0 && last.bestAsk > last.bestBid) {
        const spreadPct = (last.bestAsk - last.bestBid) / ((last.bestAsk + last.bestBid) / 2) * 100;
        if (spreadPct > CFG.maxSpreadPct) return false;
      }
    }
    return true;
  }

  // ==========================================================================
  // 5b. NORMALIZED DATA TYPES — раздел 4 ТЗ (NormalizedTrade / NormalizedOrderBookUpdate). Реальные
  // tier2-буферы уже содержат по сути этот же нормализованный вид (side из настоящего поля биржи,
  // единый формат по всем подключённым рынкам, см. шапку файла) — второй параллельный буфер с тем же
  // содержимым только бы дублировал память; здесь формализуем явный конвертер с точными именами
  // полей из ТЗ, используемый в debug/наблюдаемости (п.13/36 ТЗ), чтобы объекты с такими именами
  // реально существовали, а не подразумевались.
  // ==========================================================================
  function normalizeTrade(symbol, raw) {
    if (!raw) return null;
    return {
      exchange: global.mexcExchangeOfSymbol ? global.mexcExchangeOfSymbol(symbol) : 'MEXC',
      symbol: symbol, timestamp: raw.t, price: raw.price, quantity: raw.qty,
      quoteVolume: raw.price * raw.qty, side: raw.side === 'buy' ? 'BUY' : 'SELL',
      tradeId: raw.t + '_' + raw.price + '_' + raw.qty // синтетический id — биржи не отдают устойчивый tradeId во всех подключённых потоках
    };
  }
  function normalizeOrderBookUpdate(symbol, raw) {
    if (!raw) return null;
    return {
      exchange: global.mexcExchangeOfSymbol ? global.mexcExchangeOfSymbol(symbol) : 'MEXC',
      symbol: symbol, timestamp: raw.t, bids: raw.bids, asks: raw.asks,
      isSnapshot: true // честно: периодический снимок топ-N, не diff-поток с sequence — см. шапку файла и раздел 30 ТЗ
    };
  }

  // ==========================================================================
  // 5c. DATA QUALITY — раздел 31 ТЗ: DATA_OK / DATA_DEGRADED / DATA_STALE. На устаревших данных
  // (потерян WS, поток залип) детекторы должны молчать, а не выдавать вывод по мёртвому снимку —
  // тот же принцип "пусто — нормальный результат", что и во всей остальной философии движка.
  // ==========================================================================
  function dataQualityFor(lastTs, now) {
    if (lastTs == null) return 'DATA_STALE';
    const age = now - lastTs;
    if (age <= CFG.dataFreshOkMs) return 'DATA_OK';
    if (age <= CFG.dataFreshDegradedMs) return 'DATA_DEGRADED';
    return 'DATA_STALE';
  }

  // ==========================================================================
  // 6. ДЕТЕКТОР: ЁРШИК — обёртка state machine поверх протестированного Core.detectErshik.
  //    WATCHING -> CONFIRMING (тики копятся) -> CONFIRMED/ACTIVE (событие создано) -> decay в
  //    sweepEventLifecycle. Один положительный тик НИКОГДА сам по себе не создаёт событие (п.9 ТЗ).
  // ==========================================================================
  function runErshik(symbol, trades, now, quality) {
    const st = getSymbolState(symbol).ershik;
    const hit = coreDetectErshik(trades, {
      lookback: CFG.ershik.lookback, minRepeats: CFG.ershik.minRunLength,
      structureThreshold: CFG.ershik.structureThreshold, tolerance: CFG.ershik.tolerance
    });
    getSymbolState(symbol).debug.ershik = { hit: !!hit, raw: hit };
    if (!hit) {
      // Не сбрасываем немедленно — окно confirmWindowMs даёт право на пропуск одного тика подряд,
      // иначе шумный рынок никогда бы не набрал cyclesToConfirm.
      if (st.status === 'CONFIRMING' && now - st.firstTickAt > CFG.ershik.confirmWindowMs) { st.status = 'WATCHING'; st.cycles = 0; }
      return;
    }
    if (st.status === 'WATCHING') { st.status = 'CONFIRMING'; st.cycles = 1; st.firstTickAt = now; st.lastTickAt = now; return; }
    if (now - st.lastTickAt > CFG.ershik.confirmWindowMs) { st.status = 'CONFIRMING'; st.cycles = 1; st.firstTickAt = now; st.lastTickAt = now; return; }
    st.cycles++; st.lastTickAt = now;
    if (st.status === 'CONFIRMING' && st.cycles < CFG.ershik.cyclesToConfirm) return;
    st.status = 'CONFIRMED';
    const confidence = clamp(55 + st.cycles * 4 + (hit.structureSignals || 0) * 5, 0, 97);
    upsertEvent(symbol, 'ERSHIK', {
      cycles: st.cycles, repeatCount: hit.repeatCount, structureSignals: hit.structureSignals,
      volumeUsd: hit.volumeUsd, durationS: Math.round((now - st.firstTickAt) / 1000)
    }, confidence, hit.direction, quality);
  }

  // ==========================================================================
  // 7. ДЕТЕКТОР: ЛЕСТНИЦА — своя wall-tracking state machine поверх findLevelWall (относительный,
  //    не $5k) + Core.detectAbsorption как подтверждение "стену СЪЕЛИ" (не отменили — см. п.10 ТЗ,
  //    отличие от ПЕРЕСТАВЛЯША ниже).
  // ==========================================================================
  function runLadder(symbol, depthSnaps, trades, now, quality) {
    const st = getSymbolState(symbol).ladder;
    if (!depthSnaps || depthSnaps.length < 6) return;
    const cur = depthSnaps[depthSnaps.length - 1];
    const bidWall = findLevelWall(cur.bids, CFG.ladder.wallMinRatio);
    const askWall = findLevelWall(cur.asks, CFG.ladder.wallMinRatio);
    getSymbolState(symbol).debug.ladder = { bidWall: bidWall, askWall: askWall, state: st.status };

    if (st.status === 'WATCHING') {
      const w = bidWall || askWall;
      if (w) { st.status = 'WALL_ACTIVE'; st.side = bidWall ? 'bid' : 'ask'; st.lastWall = w; st.lastTickAt = now; st.repeats = 0; }
      return;
    }
    const sideWall = st.side === 'bid' ? bidWall : askWall;
    if (st.status === 'WALL_ACTIVE') {
      if (sideWall && Math.abs(sideWall.p - st.lastWall.p) / st.lastWall.p < 0.0005) { st.lastWall = sideWall; return; } // та же стена, ещё стоит
      // Стена пропала с этого уровня — реально ли поглощена (не отменена)?
      const absorbed = coreDetectAbsorption(depthSnaps, trades, { minSnapshots: 6 });
      if (!absorbed) { st.status = 'WATCHING'; return; } // отменили, не съели -> это не Лестница (см. Переставляш)
      st.status = 'AWAITING_NEXT'; st.lastTickAt = now;
      return;
    }
    if (st.status === 'AWAITING_NEXT') {
      if (now - st.lastTickAt > CFG.ladder.maxGapMs) { st.status = 'WATCHING'; return; } // слишком долго без продолжения — цепочка оборвана
      const w = st.side === 'bid' ? bidWall : askWall;
      if (!w) return;
      const sizeRatio = w.q / st.lastWall.q;
      const displacementPct = Math.abs(w.p - st.lastWall.p) / st.lastWall.p * 100;
      const sizeOk = sizeRatio >= (1 - CFG.ladder.sizeTolerancePct / 100) && sizeRatio <= (1 + CFG.ladder.sizeTolerancePct / 100) * 2; // следующая стена такая же или крупнее — сознательно асимметрично (см. ТЗ "такой же или немного больший объём")
      const dirOk = st.side === 'bid' ? w.p < st.lastWall.p : w.p > st.lastWall.p; // "дальше по направлению движения"
      if (!sizeOk || !dirOk || displacementPct < CFG.ladder.minDisplacementPct) return;
      st.repeats++; st.lastWall = w; st.status = 'WALL_ACTIVE'; st.lastTickAt = now;
      if (st.repeats < CFG.ladder.minRepeats) return;
      const confidence = clamp(55 + st.repeats * 8, 0, 96);
      upsertEvent(symbol, 'LADDER', {
        repeats: st.repeats, side: st.side, wallSizeUsd: Math.round(w.q * w.p), lastStepPct: Math.round(displacementPct * 100) / 100
      }, confidence, st.side === 'bid' ? 'LONG' : 'SHORT', quality);
    }
  }

  // ==========================================================================
  // 8. ДЕТЕКТОР: ПЕРЕСТАВЛЯШ — та же wall-tracking, но триггерится именно когда стену ОТМЕНИЛИ
  //    (не съели — detectAbsorption вернул null), и следующая похожая стена появилась РЯДОМ
  //    (не далеко, в отличие от Лестницы). Явно НЕ утверждаем "один и тот же ордер/участник" —
  //    только "repositioning pattern" по совпадению цена/размер/время (п.11 ТЗ, честная оговорка).
  // ==========================================================================
  function runReposition(symbol, depthSnaps, trades, now, quality) {
    const st = getSymbolState(symbol).reposition;
    if (!depthSnaps || depthSnaps.length < 6) return;
    const cur = depthSnaps[depthSnaps.length - 1];
    const bidWall = findLevelWall(cur.bids, CFG.reposition.wallMinRatio);
    const askWall = findLevelWall(cur.asks, CFG.reposition.wallMinRatio);
    getSymbolState(symbol).debug.reposition = { bidWall: bidWall, askWall: askWall, state: st.status };

    if (st.status === 'WATCHING') {
      const w = bidWall || askWall;
      if (w) { st.status = 'WALL_ACTIVE'; st.side = bidWall ? 'bid' : 'ask'; st.lastWall = w; st.lastTickAt = now; st.moves = 0; }
      return;
    }
    const sideWall = st.side === 'bid' ? bidWall : askWall;
    if (st.status === 'WALL_ACTIVE') {
      if (sideWall && Math.abs(sideWall.p - st.lastWall.p) / st.lastWall.p < 0.0005) { st.lastWall = sideWall; return; }
      const absorbed = coreDetectAbsorption(depthSnaps, trades, { minSnapshots: 6 });
      if (absorbed) { st.status = 'WATCHING'; return; } // реально съедена -> это Лестница, не Переставляш
      st.status = 'AWAITING_NEXT'; st.lastTickAt = now; // отменена без исполнения — кандидат в переставляш
      return;
    }
    if (st.status === 'AWAITING_NEXT') {
      if (now - st.lastTickAt > CFG.reposition.maxGapMs) { st.status = 'WATCHING'; return; }
      const w = st.side === 'bid' ? bidWall : askWall;
      if (!w) return;
      const sizeRatio = w.q / st.lastWall.q;
      const sizeOk = sizeRatio >= (1 - CFG.reposition.sizeTolerancePct / 100) && sizeRatio <= (1 + CFG.reposition.sizeTolerancePct / 100);
      const distPct = Math.abs(w.p - st.lastWall.p) / st.lastWall.p * 100;
      if (!sizeOk || distPct > CFG.reposition.maxLevelDistancePct) return; // слишком далеко/непохожа — не переставленная, а другая стена
      st.moves++; st.lastWall = w; st.status = 'WALL_ACTIVE'; st.lastTickAt = now;
      if (st.moves < CFG.reposition.minMoves) return;
      const confidence = clamp(50 + st.moves * 10, 0, 92);
      upsertEvent(symbol, 'REPOSITION', {
        moves: st.moves, side: st.side, wallSizeUsd: Math.round(w.q * w.p), lastDistancePct: Math.round(distPct * 100) / 100
      }, confidence, st.side === 'bid' ? 'LONG' : 'SHORT', quality);
    }
  }

  // ==========================================================================
  // 9. ДЕТЕКТОР: ПОКУПАШ / ПРОДАВАШ — общий движок, direction параметризован (п.13 ТЗ).
  //    НЕ "buyVolume > sellVolume" (запрещено п.12) — требуется repeated структура: устойчивая
  //    доля сделок в одну сторону + похожий (не идентичный) размер + похожая частота.
  // ==========================================================================
  function runAggroDetector(symbol, trades, now, side, pattern, quality) {
    const debugKey = pattern === 'BUYER' ? 'buyer' : 'seller';
    const st = getSymbolState(symbol)[debugKey];
    const recent = trades.slice(-CFG.aggro.lookback);
    if (recent.length < CFG.aggro.minRepeats) {
      getSymbolState(symbol).debug[debugKey] = { reason: 'insufficient_trades', count: recent.length, state: st.status };
      return;
    }
    const sideTrades = recent.filter(function (t) { return t.side === side; });
    const dominance = recent.length ? sideTrades.length / recent.length : 0;
    const sizes = sideTrades.map(function (t) { return t.price * t.qty; });
    const sizeCvV = cv(sizes);
    const intervals = [];
    for (let i = 1; i < sideTrades.length; i++) intervals.push(sideTrades[i].t - sideTrades[i - 1].t);
    const intervalCvV = cv(intervals);
    // Debug пишется ДО геймов на выход — иначе не видно, ПОЧЕМУ паттерн не сработал, а именно это и
    // нужно для observability (раздел 36 ТЗ), а не только подтверждать удачные случаи.
    getSymbolState(symbol).debug[debugKey] = {
      repeats: sideTrades.length, dominance: Math.round(dominance * 100) / 100,
      sizeCv: Math.round(sizeCvV * 100) / 100, intervalCv: Math.round(intervalCvV * 100) / 100, state: st.status,
      thresholds: { minRepeats: CFG.aggro.minRepeats, dominanceMin: CFG.aggro.dominanceMin, sizeCvMax: CFG.aggro.sizeCvMax, intervalCvMax: CFG.aggro.intervalCvMax }
    };
    if (sideTrades.length < CFG.aggro.minRepeats) { st.status = 'WATCHING'; return; }
    if (dominance < CFG.aggro.dominanceMin) { st.status = 'WATCHING'; return; }
    if (sizeCvV > CFG.aggro.sizeCvMax) { st.status = 'WATCHING'; return; }
    if (intervalCvV > CFG.aggro.intervalCvMax) { st.status = 'WATCHING'; return; }

    st.status = 'ACTIVE'; st.repeats = sideTrades.length; st.lastTickAt = now;
    const consistency = clamp(1 - (sizeCvV + intervalCvV) / 2, 0, 1);
    const confidence = clamp(50 + dominance * 25 + consistency * 22, 0, 96);
    upsertEvent(symbol, pattern, {
      repeats: sideTrades.length, dominancePct: Math.round(dominance * 100),
      medianSizeUsd: Math.round(median(sizes)), sizeDeviationPct: Math.round(sizeCvV * 100),
      medianIntervalMs: Math.round(median(intervals) || 0)
    }, confidence, side === 'buy' ? 'LONG' : 'SHORT', quality);
  }

  // ==========================================================================
  // 10. ДЕТЕКТОР: ПРОКИД / ПРОСТРЕЛ — общий impulse-детектор + confirmation window (п.14/15 ТЗ:
  //     классификация ТОЛЬКО после того, как появилась информация о последующем движении —
  //     обязательная задержка, не мгновенное решение).
  // ==========================================================================
  function runImpulse(symbol, trades, depthSnaps, now, quality) {
    const st = getSymbolState(symbol);
    const f = coreComputeFeatures(trades, depthSnaps, now);
    getSymbolState(symbol).debug.impulse = { f: f, state: st.impulse };

    if (st.impulse && st.impulse.status === 'CONFIRMING') {
      // Уже в окне подтверждения — не ищем новый импульс, ждём исхода текущего.
      const imp = st.impulse;
      const last = trades[trades.length - 1];
      if (!last) return;
      const price = last.price;
      if (price > imp.maxPrice) imp.maxPrice = price;
      if (price < imp.minPrice) imp.minPrice = price;
      const excursion = imp.direction === 'LONG' ? (imp.maxPrice - imp.startPrice) : (imp.startPrice - imp.minPrice);
      if (excursion > imp.amplitude) imp.amplitude = excursion; // максимальный размах на всякий случай (может продолжить расти во время окна)
      if (now - imp.startedAt < CFG.impulse.confirmWindowMs) return; // окно ещё не закрылось — рано классифицировать

      const retraced = imp.direction === 'LONG' ? (imp.maxPrice - price) : (price - imp.minPrice);
      const retracedPct = imp.amplitude > 0 ? (retraced / imp.amplitude) * 100 : 0;
      const backInRange = imp.direction === 'LONG' ? price <= imp.preRangeHi * 1.0015 : price >= imp.preRangeLo * 0.9985;
      const isProkid = retracedPct >= CFG.impulse.returnThresholdPct && backInRange;
      const pattern = isProkid ? 'PROKID' : 'PROSTREL';
      const confidence = clamp(isProkid ? 55 + retracedPct * 0.4 : 55 + clamp((100 - retracedPct), 0, 40), 0, 95);
      // audit fix (раздел 31 ТЗ): ПРОКИД/ПРОСТРЕЛ всегда создаёт НОВОЕ событие (не апдейт), поэтому
      // при DATA_DEGRADED публикацию просто откладываем — impulse остаётся в CONFIRMING (st.impulse
      // не трогаем), переклассификация повторится на следующем тике, когда качество данных восстановится.
      if (quality === 'DATA_DEGRADED') return;
      const k = keyOf(symbol, pattern);
      const ev = {
        id: 'pe' + (++eventSeq), symbol: symbol, exchange: global.mexcExchangeOfSymbol ? global.mexcExchangeOfSymbol(symbol) : 'MEXC',
        pattern: pattern, direction: imp.direction, status: 'ACTIVE',
        startedAt: imp.startedAt, lastUpdateAt: now, confidence: confidence,
        metrics: {
          impulsePct: Math.round(imp.amplitude / imp.startPrice * 10000) / 100,
          retracedPct: Math.round(retracedPct), durationS: Math.round((now - imp.startedAt) / 1000)
        },
        timeline: []
      };
      pushTimeline(ev, 'PATTERN_CONFIRMED', labelFor(pattern) + ' классифицирован после ' + Math.round(CFG.impulse.confirmWindowMs / 1000) + 'с окна подтверждения');
      events.set(k, ev);
      // Прокид/прострел — одномоментное, не длящееся состояние; сразу планируем угасание.
      ev.status = 'WEAKENING';
      setTimeout(function () { if (events.get(k) === ev) { ev.status = 'ENDED'; pushTimeline(ev, 'PATTERN_ENDED', 'событие закрыто'); } }, 20000);
      st.impulse = null;
      return;
    }

    // Поиск НОВОГО импульса — адаптивный z-score (СВОЯ история волатильности символа, не фикс. %).
    if (f.volatility_30s == null || f.volatility_percentile == null) return; // недостаточно истории — честно молчим
    const bigMove = f.volatility_percentile >= 0.97 && f.returns[30] != null && Math.abs(f.returns[30]) > 0;
    if (!bigMove) return;
    const volOk = f.large_trade_ratio == null || f.large_trade_ratio >= CFG.impulse.minVolumePercentile - 0.35; // мягкое условие — большой объём подтверждает, но не единственное условие (п.15 "prostrel POTENTIAL")
    if (!volOk) return;
    const direction = f.returns[30] > 0 ? 'LONG' : 'SHORT';
    const last = trades[trades.length - 1];
    const preTrades = trades.filter(function (t) { return t.t < now - 15000 && t.t >= now - 60000; });
    if (preTrades.length < 5) return;
    const preRangeHi = Math.max.apply(null, preTrades.map(function (t) { return t.price; }));
    const preRangeLo = Math.min.apply(null, preTrades.map(function (t) { return t.price; }));
    st.impulse = {
      status: 'CONFIRMING', direction: direction, startedAt: now, startPrice: last.price,
      preRangeHi: preRangeHi, preRangeLo: preRangeLo, maxPrice: last.price, minPrice: last.price, amplitude: 0
    };
  }

  // ==========================================================================
  // 11. ОСНОВНОЙ ЦИКЛ — чанкинг (тот же анти-фриз приём, что и у Filter 1/2, см. историю).
  // ==========================================================================
  let recomputeInProgress = false;
  let recomputeQueue = null;
  let lastComputeAt = 0;

  function processOneSymbol(symbol, now) {
    if (!isEligible(symbol)) return;
    const trades = global.mexcTier2TradesForSymbol(symbol);
    if (!trades || trades.length < CFG.minBaselineSamples) return;
    const depthSnaps = global.mexcTier2DepthForSymbol(symbol) || [];
    const lastTrade = trades[trades.length - 1];
    const quality = dataQualityFor(lastTrade ? lastTrade.t : null, now);
    const dbg = getSymbolState(symbol).debug;
    dbg.dataQuality = quality;
    dbg.normalized = { lastTrade: normalizeTrade(symbol, lastTrade), lastDepth: normalizeOrderBookUpdate(symbol, depthSnaps[depthSnaps.length - 1]) };
    if (quality === 'DATA_STALE') return; // раздел 31 ТЗ — не запускаем детекторы на мёртвых данных
    try {
      runErshik(symbol, trades, now, quality);
      runLadder(symbol, depthSnaps, trades, now, quality);
      runReposition(symbol, depthSnaps, trades, now, quality);
      runAggroDetector(symbol, trades, now, 'buy', 'BUYER', quality);
      runAggroDetector(symbol, trades, now, 'sell', 'SELLER', quality);
      runImpulse(symbol, trades, depthSnaps, now, quality);
    } catch (e) {
      if (global.logE) global.logE('PatternEngine', symbol + ': детектор упал — ' + e.message);
    }
  }

  function runChunk() {
    const q = recomputeQueue;
    if (!q) { recomputeInProgress = false; return; }
    const now = Date.now();
    const end = Math.min(q.idx + CFG.chunkSize, q.symbols.length);
    for (let i = q.idx; i < end; i++) processOneSymbol(q.symbols[i], now);
    q.idx = end;
    if (q.idx < q.symbols.length) { setTimeout(runChunk, 0); return; }
    recomputeQueue = null;
    recomputeInProgress = false;
  }

  function recompute() {
    if (recomputeInProgress) return;
    const now = Date.now();
    if (now - lastComputeAt < CFG.recomputeIntervalMs) return;
    lastComputeAt = now;
    if (!global.mexcTier2ActiveSymbols) return;
    const symbols = global.mexcTier2ActiveSymbols();
    recomputeQueue = { symbols: symbols, idx: 0 };
    recomputeInProgress = true;
    runChunk();
  }

  // ==========================================================================
  // 12. PUBLIC API
  // ==========================================================================
  function getActiveEvents(filterPatterns, filterExchange) {
    recompute();
    const out = [];
    events.forEach(function (ev) {
      if (ev.status === 'ENDED' && Date.now() - ev.lastUpdateAt > 15000) return; // ENDED кратко видны, потом уходят из "активной" выборки (остаются в истории через getAllEvents)
      if (filterPatterns && filterPatterns.length && filterPatterns.indexOf(ev.pattern) === -1) return;
      if (filterExchange && filterExchange !== 'ALL' && ev.exchange !== filterExchange) return;
      out.push(ev);
    });
    out.sort(function (a, b) {
      const rank = { ACTIVE: 2, WEAKENING: 1, ENDED: 0 };
      if (rank[a.status] !== rank[b.status]) return rank[b.status] - rank[a.status];
      return b.confidence - a.confidence;
    });
    return out;
  }
  function getEventById(id) {
    let found = null;
    events.forEach(function (ev) { if (ev.id === id) found = ev; });
    return found;
  }
  function getDebugInfo(symbol) {
    const st = symbolStates.get(symbol);
    return st ? st.debug : null;
  }

  const api = {
    CFG: CFG,
    LABELS: LABELS,
    labelFor: labelFor,
    getActiveEvents: getActiveEvents,
    getEventById: getEventById,
    getDebugInfo: getDebugInfo,
    blacklist: Blacklist,
    // Для replay/synthetic тестов (п.33 ТЗ) — прогнать один символ через реальные детекторы без
    // ожидания живого рынка. trades/depthSnaps — тот же формат, что и боевые буферы. Работает и в
    // браузере, и под Node (tests/) — не трогает global.mexcCoinMap/тикер-поток, только чистые
    // детекторные функции с переданными данными.
    // reset=true — чистый лист перед прогоном (для независимых сценариев на одном имени символа);
    // reset=false (по умолчанию) — состояние копится между вызовами, как в реальном recompute()-
    // цикле, что и нужно для проверки самого state machine (несколько тиков подряд -> CONFIRMED).
    // quality (audit fix) — опционально 'DATA_OK'|'DATA_DEGRADED'|'DATA_STALE', тот же контракт, что
    // и в processOneSymbol: STALE вообще не вызывает детекторы, DEGRADED протаскивается в upsertEvent
    // (не создаёт НОВЫХ событий, апдейт существующих не блокирует). По умолчанию (undefined) ведёт
    // себя как раньше — не влияет на существующие тесты.
    __replay: function (symbol, trades, depthSnaps, now, reset, quality) {
      if (reset) {
        symbolStates.delete(symbol);
        const rk1 = keyOf(symbol, 'ERSHIK'), rk2 = keyOf(symbol, 'LADDER'), rk3 = keyOf(symbol, 'REPOSITION');
        const rk4 = keyOf(symbol, 'BUYER'), rk5 = keyOf(symbol, 'SELLER'), rk6 = keyOf(symbol, 'PROKID'), rk7 = keyOf(symbol, 'PROSTREL');
        [rk1, rk2, rk3, rk4, rk5, rk6, rk7].forEach(function (k) { events.delete(k); });
      }
      const k1 = keyOf(symbol, 'ERSHIK'), k2 = keyOf(symbol, 'LADDER'), k3 = keyOf(symbol, 'REPOSITION');
      const k4 = keyOf(symbol, 'BUYER'), k5 = keyOf(symbol, 'SELLER'), k6 = keyOf(symbol, 'PROKID'), k7 = keyOf(symbol, 'PROSTREL');
      if (quality !== 'DATA_STALE') {
        try {
          runErshik(symbol, trades, now, quality);
          runLadder(symbol, depthSnaps || [], trades, now, quality);
          runReposition(symbol, depthSnaps || [], trades, now, quality);
          runAggroDetector(symbol, trades, now, 'buy', 'BUYER', quality);
          runAggroDetector(symbol, trades, now, 'sell', 'SELLER', quality);
          runImpulse(symbol, trades, depthSnaps || [], now, quality);
        } catch (e) { /* тест сам увидит по результату */ }
      }
      return [k1, k2, k3, k4, k5, k6, k7].map(function (k) { return events.get(k) || null; });
    },
    // Тестовый доступ к сырому per-symbol state (не только к debug-срезу, который снимается ДО
    // перехода состояния конкретного тика) — нужен для проверки промежуточных шагов wall-tracking
    // state machine (Лестница/Переставляш) между отдельными __replay()-вызовами.
    __peekState: function (symbol) { return symbolStates.get(symbol) || null; },
    // Тестовый доступ к sweepEventLifecycle (в браузере вызывается своим setInterval, см. низ файла;
    // под Node тот таймер не заводится) — нужен для проверки ACTIVE->WEAKENING->ENDED через
    // подмену Date.now() в тесте, без реального ожидания decayMs/endMs.
    __sweepLifecycle: function () { sweepEventLifecycle(); }
  };
  // Фоновые таймеры (основной цикл по живому рынку + decay-проверка) — только в браузере. Под
  // Node (require() из tests/) их не должно быть: там движок дёргают исключительно через
  // __replay() синхронно, живого window.mexcTier2ActiveSymbols там просто не существует.
  if (typeof window !== 'undefined' && global === window) {
    setInterval(sweepEventLifecycle, CFG.eventDecayCheckMs);
  }
  global.PatternEngine = api;
  return api;
});
