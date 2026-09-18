// ============================================================================
// WIDGET FILTER 2 — качественный microstructure-фильтр, ИЗОЛИРОВАННЫЙ от основного скринера
// (Filter 1 / patternHistory / таблица "Скринер" этот файл не трогает и от него не зависит).
// Используется ТОЛЬКО в Widget Mode (см. app.js: renderWidgetFilter2Signals).
//
// Данные — ДВА реальных, уже существующих источника (второго WebSocket/потока этот файл не
// создаёт): 1) Tier 2 буферы сделок/стакана (mexcTier2TradesForSymbol/mexcTier2DepthForSymbol) —
// точные микроструктурные детекторы, но только там, где у монеты реально есть подписка (биржи
// физически не дают подписаться на сделки+стакан по тысячам пар разом); 2) Tier 1 — обычный
// тикер-поток (mexcCoinMap: price/vol24/change24/vol5s), который идёт ПО ВСЕМ монетам сразу —
// используется для более лёгких, но тоже честных детекторов (см. tier1Detectors ниже), чтобы
// движок реально просматривал весь рынок, а не только watchlist.
//
// Принцип (по ТЗ): quality > quantity. Пусто — нормальный результат. Каждый показанный сигнал
// обязан пройти: CANDIDATE -> VALIDATION -> TRADEABILITY -> NOISE FILTER -> QUALITY SCORE ->
// (COMPOSITE) -> DISPLAY. Ничего не смотрит в будущее (никаких future-данных при детекции —
// только для последующей оценки исхода, см. sweepOutcomes).
// ============================================================================
(function (global) {
  'use strict';

  // ------------------------------------------------------------------------
  // Конфиг (изолирован от основного Settings — сознательно: это 45-пунктовое ТЗ на отдельный
  // движок, а не ещё 40 полей в общей странице настроек). Разумные дефолты, правятся здесь.
  // ------------------------------------------------------------------------
  const CFG = {
    recentWindowMs: 120000,          // окно "недавних" сделок для детекторов повторяемости
    baselineWindowMs: 10 * 60000,    // окно для adaptive baseline (медианный размер/интервал/объём)
    minBaselineSamples: 8,           // меньше — baseline считается ненадёжным, детектор пропускает символ
    minRepeats: 5,                   // минимум повторений для повторяш/робота/периодички (п.7: "2-3 не считать")
    sizeCvMax: 0.55,                 // макс. коэффициент вариации размера для "похожих" сделок
    intervalCvMax: 0.45,             // макс. коэффициент вариации интервала для периодичности
    aggressorSizeMult: 7,            // сделка >= baseline*7 — кандидат в "агрессор"
    displayThreshold: 78,            // quality score >= это -> реально показываем (п.24)
    watchThreshold: 62,              // ниже — не показываем, но не мусор, просто "не дотянул"
    // Ликвидностный "пол" (п.21) — отсекает совсем мёртвые пары без реальной торговли (там детекторы
    // просто шумят на 2-3 сделках). БЫЛО 150000 -> опущено до 40000 + добавлен флэт-бонус +7 за
    // LOW_LIQUIDITY — по факту (реальный фидбэк пользователя, 2026-09) это дало явный шум: "детектит
    // тупые монеты, на которых по факту ничего нет". Урок — регим-бонус ЗА САМ ФАКТ неликвидности
    // (независимо от силы найденного паттерна) поднимал слабые/шумные сигналы через displayThreshold
    // только потому, что монета тонкая, а не потому что там реально что-то происходит. Компромисс:
    // порог всё равно ниже исходного (даём неликвиду шанс попасть в скоринг), но БЕЗ автоматической
    // прибавки к score — см. qualityScore ниже, где регим-бонус убран, эмфаза на неликвид/роботов
    // теперь идёт ТОЛЬКО через TYPE-бонусы (BOT_TYPES/INEFFICIENCY_TYPES), которые требуют, чтобы
    // детектор реально нашёл паттерн, а не просто "монета тонкая".
    minVol24Usd: 80000,
    // Потолок по объёму (по запросу, 2026-09) — "торгую неэффективности/аномалии, мне там не нужна
    // Солана и Биткоин". Тяжёлые топовые монеты — самые эффективно оценённые рынки в крипте (глубже
    // всего арбитражится, институциональный поток доминирует) — ровно то, где искать "неэффективность"
    // менее осмысленно, чем на мелких/средних альтах. $25M/24ч — уже заметно выше топ-30-40 alt-монет
    // по объёму, но на 2-3 порядка меньше BTC/ETH/SOL/BNB — жёстко отсекает именно "тяжеляк", не мелочь.
    maxVol24Usd: 25000000,
    maxSpreadPct: 1.6,                // умеренно шире прежнего (1.2), не 2.5 — реальный экономический фильтр всё равно ниже, в tradeabilityMoveOk
    staleMs: 15000,                  // те же 15с, что и у остальных детекторов проекта (протухшие данные)
    signalDecayMs: 75000,            // сигнал без переподтверждения дольше этого — считается ACTIVE -> истёк
    cooldownPerSymbolTypeMs: 45000,  // анти-дребезг: тот же тип сигнала на той же монете не чаще этого
    recomputeIntervalMs: 2200,
    outcomeCheckpointsS: [1, 3, 5, 10, 30, 60],
    maxDisplayed: 6,
    // --- Tier-1 широкий скан (см. шапку файла ниже) ---
    tier1HistoryCap: 220,            // ~220 сэмплов * recomputeIntervalMs(2.2с) ≈ 8 минут истории
    tier1MinSamples: 15,
    tier1BreakoutMinVolAccel: 1.6,   // рост объёма (vol24) за окно вне обычной скорости роста
    tier1AggressorVolMult: 3.2       // текущая vol5s (реализованная волатильность) >> собственная медиана монеты
  };

  const LABELS = {
    robotBuyer: '🤖 РОБОТ-ПОКУПАШ',
    robotSeller: '🤖 РОБОТ-ПРОДАВАШ',
    repositioning: '🔄 ПЕРЕСТАВЛЯШ',
    repeatedPrints: '🔁 ПОВТОРЯШ',
    periodicity: '⏱ ПЕРИОДИЧКА',
    absorptionBuy: '🧱 ПОГЛОЩЕНИЕ (buy)',
    absorptionSell: '🧱 ПОГЛОЩЕНИЕ (sell)',
    refill: '🧊 REFILL',
    holderBid: '🛡 ДЕРЖАТЕЛЬ (bid)',
    holderAsk: '🛡 ДЕРЖАТЕЛЬ (ask)',
    liquidityPull: '💨 ЛИКВИДНОСТЬ УШЛА',
    liquidityVacuum: '🌪 ЛИКВИДНОСТНЫЙ ВАКУУМ',
    breakout: '🚀 ВЫЛЕТ',
    aggressor: '🐋 АГРЕССОР',
    ladder: '🪜 ЛЕСТНИЦА',
    uptick: '🔼 АПТИК',
    downtick: '🔽 ДАУНТИК',
    shootThrough: '💥 ПРОСТРЕЛ',
    rangeSpikeRevert: '🦔 ЁРШИК (ценовой)',
    flowCascade: '⛓ FLOW CASCADE',
    twapLike: '🤖 TWAP-ПОДОБНЫЙ',
    vwapLike: '🤖 VWAP-ПОДОБНЫЙ',
    inventoryUnload: '📤 РАЗДАЧА',
    gridLike: '🧹 GRID-ПОДОБНЫЙ',
    marketMakerLike: '⚖ MARKET-MAKER-ПОДОБНЫЙ',
    icebergLike: '🧊 ICEBERG-ПОДОБНЫЙ',
    sniperLike: '🎯 LIQUIDITY-TAKER',
    distributedLiquidity: '🧹 ЁРШИК (ликвидность)'
  };

  // Категории типов — упор Filter 2 (по запросу): роботы/алгоритмы и рыночные неэффективности
  // получают бонус к score (см. qualityScore ниже), чтобы при прочих равных именно они чаще
  // всплывали над порогом показа, а не тонули среди обычных momentum-сигналов (агрессор/вылет/тик).
  const BOT_TYPES = new Set([
    'robotBuyer', 'robotSeller', 'twapLike', 'vwapLike', 'gridLike', 'marketMakerLike',
    'icebergLike', 'sniperLike', 'distributedLiquidity', 'inventoryUnload'
  ]);
  const INEFFICIENCY_TYPES = new Set([
    'absorptionBuy', 'absorptionSell', 'refill', 'holderBid', 'holderAsk',
    'liquidityPull', 'liquidityVacuum', 'ladder', 'flowCascade', 'rangeSpikeRevert'
  ]);

  // ------------------------------------------------------------------------
  // Статистика — маленькие локальные хелперы (не тянем MexcCore, модуль изолирован намеренно).
  // ------------------------------------------------------------------------
  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort(function (a, b) { return a - b; });
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function mean(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(mean(arr.map(function (x) { return (x - m) * (x - m); })));
  }
  function cv(arr) { const m = mean(arr); return m > 0 ? stdev(arr) / m : 0; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ------------------------------------------------------------------------
  // FEATURE ENGINE — сырые признаки по сделкам за окно, плюс adaptive baseline (п.20: не
  // одинаковые пороги для всех монет — всё нормализовано относительно СВОЕЙ истории монеты).
  // ------------------------------------------------------------------------
  function computeFeatures(symbol, now) {
    const allTrades = global.mexcTier2TradesForSymbol(symbol) || [];
    if (allTrades.length < CFG.minBaselineSamples) return null;

    const baselineTrades = allTrades.filter(function (t) { return now - t.t <= CFG.baselineWindowMs; });
    if (baselineTrades.length < CFG.minBaselineSamples) return null;
    const recentTrades = allTrades.filter(function (t) { return now - t.t <= CFG.recentWindowMs; });
    if (!recentTrades.length) return null;

    const baselineNotional = baselineTrades.map(function (t) { return t.price * t.qty; });
    const baselineIntervals = [];
    for (let i = 1; i < baselineTrades.length; i++) baselineIntervals.push(baselineTrades[i].t - baselineTrades[i - 1].t);

    const baseline = {
      medianNotional: median(baselineNotional) || 1e-9,
      medianIntervalMs: median(baselineIntervals) || 1000,
      volNotional: baselineNotional.reduce(function (a, b) { return a + b; }, 0)
    };

    // OFI (order-flow imbalance) — реальная, не выдуманная величина: взвешенный перевес
    // агрессивного объёма BUY против SELL за недавнее окно, нормализованный в [-1..1]. Используется
    // как ПОДТВЕРЖДЕНИЕ для других детекторов (п.11 ТЗ — "не показывать buy>sell само по себе"),
    // не как отдельный UI-сигнал.
    const buyN = recentTrades.filter(function (t) { return t.side === 'buy'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const sellN = recentTrades.filter(function (t) { return t.side === 'sell'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const ofi = (buyN + sellN) > 0 ? (buyN - sellN) / (buyN + sellN) : 0;

    return { symbol: symbol, now: now, allTrades: allTrades, recentTrades: recentTrades, baseline: baseline, ofi: ofi, regime: classifyRegime(symbol) };
  }

  // ------------------------------------------------------------------------
  // MARKET REGIME (п.38) — грубая, но честная классификация по собственной недавней истории
  // символа (tier1History, если уже накопилась) — используется, чтобы не считать аномалией то,
  // что для этой монеты прямо сейчас является нормой (весь рынок штормит одинаково).
  // ------------------------------------------------------------------------
  function classifyRegime(symbol) {
    const hist = tier1History.get(symbol);
    if (!hist || hist.length < 8) return 'NORMAL';
    const vols = hist.map(function (h) { return h.vol5s; });
    const baselineVol = median(vols.slice(0, -3)) || 0;
    const curVol = mean(vols.slice(-3));
    const coin = global.mexcCoinMap.get(symbol);
    // *3, не *1.3 — по запросу упор на неликвид: полоса LOW_LIQUIDITY (и, значит, бонус в
    // qualityScore) должна реально накрывать "обычный неликвидный альт", а не только узкую щель
    // прямо над минимальным порогом входа CFG.minVol24Usd.
    if (coin && coin.vol24 < CFG.minVol24Usd * 3) return 'LOW_LIQUIDITY';
    if (baselineVol > 0 && curVol > baselineVol * 2.5) return 'HIGH_VOLATILITY';
    return 'NORMAL';
  }

  // ------------------------------------------------------------------------
  // DETECTORS — каждый: (features) -> candidate|null. candidate = {type, direction, evidence, rawScore(0-100)}.
  // Ничего не смотрит дальше "now" — только allTrades/recentTrades внутри features, которые сами
  // отфильтрованы по времени <= now в момент вызова (см. computeFeatures/computeDepthFeatures).
  // ------------------------------------------------------------------------
  const tradeDetectors = {
    // 🤖 РОБОТ-ПОКУПАШ / РОБОТ-ПРОДАВАШ — не просто "много BUY", а похожий размер + похожий
    // интервал + устойчивая последовательность в одну сторону (п.4-5).
    robot: function (f) {
      const trades = f.recentTrades.slice(-40);
      if (trades.length < CFG.minRepeats) return null;
      // непрерывность: доля sideTrades среди ВСЕХ последних N сделок должна быть высокой — иначе
      // это просто "рынок торговался", а не устойчивое однонаправленное поведение.
      const results = [];
      ['buy', 'sell'].forEach(function (side) {
        const sideTrades = trades.filter(function (t) { return t.side === side; });
        if (sideTrades.length < CFG.minRepeats) return;
        const dominance = sideTrades.length / trades.length;
        if (dominance < 0.65) return;
        const sizes = sideTrades.map(function (t) { return t.price * t.qty; });
        if (cv(sizes) > CFG.sizeCvMax) return;
        const intervals = [];
        for (let i = 1; i < sideTrades.length; i++) intervals.push(sideTrades[i].t - sideTrades[i - 1].t);
        if (cv(intervals) > CFG.intervalCvMax) return;
        const medSize = median(sizes);
        if (medSize < f.baseline.medianNotional * 0.4) return;
        const periodicity = clamp(1 - cv(intervals), 0, 1);
        results.push({
          type: side === 'buy' ? 'robotBuyer' : 'robotSeller',
          direction: side === 'buy' ? 'LONG' : 'SHORT',
          rawScore: 55 + dominance * 20 + periodicity * 20 + clamp((sideTrades.length - CFG.minRepeats) * 2, 0, 10),
          evidence: {
            repeats: sideTrades.length, medianSizeUsd: medSize, medianIntervalMs: Math.round(median(intervals) || 0),
            periodicityPct: Math.round(periodicity * 100), dominancePct: Math.round(dominance * 100)
          }
        });
      });
      return results;
    },

    // 🔁 ПОВТОРЯШ — похожий размер сделок подряд (без требования доминирования направления).
    repeatedPrints: function (f) {
      const trades = f.recentTrades.slice(-40);
      if (trades.length < CFG.minRepeats) return null;
      const sizes = trades.map(function (t) { return t.price * t.qty; });
      const medSize = median(sizes);
      if (medSize < f.baseline.medianNotional * 0.5) return null;
      const similar = trades.filter(function (t) { return Math.abs(t.price * t.qty - medSize) / medSize <= 0.35; });
      if (similar.length < CFG.minRepeats) return null;
      const sizeCvV = cv(similar.map(function (t) { return t.price * t.qty; }));
      const intervals = [];
      for (let i = 1; i < similar.length; i++) intervals.push(similar[i].t - similar[i - 1].t);
      const buy = similar.filter(function (t) { return t.side === 'buy'; }).length;
      return [{
        type: 'repeatedPrints',
        direction: buy >= similar.length / 2 ? 'LONG' : 'SHORT',
        rawScore: 50 + clamp((similar.length - CFG.minRepeats) * 3, 0, 20) + clamp((1 - sizeCvV) * 20, 0, 20),
        evidence: {
          repeats: similar.length, medianSizeUsd: medSize, sizeDeviationPct: Math.round(sizeCvV * 100),
          medianIntervalMs: Math.round(median(intervals) || 0), minIntervalMs: intervals.length ? Math.min.apply(null, intervals) : 0,
          maxIntervalMs: intervals.length ? Math.max.apply(null, intervals) : 0
        }
      }];
    },

    // ⏱ ПЕРИОДИЧКА — временнáя регулярность сделок (любой стороны), отдельно от размера.
    periodicity: function (f) {
      const trades = f.recentTrades.slice(-40);
      if (trades.length < Math.max(6, CFG.minRepeats)) return null;
      const intervals = [];
      for (let i = 1; i < trades.length; i++) intervals.push(trades[i].t - trades[i - 1].t);
      if (intervals.length < 5) return null;
      const cvV = cv(intervals);
      if (cvV > 0.3) return null;
      const periodicityScore = clamp(1 - cvV, 0, 1);
      return [{
        type: 'periodicity',
        direction: 'NEUTRAL',
        rawScore: 45 + periodicityScore * 40 + clamp((intervals.length - 5) * 1.5, 0, 10),
        evidence: {
          cycles: intervals.length, medianIntervalMs: Math.round(median(intervals)),
          intervalDeviationPct: Math.round(cvV * 100), periodicityScorePct: Math.round(periodicityScore * 100)
        }
      }];
    },

    // 🐋 АГРЕССОР — аномально крупная сделка (или тесный кластер), С подтверждением продолжением
    // того же направления (п.16: одиночный принт без подтверждения — не показывать).
    aggressor: function (f) {
      const trades = f.recentTrades.slice(-30);
      if (trades.length < 4) return null;
      let best = null;
      trades.forEach(function (t, i) {
        const notional = t.price * t.qty;
        if (notional < f.baseline.medianNotional * CFG.aggressorSizeMult) return;
        const follow = trades.slice(i + 1, i + 6).filter(function (x) { return x.side === t.side; });
        if (follow.length < 2) return; // нет подтверждения продолжением — не агрессор, просто принт
        if (!best || notional > best.notional) best = { trade: t, notional: notional, follow: follow.length };
      });
      if (!best) return null;
      const multiple = best.notional / f.baseline.medianNotional;
      return [{
        type: 'aggressor',
        direction: best.trade.side === 'buy' ? 'LONG' : 'SHORT',
        rawScore: 60 + clamp((multiple - CFG.aggressorSizeMult) * 3, 0, 25) + clamp(best.follow * 2, 0, 15),
        evidence: {
          sizeUsd: Math.round(best.notional), baselineMultiple: Math.round(multiple * 10) / 10,
          followThroughTrades: best.follow
        }
      }];
    },

    // 🧱 ПОГЛОЩЕНИЕ — агрессивный объём в одну сторону при почти неподвижной цене (executed
    // volume / price displacement — большое соотношение = поглощение, п.9).
    absorption: function (f) {
      const trades = f.recentTrades;
      if (trades.length < 8) return null;
      const buyNotional = trades.filter(function (t) { return t.side === 'buy'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
      const sellNotional = trades.filter(function (t) { return t.side === 'sell'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
      const p0 = trades[0].price, p1 = trades[trades.length - 1].price;
      const displacementPct = Math.abs(p1 - p0) / p0 * 100;
      const totalNotional = buyNotional + sellNotional;
      if (totalNotional < f.baseline.volNotional * 0.6) return null; // не аномально активно — нечего поглощать
      const dominant = buyNotional > sellNotional ? 'buy' : 'sell';
      const dominantNotional = Math.max(buyNotional, sellNotional);
      if (dominantNotional < totalNotional * 0.62) return null; // нет явного перевеса стороны
      if (displacementPct > 0.35) return null; // цена реально сдвинулась — это не поглощение, а импульс
      const impactRatio = dominantNotional / Math.max(displacementPct, 0.02);
      return [{
        type: dominant === 'buy' ? 'absorptionBuy' : 'absorptionSell',
        direction: dominant === 'buy' ? 'LONG' : 'SHORT',
        rawScore: 55 + clamp(Math.log10(impactRatio) * 8, 0, 30) + clamp((0.35 - displacementPct) * 20, 0, 10),
        evidence: {
          aggressiveVolumeUsd: Math.round(dominantNotional), priceDisplacementPct: Math.round(displacementPct * 100) / 100,
          impactRatio: Math.round(impactRatio)
        }
      }];
    },

    // 🚀 ВЫЛЕТ — composite по построению: пробой уровня + агрессивный флоу + объёмная аномалия.
    breakout: function (f) {
      const trades = f.recentTrades;
      if (trades.length < 10) return null;
      const prices = trades.map(function (t) { return t.price; });
      const hi = Math.max.apply(null, prices.slice(0, -3));
      const lo = Math.min.apply(null, prices.slice(0, -3));
      const last = prices[prices.length - 1];
      const brokeUp = last > hi;
      const brokeDown = last < lo;
      if (!brokeUp && !brokeDown) return null;
      const buyNotional = trades.filter(function (t) { return t.side === 'buy'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
      const sellNotional = trades.filter(function (t) { return t.side === 'sell'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
      const flowOk = brokeUp ? buyNotional > sellNotional * 1.3 : sellNotional > buyNotional * 1.3;
      if (!flowOk) return null;
      const totalNotional = buyNotional + sellNotional;
      const volAnomaly = totalNotional / Math.max(f.baseline.volNotional, 1);
      if (volAnomaly < 1.4) return null;
      const displacementPct = Math.abs(last - trades[0].price) / trades[0].price * 100;
      return [{
        type: 'breakout',
        direction: brokeUp ? 'LONG' : 'SHORT',
        rawScore: 58 + clamp((volAnomaly - 1.4) * 12, 0, 22) + clamp(displacementPct * 6, 0, 20),
        evidence: {
          levelBreak: brokeUp ? 'HIGH' : 'LOW', volumeAnomalyX: Math.round(volAnomaly * 10) / 10,
          priceDisplacementPct: Math.round(displacementPct * 100) / 100
        }
      }];
    },

    // 🔼 АПТИК / 🔽 ДАУНТИК — подтверждённое определение (небогач.ру/proptrading.ru): "аптик" —
    // сделка ПО ЦЕНЕ ВЫШЕ предыдущей ("плюс-тик"). Устойчивый бот-алгоритм — это длинный ХВОСТОВОЙ
    // забег подряд идущих сделок, каждая не ниже предыдущей (даунтик — зеркально), а не просто
    // "цена выросла" — считаем именно длину забега подряд идущих тиков в одну сторону.
    tick: function (f) {
      const trades = f.recentTrades.slice(-40);
      if (trades.length < CFG.minRepeats + 1) return null;
      const results = [];
      [1, -1].forEach(function (dir) {
        let run = 1;
        for (let i = trades.length - 1; i > 0; i--) {
          const d = (trades[i].price - trades[i - 1].price) * dir;
          if (d >= 0) run++; else break;
        }
        if (run < CFG.minRepeats + 1) return;
        const seq = trades.slice(trades.length - run);
        const displacementPct = Math.abs(seq[seq.length - 1].price - seq[0].price) / seq[0].price * 100;
        if (displacementPct < 0.04) return; // топчется на месте — не настоящий тиковый забег
        let strictSteps = 0;
        for (let i = 1; i < seq.length; i++) { if ((seq[i].price - seq[i - 1].price) * dir > 0) strictSteps++; }
        results.push({
          type: dir === 1 ? 'uptick' : 'downtick',
          direction: dir === 1 ? 'LONG' : 'SHORT',
          rawScore: 48 + clamp((run - CFG.minRepeats) * 5, 0, 28) + clamp(displacementPct * 18, 0, 24),
          evidence: { consecutiveTicks: run - 1, strictSteps: strictSteps, priceMovePct: Math.round(displacementPct * 10000) / 10000 }
        });
      });
      return results.length ? results : null;
    },

    // 💥 ПРОСТРЕЛ — подтверждённое определение (fsr-develop.ru/slovar-skalpera): "чужой маркетный
    // ордер с повышенным объёмом, выполненный на слабом рынке" — в отличие от 🐋АГРЕССОРА, здесь
    // НЕ требуется подтверждение продолжением того же направления — это разовый выстрел именно
    // потому, что рынок был тонким/тихим прямо перед ним (recentNotional << baseline).
    shootThrough: function (f) {
      const trades = f.recentTrades;
      if (trades.length < 6) return null;
      const recentNotional = trades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
      if (recentNotional > f.baseline.volNotional * 0.45) return null; // рынок был не слабым — не прострел
      let best = null;
      trades.forEach(function (t) {
        const notional = t.price * t.qty;
        if (notional < f.baseline.medianNotional * 5) return;
        if (!best || notional > best.notional) best = { trade: t, notional: notional };
      });
      if (!best) return null;
      const multiple = best.notional / f.baseline.medianNotional;
      return [{
        type: 'shootThrough',
        direction: best.trade.side === 'buy' ? 'LONG' : 'SHORT',
        rawScore: 46 + clamp((multiple - 5) * 4, 0, 30) + clamp((1 - recentNotional / (f.baseline.volNotional * 0.45)) * 20, 0, 20),
        evidence: { sizeUsd: Math.round(best.notional), baselineMultiple: Math.round(multiple * 10) / 10, weakMarket: true }
      }];
    },

    // 🦔 ЁРШИК — цена ходит примерно в одном диапазоне, происходит прострел вверх/вниз за его
    // пределы, и цена СРАЗУ возвращается обратно в диапазон (по формулировке пользователя).
    rangeSpikeRevert: function (f) {
      const trades = f.recentTrades;
      if (trades.length < 10) return null;
      const body = trades.slice(0, -3);
      const tail = trades.slice(-3);
      const bodyPrices = body.map(function (t) { return t.price; });
      const hi = Math.max.apply(null, bodyPrices);
      const lo = Math.min.apply(null, bodyPrices);
      const mid = (hi + lo) / 2;
      const rangePct = (hi - lo) / mid * 100;
      if (rangePct > 1.4) return null; // это уже не боковик — тренд/сильная волатильность
      const spikeUp = tail.some(function (t) { return t.price > hi * 1.0015; });
      const spikeDown = tail.some(function (t) { return t.price < lo * 0.9985; });
      if (!spikeUp && !spikeDown) return null;
      const last = trades[trades.length - 1];
      const backInRange = last.price <= hi * 1.0005 && last.price >= lo * 0.9995;
      if (!backInRange) return null; // прострел был, но откат в диапазон ещё не подтверждён
      return [{
        type: 'rangeSpikeRevert',
        direction: spikeUp ? 'SHORT' : 'LONG', // прострел вверх с откатом -> ожидаемо вниз к диапазону, и наоборот
        rawScore: 50 + clamp((1.4 - rangePct) * 10, 0, 15) + 15,
        evidence: { rangePct: Math.round(rangePct * 100) / 100, spikeDirection: spikeUp ? 'UP' : 'DOWN' }
      }];
    }
  };

  // ------------------------------------------------------------------------
  // Order-book детекторы — работают ТОЛЬКО там, где реально есть Tier2-стакан (честно пропускаем
  // символ, если снапшотов нет, вместо того чтобы что-то придумывать без данных).
  // ------------------------------------------------------------------------
  function computeDepthFeatures(symbol, now) {
    const snaps = (global.mexcTier2DepthForSymbol(symbol) || []).filter(function (s) { return now - s.t <= CFG.baselineWindowMs; });
    if (snaps.length < 6) return null;
    const recent = snaps.filter(function (s) { return now - s.t <= CFG.recentWindowMs; });
    if (recent.length < 4) return null;
    const avgLevelQty = mean(snaps.slice(-30).flatMap(function (s) { return (s.bids || []).concat(s.asks || []).map(function (l) { return l.q; }); }).filter(function (q) { return q > 0; })) || 1e-9;
    return { symbol: symbol, snaps: snaps, recent: recent, avgLevelQty: avgLevelQty };
  }

  function topLevel(levels) {
    if (!levels || !levels.length) return null;
    return levels.reduce(function (best, l) { return (!best || l.q > best.q) ? l : best; }, null);
  }

  const depthDetectors = {
    // 🛡 ДЕРЖАТЕЛЬ — крупный уровень, который получает удары (цена рядом двигается/торгуется), но
    // восстанавливается и удерживает цену (несколько снапшотов подряд крупный уровень остаётся).
    holder: function (df) {
      const out = [];
      ['bids', 'asks'].forEach(function (side) {
        const snaps = df.recent;
        let wallSnapshotsCount = 0;
        let refCount = 0;
        let lastQty = null;
        for (let i = 0; i < snaps.length; i++) {
          const top = topLevel(snaps[i][side]);
          if (!top || top.q < df.avgLevelQty * 5) { lastQty = null; continue; }
          wallSnapshotsCount++;
          if (lastQty != null && top.q < lastQty * 0.7) refCount++; // видимое исполнение с последующим восстановлением
          lastQty = top.q;
        }
        if (wallSnapshotsCount >= 4 && refCount >= 1) {
          out.push({
            type: side === 'bids' ? 'holderBid' : 'holderAsk',
            direction: side === 'bids' ? 'LONG' : 'SHORT',
            rawScore: 55 + clamp(wallSnapshotsCount * 3, 0, 20) + clamp(refCount * 10, 0, 20),
            evidence: { wallSnapshots: wallSnapshotsCount, refills: refCount, levelMultiple: Math.round((lastQty || 0) / df.avgLevelQty) }
          });
        }
      });
      return out;
    },

    // 🧊 REFILL — конкретный уровень многократно исполняется и снова появляется (несколько
    // циклов "исчез -> появился похожего размера").
    refill: function (df) {
      const snaps = df.recent;
      if (snaps.length < 6) return null;
      let cycles = 0;
      let side = null;
      ['bids', 'asks'].forEach(function (s) {
        let present = false, refillsHere = 0, lastQty = 0;
        snaps.forEach(function (snap) {
          const top = topLevel(snap[s]);
          const big = top && top.q >= df.avgLevelQty * 4;
          if (present && !big) { present = false; } // исполнилось/пропало
          else if (!present && big) { refillsHere++; present = true; lastQty = top.q; } // появилось заново
          else if (present && big) { lastQty = top.q; }
        });
        if (refillsHere > cycles) { cycles = refillsHere; side = s; }
      });
      if (cycles < 3) return null;
      return [{
        type: 'refill',
        direction: side === 'bids' ? 'LONG' : 'SHORT',
        rawScore: 50 + clamp(cycles * 8, 0, 35),
        evidence: { refillCycles: cycles, side: side === 'bids' ? 'BID' : 'ASK' }
      }];
    },

    // 💨 ЛИКВИДНОСТЬ УШЛА — крупный уровень был, резко исчез (не за счёт исполнения — снятие).
    liquidityPull: function (df) {
      const snaps = df.recent;
      if (snaps.length < 4) return null;
      let found = null;
      for (let i = 1; i < snaps.length; i++) {
        ['bids', 'asks'].forEach(function (s) {
          const prevTop = topLevel(snaps[i - 1][s]);
          const curTop = topLevel(snaps[i][s]);
          if (!prevTop || prevTop.q < df.avgLevelQty * 6) return;
          const stillThere = curTop && Math.abs(curTop.p - prevTop.p) / prevTop.p < 0.001 && curTop.q > prevTop.q * 0.5;
          if (!stillThere && (!found || prevTop.q > found.qty)) {
            found = { side: s, qty: prevTop.q, price: prevTop.p };
          }
        });
      }
      if (!found) return null;
      return [{
        type: 'liquidityPull',
        direction: found.side === 'bids' ? 'SHORT' : 'LONG', // ушла поддержка снизу -> риск вниз, и наоборот
        rawScore: 52 + clamp(Math.log10(found.qty / df.avgLevelQty) * 12, 0, 35),
        evidence: { pulledSide: found.side === 'bids' ? 'BID' : 'ASK', pulledMultiple: Math.round(found.qty / df.avgLevelQty) }
      }];
    },

    // 🌪 ВАКУУМ — общая глубина резко просела относительно её же недавней нормы.
    liquidityVacuum: function (df) {
      const snaps = df.recent;
      if (snaps.length < 5) return null;
      const depthOf = function (s) { return (s.bidVol || 0) + (s.askVol || 0); };
      const baselineDepth = median(df.snaps.slice(0, -4).map(depthOf));
      const curDepth = depthOf(snaps[snaps.length - 1]);
      if (!baselineDepth || curDepth > baselineDepth * 0.45) return null;
      return [{
        type: 'liquidityVacuum',
        direction: 'NEUTRAL',
        rawScore: 50 + clamp((1 - curDepth / baselineDepth) * 45, 0, 40),
        evidence: { depthDropPct: Math.round((1 - curDepth / baselineDepth) * 100) }
      }];
    },

    // 🔄 ПЕРЕСТАВЛЯШ — верхний уровень одной стороны систематически "уезжает" в одну сторону
    // через несколько снапшотов подряд (а не разово).
    repositioning: function (df) {
      const snaps = df.recent;
      if (snaps.length < 5) return null;
      let out = null;
      ['bids', 'asks'].forEach(function (s) {
        const prices = snaps.map(function (snap) { const t = topLevel(snap[s]); return t ? t.p : null; }).filter(function (p) { return p != null; });
        if (prices.length < 5) return;
        let steps = 0, dirSum = 0;
        for (let i = 1; i < prices.length; i++) {
          const d = prices[i] - prices[i - 1];
          if (Math.abs(d) < 1e-12) continue;
          steps++; dirSum += d > 0 ? 1 : -1;
        }
        if (steps < 4) return;
        const consistency = Math.abs(dirSum) / steps;
        if (consistency < 0.7) return;
        if (!out || consistency > out.consistency) out = { side: s, steps: steps, consistency: consistency };
      });
      if (!out) return null;
      return [{
        type: 'repositioning',
        direction: 'NEUTRAL',
        rawScore: 48 + clamp(out.steps * 4, 0, 25) + clamp(out.consistency * 25, 0, 25),
        evidence: { side: out.side === 'bids' ? 'BID' : 'ASK', steps: out.steps, consistencyPct: Math.round(out.consistency * 100) }
      }];
    },

    // 🪜 ЛЕСТНИЦА — несколько РАЗНЫХ уровней рядом одновременно показывают повышенный размер
    // (структура), а не один случайный всплеск.
    ladder: function (df) {
      const snap = df.recent[df.recent.length - 1];
      let out = null;
      ['bids', 'asks'].forEach(function (s) {
        const levels = (snap[s] || []).filter(function (l) { return l.q >= df.avgLevelQty * 2.2; });
        if (levels.length >= 3 && (!out || levels.length > out.count)) out = { side: s, count: levels.length };
      });
      if (!out) return null;
      return [{
        type: 'ladder',
        direction: out.side === 'bids' ? 'LONG' : 'SHORT',
        rawScore: 50 + clamp((out.count - 3) * 8, 0, 30),
        evidence: { side: out.side === 'bids' ? 'BID' : 'ASK', levels: out.count }
      }];
    }
  };

  // ------------------------------------------------------------------------
  // TIER-1 ШИРОКИЙ СКАН — обходит ВСЕ монеты (window.mexcCoinMap — реально весь трекаемый рынок
  // по всем подключённым биржам, не только watchlist), а не только Tier2-подмножество с полными
  // сделками/стаканом. Биржи физически не дают подписаться на сделки+стакан по тысячам пар
  // одновременно (то самое ограничение, из-за которого вообще существует Tier2-watchlist) — но
  // тикер-поток (цена/объём/волатильность) идёт по ВСЕМ монетам сразу, и это честные, уже
  // посчитанные значения (vol5s/vol30s/vol24/change24 — та же метрика, что видна в таблице
  // "Скринер"), не выдумка. Свою историю по каждой монете строим сами (coinMap отдаёт только
  // текущий снимок, не буфер) — сэмплируем на каждый recompute(), см. tier1History ниже.
  // ------------------------------------------------------------------------
  const tier1History = new Map(); // symbol -> [{t, price, vol24, vol5s}]

  function sampleTier1(now) {
    global.mexcCoinMap.forEach(function (coin, symbol) {
      if (!coin || !coin.price) return;
      let arr = tier1History.get(symbol);
      if (!arr) { arr = []; tier1History.set(symbol, arr); }
      arr.push({ t: now, price: coin.price, vol24: coin.vol24 || 0, vol5s: coin.vol5s || 0 });
      if (arr.length > CFG.tier1HistoryCap) arr.splice(0, arr.length - CFG.tier1HistoryCap);
    });
  }

  const tier1Detectors = {
    // 🚀 ВЫЛЕТ (lite) — пробой собственного недавнего диапазона монеты + объём растёт заметно
    // быстрее, чем рос до этого (ускорение, не просто "объём большой" — у каждой монеты своя норма).
    breakout: function (symbol, hist) {
      if (hist.length < CFG.tier1MinSamples) return null;
      const mid = hist.length >> 1;
      const earlier = hist.slice(0, mid), later = hist.slice(mid);
      const rangeHi = Math.max.apply(null, earlier.map(function (h) { return h.price; }));
      const rangeLo = Math.min.apply(null, earlier.map(function (h) { return h.price; }));
      const last = hist[hist.length - 1];
      const brokeUp = last.price > rangeHi;
      const brokeDown = last.price < rangeLo;
      if (!brokeUp && !brokeDown) return null;
      const volGrowthEarly = Math.max(1e-9, earlier[earlier.length - 1].vol24 - earlier[0].vol24);
      const volGrowthLate = later[later.length - 1].vol24 - later[0].vol24;
      const accel = volGrowthLate / volGrowthEarly;
      if (accel < CFG.tier1BreakoutMinVolAccel) return null;
      const displacementPct = Math.abs(last.price - earlier[0].price) / earlier[0].price * 100;
      return [{
        type: 'breakout',
        direction: brokeUp ? 'LONG' : 'SHORT',
        rawScore: 50 + clamp((accel - CFG.tier1BreakoutMinVolAccel) * 10, 0, 25) + clamp(displacementPct * 4, 0, 20),
        evidence: { levelBreak: brokeUp ? 'HIGH' : 'LOW', volumeAccelX: Math.round(accel * 10) / 10, priceDisplacementPct: Math.round(displacementPct * 100) / 100, source: 'tier1' }
      }];
    },
    // 🐋 АГРЕССОР (lite) — реализованная волатильность (vol5s) сейчас намного выше СВОЕЙ ЖЕ обычной
    // нормы за последние ~8 минут (adaptive per-symbol baseline, п.20), а не общий порог на всех.
    aggressor: function (symbol, hist) {
      if (hist.length < CFG.tier1MinSamples) return null;
      const baselineSlice = hist.slice(0, -3);
      const baselineVol5s = median(baselineSlice.map(function (h) { return h.vol5s; }));
      if (baselineVol5s <= 0) return null;
      const curVol5s = mean(hist.slice(-3).map(function (h) { return h.vol5s; }));
      const mult = curVol5s / baselineVol5s;
      if (mult < CFG.tier1AggressorVolMult) return null;
      const first = hist[hist.length - 4] || hist[0];
      const last = hist[hist.length - 1];
      const direction = last.price >= first.price ? 'LONG' : 'SHORT';
      return [{
        type: 'aggressor',
        direction: direction,
        rawScore: 48 + clamp((mult - CFG.tier1AggressorVolMult) * 8, 0, 35),
        evidence: { realizedVolMultiple: Math.round(mult * 10) / 10, source: 'tier1' }
      }];
    }
  };

  // ==========================================================================
  // ALGORITHMIC BEHAVIOR DETECTOR — отдельный слой (по ТЗ п.1-13 "детектирование алгоритмических
  // торговых ботов"). НЕ заявляет "это бот" — только "поведение статистически похоже на X-LIKE".
  // Течёт через ТОТ ЖЕ pipeline (validation/tradeability/quality/composite), что и остальные
  // детекторы — просто ещё два набора (trade-based/depth-based), см. их подключение в
  // collectSymbolCandidates ниже. Использует существующие computeFeatures/computeDepthFeatures/
  // topLevel — никакой второй feature-engine не создаётся.
  // ==========================================================================
  const algoTradeDetectors = {
    // 🤖 TWAP-LIKE — дробление на похожие порции с ГЛАВНЫМ весом на временную регулярность
    // (в отличие от robotBuyer/Seller, где вес более-менее поровну между размером/интервалом).
    twapLike: function (f) {
      const trades = f.recentTrades.slice(-50);
      if (trades.length < CFG.minRepeats + 3) return null;
      const results = [];
      ['buy', 'sell'].forEach(function (side) {
        const sideTrades = trades.filter(function (t) { return t.side === side; });
        if (sideTrades.length < CFG.minRepeats + 3) return;
        if (sideTrades.length / trades.length < 0.7) return;
        const sizes = sideTrades.map(function (t) { return t.price * t.qty; });
        const sizeCvV = cv(sizes);
        if (sizeCvV > 0.4) return;
        const intervals = [];
        for (let i = 1; i < sideTrades.length; i++) intervals.push(sideTrades[i].t - sideTrades[i - 1].t);
        const intervalCvV = cv(intervals);
        if (intervalCvV > 0.35) return; // TWAP: временная регулярность — ключевой признак
        results.push({
          type: 'twapLike',
          direction: side === 'buy' ? 'LONG' : 'SHORT',
          rawScore: 50 + clamp((1 - intervalCvV) * 30, 0, 30) + clamp((sideTrades.length - (CFG.minRepeats + 3)) * 2, 0, 15) + clamp((1 - sizeCvV) * 15, 0, 15),
          evidence: {
            executions: sideTrades.length, medianSizeUsd: Math.round(median(sizes)),
            sizeDeviationPct: Math.round(sizeCvV * 100), medianIntervalMs: Math.round(median(intervals)),
            intervalDeviationPct: Math.round(intervalCvV * 100)
          }
        });
      });
      return results.length ? results : null;
    },

    // 🤖 VWAP-LIKE — доля объёма исполнения в одну сторону остаётся стабильно высокой в КАЖДОМ
    // из нескольких под-окон подряд (participation_rate), а не в одном спайке.
    vwapLike: function (f) {
      const trades = f.recentTrades;
      if (trades.length < 15) return null;
      const chunkSize = Math.floor(trades.length / 3);
      if (chunkSize < 4) return null;
      const chunks = [trades.slice(0, chunkSize), trades.slice(chunkSize, chunkSize * 2), trades.slice(chunkSize * 2)];
      const results = [];
      ['buy', 'sell'].forEach(function (side) {
        const rates = chunks.map(function (chunk) {
          const sideN = chunk.filter(function (t) { return t.side === side; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
          const totalN = chunk.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
          return totalN > 0 ? sideN / totalN : 0;
        });
        const minRate = Math.min.apply(null, rates);
        if (minRate < 0.55) return; // должно доминировать стабильно во ВСЕХ под-окнах, не в одном
        const totalNotional = trades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
        if (totalNotional < f.baseline.volNotional * 0.8) return;
        const avgRate = mean(rates);
        results.push({
          type: 'vwapLike',
          direction: side === 'buy' ? 'LONG' : 'SHORT',
          rawScore: 48 + clamp((avgRate - 0.55) * 60, 0, 30) + clamp((minRate - 0.55) * 40, 0, 20),
          evidence: { participationRatePct: Math.round(avgRate * 100), minChunkParticipationPct: Math.round(minRate * 100) }
        });
      });
      return results.length ? results : null;
    },

    // 📤 РАЗДАЧА (INVENTORY-UNLOAD-LIKE) — протяжённое (не короткий всплеск) однонаправленное
    // исполнение множеством некрупных сделок при слабой реакции цены относительно объёма.
    inventoryUnload: function (f) {
      const trades = f.allTrades.filter(function (t) { return f.now - t.t <= 5 * 60000; });
      if (trades.length < 15) return null;
      const durationMs = trades[trades.length - 1].t - trades[0].t;
      if (durationMs < 40000) return null;
      const results = [];
      ['buy', 'sell'].forEach(function (side) {
        const sideTrades = trades.filter(function (t) { return t.side === side; });
        const oppTrades = trades.filter(function (t) { return t.side !== side; });
        if (sideTrades.length < 12) return;
        const sideN = sideTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
        const oppN = oppTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
        if (sideN < oppN * 1.5) return;
        const p0 = trades[0].price, p1 = trades[trades.length - 1].price;
        const dispPct = Math.abs(p1 - p0) / p0 * 100;
        const impactRatio = sideN / Math.max(dispPct, 0.05);
        if (impactRatio < f.baseline.volNotional * 0.5) return;
        results.push({
          type: 'inventoryUnload',
          direction: side === 'buy' ? 'LONG' : 'SHORT',
          rawScore: 50 + clamp((sideTrades.length - 12) * 1.5, 0, 20) + clamp((durationMs / 1000 - 40) * 0.3, 0, 20) + clamp(Math.log10(Math.max(impactRatio, 1)) * 5, 0, 15),
          evidence: { executions: sideTrades.length, durationSec: Math.round(durationMs / 1000), notionalUsd: Math.round(sideN), priceDisplacementPct: Math.round(dispPct * 100) / 100 }
        });
      });
      return results.length ? results : null;
    }
  };

  const algoDepthDetectors = {
    // 🧹 GRID-LIKE — несколько регулярно расставленных повышенных уровней на одной стороне,
    // сохраняющихся/восстанавливающихся в течение НЕСКОЛЬКИХ снапшотов подряд.
    gridLike: function (df) {
      const results = [];
      ['bids', 'asks'].forEach(function (side) {
        let persistCount = 0, lastLevelsCount = 0, spacingOk = false;
        df.recent.forEach(function (snap) {
          const levels = (snap[side] || []).filter(function (l) { return l.q >= df.avgLevelQty * 1.8; })
            .sort(function (a, b) { return side === 'bids' ? b.p - a.p : a.p - b.p; });
          if (levels.length >= 3) {
            persistCount++;
            const gaps = [];
            for (let i = 1; i < levels.length; i++) gaps.push(Math.abs(levels[i].p - levels[i - 1].p));
            if (gaps.length && cv(gaps) < 0.5) spacingOk = true;
            lastLevelsCount = levels.length;
          }
        });
        if (persistCount >= 3 && spacingOk) {
          results.push({
            type: 'gridLike', direction: side === 'bids' ? 'LONG' : 'SHORT',
            rawScore: 48 + clamp(persistCount * 6, 0, 30) + clamp(lastLevelsCount * 4, 0, 20),
            evidence: { side: side === 'bids' ? 'BID' : 'ASK', persistentSnapshots: persistCount, levels: lastLevelsCount }
          });
        }
      });
      return results.length ? results : null;
    },

    // MARKET-MAKER-LIKE — обе стороны книги одновременно держат заметную ликвидность рядом с mid,
    // с частым мелким repricing БЕЗ выраженного направленного дрейфа (иначе это ПЕРЕСТАВЛЯШ).
    marketMakerLike: function (df) {
      const snaps = df.recent;
      if (snaps.length < 6) return null;
      let bothSidesPresent = 0;
      const bidSteps = [], askSteps = [];
      let prevBid = null, prevAsk = null;
      snaps.forEach(function (snap) {
        const b = topLevel(snap.bids), a = topLevel(snap.asks);
        if (b && a && b.q >= df.avgLevelQty * 1.5 && a.q >= df.avgLevelQty * 1.5) bothSidesPresent++;
        if (b && prevBid != null && Math.abs(b.p - prevBid) > 1e-12) bidSteps.push(b.p - prevBid);
        if (a && prevAsk != null && Math.abs(a.p - prevAsk) > 1e-12) askSteps.push(a.p - prevAsk);
        if (b) prevBid = b.p; if (a) prevAsk = a.p;
      });
      if (bothSidesPresent < snaps.length * 0.6) return null;
      const totalSteps = bidSteps.length + askSteps.length;
      if (totalSteps < 6) return null;
      const bidDirConsistency = bidSteps.length ? Math.abs(bidSteps.filter(function (d) { return d > 0; }).length - bidSteps.filter(function (d) { return d < 0; }).length) / bidSteps.length : 0;
      if (bidDirConsistency > 0.5) return null; // выраженное направление -> репозиционирование, не MM
      return [{
        type: 'marketMakerLike', direction: 'NEUTRAL',
        rawScore: 46 + clamp(totalSteps * 3, 0, 30) + clamp(bothSidesPresent * 3, 0, 20),
        evidence: { repricingEvents: totalSteps, bothSidesPresentSnapshots: bothSidesPresent }
      }];
    },

    // 🧊 ICEBERG-LIKE — усиленный REFILL: суммарно исполненный объём на уровне значительно (>1.8x)
    // превышает изначально видимый размер, при >=4 циклах восстановления.
    icebergLike: function (df) {
      const snaps = df.recent;
      if (snaps.length < 6) return null;
      let best = null;
      ['bids', 'asks'].forEach(function (s) {
        let present = false, cycles = 0, lastQty = 0, initialQty = 0, executedSum = 0;
        snaps.forEach(function (snap) {
          const top = topLevel(snap[s]);
          const big = top && top.q >= df.avgLevelQty * 4;
          if (present && !big) { executedSum += lastQty; present = false; }
          else if (!present && big) { if (!initialQty) initialQty = top.q; cycles++; present = true; lastQty = top.q; }
          else if (present && big) { lastQty = top.q; }
        });
        if (cycles < 4) return;
        const ratio = initialQty > 0 ? executedSum / initialQty : 0;
        if (ratio < 1.8) return;
        if (!best || cycles > best.cycles) best = { side: s, cycles: cycles, ratio: ratio };
      });
      if (!best) return null;
      return [{
        type: 'icebergLike', direction: best.side === 'bids' ? 'LONG' : 'SHORT',
        rawScore: 52 + clamp((best.cycles - 4) * 7, 0, 25) + clamp((best.ratio - 1.8) * 10, 0, 25),
        evidence: { side: best.side === 'bids' ? 'BID' : 'ASK', refillCycles: best.cycles, executedToInitialRatio: Math.round(best.ratio * 10) / 10 }
      }];
    },

    // 🎯 LIQUIDITY-TAKER-LIKE (SNIPER) — резкое (>=55%) падение суммарной глубины первых 5 уровней
    // между двумя соседними снапшотами — быстрое поглощение нескольких уровней подряд.
    sniperLike: function (df) {
      const snaps = df.recent;
      if (snaps.length < 4) return null;
      let best = null;
      ['bids', 'asks'].forEach(function (s) {
        const depths = snaps.map(function (snap) { return (snap[s] || []).slice(0, 5).reduce(function (a, l) { return a + l.q; }, 0); });
        for (let i = 1; i < depths.length; i++) {
          if (depths[i - 1] <= 0) continue;
          const drop = (depths[i - 1] - depths[i]) / depths[i - 1];
          if (drop > 0.55 && (!best || drop > best.drop)) best = { side: s, drop: drop };
        }
      });
      if (!best) return null;
      return [{
        type: 'sniperLike', direction: best.side === 'bids' ? 'SHORT' : 'LONG',
        rawScore: 50 + clamp((best.drop - 0.55) * 60, 0, 35),
        evidence: { side: best.side === 'bids' ? 'BID' : 'ASK', depthDropPct: Math.round(best.drop * 100) }
      }];
    },

    // 🧹 ЁРШИК / DYNAMIC_DISTRIBUTED_LIQUIDITY — несколько повышенных уровней держатся в течение
    // нескольких снапшотов, но состав конкретных уровней МЕНЯЕТСЯ (turnover) — отличие от
    // статичной толстой стены (STATIC_CLUSTER), которая турновер не даёт и потому сигналом не является.
    distributedLiquidity: function (df) {
      const snaps = df.recent;
      if (snaps.length < 4) return null;
      let best = null;
      ['bids', 'asks'].forEach(function (s) {
        const sets = snaps.map(function (snap) {
          return new Set((snap[s] || []).filter(function (l) { return l.q >= df.avgLevelQty * 2; }).map(function (l) { return Math.round(l.p * 100000); }));
        });
        const withLevels = sets.filter(function (set) { return set.size >= 3; });
        if (withLevels.length < 3) return;
        const first = withLevels[0], last = withLevels[withLevels.length - 1];
        let common = 0; first.forEach(function (p) { if (last.has(p)) common++; });
        const turnover = 1 - common / Math.max(first.size, 1);
        if (turnover < 0.3) return; // статично — не ёршик
        if (!best || withLevels.length > best.count) best = { side: s, count: withLevels.length, turnover: turnover };
      });
      if (!best) return null;
      return [{
        type: 'distributedLiquidity', direction: 'NEUTRAL',
        rawScore: 48 + clamp(best.count * 5, 0, 25) + clamp(best.turnover * 30, 0, 25),
        evidence: { side: best.side === 'bids' ? 'BID' : 'ASK', persistentMultiLevelSnapshots: best.count, turnoverPct: Math.round(best.turnover * 100) }
      }];
    }
  };

  // ------------------------------------------------------------------------
  // VALIDATION / TRADEABILITY / NOISE — п.21-25.
  // ------------------------------------------------------------------------
  function tradeabilityOk(symbol) {
    const coin = global.mexcCoinMap.get(symbol);
    if (!coin) return false;
    if ((coin.vol24 || 0) < CFG.minVol24Usd) return false;
    if ((coin.vol24 || 0) > CFG.maxVol24Usd) return false; // тяжёлые топовые монеты — вне периметра этого фильтра, см. CFG.maxVol24Usd
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

  function qualityScore(candidate, symbol) {
    // Базовый rawScore детектора (0-100, но обычно 40-100) + подтверждение потоком (п.24-25 ТЗ) —
    // здесь без look-ahead, всё из уже посчитанных candidate.evidence/OFI. Бонус "явно ликвидная
    // монета -> небольшой бонус доверия" здесь был раньше — убран (по запросу, 2026-09): он прямо
    // противоречил цели этого фильтра ("торгую неэффективности/аномалии, мне тут не нужны Солана и
    // Биткоин") — поощрял ровно те тяжёлые монеты, которые CFG.maxVol24Usd теперь отсекает на входе.
    let score = clamp(candidate.rawScore, 0, 100);

    // OFI-подтверждение (п.11 ТЗ: OFI — фактор подтверждения, не отдельный сигнал) — направление
    // детектора совпадает с реальным перевесом потока сделок -> небольшой бонус; расходится с
    // сильным потоком в обратную сторону -> штраф (сигнал менее надёжен без поддержки потока).
    if (candidate.direction === 'LONG' && candidate.ofi != null) score += clamp(candidate.ofi * 12, -10, 10);
    if (candidate.direction === 'SHORT' && candidate.ofi != null) score += clamp(-candidate.ofi * 12, -10, 10);

    // УПОР Filter 2 (по запросу) — роботы/алгоритмы и рыночные неэффективности приоритетнее обычных
    // momentum-сигналов (агрессор/вылет/тик), т.к. именно там реально есть что эксплуатировать.
    if (BOT_TYPES.has(candidate.type)) score += 8;
    if (INEFFICIENCY_TYPES.has(candidate.type)) score += 6;

    // Regime-адаптация (п.38 ТЗ): в HIGH_VOLATILITY то, что выглядело бы аномальным в спокойном
    // рынке, для этой монеты прямо сейчас может быть нормой — небольшой штраф на "обычных для
    // текущего режима" детекторах (агрессор/вылет), чтобы не флагать весь рынок разом при общем шторме.
    if (candidate.regime === 'HIGH_VOLATILITY' && (candidate.type === 'aggressor' || candidate.type === 'breakout')) score -= 8;
    // LOW_LIQUIDITY — БЕЗ бонуса (пробовали +7 "по запросу" — реальный фидбэк пользователя, 2026-09:
    // "детектит тупые монеты, на которых по факту ничего нет"). Проблема оказалась в том, что бонус
    // давался ЗА САМ ФАКТ неликвидности, независимо от силы паттерна — то есть слабый/шумный сигнал
    // на тонкой монете мог перескочить displayThreshold только потому, что монета тонкая, а не
    // потому, что там реально что-то происходит. Эмфаза на неликвид/роботов/неэффективности теперь
    // идёт ТОЛЬКО через TYPE-бонусы (BOT_TYPES/INEFFICIENCY_TYPES выше), которые требуют, чтобы
    // детектор реально нашёл конкретный паттерн — не штраф, но и не поощрение самой неликвидности.
    // tradeabilityOk/tradeabilityMoveOk ниже по-прежнему не пускают совсем мёртвые/неторгуемые пары.

    return clamp(Math.round(score), 0, 100);
  }

  // TRADEABILITY (продолжение, п.24 ТЗ) — "интересно" ещё не значит "торгуемо": ожидаемое движение
  // должно заметно превышать спред+комиссии+оценочный slippage, иначе сигнал статистически может
  // быть честным, но бессмысленным для входа. Простая, но реальная оценка (без выдуманных чисел):
  // берём заявленное детектором смещение цены (priceDisplacementPct/priceMovePct/totalDisplacementPct)
  // и требуем, чтобы оно было заметно больше половины спреда (если стакан есть) плюс типовая комиссия.
  const ASSUMED_ROUNDTRIP_FEE_PCT = 0.16; // 2 x ~0.08% — консервативная оценка тейкерской комиссии
  function tradeabilityMoveOk(candidate, symbol) {
    const e = candidate.evidence || {};
    const movePct = e.priceDisplacementPct != null ? Math.abs(e.priceDisplacementPct)
      : e.priceMovePct != null ? Math.abs(e.priceMovePct)
      : e.totalDisplacementPct != null ? Math.abs(e.totalDisplacementPct)
      : null;
    if (movePct == null) return true; // детектор не заявляет ценового смещения (например, чистый REFILL/ДЕРЖАТЕЛЬ) — не блокируем по этому критерию
    let spreadPct = 0.05;
    const depth = global.mexcTier2DepthForSymbol(symbol);
    if (depth && depth.length) {
      const last = depth[depth.length - 1];
      if (last.bestBid > 0 && last.bestAsk > last.bestBid) spreadPct = (last.bestAsk - last.bestBid) / ((last.bestAsk + last.bestBid) / 2) * 100;
    }
    return movePct >= (spreadPct / 2 + ASSUMED_ROUNDTRIP_FEE_PCT) * 0.6; // честный, не завышенный порог — отсекает только явно бессмысленные по размеру ситуации
  }

  // ------------------------------------------------------------------------
  // Основной цикл: CANDIDATE -> VALIDATION -> TRADEABILITY -> QUALITY -> COMPOSITE -> STORE.
  // ------------------------------------------------------------------------
  const confirmedSignals = new Map(); // symbol -> {types:[...], score, detectedAt, lastSeenAt, evidence:{}, direction, priceAtSignal, outcome:{}}
  const lastFiredAt = new Map(); // "symbol|type" -> ts, антидребезг (п. cooldownPerSymbolTypeMs)
  let lastComputeAt = 0;

  function collectSymbolCandidates(symbol, now, hasTier2) {
    const out = [];
    // БАГ (нашёл при аудите, 2026-09): regime раньше оставался на дефолтном 'NORMAL', если
    // hasTier2=true, но computeFeatures() вернул null (мало сделок для baseline) — а это ИМЕННО
    // самые неликвидные Tier2-монеты, то есть ровно те, для которых регим-бонус LOW_LIQUIDITY в
    // qualityScore важнее всего. classifyRegime(symbol) не завязан на computeFeatures (использует
    // отдельно tier1History/coinMap), поэтому его безопасно звать всегда заранее как базовое
    // значение — f.regime (когда f есть) всё равно считается тем же classifyRegime() внутри
    // computeFeatures, так что двойного вызова с разными результатами тут не бывает.
    let ofi = 0, regime = classifyRegime(symbol);
    if (hasTier2) {
      const f = computeFeatures(symbol, now);
      if (f) {
        ofi = f.ofi; regime = f.regime;
        Object.keys(tradeDetectors).forEach(function (key) {
          const res = tradeDetectors[key](f);
          if (res) out.push.apply(out, res);
        });
        Object.keys(algoTradeDetectors).forEach(function (key) {
          const res = algoTradeDetectors[key](f);
          if (res) out.push.apply(out, res);
        });
      }
      const df = computeDepthFeatures(symbol, now);
      if (df) {
        Object.keys(depthDetectors).forEach(function (key) {
          const res = depthDetectors[key](df);
          if (res) out.push.apply(out, res);
        });
        Object.keys(algoDepthDetectors).forEach(function (key) {
          const res = algoDepthDetectors[key](df);
          if (res) out.push.apply(out, res);
        });
      }
    }
    // Tier-1 (широкий скан по цене/объёму) — работает ВСЕГДA, независимо от того, есть ли у
    // монеты Tier2-подписка: там, где есть ещё и реальные сделки, это просто дополнительное
    // подтверждение к более точным Tier2-детекторам выше.
    const hist = tier1History.get(symbol);
    if (hist && hist.length >= CFG.tier1MinSamples) {
      Object.keys(tier1Detectors).forEach(function (key) {
        const res = tier1Detectors[key](symbol, hist);
        if (res) out.push.apply(out, res);
      });
    }
    const flowCascade = detectFlowCascade(symbol, now);
    if (flowCascade) out.push(flowCascade);

    out.forEach(function (c) { c.ofi = ofi; c.regime = regime; c.reasons = buildReasons(c); });
    return out;
  }

  // ------------------------------------------------------------------------
  // FLOW CASCADE — одно событие тянет за собой следующее: агрессивный всплеск -> заметный сдвиг
  // цены -> НОВЫЙ агрессивный всплеск в ту же сторону -> новый сдвиг. Не путать с одним сильным
  // burst'ом (п.21 ТЗ) — здесь обязательна ЦЕПОЧКА из >=2 связанных звеньев.
  // ------------------------------------------------------------------------
  function detectFlowCascade(symbol, now) {
    const trades = (global.mexcTier2TradesForSymbol(symbol) || []).filter(function (t) { return now - t.t <= CFG.recentWindowMs; });
    if (trades.length < 12) return null;
    // делим окно на последовательные под-окна по ~6 сделок, для каждого считаем перевес объёма и
    // сдвиг цены — событие "цепочки" = >=2 под-окна подряд с одинаковым направлением и реальным сдвигом
    const chunkSize = 6;
    const chunks = [];
    for (let i = 0; i + chunkSize <= trades.length; i += chunkSize) chunks.push(trades.slice(i, i + chunkSize));
    if (chunks.length < 2) return null;
    let streak = 0, dir = null, totalNotional = 0;
    let bestStreak = 0, bestDir = null, bestNotional = 0;
    chunks.forEach(function (chunk) {
      const buyN = chunk.filter(function (t) { return t.side === 'buy'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
      const sellN = chunk.filter(function (t) { return t.side === 'sell'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
      const disp = (chunk[chunk.length - 1].price - chunk[0].price) / chunk[0].price * 100;
      const chunkDir = buyN > sellN * 1.3 && disp > 0.03 ? 'buy' : (sellN > buyN * 1.3 && disp < -0.03 ? 'sell' : null);
      if (chunkDir && chunkDir === dir) { streak++; totalNotional += buyN + sellN; }
      else { dir = chunkDir; streak = chunkDir ? 1 : 0; totalNotional = chunkDir ? buyN + sellN : 0; }
      if (streak > bestStreak) { bestStreak = streak; bestDir = dir; bestNotional = totalNotional; }
    });
    if (bestStreak < 2) return null;
    const totalDisp = Math.abs(trades[trades.length - 1].price - trades[0].price) / trades[0].price * 100;
    return {
      type: 'flowCascade',
      direction: bestDir === 'buy' ? 'LONG' : 'SHORT',
      rawScore: 52 + clamp((bestStreak - 2) * 10, 0, 25) + clamp(totalDisp * 10, 0, 20),
      evidence: { linkedBursts: bestStreak, totalDisplacementPct: Math.round(totalDisp * 100) / 100, totalNotionalUsd: Math.round(bestNotional) }
    };
  }

  // Машиночитаемые причины (п.39 ТЗ) — строковые теги, выводимые в панель "почему сработало"
  // рядом с числовыми evidence, без изменения самих детекторов (собираем по уже посчитанным полям).
  function buildReasons(c) {
    const reasons = [];
    const e = c.evidence || {};
    if (e.repeats >= CFG.minRepeats) reasons.push('repeated_similar_trades');
    if (e.periodicityPct >= 70) reasons.push('stable_timing_interval');
    if (e.dominancePct >= 65) reasons.push('directional_dominance');
    if (e.impactRatio) reasons.push('low_price_displacement_vs_volume');
    if (e.baselineMultiple >= CFG.aggressorSizeMult) reasons.push('abnormal_trade_size');
    if (e.followThroughTrades) reasons.push('follow_through_confirmed');
    if (e.volumeAnomalyX >= 1.4 || e.volumeAccelX >= CFG.tier1BreakoutMinVolAccel) reasons.push('volume_anomaly');
    if (e.levelBreak) reasons.push('level_break');
    if (e.refillCycles || e.refills) reasons.push('liquidity_refill_observed');
    if (e.consistencyPct >= 70) reasons.push('systematic_repositioning');
    if (e.depthDropPct) reasons.push('depth_collapse');
    if (e.pulledMultiple) reasons.push('liquidity_removed');
    if (e.consecutiveTicks >= CFG.minRepeats) reasons.push('consecutive_same_direction_ticks');
    if (e.weakMarket) reasons.push('thin_market_at_execution');
    if (e.linkedBursts) reasons.push('chained_aggressive_bursts');
    if (e.participationRatePct >= 55) reasons.push('stable_participation_rate');
    if (e.repricingEvents) reasons.push('frequent_two_sided_repricing');
    if (e.executedToInitialRatio >= 1.8) reasons.push('executed_volume_exceeds_visible_depth');
    if (e.depthDropPct >= 55) reasons.push('rapid_multi_level_depth_consumption');
    if (e.turnoverPct >= 30) reasons.push('dynamic_level_turnover');
    if (e.durationSec >= 40) reasons.push('sustained_directional_distribution');
    if (c.regime && c.regime !== 'NORMAL') reasons.push('regime_' + c.regime.toLowerCase());
    if (Math.abs(c.ofi || 0) > 0.3) reasons.push(c.ofi > 0 ? 'order_flow_confirms_buy' : 'order_flow_confirms_sell');
    return reasons;
  }

  function recompute() {
    const now = Date.now();
    if (now - lastComputeAt < CFG.recomputeIntervalMs) return;
    lastComputeAt = now;
    if (!global.mexcCoinMap) return; // app.js ещё не проэкспортировал accessor'ы
    sampleTier1(now);

    const tier2Symbols = new Set(global.mexcTier2ActiveSymbols ? global.mexcTier2ActiveSymbols() : []);
    const symbols = Array.from(global.mexcCoinMap.keys()); // ВСЕ монеты рынка, не только watchlist
    symbols.forEach(function (symbol) {
      const hasTier2 = tier2Symbols.has(symbol);
      if (hasTier2 && !global.mexcSymbolDataIsFresh(symbol, now)) return; // протухшие Tier2-данные -> детектор молчит (п.34)
      if (!tradeabilityOk(symbol)) return; // ликвидностный фильтр (п.21) — до любого детектора

      const candidates = collectSymbolCandidates(symbol, now, hasTier2).filter(function (c) { return tradeabilityMoveOk(c, symbol); });
      if (!candidates.length) return;

      // COOLDOWN — анти-дребезг на пару (symbol, type), АДАПТИВНЫЙ по режиму (п.28 ТЗ): у более
      // волатильной прямо сейчас монеты события реально повторяются чаще — не душим их тем же
      // фиксированным окном, что и у спокойной монеты, и наоборот.
      const passed = candidates.filter(function (c) {
        const key = symbol + '|' + c.type;
        const last = lastFiredAt.get(key) || 0;
        const mult = c.regime === 'HIGH_VOLATILITY' ? 0.5 : (c.regime === 'LOW_LIQUIDITY' ? 1.6 : 1);
        return now - last >= CFG.cooldownPerSymbolTypeMs * mult;
      });
      if (!passed.length) return;

      const scored = passed.map(function (c) { return Object.assign({}, c, { score: qualityScore(c, symbol) }); })
        .filter(function (c) { return c.score >= CFG.watchThreshold; }); // NOISE FILTER — ниже watch вообще не рассматриваем
      if (!scored.length) return;

      scored.forEach(function (c) { lastFiredAt.set(symbol + '|' + c.type, now); });

      // COMPOSITE — если несколько типов подтвердились у одной монеты почти одновременно, это
      // один сигнал с составным названием и небольшим бонусом, а не N отдельных строк.
      const best = scored.reduce(function (a, b) { return b.score > a.score ? b : a; });
      const compositeBonus = clamp((scored.length - 1) * 5, 0, 15);
      const finalScore = clamp(best.score + compositeBonus, 0, 100);
      if (finalScore < CFG.displayThreshold) {
        // не дотянуло до показа — но помним как "watch", чтобы не пересоздавать заново с нуля
        return;
      }

      const coin = global.mexcCoinMap.get(symbol);
      const existing = confirmedSignals.get(symbol);
      confirmedSignals.set(symbol, {
        symbol: symbol,
        types: scored.map(function (c) { return c.type; }),
        // Доминирующий тип ЭТОГО прохода (самый высокий score среди подтвердившихся) — используется
        // для короткой подписи в виджете (см. compositeLabel), чтобы не склеивать в одну строку
        // эмодзи+название всех сработавших типов разом (было нечитаемо/переполняло "таблетку").
        // Полный список типов никуда не делся — те же rec.types/evidence, видны при разворачивании.
        primaryType: best.type,
        direction: scored[0].direction,
        score: finalScore,
        detectedAt: existing ? existing.detectedAt : now,
        lastSeenAt: now,
        evidence: scored.map(function (c) { return { type: c.type, evidence: c.evidence, score: c.score, reasons: c.reasons }; }),
        priceAtSignal: existing ? existing.priceAtSignal : (coin ? coin.price : null),
        outcome: existing ? existing.outcome : {}
      });
    });

    // Истечение неподтверждённых сигналов (п.29 "currently active" -> пропадают, если рынок остыл)
    confirmedSignals.forEach(function (rec, symbol) {
      if (now - rec.lastSeenAt > CFG.signalDecayMs) confirmedSignals.delete(symbol);
    });

    sweepOutcomes(now);
  }

  // ------------------------------------------------------------------------
  // Историческая проверка (п.35) — MFE/MAE на чекпоинтах 1/3/5/10/30/60с. Никогда не переписывает
  // priceAtSignal задним числом — только дополняет outcome по мере наступления времени.
  // ------------------------------------------------------------------------
  function sweepOutcomes(now) {
    confirmedSignals.forEach(function (rec) {
      if (rec.priceAtSignal == null) return;
      const coin = global.mexcCoinMap.get(rec.symbol);
      const curPrice = coin ? coin.price : null;
      if (curPrice == null) return;
      CFG.outcomeCheckpointsS.forEach(function (s) {
        const key = 'at' + s + 's';
        if (rec.outcome[key] != null) return;
        if (now - rec.detectedAt < s * 1000) return;
        const movePct = (curPrice - rec.priceAtSignal) / rec.priceAtSignal * 100;
        rec.outcome[key] = Math.round(movePct * 100) / 100;
      });
    });
  }

  // ------------------------------------------------------------------------
  // Публичное API — читает app.js (рендер виджета) и Auto Open. Никогда не отдаёт "сырые"
  // candidate — только то, что уже прошло весь pipeline и лежит в confirmedSignals.
  // ------------------------------------------------------------------------
  function getDisplayedSignals() {
    recompute();
    return Array.from(confirmedSignals.values())
      .sort(function (a, b) { return b.score - a.score || b.lastSeenAt - a.lastSeenAt; })
      .slice(0, CFG.maxDisplayed);
  }
  function labelFor(type) { return LABELS[type] || type; }
  // Короткая подпись для строки в виджете: ТОЛЬКО доминирующий тип ("если это прострел — пишется
  // прострел, без лишнего"), не склейка всех подтвердившихся типов через " + " (та версия переполняла
  // "таблетку" и обрезалась). Если типов больше одного — компактный "+N" рядом, полный список остаётся
  // доступен в evidence при разворачивании строки (см. renderWidgetFilter2Signals в app.js).
  function compositeLabel(rec) {
    const uniqueTypes = Array.from(new Set(rec.types));
    const primary = labelFor(rec.primaryType || uniqueTypes[0]);
    return uniqueTypes.length > 1 ? (primary + ' +' + (uniqueTypes.length - 1)) : primary;
  }

  global.WidgetFilter2 = {
    CFG: CFG,
    labelFor: labelFor,
    compositeLabel: compositeLabel,
    getDisplayedSignals: getDisplayedSignals
  };
})(window);
