// core-utils.js — DOM-free, pure(-ish) helpers shared by web/js/app.js and the tests/ verify
// scripts. Deliberately kept dependency-free (no protobufjs, no DOM, no WebSocket) so it can be
// `require()`d directly from plain Node test scripts without stubbing a browser environment.
//
// Loaded as a plain <script> before app.js in index.html (project has no bundler/build step —
// see README.md), so in the browser this attaches itself to window.MexcCore; app.js reads it
// from there. In Node (tests/), module.exports is used instead via the UMD-style wrapper below.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MexcCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------
  // Структурное логирование (DEBUG/INFO/WARNING/ERROR) с префиксом области — раньше сбои внутри
  // Финреза/WS не логировались вообще, только отражались в состоянии UI, из-за чего тихие регрессии
  // было тяжело отличить от реального сетевого сбоя без консоли, специально открытой в момент бага.
  // Не используется на "горячих" путях (по каждой сделке/тику) — только на переходах состояния
  // (подключение/разрыв/ошибка/восстановление), поэтому не спамит консоль.
  // ------------------------------------------------------------------
  const LOG_RING_MAX = 200;
  const logRing = [];
  function pushLogRing(level, scope, msg, data) {
    logRing.push({ t: Date.now(), level: level, scope: scope, msg: msg, data: data });
    if (logRing.length > LOG_RING_MAX) logRing.shift();
  }
  function logD(scope, msg, data) { pushLogRing('DEBUG', scope, msg, data); if (data !== undefined) console.debug('[' + scope + ']', msg, data); else console.debug('[' + scope + ']', msg); }
  function logI(scope, msg, data) { pushLogRing('INFO', scope, msg, data); if (data !== undefined) console.info('[' + scope + ']', msg, data); else console.info('[' + scope + ']', msg); }
  function logW(scope, msg, data) { pushLogRing('WARNING', scope, msg, data); if (data !== undefined) console.warn('[' + scope + ']', msg, data); else console.warn('[' + scope + ']', msg); }
  function logE(scope, msg, data) { pushLogRing('ERROR', scope, msg, data); if (data !== undefined) console.error('[' + scope + ']', msg, data); else console.error('[' + scope + ']', msg); }

  // Оборачивает промис-возвращающую функцию повтором с задержкой (по умолчанию 1с/3с/8с, 3 попытки) —
  // раньше НИ ОДИН REST-запрос в приложении не повторялся при сбое (только у основного WS был
  // exponential backoff); одиночный сетевой блип на GET-запросе означал моментальный отказ. Используем
  // только для идемпотентных GET-эндпоинтов. Не бесконечный — специально ограничен, чтобы не усиливать
  // нагрузку на MEXC во время реального сбоя (см. лимит 100 запросов/с у самого MEXC).
  // shouldRetry(err) — опциональный предикат; если возвращает false, повтор не делается вообще
  // (например, "Invalid symbol" — это не транзиентный сбой, а постоянное состояние).
  function withRetry(fn, attempts, delaysMs, scope, shouldRetry) {
    attempts = attempts || 3;
    delaysMs = delaysMs || [1000, 3000, 8000];
    scope = scope || 'retry';
    return new Promise(function (resolve, reject) {
      let attempt = 0;
      function tryOnce() {
        attempt++;
        Promise.resolve().then(fn).then(resolve, function (err) {
          const retryable = !shouldRetry || shouldRetry(err);
          if (!retryable || attempt >= attempts) {
            if (attempt > 1 || !retryable) logW(scope, (retryable ? 'все ' + attempts + ' попытки исчерпаны' : 'ошибка не повторяемая, повтор пропущен') + ': ' + ((err && err.message) || err));
            reject(err);
            return;
          }
          const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
          logD(scope, 'попытка ' + attempt + '/' + attempts + ' не удалась (' + ((err && err.message) || err) + '), повтор через ' + delay + 'мс');
          setTimeout(tryOnce, delay);
        });
      }
      tryOnce();
    });
  }

  // Короткий отпечаток API-ключа для обнаружения "это другой аккаунт" без хранения ключа второй
  // раз (он и так уже лежит в localStorage открытым текстом отдельно) — первые/последние 4 символа
  // + длина достаточно, чтобы отличить один реальный ключ MEXC от другого, но не публикуют ключ
  // целиком в отдельном месте.
  function computeApiKeyFingerprint(apiKey) {
    if (!apiKey) return null;
    return apiKey.slice(0, 4) + '...' + apiKey.slice(-4) + ':' + apiKey.length;
  }

  // Общий capped ring-буфер (Map<key, Array>) — используется буферами Tier 2 (сделки/стакан по
  // watchlist-монетам, см. план движка паттернов): добавляет item, при превышении cap выкидывает
  // самые старые элементы СПЕРЕДИ (FIFO), не пересоздавая массив каждый раз через slice.
  function pushRing(map, key, item, cap) {
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(item);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
    return arr;
  }

  // Чистая функция гистерезиса для watchlist Tier 2 (см. план движка паттернов): решает, какие
  // монеты добавить/убрать из watchlist на ОДНОМ цикле оценки, без побочных эффектов (никаких
  // WebSocket/DOM здесь) — только чтение/запись переданных Map-счётчиков. Смысл гистерезиса: монета
  // на границе топ-N не должна дёргать WS-соединение туда-обратно каждый цикл — нужно продержаться
  // в кандидатах/вне диапазона несколько циклов подряд, прежде чем что-то реально изменится.
  //
  // opts:
  //   rankedSymbols   — символы всех "живых" (прошедших порог ликвидности) монет, отсортированные
  //                      по убыванию watchlist-скора (сам скор сюда не передаётся, порядок уже готов)
  //   currentMembers  — Set текущих участников watchlist
  //   candidateStreaks, evictStreaks — Map<symbol, count>, МУТИРУЮТСЯ на месте (счётчики стрика)
  //   size            — целевой размер watchlist (например 20)
  //   evictMargin     — запас рангов, при выходе за topN+evictMargin начинается отсчёт на вылет
  //   addStreakNeeded, evictStreakNeeded — сколько циклов подряд нужно продержаться для add/evict
  //   forced          — Set символов, которые всегда должны быть в watchlist (текущая открытая
  //                      монета, избранное) — добавляются немедленно (без стрика) и никогда не
  //                      попадают на вылет по рейтингу, пока остаются forced
  //   maxSize         — ЖЁСТКИЙ потолок общего размера watchlist (forced + остальные вместе).
  //                      По умолчанию — то же самое, что size (без него "топ-N по рангу" ничем не
  //                      ограничивает суммарный РАЗМЕР: на живом рынке ранги волатильны, и за
  //                      несколько циклов подряд в "top-N" может успеть засветиться заметно БОЛЬШЕ
  //                      N разных символов, прежде чем гистерезис вылета их нагонит — без явного
  //                      потолка watchlist может расти НЕОГРАНИЧЕННО, что напрямую противоречит
  //                      цели всей этой системы: ограниченный, предсказуемый бюджет WS-подключений).
  // returns { toAdd: [symbols], toEvict: [symbols] } — то, что нужно ФАКТИЧЕСКИ изменить в этом цикле.
  function computeWatchlistTransitions(opts) {
    const rankedSymbols = opts.rankedSymbols || [];
    const currentMembers = opts.currentMembers || new Set();
    const candidateStreaks = opts.candidateStreaks || new Map();
    const evictStreaks = opts.evictStreaks || new Map();
    const size = opts.size;
    const evictMargin = opts.evictMargin || 0;
    const addStreakNeeded = opts.addStreakNeeded || 1;
    const evictStreakNeeded = opts.evictStreakNeeded || 1;
    const forced = opts.forced || new Set();
    const maxSize = opts.maxSize || size;

    const topN = new Set(rankedSymbols.slice(0, size));
    const topNPlusMargin = new Set(rankedSymbols.slice(0, size + evictMargin));

    const toEvict = [];
    // Кандидаты на вылет считаем ПЕРВЫМИ (не зависят от того, что будет добавлено) — forced
    // никогда, иначе только после evictStreakNeeded циклов подряд вне topN+evictMargin.
    currentMembers.forEach(function (sym) {
      if (forced.has(sym)) { evictStreaks.delete(sym); return; }
      if (!topNPlusMargin.has(sym)) {
        const streak = (evictStreaks.get(sym) || 0) + 1;
        evictStreaks.set(sym, streak);
        if (streak >= evictStreakNeeded) {
          toEvict.push(sym);
          evictStreaks.delete(sym);
        }
      } else {
        evictStreaks.delete(sym); // вернулась в диапазон — сбрасываем счётчик
      }
    });

    // forced добавляются немедленно и БЕЗ учёта потолка (пользователь явно выбрал эту монету) —
    // но всё равно занимают место в общем бюджете при расчёте остатка для обычных кандидатов ниже.
    const toAdd = [];
    forced.forEach(function (sym) {
      if (!currentMembers.has(sym)) toAdd.push(sym);
    });

    const projectedSize = currentMembers.size - toEvict.length + toAdd.length;
    let remainingSlots = Math.max(0, maxSize - projectedSize);

    rankedSymbols.forEach(function (sym) {
      if (currentMembers.has(sym) || forced.has(sym)) return; // уже участник или уже обработан как forced
      if (topN.has(sym)) {
        const streak = (candidateStreaks.get(sym) || 0) + 1;
        candidateStreaks.set(sym, streak);
        if (streak >= addStreakNeeded) {
          if (remainingSlots > 0) {
            toAdd.push(sym);
            candidateStreaks.delete(sym);
            remainingSlots--;
          }
          // иначе: кандидат честно "созрел", но свободных слотов нет — счётчик НЕ сбрасываем, чтобы
          // не заставлять его повторно копить addStreakNeeded циклов, когда место освободится.
        }
      } else {
        candidateStreaks.delete(sym); // выпал из топа до набора стрика — сбрасываем счётчик
      }
    });

    return { toAdd: toAdd, toEvict: toEvict };
  }

  // ============================================================================
  // Pattern Detection Engine — общая (DOM-независимая) статистика, используемая ВСЕМИ детекторами
  // Tier 2 (app.js). Требование ТЗ #10 ("адаптивные пороги для каждой монеты, не одинаковые для
  // всех") реализовано через медиану + MAD (median absolute deviation) вместо среднего/стандартного
  // отклонения — MAD устойчив к выбросам: одна аномально крупная сделка на тонкой монете не взрывает
  // порог так, как это сделало бы обычное std dev (см. tests/verify_adaptive_threshold.js —
  // конкретное сравнение с наивным mean/stdev на синтетических данных).
  // ============================================================================
  function median(values) {
    if (!values || !values.length) return 0;
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function medianAbsoluteDeviation(values, med) {
    if (!values || !values.length) return 0;
    const m = med === undefined ? median(values) : med;
    const deviations = values.map(function (v) { return Math.abs(v - m); });
    return median(deviations);
  }

  // z-подобная оценка "насколько value необычно для этого набора" — 0 в центре распределения,
  // растёт по модулю к краям. 1.4826 — стандартный множитель, приводящий MAD к масштабу std dev для
  // нормального распределения (общепринятая константа, не подгонка).
  function robustZScore(value, values) {
    const med = median(values);
    const mad = medianAbsoluteDeviation(values, med);
    const scaledMad = mad * 1.4826;
    if (scaledMad < 1e-9) return value === med ? 0 : (value > med ? 1 : -1) * 1e6; // вырожденный случай: все значения одинаковы
    return (value - med) / scaledMad;
  }

  // Единая формула PATTERN SCORE (0-100, ТЗ #8) — взвешенная сумма нормализованных (0..1) факторов.
  // Веса сознательно смещены в сторону статистической валидности (повторяемость+стабильность+
  // значимость = 50%) над "красивостью" сигнала (объём/отклонение/свежесть), чтобы шумные, но
  // единичные всплески не выбивались в топ мимо по-настоящему повторяющихся паттернов.
  // f.confirmation и f.pastSuccess по умолчанию 0 (нейтрально), пока не подключена история (ТЗ #9,
  // отдельный этап плана) — качество скоринга для самих детекторов от этого не деградирует, просто
  // эти два фактора начинают работать только когда появляются данные для них.
  const PATTERN_SCORE_WEIGHTS = {
    repeatability: 0.20, stability: 0.15, significance: 0.15, volume: 0.10,
    deviation: 0.10, freshness: 0.10, confirmation: 0.10, pastSuccess: 0.10
  };
  function scorePatternEvent(f) {
    f = f || {};
    let score = 0;
    Object.keys(PATTERN_SCORE_WEIGHTS).forEach(function (k) {
      const v = Math.max(0, Math.min(1, f[k] || 0));
      score += v * PATTERN_SCORE_WEIGHTS[k];
    });
    return Math.round(score * 100);
  }

  // Пересчитывает scoreAtSignal/confidencePct события ИЗ ЕГО ЖЕ факторов (например, после того как
  // выставлен factors.confirmation или factors.pastSuccess) — ЕДИНАЯ точка пересчёта, которая
  // уважает ev.maxConfidence, если он есть (см. detectFakeLiquidity — эвристика без ground truth
  // держит честный потолок уверенности; без единой функции для пересчёта легко забыть про этот
  // потолок в одном из мест, где score пересчитывается заново — что и произошло на практике до
  // выделения этой функции, см. app.js). Мутирует ev на месте и возвращает итоговый score.
  function applyPatternScore(ev) {
    const raw = scorePatternEvent(ev.factors);
    const capped = ev.maxConfidence != null ? Math.min(raw, ev.maxConfidence) : raw;
    ev.scoreAtSignal = capped;
    ev.confidencePct = capped;
    return capped;
  }

  // Находит крупнейший кластер значений, все члены которого укладываются в друг друга с допуском
  // `tolerance` (например 0.15 = ±15%, та же идея "не искать секунда в секунду", что и для циклов
  // в ТЗ) — используется и для повторяющихся размеров сделок, и для повторяющихся интервалов между
  // ними (одна и та же математика, разный вход). O(n log n) на сортировку + O(n) скользящее окно по
  // отсортированному массиву (оба указателя монотонно идут вперёд, классический two-pointer).
  function findDominantCluster(values, tolerance) {
    if (!values || values.length < 2) return null;
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    let best = null;
    let i = 0;
    for (let j = 0; j < sorted.length; j++) {
      while (sorted[j] > sorted[i] * (1 + tolerance)) i++;
      const count = j - i + 1;
      if (!best || count > best.count) {
        const members = sorted.slice(i, j + 1);
        best = { count: count, members: members, representative: median(members), min: members[0], max: members[members.length - 1] };
      }
    }
    return best;
  }

  // "Статистическая значимость" найденного кластера — НЕ z-score представителя кластера против
  // всего набора (это самоссылочно и вырождается в ~0, когда кластер составляет большинство точек —
  // ровно случай настоящего повторяющегося паттерна). Вместо этого: сколько точек попало бы в
  // произвольную tolerance-полосу СЛУЧАЙНО, если бы значения были равномерно раскиданы по всему
  // наблюдаемому (лог-)диапазону — и во сколько раз реальный кластер больше этого ожидания.
  // ratio=1 (ровно как случайно) -> значимость 0; ratio>=5 (в 5 раз больше случайного) -> значимость 1.
  function clusterSignificance(cluster, allValues, tolerance) {
    if (!allValues || allValues.length < 3) return 0.5;
    const sorted = allValues.slice().sort(function (a, b) { return a - b; });
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    if (hi <= lo) return 0.5; // все значения идентичны — сравнивать не с чем
    const numBands = Math.max(1, Math.log(hi / lo) / Math.log(1 + tolerance));
    const expectedPerBand = allValues.length / numBands;
    if (expectedPerBand < 1e-6) return 1;
    const ratio = cluster.count / expectedPerBand;
    return Math.min(1, Math.max(0, (ratio - 1) / 4));
  }

  // ============================================================================
  // Детекторы Tier 2 — ЧИСТЫЕ функции (trades[], opts) -> event|null, без обращения к
  // tier2Trades/DOM/WS. app.js передаёт им tier2Trades.get(symbol) и добавляет к результату
  // symbol/detectedAt — сюда вынесены специально, чтобы можно было гонять их на синтетических
  // данных из tests/ (в т.ч. отдельный контрольный прогон на чистом шуме — критично для #5 ТЗ,
  // "не путать структуру со случайным шумом рынка"), а не полагаться только на живой рынок.
  // trade shape: {t: ms-timestamp, price: number, qty: number, side: 'buy'|'sell'}
  // ============================================================================

  // repeatSize: повторяющиеся по размеру сделки (ТЗ: "одинаковые размеры сделок").
  function detectRepeatedTradeSizes(trades, opts) {
    opts = opts || {};
    const tolerance = opts.tolerance || 0.15;
    const minRepeats = opts.minRepeats || 5;
    const lookback = opts.lookback || 200;
    if (!trades || trades.length < 10) return null;
    const recent = trades.slice(-lookback);
    const sizesUsd = recent.map(function (t) { return t.price * t.qty; });
    const cluster = findDominantCluster(sizesUsd, tolerance);
    if (!cluster || cluster.count < minRepeats) return null;

    const members = recent.filter(function (t) { const v = t.price * t.qty; return v >= cluster.min && v <= cluster.max; });
    const buyCount = members.filter(function (t) { return t.side === 'buy'; }).length;
    const sellCount = members.length - buyCount;
    const direction = buyCount > sellCount * 1.5 ? 'LONG' : (sellCount > buyCount * 1.5 ? 'SHORT' : 'BOTH');

    const widthRatio = (cluster.max - cluster.min) / Math.max(cluster.representative, 1e-9);
    const stability = Math.max(0, 1 - widthRatio / tolerance);
    const significance = clusterSignificance(cluster, sizesUsd, tolerance);
    const volumeUsd = cluster.count * cluster.representative;

    const factors = {
      repeatability: Math.min(1, cluster.count / 15), stability: stability, significance: significance,
      volume: Math.min(1, volumeUsd / 5000), deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const last = recent[recent.length - 1];
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'repeatSize', direction: direction, repeatCount: cluster.count,
      sizeRangeUsd: [Math.round(cluster.min), Math.round(cluster.max)], volumeUsd: Math.round(volumeUsd),
      priceAtSignal: last.price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // repeatInterval: повторяющиеся интервалы между сделками (ТЗ: "одинаковые интервалы между событиями").
  function detectRepeatedIntervals(trades, opts) {
    opts = opts || {};
    const tolerance = opts.tolerance || 0.15;
    const minRepeats = opts.minRepeats || 5;
    const lookback = opts.lookback || 200;
    if (!trades || trades.length < 12) return null;
    const recent = trades.slice(-lookback);
    const gaps = [];
    for (let i = 1; i < recent.length; i++) {
      const g = (recent[i].t - recent[i - 1].t) / 1000;
      if (g > 0.05) gaps.push(g); // отсекаем почти-нулевые (несколько сделок в одном протокольном фрейме)
    }
    const cluster = findDominantCluster(gaps, tolerance);
    if (!cluster || cluster.count < minRepeats) return null;

    const widthRatio = (cluster.max - cluster.min) / Math.max(cluster.representative, 1e-9);
    const stability = Math.max(0, 1 - widthRatio / tolerance);
    const significance = clusterSignificance(cluster, gaps, tolerance);

    const factors = {
      repeatability: Math.min(1, cluster.count / 15), stability: stability, significance: significance,
      volume: 0.5, deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const last = recent[recent.length - 1];
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'repeatInterval', direction: 'BOTH', repeatCount: cluster.count,
      avgIntervalS: Math.round(cluster.representative * 10) / 10,
      priceAtSignal: last.price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // burstNoFollow: всплеск объёма БЕЗ пропорционального движения цены (ТЗ: "крупный объём без
  // нормального продолжения") — адаптивно per-coin: и "что такое всплеск", и "что такое нормальное
  // движение" считаются от СОБСТВЕННОЙ недавней истории именно этой монеты (N-секундные бакеты), а
  // не от одного правила на весь рынок (ТЗ #10).
  function detectBurstNoFollowThrough(trades, opts) {
    opts = opts || {};
    const bucketMs = opts.bucketMs || 10000;
    const minRepeats = opts.minRepeats || 3;
    const lookback = opts.lookback || 300;
    if (!trades || trades.length < 30) return null;
    const recent = trades.slice(-lookback);

    const buckets = new Map(); // bucketIndex -> {volume, firstPrice, lastPrice, count}
    recent.forEach(function (t) {
      const b = Math.floor(t.t / bucketMs);
      let bk = buckets.get(b);
      if (!bk) { bk = { volume: 0, firstPrice: t.price, lastPrice: t.price, count: 0 }; buckets.set(b, bk); }
      bk.volume += t.price * t.qty;
      bk.lastPrice = t.price;
      bk.count++;
    });
    const bucketList = Array.from(buckets.values());
    if (bucketList.length < 6) return null; // недостаточно истории, чтобы знать, что для этой монеты "обычно"

    const currentBucket = bucketList[bucketList.length - 1];
    const pastBuckets = bucketList.slice(0, -1);
    if (currentBucket.count < minRepeats) return null;

    const pastVolumes = pastBuckets.map(function (b) { return b.volume; });
    const pastMoves = pastBuckets.map(function (b) { return b.firstPrice > 0 ? Math.abs(b.lastPrice - b.firstPrice) / b.firstPrice : 0; });
    const currentMove = currentBucket.firstPrice > 0 ? Math.abs(currentBucket.lastPrice - currentBucket.firstPrice) / currentBucket.firstPrice : 0;

    const volumeZ = robustZScore(currentBucket.volume, pastVolumes);
    const moveZ = robustZScore(currentMove, pastMoves);
    // Всплеск объёма (заметно выше обычного для ЭТОЙ монеты) БЕЗ соразмерного движения цены —
    // moveZ низкий значит "цена вела себя как обычно", несмотря на необычный объём.
    if (volumeZ < 3 || moveZ > 1) return null;

    const bucketStartMs = Math.floor(recent[recent.length - 1].t / bucketMs) * bucketMs;
    const buyCount = recent.filter(function (t) { return t.t >= bucketStartMs && t.side === 'buy'; }).length;
    const sellCount = currentBucket.count - buyCount;

    const factors = {
      repeatability: Math.min(1, currentBucket.count / 15), stability: 0.5,
      significance: Math.min(1, volumeZ / 6), volume: Math.min(1, currentBucket.volume / 5000),
      deviation: Math.min(1, volumeZ / 6), freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'burstNoFollow', direction: buyCount > sellCount ? 'LONG' : (sellCount > buyCount ? 'SHORT' : 'BOTH'),
      repeatCount: currentBucket.count, volumeUsd: Math.round(currentBucket.volume),
      priceMovePct: currentMove, priceAtSignal: currentBucket.lastPrice,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // Коэффициент автокорреляции временного ряда с самим собой, сдвинутым на `lag` отсчётов
  // (Пирсон). Стандартная статистика для поиска периодичности — пик автокорреляции на лаге L
  // означает "ряд похож сам на себя через L шагов", т.е. вероятный период L.
  function autocorrelation(series, lag) {
    const n = series.length;
    if (lag >= n || lag < 1) return 0;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += series[i];
    mean /= n;
    let num = 0, den = 0;
    for (let i = 0; i < n - lag; i++) num += (series[i] - mean) * (series[i + lag] - mean);
    for (let i = 0; i < n; i++) den += (series[i] - mean) * (series[i] - mean);
    return den > 1e-9 ? num / den : 0;
  }

  // cycle: авто-обнаружение циклического поведения (ТЗ #2/#4) — НЕ фиксированные пресеты
  // (1/2/3/4/5 минут), а реальный период, найденный автокорреляцией по бакетированному ряду
  // net-delta (buy-объём минус sell-объём), с допуском ±tolerance (тот же принцип, что и у
  // остальных кластерных детекторов). Период сам по себе — только первая часть доказательства;
  // вторая — реальные пики в ряду ДЕЙСТВИТЕЛЬНО повторяются с этим периодом (иначе шумный ряд может
  // случайно дать высокую автокорреляцию на каком-то лаге без реальной структуры).
  function detectCyclicity(trades, opts) {
    opts = opts || {};
    const bucketMs = opts.bucketMs || 2000;
    const minRepeats = opts.minRepeats || 8;
    const tolerance = opts.tolerance || 0.15;
    const lookback = opts.lookback || 2000;
    const minCorrelation = opts.minCorrelation != null ? opts.minCorrelation : 0.25;
    if (!trades || trades.length < 30) return null;
    const recent = trades.slice(-lookback);

    const buckets = new Map();
    let minB = Infinity, maxB = -Infinity;
    recent.forEach(function (t) {
      const b = Math.floor(t.t / bucketMs);
      const delta = (t.side === 'buy' ? 1 : -1) * t.price * t.qty;
      buckets.set(b, (buckets.get(b) || 0) + delta);
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    });
    const n = maxB - minB + 1;
    if (n < 20) return null; // недостаточно временного охвата для поиска периода вообще

    const series = new Array(n).fill(0);
    buckets.forEach(function (v, b) { series[b - minB] = v; });

    const minLag = Math.max(2, Math.ceil(5000 / bucketMs)); // период не короче ~5с (иначе это уже не "цикл", а тиковый шум)
    const maxLag = Math.floor(n / minRepeats); // период должен успеть повториться minRepeats раз в наблюдаемом окне
    if (maxLag <= minLag) return null;

    let best = null;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const corr = autocorrelation(series, lag);
      if (!best || corr > best.corr) best = { lag: lag, corr: corr };
    }
    if (!best || best.corr < minCorrelation) return null;

    // Подтверждение: реальные пики в ряду (по модулю сильно выше типичного для этого ряда) и
    // расстояния МЕЖДУ ними кластеризуются вокруг найденного периода — иначе высокая автокорреляция
    // могла возникнуть на длинном пологом тренде, а не на настоящем повторяющемся цикле.
    const absSeries = series.map(function (v) { return Math.abs(v); });
    const med = median(absSeries);
    const mad = medianAbsoluteDeviation(absSeries, med);
    const peakThreshold = med + 1.5 * mad * 1.4826;
    const peakIndices = [];
    for (let i = 1; i < n - 1; i++) {
      if (absSeries[i] > peakThreshold && absSeries[i] >= absSeries[i - 1] && absSeries[i] >= absSeries[i + 1]) peakIndices.push(i);
    }
    if (peakIndices.length < minRepeats) return null;

    const peakGapsBuckets = [];
    for (let i = 1; i < peakIndices.length; i++) peakGapsBuckets.push(peakIndices[i] - peakIndices[i - 1]);
    const gapCluster = findDominantCluster(peakGapsBuckets, tolerance);
    if (!gapCluster || gapCluster.count < minRepeats - 1) return null;

    const periodS = gapCluster.representative * bucketMs / 1000;
    const buyPeaks = peakIndices.filter(function (i) { return series[i] > 0; }).map(function (i) { return series[i]; });
    const sellPeaks = peakIndices.filter(function (i) { return series[i] < 0; }).map(function (i) { return Math.abs(series[i]); });

    const stability = Math.max(0, 1 - ((gapCluster.max - gapCluster.min) / Math.max(gapCluster.representative, 1e-9)) / tolerance);
    const factors = {
      repeatability: Math.min(1, (gapCluster.count + 1) / 15), stability: stability,
      significance: Math.min(1, Math.abs(best.corr) / 0.6), volume: Math.min(1, (buyPeaks.concat(sellPeaks).reduce(function (a, b) { return a + b; }, 0)) / 5000),
      deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    const direction = buyPeaks.length > sellPeaks.length * 1.5 ? 'LONG' : (sellPeaks.length > buyPeaks.length * 1.5 ? 'SHORT' : 'BOTH');
    return {
      detectorKey: 'cycle', direction: direction, repeatCount: gapCluster.count + 1,
      cycleS: Math.round(periodS * 10) / 10,
      buyRangeUsd: buyPeaks.length ? [Math.round(Math.min.apply(null, buyPeaks)), Math.round(Math.max.apply(null, buyPeaks))] : null,
      sellRangeUsd: sellPeaks.length ? [Math.round(Math.min.apply(null, sellPeaks)), Math.round(Math.max.apply(null, sellPeaks))] : null,
      priceAtSignal: recent[recent.length - 1].price,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // sequence: повторяющиеся последовательности BUY/SELL (ТЗ #3) — n-gram сканирование по алфавиту
  // {B,S} (сторона сделки), длины minLen..maxLen, БЕЗ ограничения заранее заданными шаблонами.
  // Однородные забеги ("BBBB"/"SSSS") исключены сознательно — это не "последовательность", а просто
  // затяжной перекос в одну сторону, для него есть burstNoFollow/ineff. Гейт по significance
  // (наблюдаемое количество вхождений против ожидаемого по случайной модели с ТЕМИ ЖЕ частотами
  // B/S, что и в реальных данных) — критично для коротких длин: у алфавита из 2 символов короткая
  // 3-буквенная последовательность и так довольно часто встречается в чистом шуме просто по
  // комбинаторике (2^3=8 вариантов), поэтому одного "count >= minRepeats" НЕДОСТАТОЧНО, значимость
  // должна реально означать "заметно чаще, чем случайно", а не просто "не редкость".
  function detectRepeatingSequence(trades, opts) {
    opts = opts || {};
    const minLen = opts.minLen || 3;
    const maxLen = opts.maxLen || 6;
    const minRepeats = opts.minRepeats || 5;
    const lookback = opts.lookback || 200;
    const minSignificance = opts.minSignificance != null ? opts.minSignificance : 0.5;
    if (!trades || trades.length < minLen + minRepeats) return null;
    const recent = trades.slice(-lookback);
    const symbols = recent.map(function (t) { return t.side === 'buy' ? 'B' : 'S'; }).join('');
    const totalB = (symbols.match(/B/g) || []).length;
    const pB = symbols.length ? totalB / symbols.length : 0.5;

    let best = null;
    for (let len = minLen; len <= maxLen; len++) {
      const counts = new Map();
      for (let i = 0; i <= symbols.length - len; i++) {
        const sub = symbols.substr(i, len);
        counts.set(sub, (counts.get(sub) || 0) + 1);
      }
      counts.forEach(function (count, sub) {
        if (/^B+$/.test(sub) || /^S+$/.test(sub)) return; // однородный забег — не сюда
        if (count < minRepeats) return;
        const positions = symbols.length - len + 1;
        const pSub = sub.split('').reduce(function (p, ch) { return p * (ch === 'B' ? pB : (1 - pB)); }, 1);
        const expectedCount = pSub * positions;
        const significance = expectedCount > 1e-9 ? Math.max(0, (count / expectedCount - 1) / 4) : 1;
        const rank = count * len * (0.3 + significance); // длиннее и значимее — приоритетнее короткого частого совпадения
        if (!best || rank > best.rank) best = { sub: sub, count: count, len: len, significance: Math.min(1, significance), rank: rank };
      });
    }
    if (!best || best.significance < minSignificance) return null;

    // Непересекающиеся вхождения — честный repeatCount (не "скользящее окно", которое считает одно
    // и то же физическое совпадение много раз подряд для перекрывающихся сдвигов).
    const occurrences = [];
    let searchFrom = 0;
    while (true) {
      const idx = symbols.indexOf(best.sub, searchFrom);
      if (idx === -1) break;
      occurrences.push(idx);
      searchFrom = idx + best.len;
    }
    if (occurrences.length < minRepeats) return null;

    const buyCount = (best.sub.match(/B/g) || []).length;
    const sellCount = best.len - buyCount;
    const direction = buyCount > sellCount ? 'LONG' : (sellCount > buyCount ? 'SHORT' : 'BOTH');

    let volumeUsd = 0;
    occurrences.forEach(function (idx) {
      for (let j = 0; j < best.len; j++) volumeUsd += recent[idx + j].price * recent[idx + j].qty;
    });

    const factors = {
      repeatability: Math.min(1, occurrences.length / 10), stability: 0.7, significance: best.significance,
      volume: Math.min(1, volumeUsd / 5000), deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'sequence', direction: direction, repeatCount: occurrences.length,
      sequencePattern: best.sub, sequenceLen: best.len, volumeUsd: Math.round(volumeUsd),
      priceAtSignal: recent[recent.length - 1].price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ladder ("лесенка"): самый длинный подряд идущий монотонный забег изменения цены — НЕ примитивно
  // "несколько сделок подряд вверх", а с учётом равномерности шага (кластеризация % изменения на
  // каждом шаге), направления, интервалов и объёма (ТЗ #6). significance — НЕ z-score самого забега
  // (см. clusterSignificance выше про то, почему это самоссылочно), а классическая статистика
  // "ожидаемая длина самой длинной серии одного знака в N случайных шагах" ≈ log2(N) — забег заметно
  // длиннее этого ожидания статистически значим сам по себе, backround не нужен для сравнения.
  function detectLadder(trades, opts) {
    opts = opts || {};
    const tolerance = opts.tolerance || 0.3; // шаги "лесенки" разрешаем чуть более гуляющими, чем trade-size кластер
    const minRepeats = opts.minRepeats || 8; // минимум ШАГОВ в забеге
    const lookback = opts.lookback || 200;
    const minSignificance = opts.minSignificance != null ? opts.minSignificance : 0.15;
    if (!trades || trades.length < minRepeats + 1) return null;
    const recent = trades.slice(-lookback);

    let bestStart = -1, bestEnd = -1, bestLen = 0, bestSign = 0;
    let curStart = 0, curSign = 0, curLen = 0;
    let totalSteps = 0;
    for (let i = 1; i < recent.length; i++) {
      const sign = Math.sign(recent[i].price - recent[i - 1].price);
      if (sign === 0) continue;
      totalSteps++;
      if (sign === curSign) {
        curLen++;
      } else {
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; bestEnd = i - 1; bestSign = curSign; }
        curSign = sign; curStart = i - 1; curLen = 1;
      }
    }
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; bestEnd = recent.length - 1; bestSign = curSign; }
    if (bestLen < minRepeats || bestStart < 0) return null;

    const expectedMaxRun = totalSteps > 1 ? Math.log(totalSteps) / Math.LN2 : 1;
    const significance = Math.min(1, Math.max(0, (bestLen - expectedMaxRun) / Math.max(expectedMaxRun, 1e-9)));
    if (significance < minSignificance) return null;

    const runTrades = recent.slice(bestStart, bestEnd + 1);
    const steps = [];
    const intervals = [];
    for (let i = 1; i < runTrades.length; i++) {
      const pct = Math.abs((runTrades[i].price - runTrades[i - 1].price) / runTrades[i - 1].price);
      if (pct > 0) steps.push(pct);
      intervals.push((runTrades[i].t - runTrades[i - 1].t) / 1000);
    }
    if (steps.length < minRepeats) return null;

    const stepCluster = findDominantCluster(steps, tolerance);
    if (!stepCluster || stepCluster.count < Math.ceil(steps.length * 0.6)) return null; // шаги должны быть довольно однородны, не хаотичны

    const stepWidthRatio = (stepCluster.max - stepCluster.min) / Math.max(stepCluster.representative, 1e-9);
    const stability = Math.max(0, 1 - stepWidthRatio / tolerance);
    const volumeUsd = runTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);

    const factors = {
      repeatability: Math.min(1, bestLen / 15), stability: stability, significance: significance,
      volume: Math.min(1, volumeUsd / 5000), deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'ladder', direction: bestSign > 0 ? 'LONG' : 'SHORT', repeatCount: bestLen,
      avgStepPct: Math.round(stepCluster.representative * 10000) / 100,
      avgIntervalS: Math.round(median(intervals) * 10) / 10, volumeUsd: Math.round(volumeUsd),
      priceAtSignal: runTrades[runTrades.length - 1].price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ershik ("ёршик") — хаотичное на вид, но СТРУКТУРИРОВАННОЕ чередование BUY/SELL (ТЗ #5).
  // Явное требование ТЗ: сырая частота чередования САМА ПО СЕБЕ не считается — обычный рыночный
  // шум тоже часто чередует сторону сделки. Забег чередования квалифицируется только если ≥2 из 3
  // структурных признаков подтверждаются: (1) размеры сделок кластеризуются, а не случайны,
  // (2) интервалы между сделками кластеризуются, (3) цена остаётся в узком диапазоне относительно
  // обычной волатильности этой монеты за тот же охват. Один только длинный забег чередования без
  // ни одного из этих признаков классифицируется как шум и НЕ возвращается как паттерн.
  function detectErshik(trades, opts) {
    opts = opts || {};
    const tolerance = opts.tolerance || 0.2;
    const minRepeats = opts.minRepeats || 8; // минимум сделок в забеге чередования
    const lookback = opts.lookback || 200;
    const structureThreshold = opts.structureThreshold != null ? opts.structureThreshold : 0.6;
    if (!trades || trades.length < minRepeats + 2) return null;
    const recent = trades.slice(-lookback);

    let bestStart = -1, bestLen = 0;
    let curStart = 0, curLen = 1;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].side !== recent[i - 1].side) {
        curLen++;
      } else {
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        curStart = i; curLen = 1;
      }
    }
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    if (bestLen < minRepeats || bestStart < 0) return null;

    const runTrades = recent.slice(bestStart, bestStart + bestLen);

    const sizes = runTrades.map(function (t) { return t.price * t.qty; });
    const sizeCluster = findDominantCluster(sizes, tolerance);
    const sizeClusteringOk = !!(sizeCluster && sizeCluster.count >= Math.ceil(runTrades.length * structureThreshold));

    const intervals = [];
    for (let i = 1; i < runTrades.length; i++) intervals.push((runTrades[i].t - runTrades[i - 1].t) / 1000);
    const intervalCluster = intervals.length ? findDominantCluster(intervals, tolerance) : null;
    const intervalRegularOk = !!(intervalCluster && intervalCluster.count >= Math.ceil(intervals.length * structureThreshold));

    const prices = runTrades.map(function (t) { return t.price; });
    const runMedian = median(prices);
    const runRange = runMedian > 0 ? (Math.max.apply(null, prices) - Math.min.apply(null, prices)) / runMedian : 0;
    const allPrices = recent.map(function (t) { return t.price; });
    const ambMedian = median(allPrices);
    const ambientRange = ambMedian > 0 ? (Math.max.apply(null, allPrices) - Math.min.apply(null, allPrices)) / ambMedian : 0;
    const priceContainedOk = ambientRange > 1e-9 ? runRange < ambientRange * 0.7 : true;

    const structureSignals = (sizeClusteringOk ? 1 : 0) + (intervalRegularOk ? 1 : 0) + (priceContainedOk ? 1 : 0);
    if (structureSignals < 2) return null; // ключевой гейт против шума — см. комментарий выше функции

    const buyCount = runTrades.filter(function (t) { return t.side === 'buy'; }).length;
    const sellCount = runTrades.length - buyCount;
    const direction = buyCount > sellCount * 1.3 ? 'LONG' : (sellCount > buyCount * 1.3 ? 'SHORT' : 'BOTH');
    const volumeUsd = sizes.reduce(function (a, b) { return a + b; }, 0);

    const factors = {
      repeatability: Math.min(1, bestLen / 15),
      stability: (sizeClusteringOk ? 0.5 : 0) + (intervalRegularOk ? 0.5 : 0),
      significance: structureSignals / 3,
      volume: Math.min(1, volumeUsd / 5000),
      deviation: priceContainedOk ? 1 : 0.3,
      freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'ershik', direction: direction, repeatCount: bestLen, structureSignals: structureSignals,
      volumeUsd: Math.round(volumeUsd), priceAtSignal: runTrades[runTrades.length - 1].price,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ============================================================================
  // Детекторы на СТАКАНЕ (Tier 2, только watchlist-монеты — см. план). depthSnapshots — ring-буфер
  // tier2Depth: [{t, bids:[{p,q}], asks:[{p,q}], bestBid, bestAsk, bidVol, askVol}], ~1 снимок/500мс.
  // ============================================================================

  // imbalance: дисбаланс стакана (ask/bid объём в топ-N уровней), z-скор ПРОТИВ СОБСТВЕННОЙ недавней
  // истории этого коэффициента у ЭТОЙ монеты (ТЗ #10 — адаптивно per-coin, не абсолютный порог),
  // плюс требование устойчивости — единичный шумный снимок не считается, дисбаланс должен
  // продержаться несколько снимков подряд в одну сторону.
  function detectImbalance(depthSnapshots, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 300;
    const minSnapshots = opts.minSnapshots || 20;
    const minZ = opts.minZ != null ? opts.minZ : 2.5;
    const persistN = opts.persistN || 5;
    if (!depthSnapshots || depthSnapshots.length < minSnapshots) return null;
    const recent = depthSnapshots.slice(-lookback);
    const ratios = recent.map(function (s) {
      const total = s.bidVol + s.askVol;
      return total > 1e-9 ? (s.bidVol - s.askVol) / total : 0;
    });
    const current = ratios[ratios.length - 1];
    const history = ratios.slice(0, -1);
    if (history.length < minSnapshots - 1) return null;
    const z = robustZScore(current, history);
    if (Math.abs(z) < minZ) return null;

    const lastFew = ratios.slice(-Math.min(persistN, ratios.length));
    const sameSignCount = lastFew.filter(function (r) { return Math.sign(r) === Math.sign(current) && Math.abs(r) > 0.15; }).length;
    const stability = sameSignCount / lastFew.length;
    if (stability < 0.6) return null; // разовый выброс — не устойчивый дисбаланс

    const cur = recent[recent.length - 1];
    const factors = {
      repeatability: stability, stability: stability, significance: Math.min(1, Math.abs(z) / 5),
      volume: Math.min(1, (cur.bidVol + cur.askVol) / 50000), deviation: Math.min(1, Math.abs(z) / 5),
      freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'imbalance', direction: current > 0 ? 'LONG' : 'SHORT',
      imbalanceRatio: Math.round(current * 1000) / 1000, repeatCount: sameSignCount,
      bidVolUsd: Math.round(cur.bidVol), askVolUsd: Math.round(cur.askVol),
      priceAtSignal: cur.bestBid, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // Общая внутренняя часть absorption/fakeLiquidity — обе ищут "крупный резидентный объём на
  // одном уровне цены заметно усох", различаются только тем, было ли это исполнено (см. ниже).
  function trackShrinkingLevel(depthSnapshots, trades, opts) {
    const lookback = opts.lookback || 300;
    const minSnapshots = opts.minSnapshots || 20;
    const priceTolerance = opts.priceTolerance || 0.002;
    if (!depthSnapshots || depthSnapshots.length < minSnapshots) return null;
    const recent = depthSnapshots.slice(-lookback);
    const sides = ['bestBid', 'bestAsk'];
    let best = null;
    sides.forEach(function (sideKey) {
      const bookKey = sideKey === 'bestBid' ? 'bids' : 'asks';
      const first = recent[0];
      if (!first[sideKey]) return;
      const levelPrice = first[sideKey];
      const atLevel = recent.filter(function (s) { return s[sideKey] && Math.abs(s[sideKey] - levelPrice) / levelPrice <= priceTolerance; });
      if (atLevel.length < minSnapshots * 0.6) return;
      const qtyAt = function (s) { return s[bookKey] && s[bookKey].length ? s[bookKey][0].q : 0; };
      const startQty = qtyAt(atLevel[0]);
      const endQty = qtyAt(atLevel[atLevel.length - 1]);
      if (startQty <= 0) return;
      const shrinkRatio = (startQty - endQty) / startQty;
      if (shrinkRatio < 0.3) return;
      const t0 = atLevel[0].t, t1 = atLevel[atLevel.length - 1].t;
      const nearbyTrades = (trades || []).filter(function (tr) { return tr.t >= t0 && tr.t <= t1 && Math.abs(tr.price - levelPrice) / levelPrice <= priceTolerance; });
      const executedQty = nearbyTrades.reduce(function (a, tr) { return a + tr.qty; }, 0);
      const shrunkQty = startQty - endQty;
      const candidate = {
        side: sideKey === 'bestBid' ? 'bid' : 'ask', levelPrice: levelPrice, atLevel: atLevel,
        shrinkRatio: shrinkRatio, shrunkQty: shrunkQty, executedQty: executedQty
      };
      if (!best || shrinkRatio > best.shrinkRatio) best = candidate;
    });
    return best;
  }

  // absorption: крупная плотность на уровне усыхает, ЦЕНА ЧЕРЕЗ НЕЁ НЕ ПРОШЛА, и объём, который
  // исчез из стакана, реально нашёл соответствие в исполненных сделках у этого уровня — то есть
  // заявку действительно "съели" потоком, а не просто отменили (ТЗ: "поглощение плотности").
  function detectAbsorption(depthSnapshots, trades, opts) {
    opts = opts || {};
    const track = trackShrinkingLevel(depthSnapshots, trades, opts);
    if (!track) return null;
    if (track.executedQty < track.shrunkQty * 0.3) return null; // мало что исполнилось — это, скорее, снятие заявки (fakeLiquidity), не поглощение
    const volumeUsd = track.executedQty * track.levelPrice;
    const matchRatio = Math.min(1, track.executedQty / Math.max(track.shrunkQty, 1e-9));
    const factors = {
      repeatability: Math.min(1, track.atLevel.length / (opts.minSnapshots || 20)), stability: matchRatio,
      significance: Math.min(1, track.shrinkRatio), volume: Math.min(1, volumeUsd / 5000),
      deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'absorption', direction: track.side === 'bid' ? 'LONG' : 'SHORT',
      repeatCount: track.atLevel.length, priceLevel: track.levelPrice,
      shrinkPct: Math.round(track.shrinkRatio * 1000) / 10, volumeUsd: Math.round(volumeUsd),
      priceAtSignal: track.levelPrice, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // fakeLiquidity: тот же паттерн "плотность усохла", но БЕЗ соответствующего исполненного объёма —
  // заявка, похоже, просто снята/переставлена, а не съедена потоком. ЭТО ЭВРИСТИКА, не факт: без
  // ID заявок в публичном стакане MEXC отличить "снята" от "переставлена на микро-тик и снова
  // подхвачена" невозможно в принципе — поэтому confidence искусственно ограничен сверху (см. cap
  // ниже) и результат помечен isHeuristic, чтобы UI не выдавал это за подтверждённый спуфинг.
  function detectFakeLiquidity(depthSnapshots, trades, opts) {
    opts = opts || {};
    const track = trackShrinkingLevel(depthSnapshots, trades, opts);
    if (!track) return null;
    if (track.executedQty > track.shrunkQty * 0.3) return null; // прилично исполнилось — это absorption, не "фейк"
    if (track.shrinkRatio < 0.5) return null; // для "фейка" требуем более выраженное исчезновение
    const factors = {
      repeatability: Math.min(1, track.atLevel.length / (opts.minSnapshots || 20)), stability: 0.4,
      significance: Math.min(1, track.shrinkRatio), volume: Math.min(1, (track.shrunkQty * track.levelPrice) / 5000),
      deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const rawScore = scorePatternEvent(factors);
    const maxConfidence = 60; // честный потолок уверенности для эвристики без ground truth
    const cappedScore = Math.min(rawScore, maxConfidence);
    return {
      detectorKey: 'fakeLiquidity', direction: track.side === 'bid' ? 'SHORT' : 'LONG', // исчезла поддержка/сопротивление -> цена вероятнее пойдёт в сторону от неё
      repeatCount: track.atLevel.length, priceLevel: track.levelPrice,
      shrinkPct: Math.round(track.shrinkRatio * 1000) / 10, isHeuristic: true, maxConfidence: maxConfidence,
      priceAtSignal: track.levelPrice, scoreAtSignal: cappedScore, confidencePct: cappedScore, factors: factors
    };
  }

  // exhaustion: истощение импульса (ТЗ: "истощение") — после пика объёма КАЖДЫЙ следующий бакет
  // монотонно меньше предыдущего (не просто "объём упал один раз") вплоть до текущего момента.
  function detectExhaustion(trades, opts) {
    opts = opts || {};
    const bucketMs = opts.bucketMs || 10000;
    const minDecayBuckets = opts.minRepeats || 3;
    const lookback = opts.lookback || 300;
    if (!trades || trades.length < 30) return null;
    const recent = trades.slice(-lookback);
    const buckets = new Map();
    recent.forEach(function (t) {
      const b = Math.floor(t.t / bucketMs);
      let bk = buckets.get(b);
      if (!bk) { bk = { volume: 0, firstPrice: t.price, lastPrice: t.price, count: 0 }; buckets.set(b, bk); }
      bk.volume += t.price * t.qty; bk.lastPrice = t.price; bk.count++;
    });
    const bucketList = Array.from(buckets.values());
    const n = bucketList.length;
    if (n < 6) return null;

    let peakIdx = -1, peakVol = 0;
    for (let i = Math.max(0, n - 7); i < n - 1; i++) { if (bucketList[i].volume > peakVol) { peakVol = bucketList[i].volume; peakIdx = i; } }
    if (peakIdx === -1 || peakVol <= 0) return null;

    let decayCount = 0;
    for (let i = peakIdx + 1; i < n; i++) {
      if (bucketList[i].volume < bucketList[i - 1].volume) decayCount++;
      else break; // нарушение монотонности — не чистое затухание
    }
    const decayBuckets = n - 1 - peakIdx;
    if (decayCount < minDecayBuckets || decayCount < decayBuckets) return null;

    const lastBucket = bucketList[n - 1];
    const volumeDeclinePct = (peakVol - lastBucket.volume) / peakVol;
    const factors = {
      repeatability: Math.min(1, decayCount / 6), stability: 0.6, significance: Math.min(1, volumeDeclinePct),
      volume: Math.min(1, peakVol / 5000), deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'exhaustion', direction: 'BOTH', repeatCount: decayCount,
      volumeDeclinePct: Math.round(volumeDeclinePct * 1000) / 10, volumeUsd: Math.round(peakVol),
      priceAtSignal: lastBucket.lastPrice, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // zoneReturn: повторное возвращение цены к одной и той же зоне + реакция на каждом касании (ТЗ:
  // "повторяющаяся реакция цены на определённый объём/зону"). Зона — кластер локальных экстремумов
  // одного типа (минимумов ИЛИ максимумов) в пределах tolerance; реакция — движение в
  // противоположную сторону в ближайших сделках после каждого касания.
  function detectZoneReturn(trades, opts) {
    opts = opts || {};
    const tolerance = opts.tolerance || 0.005;
    const minRepeats = opts.minRepeats || 5;
    const lookback = opts.lookback || 300;
    const reactionWindow = opts.reactionWindow || 10;
    if (!trades || trades.length < 30) return null;
    const recent = trades.slice(-lookback);
    const prices = recent.map(function (t) { return t.price; });

    const extrema = [];
    for (let i = 2; i < prices.length - 2; i++) {
      const isMin = prices[i] <= prices[i - 1] && prices[i] <= prices[i - 2] && prices[i] <= prices[i + 1] && prices[i] <= prices[i + 2];
      const isMax = prices[i] >= prices[i - 1] && prices[i] >= prices[i - 2] && prices[i] >= prices[i + 1] && prices[i] >= prices[i + 2];
      if (isMin) extrema.push({ idx: i, price: prices[i], type: 'min' });
      else if (isMax) extrema.push({ idx: i, price: prices[i], type: 'max' });
    }
    if (extrema.length < minRepeats) return null;

    const mins = extrema.filter(function (e) { return e.type === 'min'; }).map(function (e) { return e.price; });
    const maxs = extrema.filter(function (e) { return e.type === 'max'; }).map(function (e) { return e.price; });
    const minCluster = mins.length > 1 ? findDominantCluster(mins, tolerance) : null;
    const maxCluster = maxs.length > 1 ? findDominantCluster(maxs, tolerance) : null;

    let zoneCluster = null, zoneType = null;
    if (minCluster && (!maxCluster || minCluster.count >= maxCluster.count)) { zoneCluster = minCluster; zoneType = 'min'; }
    else if (maxCluster) { zoneCluster = maxCluster; zoneType = 'max'; }
    if (!zoneCluster || zoneCluster.count < minRepeats) return null;

    const touches = extrema.filter(function (e) { return e.type === zoneType && e.price >= zoneCluster.min && e.price <= zoneCluster.max; });
    const reactions = touches.map(function (touch) {
      const after = recent.slice(touch.idx, Math.min(recent.length, touch.idx + reactionWindow));
      if (!after.length) return 0;
      const reactPrice = zoneType === 'min'
        ? Math.max.apply(null, after.map(function (t) { return t.price; }))
        : Math.min.apply(null, after.map(function (t) { return t.price; }));
      return touch.price > 0 ? Math.abs(reactPrice - touch.price) / touch.price : 0;
    });
    const avgReaction = median(reactions);
    if (avgReaction < 0.001) return null; // касания есть, но цена от зоны реально не отскакивает — нет реакции, нечего сообщать

    const widthRatio = (zoneCluster.max - zoneCluster.min) / Math.max(zoneCluster.representative, 1e-9);
    const stability = Math.max(0, 1 - widthRatio / tolerance);
    // Случайное блуждание тоже даёт локальные экстремумы, которые СЛУЧАЙНО кластеризуются иногда —
    // но кластер получается заметно менее плотным (widthRatio ближе к границе tolerance), чем у
    // настоящей повторно защищаемой зоны. Жёсткий гейт здесь, а не только полагание на итоговый
    // score/PATTERN_MIN_SCORE — тот же принцип, что у остальных детекторов (cyclicity/ladder/ershik):
    // detect() сам отказывается от результата, качество которого explicitly недостаточно, а не
    // возвращает технически non-null объект с низким score.
    if (stability < (opts.minStability != null ? opts.minStability : 0.6)) return null;
    const factors = {
      repeatability: Math.min(1, touches.length / 10), stability: stability,
      significance: Math.min(1, avgReaction / 0.01), volume: 0.5, deviation: 0.5, freshness: 1, confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'zoneReturn', direction: zoneType === 'min' ? 'LONG' : 'SHORT', repeatCount: touches.length,
      zonePrice: Math.round(zoneCluster.representative * 10000) / 10000,
      avgReactionPct: Math.round(avgReaction * 10000) / 100,
      priceAtSignal: recent[recent.length - 1].price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // standingWall: "стоящая плотность, которую скорее всего скоро пробьют" — В ОТЛИЧИЕ от
  // absorption/fakeLiquidity выше (которые смотрят НАЗАД: уровень уже усох, паттерн уже случился),
  // это ВПЕРЁД смотрящий сигнал — сама стена ещё стоит нетронутой в текущем снимке стакана, ищем её
  // ДО пробоя, а не постфактум. Определение "стены": уровень цены среди 20 видимых уровней, размер
  // которого заметно (minWallRatio раз) больше типичного (медианного) размера ОСТАЛЬНЫХ уровней той
  // же стороны книги — то есть настоящий выброс, а не просто "самый большой из примерно одинаковых".
  // "Скоро пробьют" — эвристика: считаем это правдоподобным только если (а) стена близко к текущей
  // цене (maxDistancePct — иначе тестировать её "скоро" некому) и (б) цена ЗАМЕТНО приближалась к
  // этому уровню на протяжении окна снимков (не разовый шум, устойчивый тренд сближения).
  function detectStandingWall(depthSnapshots, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 20;
    const minSnapshots = opts.minSnapshots || 10;
    const minWallRatio = opts.minWallRatio != null ? opts.minWallRatio : 3;
    const maxDistancePct = opts.maxDistancePct != null ? opts.maxDistancePct : 1.5;
    if (!depthSnapshots || depthSnapshots.length < minSnapshots) return null;
    const recent = depthSnapshots.slice(-lookback);
    const cur = recent[recent.length - 1];
    if (!cur.bestBid || !cur.bestAsk) return null;
    const midPrice = (cur.bestBid + cur.bestAsk) / 2;

    function findWall(levels) {
      if (!levels || levels.length < 4) return null;
      let best = null;
      for (let i = 0; i < levels.length; i++) {
        const others = [];
        for (let j = 0; j < levels.length; j++) { if (j !== i) others.push(levels[j].q); }
        const med = median(others);
        if (med <= 0) continue;
        const ratio = levels[i].q / med;
        if (!best || ratio > best.ratio) best = { p: levels[i].p, q: levels[i].q, ratio: ratio };
      }
      return best;
    }

    const bidWall = findWall(cur.bids);
    const askWall = findWall(cur.asks);
    const candidates = [];
    if (bidWall && bidWall.ratio >= minWallRatio) {
      const distPct = Math.abs(midPrice - bidWall.p) / midPrice * 100;
      if (distPct <= maxDistancePct) candidates.push({ side: 'bid', wall: bidWall, distPct: distPct });
    }
    if (askWall && askWall.ratio >= minWallRatio) {
      const distPct = Math.abs(askWall.p - midPrice) / midPrice * 100;
      if (distPct <= maxDistancePct) candidates.push({ side: 'ask', wall: askWall, distPct: distPct });
    }
    if (!candidates.length) return null;
    // Обе стороны могут одновременно иметь стену — берём ближайшую к цене (её раньше протестируют).
    candidates.sort(function (a, b) { return a.distPct - b.distPct; });
    const c = candidates[0];

    // "Приближение": среднее расстояние цена<->стена во второй половине окна снимков заметно (>=10%)
    // меньше, чем в первой половине — устойчивый тренд сближения, а не стена, которая просто давно
    // стоит без дела на постоянном расстоянии (к такой "скоро" не относится).
    const distSeries = [];
    for (let i = 0; i < recent.length; i++) {
      const s = recent[i];
      if (s.bestBid && s.bestAsk) distSeries.push(Math.abs((s.bestBid + s.bestAsk) / 2 - c.wall.p));
    }
    if (distSeries.length < minSnapshots) return null;
    const half = Math.floor(distSeries.length / 2);
    const avg = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; };
    const firstAvg = avg(distSeries.slice(0, half));
    const secondAvg = avg(distSeries.slice(half));
    const approaching = firstAvg > 0 && secondAvg < firstAvg * 0.9;
    if (!approaching) return null;

    const wallVolumeUsd = c.wall.q * c.wall.p;
    const factors = {
      repeatability: Math.min(1, recent.length / lookback), stability: 0.7,
      significance: Math.min(1, c.wall.ratio / 10), volume: Math.min(1, wallVolumeUsd / 20000),
      deviation: Math.min(1, (maxDistancePct - c.distPct) / maxDistancePct), freshness: 1,
      confirmation: 0, pastSuccess: 0
    };
    const score = scorePatternEvent(factors);
    return {
      detectorKey: 'standingWall',
      // Стена на ASK (сопротивление выше цены) пробита вверх -> продолжение вверх (LONG). Стена на
      // BID (поддержка ниже/у цены) пробита вниз -> продолжение вниз (SHORT). Тот же принцип
      // "пробой продолжается в сторону пробоя", что и у тиковой версии STRATEGY_DEFS.density.
      direction: c.side === 'ask' ? 'LONG' : 'SHORT',
      side: c.side, priceLevel: c.wall.p, wallRatio: Math.round(c.wall.ratio * 10) / 10,
      distancePct: Math.round(c.distPct * 100) / 100, volumeUsd: Math.round(wallVolumeUsd),
      priceAtSignal: midPrice, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ============================================================================
  // История паттернов и отслеживание исхода БЕЗ LOOK-AHEAD BIAS (ТЗ #9). Ключевой принцип:
  // scoreAtSignal/confidencePct у события ЗАМОРОЖЕНЫ в момент детекции (уже так — детекторы выше
  // считают их только по данным ДО detectedAt) и НИКОГДА не пересчитываются задним числом, когда
  // приходит outcome. outcome нужен ТОЛЬКО для (а) показа пользователю "что было дальше" и (б) как
  // вход для pastSuccess СЛЕДУЮЩИХ, ещё не случившихся событий — то есть будущее одного сигнала
  // может влиять только на прошлое-для-следующего-сигнала score, никогда на свой собственный.
  // ============================================================================
  const PATTERN_OUTCOME_CHECKPOINTS_S = [30, 120, 600, 1800]; // 30с / 2м / 10м / 30м

  // Чистый расчёт MFE/MAE (maximum favorable/adverse excursion) — приход цены relative к
  // priceAtSignal и direction сигнала, по массиву цен, НАБЛЮДАВШИХСЯ ПОСЛЕ сигнала (вызывающая
  // сторона сама отвечает за то, чтобы не передать сюда будущее относительно момента вызова).
  function computeOutcomeMetrics(priceAtSignal, direction, pricesSince) {
    if (!pricesSince || !pricesSince.length || !priceAtSignal) return null;
    let maxFav = 0, maxAdv = 0;
    pricesSince.forEach(function (p) {
      const movePct = (p - priceAtSignal) / priceAtSignal;
      if (direction === 'BOTH') {
        maxFav = Math.max(maxFav, Math.abs(movePct));
        maxAdv = Math.max(maxAdv, Math.abs(movePct));
      } else {
        const favMove = direction === 'SHORT' ? -movePct : movePct;
        if (favMove > maxFav) maxFav = favMove;
        if (-favMove > maxAdv) maxAdv = -favMove;
      }
    });
    return { maxFavorablePct: Math.round(maxFav * 10000) / 100, maxAdversePct: Math.round(maxAdv * 10000) / 100 };
  }

  // Дедупликация: один и тот же паттерн детектится каждый прогон (раз в PATTERN_DETECT_INTERVAL_MS),
  // пока условие держится — это ОДИН эпизод, а не новое событие каждые 2с. Новый эпизод начинается,
  // только если предыдущий не "виден" дольше graceMs (пропал из выдачи достаточно надолго).
  function shouldOpenNewPatternSession(lastSeenAt, now, graceMs) {
    graceMs = graceMs != null ? graceMs : 15000;
    return lastSeenAt == null || (now - lastSeenAt) > graceMs;
  }

  // Обрезка истории — тот же приём, что и у BALANCE_HISTORY_KEY в app.js (age-cutoff, потом cap по
  // символу, потом общий cap), не новая схема хранения.
  function prunePatternHistory(entries, opts) {
    opts = opts || {};
    const maxPerSymbol = opts.maxPerSymbol || 500;
    const maxTotal = opts.maxTotal || 5000;
    const maxAgeMs = opts.maxAgeMs || 30 * 24 * 3600 * 1000;
    const now = opts.now || Date.now();
    let filtered = (entries || []).filter(function (e) { return (now - e.detectedAt) <= maxAgeMs; });
    const bySymbol = new Map();
    filtered.forEach(function (e) {
      if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, []);
      bySymbol.get(e.symbol).push(e);
    });
    let result = [];
    bySymbol.forEach(function (arr) {
      arr.sort(function (a, b) { return a.detectedAt - b.detectedAt; });
      if (arr.length > maxPerSymbol) arr = arr.slice(arr.length - maxPerSymbol);
      result = result.concat(arr);
    });
    result.sort(function (a, b) { return a.detectedAt - b.detectedAt; });
    if (result.length > maxTotal) result = result.slice(result.length - maxTotal);
    return result;
  }

  // pastSuccess-фактор для НОВОГО, ещё не случившегося события: доля УЖЕ ЗАКРЫТЫХ (outcome[checkpointKey]
  // заполнен) прошлых событий ТОГО ЖЕ детектора, где движение оказалось в пользу направления сигнала
  // не меньше successThresholdPct. Вызывающая сторона обязана передать только события с
  // detectedAt < текущего момента — сам расчёт этого не проверяет (она чистая функция от входа).
  function computePastSuccessRate(historyEntries, detectorKey, opts) {
    opts = opts || {};
    const checkpointKey = opts.checkpointKey || 'at2m';
    const successThresholdPct = opts.successThresholdPct != null ? opts.successThresholdPct : 0.3;
    const relevant = (historyEntries || []).filter(function (e) {
      return e.detectorKey === detectorKey && e.outcome && e.outcome[checkpointKey] != null;
    });
    if (!relevant.length) return null;
    const successes = relevant.filter(function (e) { return e.outcome[checkpointKey].maxFavorablePct >= successThresholdPct; }).length;
    return { rate: successes / relevant.length, sampleSize: relevant.length };
  }

  // Простая train/test валидация против переобучения (ТЗ #15) — честная версия, достижимая без
  // исторического архива тика/стакана (его физически нет, см. план): "reference" = уже закрытые
  // события старше splitMs, "recent" = закрытые события младше splitMs — если оба набора достаточно
  // велики, а винрейт разошёлся заметно (>=degradeThreshold п.п.), это сигнал "детектор мог
  // переобучиться/устареть", явно показываемый пользователю, а не скрытый.
  function computeValidationSplit(historyEntries, detectorKey, opts) {
    opts = opts || {};
    const checkpointKey = opts.checkpointKey || 'at2m';
    const splitMs = opts.splitMs || 24 * 3600 * 1000;
    const now = opts.now || Date.now();
    const successThresholdPct = opts.successThresholdPct != null ? opts.successThresholdPct : 0.3;
    const degradeThreshold = opts.degradeThreshold != null ? opts.degradeThreshold : 0.2;
    const relevant = (historyEntries || []).filter(function (e) {
      return e.detectorKey === detectorKey && e.outcome && e.outcome[checkpointKey] != null;
    });
    const reference = relevant.filter(function (e) { return (now - e.detectedAt) > splitMs; });
    const recent = relevant.filter(function (e) { return (now - e.detectedAt) <= splitMs; });
    function summarize(arr) {
      if (!arr.length) return { rate: null, sampleSize: 0, avgMovePct: null };
      const successes = arr.filter(function (e) { return e.outcome[checkpointKey].maxFavorablePct >= successThresholdPct; }).length;
      const avgMove = arr.reduce(function (a, e) { return a + e.outcome[checkpointKey].maxFavorablePct; }, 0) / arr.length;
      return { rate: successes / arr.length, sampleSize: arr.length, avgMovePct: Math.round(avgMove * 100) / 100 };
    }
    const refSummary = summarize(reference);
    const recentSummary = summarize(recent);
    const degraded = refSummary.rate != null && recentSummary.rate != null && (refSummary.rate - recentSummary.rate) >= degradeThreshold;
    return { reference: refSummary, recent: recentSummary, degraded: degraded };
  }

  return {
    logRing: logRing,
    pushLogRing: pushLogRing,
    logD: logD,
    logI: logI,
    logW: logW,
    logE: logE,
    computeWatchlistTransitions: computeWatchlistTransitions,
    pushRing: pushRing,
    withRetry: withRetry,
    computeApiKeyFingerprint: computeApiKeyFingerprint,
    median: median,
    medianAbsoluteDeviation: medianAbsoluteDeviation,
    robustZScore: robustZScore,
    scorePatternEvent: scorePatternEvent,
    applyPatternScore: applyPatternScore,
    PATTERN_SCORE_WEIGHTS: PATTERN_SCORE_WEIGHTS,
    findDominantCluster: findDominantCluster,
    clusterSignificance: clusterSignificance,
    detectRepeatedTradeSizes: detectRepeatedTradeSizes,
    detectRepeatedIntervals: detectRepeatedIntervals,
    detectBurstNoFollowThrough: detectBurstNoFollowThrough,
    autocorrelation: autocorrelation,
    detectCyclicity: detectCyclicity,
    detectRepeatingSequence: detectRepeatingSequence,
    detectLadder: detectLadder,
    detectErshik: detectErshik,
    detectImbalance: detectImbalance,
    detectAbsorption: detectAbsorption,
    detectFakeLiquidity: detectFakeLiquidity,
    detectExhaustion: detectExhaustion,
    detectZoneReturn: detectZoneReturn,
    detectStandingWall: detectStandingWall,
    computeOutcomeMetrics: computeOutcomeMetrics,
    shouldOpenNewPatternSession: shouldOpenNewPatternSession,
    prunePatternHistory: prunePatternHistory,
    computePastSuccessRate: computePastSuccessRate,
    computeValidationSplit: computeValidationSplit,
    PATTERN_OUTCOME_CHECKPOINTS_S: PATTERN_OUTCOME_CHECKPOINTS_S
  };
});
