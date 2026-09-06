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
  // weights — опциональный альтернативный набор весов (по умолчанию PATTERN_SCORE_WEIGHTS выше,
  // используемый всеми 13 исходными детекторами без изменений). Новые алгоритмы плотности/импульса
  // (см. ALGO_SCORE_WEIGHTS ниже) используют другой, явно запрошенный пользователем словарь
  // факторов (context/trigger/flow/orderbook/volume/history) — та же формула клампа и взвешенной
  // суммы, просто другой набор имён/весов, а не отдельная параллельная система скоринга.
  function scorePatternEvent(f, weights) {
    f = f || {};
    weights = weights || PATTERN_SCORE_WEIGHTS;
    let score = 0;
    Object.keys(weights).forEach(function (k) {
      const v = Math.max(0, Math.min(1, f[k] || 0));
      score += v * weights[k];
    });
    return Math.round(score * 100);
  }

  // Пересчитывает scoreAtSignal/confidencePct события ИЗ ЕГО ЖЕ факторов (например, после того как
  // выставлен factors.confirmation или factors.pastSuccess) — ЕДИНАЯ точка пересчёта, которая
  // уважает ev.maxConfidence, если он есть (см. detectFakeLiquidity — эвристика без ground truth
  // держит честный потолок уверенности; без единой функции для пересчёта легко забыть про этот
  // потолок в одном из мест, где score пересчитывается заново — что и произошло на практике до
  // выделения этой функции, см. app.js). Мутирует ev на месте и возвращает итоговый score.
  function applyPatternScore(ev, weights) {
    const raw = scorePatternEvent(ev.factors, weights);
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
  // FEATURE ENGINE + расширенный набор алгоритмов микроструктуры (Phase 1 плана "АЛГОРИТМЫ").
  // Общий принцип: вместо того чтобы каждый алгоритм заново сканировал сырые trades/depthSnapshots
  // по кругу, статистически насыщенные алгоритмы (inefficiency/pump-dump-reversal/compression)
  // используют ОДИН общий расчёт признаков (computeFeatures) — z-score/percentile всегда против
  // СОБСТВЕННОЙ истории монеты (median/MAD/robustZScore выше), никогда фиксированных чисел.
  // Структурные алгоритмы (density break/absorption, liquidity sweep, impulse-pullback,
  // failed breakout) сканируют окно напрямую — им нужны специфичные, не переиспользуемые под-окна
  // (early/late часть окна, отдельные фазы импульса), так что протаскивать их через общий feature-
  // объект не упростило бы код, только усложнило бы читаемость — тот же выбор архитектуры, что и
  // у существующих 13 детекторов (каждый сам решает, что именно ему нужно из буфера).
  // ============================================================================

  // Общий словарь весов для НОВЫХ алгоритмов ниже (ТЗ: "Context 20, Trigger 25, Flow 20,
  // Orderbook 15, Volume 10, History 10" — ровно предложенный пользователем пример, применяется
  // единообразно ко всем 10, а не изобретается заново под каждый). Существующие 13 детекторов
  // продолжают использовать PATTERN_SCORE_WEIGHTS — ни один из них не тронут.
  const ALGO_SCORE_WEIGHTS = {
    context: 0.20, trigger: 0.25, flow: 0.20, orderbook: 0.15, volume: 0.10, history: 0.10
  };

  // Последняя цена сделки на момент времени targetT или раньше (для честного returns/velocity —
  // никогда не заглядывает вперёд). null, если буфер не покрывает так далеко назад.
  function priceAtOrBeforeArr(trades, targetT) {
    for (let i = trades.length - 1; i >= 0; i--) { if (trades[i].t <= targetT) return trades[i].price; }
    return null;
  }

  // Находит "стену" — уровень стакана, чей размер заметно (minWallRatio раз) больше медианного
  // размера ОСТАЛЬНЫХ уровней той же стороны книги в ОДНОМ снимке. Тот же принцип, что и
  // приватный findWall внутри detectStandingWall выше, вынесен отдельно (не трогая уже
  // протестированный detectStandingWall), чтобы density-алгоритмы ниже могли применять его к
  // ЛЮБОМУ снимку окна (не только последнему) — начало окна для контекста, конец для триггера.
  function findLevelWall(levels, minWallRatio) {
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
    if (best && best.ratio >= minWallRatio) return best;
    return null;
  }

  // computeFeatures(trades, depthSnapshots, now) — чистая функция, никакого состояния между
  // вызовами. trades/depthSnapshots — те же ring-буферы, что читают все детекторы (см. их шапку
  // выше). Любое поле, которое честно нельзя посчитать (буфер не покрывает нужное окно назад),
  // остаётся null — НИКОГДА не подставляется правдоподобная выдумка вместо реального "нет данных".
  const FEATURE_RETURN_WINDOWS_S = [1, 3, 5, 10, 30, 60, 300];
  function computeFeatures(trades, depthSnapshots, now) {
    const result = { now: now, returns: {} };
    if (!trades || trades.length < 2) return result;
    now = now || trades[trades.length - 1].t;
    result.now = now;
    const lastPrice = trades[trades.length - 1].price;
    result.last_price = lastPrice;

    FEATURE_RETURN_WINDOWS_S.forEach(function (s) {
      const p = priceAtOrBeforeArr(trades, now - s * 1000);
      result.returns[s] = (p != null && p > 0) ? (lastPrice - p) / p : null;
    });
    result.price_velocity = result.returns[5] != null ? result.returns[5] / 5 : null;
    result.price_acceleration = (result.price_velocity != null && result.returns[10] != null)
      ? result.price_velocity - (result.returns[10] / 10) : null;

    const windowMs = 60000;
    const windowTrades = trades.filter(function (t) { return t.t >= now - windowMs; });
    let buyVol = 0, sellVol = 0;
    const sizesUsd = [];
    windowTrades.forEach(function (t) {
      const usd = t.price * t.qty;
      sizesUsd.push(usd);
      if (t.side === 'buy') buyVol += usd; else sellVol += usd;
    });
    const totalVol = buyVol + sellVol;
    result.buy_volume = buyVol; result.sell_volume = sellVol;
    result.trade_count = windowTrades.length;
    result.average_trade_size = windowTrades.length ? totalVol / windowTrades.length : 0;
    result.delta = buyVol - sellVol;
    result.ofi = totalVol > 1e-9 ? (buyVol - sellVol) / totalVol : 0;
    result.buy_sell_ratio = sellVol > 1e-9 ? buyVol / sellVol : (buyVol > 0 ? null : 1);
    if (sizesUsd.length >= 10) {
      const sorted = sizesUsd.slice().sort(function (a, b) { return a - b; });
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      const largeVol = sizesUsd.filter(function (v) { return v >= p90; }).reduce(function (a, b) { return a + b; }, 0);
      result.large_trade_ratio = totalVol > 1e-9 ? largeVol / totalVol : 0;
    } else result.large_trade_ratio = null;

    const half = now - windowMs / 2;
    let firstDelta = 0, secondDelta = 0;
    windowTrades.forEach(function (t) {
      const signed = (t.side === 'buy' ? 1 : -1) * t.price * t.qty;
      if (t.t < half) firstDelta += signed; else secondDelta += signed;
    });
    result.delta_velocity = (secondDelta - firstDelta) / (windowMs / 2 / 1000);

    function volatilityOver(ms) {
      const w = trades.filter(function (t) { return t.t >= now - ms; }).map(function (t) { return t.price; });
      if (w.length < 3) return null;
      const mx = Math.max.apply(null, w), mn = Math.min.apply(null, w), med = median(w);
      return med > 0 ? (mx - mn) / med : null;
    }
    result.volatility_5s = volatilityOver(5000);
    result.volatility_30s = volatilityOver(30000);
    result.volatility_60s = volatilityOver(60000);

    // Перцентиль ТЕКУЩЕЙ 30с-волатильности против скользящей истории этой же метрики, посчитанной
    // по всему доступному буферу этой монеты — вместо фиксированного "vol < 1%".
    const bufStart = trades[0].t;
    const volHistory = [];
    for (let ts = bufStart + 30000; ts <= now; ts += 30000) {
      const w = trades.filter(function (t) { return t.t >= ts - 30000 && t.t <= ts; }).map(function (t) { return t.price; });
      if (w.length >= 3) {
        const mx = Math.max.apply(null, w), mn = Math.min.apply(null, w), med = median(w);
        if (med > 0) volHistory.push((mx - mn) / med);
      }
    }
    if (volHistory.length >= 5 && result.volatility_30s != null) {
      const below = volHistory.filter(function (v) { return v <= result.volatility_30s; }).length;
      result.volatility_percentile = below / volHistory.length;
    } else result.volatility_percentile = null;

    // relative_volume/volume_zscore: текущий 60с-объём против скользящей истории 60с-объёмов ЭТОЙ монеты.
    const volVolHistory = [];
    for (let ts = bufStart + 60000; ts <= now; ts += 30000) {
      const w = trades.filter(function (t) { return t.t >= ts - 60000 && t.t <= ts; });
      volVolHistory.push(w.reduce(function (a, t) { return a + t.price * t.qty; }, 0));
    }
    if (volVolHistory.length >= 5) {
      result.relative_volume = median(volVolHistory) > 0 ? totalVol / median(volVolHistory) : null;
      result.volume_zscore = robustZScore(totalVol, volVolHistory);
    } else { result.relative_volume = null; result.volume_zscore = null; }

    if (depthSnapshots && depthSnapshots.length) {
      const curD = depthSnapshots[depthSnapshots.length - 1];
      result.spread = (curD.bestBid != null && curD.bestAsk != null) ? curD.bestAsk - curD.bestBid : null;
      result.spread_bps = (result.spread != null && curD.bestBid > 0) ? (result.spread / curD.bestBid) * 10000 : null;
      function depthSum(levels, n) { return (levels || []).slice(0, n).reduce(function (a, l) { return a + l.q; }, 0); }
      function obi(bd, ad) { const t = bd + ad; return t > 1e-9 ? (bd - ad) / t : 0; }
      result.bid_depth_L1 = depthSum(curD.bids, 1); result.ask_depth_L1 = depthSum(curD.asks, 1);
      result.bid_depth_L5 = depthSum(curD.bids, 5); result.ask_depth_L5 = depthSum(curD.asks, 5);
      result.bid_depth_L10 = depthSum(curD.bids, 10); result.ask_depth_L10 = depthSum(curD.asks, 10);
      result.bid_depth_L20 = depthSum(curD.bids, 20); result.ask_depth_L20 = depthSum(curD.asks, 20);
      result.obi_L1 = obi(result.bid_depth_L1, result.ask_depth_L1);
      result.obi_L5 = obi(result.bid_depth_L5, result.ask_depth_L5);
      result.obi_L10 = obi(result.bid_depth_L10, result.ask_depth_L10);
      result.obi_L20 = obi(result.bid_depth_L20, result.ask_depth_L20);
      result.microprice = (curD.bidVol + curD.askVol > 1e-9 && curD.bestBid != null && curD.bestAsk != null)
        ? (curD.bestBid * curD.askVol + curD.bestAsk * curD.bidVol) / (curD.bidVol + curD.askVol) : null;
      if (depthSnapshots.length >= 6) {
        const prev = depthSnapshots[depthSnapshots.length - 4];
        const prevObi = obi(depthSum(prev.bids, 10), depthSum(prev.asks, 10));
        result.obi_velocity = result.obi_L10 - prevObi;
      } else result.obi_velocity = null;
      if (depthSnapshots.length >= 2) {
        const prevD = depthSnapshots[depthSnapshots.length - 2];
        result.bid_liquidity_delta = curD.bidVol - prevD.bidVol;
        result.ask_liquidity_delta = curD.askVol - prevD.askVol;
      } else { result.bid_liquidity_delta = null; result.ask_liquidity_delta = null; }
    }

    result.data_age_ms = now - trades[trades.length - 1].t;
    result.depth_age_ms = (depthSnapshots && depthSnapshots.length) ? now - depthSnapshots[depthSnapshots.length - 1].t : null;
    return result;
  }

  // Простой, честный market-regime tag (ТЗ: TRENDING/RANGING/HIGH_VOLATILITY/LOW_VOLATILITY/
  // ILLIQUID). НЕ используется пока для изменения live-скоринга (см. план, "Deferred") — только
  // помечает событие для последующей регим-разрезанной валидации, когда накопится история.
  function classifyRegime(trades, features) {
    if (!features || !features.trade_count) return 'UNKNOWN';
    if (features.relative_volume != null && features.relative_volume < 0.3) return 'ILLIQUID';
    if (features.volatility_percentile != null) {
      if (features.volatility_percentile >= 0.85) return 'HIGH_VOLATILITY';
      if (features.volatility_percentile <= 0.15) return 'LOW_VOLATILITY';
    }
    const now = features.now;
    const w = (trades || []).filter(function (t) { return t.t >= now - 60000; });
    if (w.length < 5) return 'UNKNOWN';
    let netMove = 0, absMove = 0;
    for (let i = 1; i < w.length; i++) { const d = w[i].price - w[i - 1].price; netMove += d; absMove += Math.abs(d); }
    const trendiness = absMove > 1e-12 ? Math.abs(netMove) / absMove : 0;
    return trendiness >= 0.35 ? 'TRENDING' : 'RANGING';
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #1 — DENSITY_BREAK
  // CONTEXT: крупная стена найдена в начале окна снимков. TRIGGER: та же стена заметно усохла к
  // концу окна. CONFIRMATION: исполненный объём в сторону пробоя корреспондирует усохшему объёму
  // (отличает "съели сделками" от "просто сняли" — та же проверка, что у absorption/fakeLiquidity),
  // и цена уже по ту сторону уровня. INVALIDATION: последние сделки идут против пробоя — событие
  // не выдаётся вовсе (не постфактум помечается, а просто не детектируется, тот же принцип, что и
  // у существующих детекторов).
  // ------------------------------------------------------------------------------------------
  function detectDensityBreak(depthSnapshots, trades, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 300;
    const minSnapshots = opts.minSnapshots || 30;
    const minWallRatio = opts.minWallRatio != null ? opts.minWallRatio : 5;
    const minShrinkRatio = opts.minShrinkRatio != null ? opts.minShrinkRatio : 0.5;
    const priceTolerance = opts.priceTolerance || 0.002;
    if (!depthSnapshots || depthSnapshots.length < minSnapshots) return null;
    const recent = depthSnapshots.slice(-lookback);
    if (recent.length < minSnapshots) return null;

    const earlyCount = Math.max(3, Math.floor(recent.length / 3));
    const early = recent.slice(0, earlyCount);
    let bestWall = null;
    ['bids', 'asks'].forEach(function (bookKey) {
      const side = bookKey === 'bids' ? 'bid' : 'ask';
      early.forEach(function (snap) {
        const w = findLevelWall(snap[bookKey], minWallRatio);
        if (w && (!bestWall || w.ratio > bestWall.ratio)) bestWall = { side: side, price: w.p, initialQty: w.q, ratio: w.ratio };
      });
    });
    if (!bestWall) return null;

    const bookKey = bestWall.side === 'bid' ? 'bids' : 'asks';
    const lateWindow = recent.slice(-Math.max(3, Math.floor(recent.length / 4)));
    // Ищем БЛИЖАЙШИЙ по цене уровень, а не первый попавшийся в пределах priceTolerance — на
    // мелкоценовых монетах шаг между уровнями стакана может быть заметно МЕНЬШЕ priceTolerance
    // (0.2%), и тогда "первый в допуске" почти всегда оказывается совсем НЕ тем уровнем, что нужно
    // (соседним, с обычным размером) — именно так проявился реальный баг здесь при тестировании.
    function qtyAtLevel(snap) {
      const levels = snap[bookKey] || [];
      let best = null, bestDist = Infinity;
      for (let i = 0; i < levels.length; i++) {
        const d = Math.abs(levels[i].p - bestWall.price);
        if (d < bestDist) { bestDist = d; best = levels[i]; }
      }
      return (best && bestDist / bestWall.price <= priceTolerance) ? best.q : 0;
    }
    const endQty = median(lateWindow.map(qtyAtLevel));
    const shrinkRatio = bestWall.initialQty > 0 ? (bestWall.initialQty - endQty) / bestWall.initialQty : 0;
    if (shrinkRatio < minShrinkRatio) return null;

    const cur = recent[recent.length - 1];
    if (!cur.bestBid || !cur.bestAsk) return null;
    const price = (cur.bestBid + cur.bestAsk) / 2;
    const crossed = bestWall.side === 'ask' ? price > bestWall.price : price < bestWall.price;
    if (!crossed) return null;

    const t0 = early[early.length - 1].t, t1 = cur.t;
    const breakoutSide = bestWall.side === 'ask' ? 'buy' : 'sell';
    const nearbyTrades = (trades || []).filter(function (tr) { return tr.t >= t0 && tr.t <= t1 && Math.abs(tr.price - bestWall.price) / bestWall.price <= priceTolerance * 3; });
    const executedInDirection = nearbyTrades.filter(function (tr) { return tr.side === breakoutSide; }).reduce(function (a, tr) { return a + tr.qty; }, 0);
    const executedTotal = nearbyTrades.reduce(function (a, tr) { return a + tr.qty; }, 0);
    const shrunkQty = bestWall.initialQty - endQty;
    const eatenRatio = shrunkQty > 0 ? Math.min(1, executedInDirection / shrunkQty) : 0;
    if (eatenRatio < 0.25) return null; // мало подтверждающих сделок — похоже на снятие заявки, не на пробой потоком

    const lastTrades = (trades || []).slice(-8);
    if (lastTrades.length >= 4) {
      const moved = lastTrades[lastTrades.length - 1].price - lastTrades[0].price;
      const movedAgainst = bestWall.side === 'ask' ? moved < 0 : moved > 0;
      if (movedAgainst) return null; // немедленный откат назад через уровень — не устойчивый пробой
    }

    const volumeUsd = executedInDirection * bestWall.price;
    const factors = {
      context: Math.min(1, bestWall.ratio / 10),
      trigger: Math.min(1, shrinkRatio),
      flow: eatenRatio,
      orderbook: executedTotal > 0 ? Math.min(1, executedInDirection / executedTotal) : 0.5,
      volume: Math.min(1, volumeUsd / 20000),
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'densityBreak', direction: bestWall.side === 'ask' ? 'LONG' : 'SHORT',
      side: bestWall.side, priceLevel: bestWall.price, wallRatio: Math.round(bestWall.ratio * 10) / 10,
      shrinkPct: Math.round(shrinkRatio * 1000) / 10, eatenRatioPct: Math.round(eatenRatio * 1000) / 10,
      volumeUsd: Math.round(volumeUsd), priceAtSignal: price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #2 — DENSITY_ABSORPTION
  // Возвращает СОСТОЯНИЕ (ABSORBING/HOLDING/BREAKING/REJECTED), а не автоматический сигнал —
  // спецификация явно требует не выдавать LONG только потому, что появилась абсорбция.
  // ------------------------------------------------------------------------------------------
  function detectDensityAbsorption(depthSnapshots, trades, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 300;
    const minSnapshots = opts.minSnapshots || 30;
    const minWallRatio = opts.minWallRatio != null ? opts.minWallRatio : 5;
    const priceTolerance = opts.priceTolerance || 0.002;
    const minAbsorptionRatio = opts.minAbsorptionRatio != null ? opts.minAbsorptionRatio : 3;
    const maxDistancePct = opts.maxDistancePct != null ? opts.maxDistancePct : 1.5;
    if (!depthSnapshots || depthSnapshots.length < minSnapshots) return null;
    const recent = depthSnapshots.slice(-lookback);
    const cur = recent[recent.length - 1];
    if (!cur.bestBid || !cur.bestAsk) return null;
    const price = (cur.bestBid + cur.bestAsk) / 2;

    const earlyCount = Math.max(3, Math.floor(recent.length / 3));
    const early = recent.slice(0, earlyCount);
    let bestWall = null;
    ['bids', 'asks'].forEach(function (bookKey) {
      const side = bookKey === 'bids' ? 'bid' : 'ask';
      early.forEach(function (snap) {
        const w = findLevelWall(snap[bookKey], minWallRatio);
        if (w && (!bestWall || w.ratio > bestWall.ratio)) bestWall = { side: side, price: w.p, initialQty: w.q };
      });
    });
    if (!bestWall) return null;
    const distPct = Math.abs(price - bestWall.price) / price * 100;
    if (distPct > maxDistancePct) return null;

    const bookKey = bestWall.side === 'bid' ? 'bids' : 'asks';
    // Ближайший уровень, не первый в допуске — тот же баг/фикс, что и в detectDensityBreak выше.
    function qtyAtLevel(snap) {
      const levels = snap[bookKey] || [];
      let best = null, bestDist = Infinity;
      for (let i = 0; i < levels.length; i++) {
        const d = Math.abs(levels[i].p - bestWall.price);
        if (d < bestDist) { bestDist = d; best = levels[i]; }
      }
      return (best && bestDist / bestWall.price <= priceTolerance) ? best.q : 0;
    }
    const currentQty = qtyAtLevel(cur);
    const remainingRatio = bestWall.initialQty > 0 ? currentQty / bestWall.initialQty : 0;

    const windowStartT = early[early.length - 1].t;
    const aggressiveSide = bestWall.side === 'ask' ? 'buy' : 'sell';
    const nearbyTrades = (trades || []).filter(function (tr) { return tr.t >= windowStartT && Math.abs(tr.price - bestWall.price) / bestWall.price <= priceTolerance * 3; });
    const aggressiveVolumeUsd = nearbyTrades.filter(function (tr) { return tr.side === aggressiveSide; }).reduce(function (a, tr) { return a + tr.price * tr.qty; }, 0);
    if (aggressiveVolumeUsd <= 0) return null;
    // avgTradeUsd — типичный размер сделки ЭТОЙ монеты по ВСЕМ сделкам буфера, а не только по
    // nearbyTrades: если бы считали только по nearbyTrades, это было бы самоссылочно — крошечные
    // сделки у стены сами задавали бы себе крошечный "типичный" размер и всегда бы проходили
    // порог. Именно эта самоссылочность и была реальным багом при тестировании.
    const avgTradeUsd = (trades && trades.length) ? median(trades.map(function (tr) { return tr.price * tr.qty; })) : 0;
    if (avgTradeUsd <= 0 || aggressiveVolumeUsd < avgTradeUsd * 15) return null; // "$10 на монете с дневным объёмом $1М" — не событие

    const priceAtWindowStart = (early[0].bestBid && early[0].bestAsk) ? (early[0].bestBid + early[0].bestAsk) / 2 : price;
    const priceProgressPct = priceAtWindowStart > 0 ? Math.abs(price - priceAtWindowStart) / priceAtWindowStart : 0;
    const absorptionRatio = (aggressiveVolumeUsd / avgTradeUsd) / Math.max(priceProgressPct * 1000, 0.05);
    if (absorptionRatio < minAbsorptionRatio) return null;

    let state;
    if (remainingRatio <= 0.2) state = 'BREAKING';
    else if (priceProgressPct >= (opts.rejectMovePct || 0.003)) state = 'REJECTED';
    else state = remainingRatio >= 0.7 ? 'ABSORBING' : 'HOLDING';

    const factors = {
      context: Math.max(0, Math.min(1, (maxDistancePct - distPct) / maxDistancePct)),
      trigger: Math.min(1, absorptionRatio / (minAbsorptionRatio * 3)),
      flow: Math.min(1, aggressiveVolumeUsd / (avgTradeUsd * 60)),
      orderbook: 1 - remainingRatio,
      volume: Math.min(1, aggressiveVolumeUsd / 20000),
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'densityAbsorption', direction: bestWall.side === 'ask' ? 'LONG' : 'SHORT', state: state,
      side: bestWall.side, priceLevel: bestWall.price, remainingLiquidityRatioPct: Math.round(remainingRatio * 1000) / 10,
      absorptionRatio: Math.round(absorptionRatio * 10) / 10, volumeUsd: Math.round(aggressiveVolumeUsd),
      priceAtSignal: price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #3 — LIQUIDITY_SWEEP
  // LIQUIDITY TAKEN + EXTREME + FLOW EXHAUSTION + RECLAIM. Обычный продолжающийся дамп/памп
  // исключается требованием, что пробитый экстремум ПЕРЕСТАЛ обновляться.
  // ------------------------------------------------------------------------------------------
  function detectLiquiditySweep(trades, depthSnapshots, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 200;
    const extremeWindowMs = opts.extremeWindowMs || 120000;
    const reclaimWindowMs = opts.reclaimWindowMs || 20000;
    if (!trades || trades.length < 30) return null;
    const recent = trades.slice(-lookback);
    const now = recent[recent.length - 1].t;

    const priorTrades = recent.filter(function (t) { return t.t < now - reclaimWindowMs && t.t >= now - extremeWindowMs; });
    if (priorTrades.length < 10) return null;
    const localLow = Math.min.apply(null, priorTrades.map(function (t) { return t.price; }));
    const localHigh = Math.max.apply(null, priorTrades.map(function (t) { return t.price; }));

    const recentTrades = recent.filter(function (t) { return t.t >= now - reclaimWindowMs; });
    if (recentTrades.length < 5) return null;
    const minRecent = Math.min.apply(null, recentTrades.map(function (t) { return t.price; }));
    const maxRecent = Math.max.apply(null, recentTrades.map(function (t) { return t.price; }));

    let side = null;
    if (minRecent < localLow) side = 'LONG';
    else if (maxRecent > localHigh) side = 'SHORT';
    if (!side) return null;

    const sweptLevel = side === 'LONG' ? localLow : localHigh;
    const currentPrice = recentTrades[recentTrades.length - 1].price;
    const reclaimed = side === 'LONG' ? currentPrice > sweptLevel : currentPrice < sweptLevel;
    if (!reclaimed) return null;

    const extremeVal = side === 'LONG' ? minRecent : maxRecent;
    const afterSweepIdx = recentTrades.findIndex(function (t) { return t.price === extremeVal; });
    const afterSweep = recentTrades.slice(afterSweepIdx + 1);
    const extremeUpdated = afterSweep.some(function (t) { return side === 'LONG' ? t.price <= minRecent : t.price >= maxRecent; });
    if (extremeUpdated) return null; // экстремум продолжает обновляться — обычный тренд/дамп, не sweep

    const sweepingSide = side === 'LONG' ? 'sell' : 'buy';
    const half = Math.floor(recentTrades.length / 2);
    const firstHalfFlow = recentTrades.slice(0, half).filter(function (t) { return t.side === sweepingSide; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const secondHalfFlow = recentTrades.slice(half).filter(function (t) { return t.side === sweepingSide; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    if (firstHalfFlow <= 0) return null;
    const exhaustionRatio = 1 - Math.min(1, secondHalfFlow / firstHalfFlow);
    if (exhaustionRatio < 0.4) return null;

    const range = Math.max(localHigh - localLow, 1e-9);
    const reclaimPct = Math.abs(currentPrice - sweptLevel) / range;
    const volumeUsd = recentTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const factors = {
      context: Math.min(1, priorTrades.length / 30),
      trigger: Math.min(1, Math.abs(sweptLevel - extremeVal) / range * 5),
      flow: exhaustionRatio,
      orderbook: 0.5,
      volume: Math.min(1, volumeUsd / 5000),
      history: 0
    };
    if (depthSnapshots && depthSnapshots.length >= 2) {
      const curD = depthSnapshots[depthSnapshots.length - 1];
      const beforeD = depthSnapshots[0];
      const sideKey = side === 'LONG' ? 'bidVol' : 'askVol';
      if (beforeD[sideKey] != null && curD[sideKey] != null && beforeD[sideKey] > 0) {
        factors.orderbook = Math.max(0, Math.min(1, curD[sideKey] / beforeD[sideKey] - 0.5));
      }
    }
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'liquiditySweep', direction: side, sweptLevel: sweptLevel,
      reclaimPct: Math.round(reclaimPct * 1000) / 10, exhaustionRatioPct: Math.round(exhaustionRatio * 1000) / 10,
      volumeUsd: Math.round(volumeUsd), priceAtSignal: currentPrice, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #4 — IMPULSE_PULLBACK_CONTINUATION
  // Трёхфазный скан ОДНОГО окна: impulse -> pullback -> continuation. Сигнал только на фазе
  // continuation — никогда в момент самого импульса.
  // ------------------------------------------------------------------------------------------
  function detectImpulsePullbackContinuation(trades, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 300;
    const impulseWindowMs = opts.impulseWindowMs || 30000;
    const pullbackWindowMs = opts.pullbackWindowMs || 60000;
    const continuationWindowMs = opts.continuationWindowMs || 30000;
    if (!trades || trades.length < 40) return null;
    const recent = trades.slice(-lookback);
    const now = recent[recent.length - 1].t;

    const continuationTrades = recent.filter(function (t) { return t.t >= now - continuationWindowMs; });
    const pullbackTrades = recent.filter(function (t) { return t.t >= now - continuationWindowMs - pullbackWindowMs && t.t < now - continuationWindowMs; });
    const impulseTrades = recent.filter(function (t) { return t.t >= now - continuationWindowMs - pullbackWindowMs - impulseWindowMs && t.t < now - continuationWindowMs - pullbackWindowMs; });
    if (impulseTrades.length < 8 || pullbackTrades.length < 5 || continuationTrades.length < 5) return null;

    const impulseMove = impulseTrades[impulseTrades.length - 1].price - impulseTrades[0].price;
    if (Math.abs(impulseMove) < 1e-12) return null;
    const direction = impulseMove > 0 ? 'LONG' : 'SHORT';
    const impulseVolume = impulseTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const impulseSide = direction === 'LONG' ? 'buy' : 'sell';
    const impulseFlow = impulseTrades.filter(function (t) { return t.side === impulseSide; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    if (impulseVolume <= 0 || impulseFlow / impulseVolume < 0.55) return null;

    const pullbackMove = pullbackTrades[pullbackTrades.length - 1].price - pullbackTrades[0].price;
    const pullbackAgainstImpulse = direction === 'LONG' ? pullbackMove < 0 : pullbackMove > 0;
    if (!pullbackAgainstImpulse) return null;
    const pullbackRatio = Math.abs(pullbackMove) / Math.abs(impulseMove);
    if (pullbackRatio >= 1) return null;
    const pullbackVolume = pullbackTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const impulseRate = impulseVolume / (impulseWindowMs / 1000);
    const pullbackRate = pullbackVolume / (pullbackWindowMs / 1000);
    if (pullbackRate > impulseRate) return null;
    const oppositeSide = direction === 'LONG' ? 'sell' : 'buy';
    const pullbackOppositeFlow = pullbackTrades.filter(function (t) { return t.side === oppositeSide; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    if (pullbackVolume > 0 && pullbackOppositeFlow / pullbackVolume >= 0.7) return null;

    const pullbackExtreme = direction === 'LONG'
      ? Math.min.apply(null, pullbackTrades.map(function (t) { return t.price; }))
      : Math.max.apply(null, pullbackTrades.map(function (t) { return t.price; }));
    const continuationPrice = continuationTrades[continuationTrades.length - 1].price;
    const brokeOut = direction === 'LONG'
      ? continuationPrice > pullbackExtreme + Math.abs(impulseMove) * 0.05
      : continuationPrice < pullbackExtreme - Math.abs(impulseMove) * 0.05;
    if (!brokeOut) return null;
    const continuationVolume = continuationTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const continuationFlow = continuationTrades.filter(function (t) { return t.side === impulseSide; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    if (continuationVolume <= 0 || continuationFlow / continuationVolume < 0.55) return null;

    const factors = {
      context: Math.min(1, impulseFlow / impulseVolume),
      trigger: Math.min(1, 1 - pullbackRatio),
      flow: Math.min(1, continuationFlow / continuationVolume),
      orderbook: 0.5,
      volume: Math.min(1, continuationVolume / 5000),
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'impulsePullbackContinuation', direction: direction,
      impulseMovePct: Math.round(impulseMove / impulseTrades[0].price * 10000) / 100,
      pullbackRatioPct: Math.round(pullbackRatio * 1000) / 10,
      volumeUsd: Math.round(continuationVolume), priceAtSignal: continuationPrice,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #5 — PRICE_VOLUME_INEFFICIENCY
  // price_zscore/volume_zscore против СОБСТВЕННОЙ истории монеты (не фикс. %). direction остаётся
  // LONG/SHORT (для единообразия с остальными детекторами/UI), классификация
  // BULLISH/BEARISH/REVERSION_CANDIDATE — в отдельном поле inefficiencyType.
  // ------------------------------------------------------------------------------------------
  function detectPriceVolumeInefficiency(trades, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 400;
    const minPriceZ = opts.minPriceZ != null ? opts.minPriceZ : 2;
    const maxVolumeZ = opts.maxVolumeZ != null ? opts.maxVolumeZ : 0.5;
    if (!trades || trades.length < 40) return null;
    const recent = trades.slice(-lookback);
    const now = recent[recent.length - 1].t;
    const features = computeFeatures(recent, null, now);
    if (features.returns[30] == null || features.volume_zscore == null) return null;

    const stepMs = 15000, winMs = 30000;
    const bufStart = recent[0].t;
    const moveHistory = [];
    for (let ts = bufStart + winMs; ts <= now; ts += stepMs) {
      const before = priceAtOrBeforeArr(recent, ts - winMs);
      const at = priceAtOrBeforeArr(recent, ts);
      if (before != null && at != null && before > 0) moveHistory.push((at - before) / before);
    }
    if (moveHistory.length < 8) return null;
    const currentMove = features.returns[30];
    const priceZ = robustZScore(currentMove, moveHistory);
    if (Math.abs(priceZ) < minPriceZ) return null;
    if (features.volume_zscore > maxVolumeZ) return null; // объём и так подтверждает движение — не неэффективность

    let inefficiencyType = currentMove > 0 ? 'BULLISH' : 'BEARISH';
    if (opts.absorptionAgainstMove) inefficiencyType = 'REVERSION_CANDIDATE'; // подставляется вызывающей стороной ТОЛЬКО при параллельном подтверждении абсорбции — никогда по факту одной дивергенции

    const factors = {
      context: Math.min(1, Math.abs(priceZ) / 5),
      trigger: Math.min(1, Math.abs(priceZ) / 4),
      flow: Math.max(0, 1 - Math.max(0, features.volume_zscore) / maxVolumeZ),
      orderbook: 0.5,
      volume: features.relative_volume != null ? Math.max(0, Math.min(1, 1 - features.relative_volume)) : 0.5,
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'priceVolumeInefficiency', direction: currentMove > 0 ? 'LONG' : 'SHORT', inefficiencyType: inefficiencyType,
      priceZ: Math.round(priceZ * 100) / 100, volumeZ: Math.round(features.volume_zscore * 100) / 100,
      movePct: Math.round(currentMove * 10000) / 100, priceAtSignal: features.last_price,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #6 — DENSITY_ABSORPTION_BREAKOUT
  // Более сильная версия density break: считает test_count ОДНОГО И ТОГО ЖЕ уровня через
  // НЕСКОЛЬКО вызовов (минуты) — единственная, наряду с #10, кому честно нужно немного состояния
  // между циклами (окно снимков само по себе не покрывает "тестировался 3 раза за 5 минут", если
  // тесты растянуты дальше глубины буфера). Контракт другой: возвращает {event, state} — state
  // мутируется и должно передаваться обратно вызывающей стороной на следующий вызов для ЭТОЙ
  // монеты (app.js хранит Map<symbol, state>, сбрасывается при выходе монеты из watchlist).
  // ------------------------------------------------------------------------------------------
  function detectDensityAbsorptionBreakout(depthSnapshots, trades, opts, state) {
    opts = opts || {};
    const minWallRatio = opts.minWallRatio != null ? opts.minWallRatio : 5;
    const priceTolerance = opts.priceTolerance || 0.002;
    const maxDistancePct = opts.maxDistancePct != null ? opts.maxDistancePct : 1.0;
    const testGapMs = opts.testGapMs || 15000;
    const staleMs = opts.staleMs || 600000;
    const minTestCount = opts.minTestCount || 3;
    state = state || {};
    // В отличие от остальных детекторов, этот смотрит ТОЛЬКО на последний снимок каждый вызов
    // (история — в state, накапливаемом между вызовами), поэтому не требует большого окна снимков.
    if (!depthSnapshots || !depthSnapshots.length) return { event: null, state: state };
    const cur = depthSnapshots[depthSnapshots.length - 1];
    if (!cur.bestBid || !cur.bestAsk) return { event: null, state: state };
    const price = (cur.bestBid + cur.bestAsk) / 2;

    if (state.trackedLevel && cur.t - state.trackedLevel.lastTestAt > staleMs) state.trackedLevel = null;

    const bidWall = findLevelWall(cur.bids, minWallRatio);
    const askWall = findLevelWall(cur.asks, minWallRatio);
    let candidate = null;
    if (bidWall) { const d = Math.abs(price - bidWall.p) / price * 100; if (d <= maxDistancePct) candidate = { side: 'bid', price: bidWall.p, qty: bidWall.q, dist: d }; }
    if (askWall) { const d = Math.abs(askWall.p - price) / price * 100; if (d <= maxDistancePct && (!candidate || d < candidate.dist)) candidate = { side: 'ask', price: askWall.p, qty: askWall.q, dist: d }; }

    if (!state.trackedLevel) {
      if (!candidate) return { event: null, state: state };
      state.trackedLevel = { side: candidate.side, price: candidate.price, initialQty: candidate.qty, currentQty: candidate.qty, testCount: 1, lastTestAt: cur.t, firstSeenAt: cur.t };
      return { event: null, state: state };
    }

    const tl = state.trackedLevel;
    const sameLevel = candidate && candidate.side === tl.side && Math.abs(candidate.price - tl.price) / tl.price <= priceTolerance * 5;
    if (sameLevel) {
      if (cur.t - tl.lastTestAt >= testGapMs) { tl.testCount++; tl.lastTestAt = cur.t; }
      tl.currentQty = candidate.qty;
    } else if (candidate) {
      state.trackedLevel = { side: candidate.side, price: candidate.price, initialQty: candidate.qty, currentQty: candidate.qty, testCount: 1, lastTestAt: cur.t, firstSeenAt: cur.t };
      return { event: null, state: state };
    } else {
      tl.currentQty = 0;
    }

    const remainingLiquidityRatio = tl.initialQty > 0 ? tl.currentQty / tl.initialQty : 0;
    if (tl.testCount < minTestCount) return { event: null, state: state };
    if (remainingLiquidityRatio > 0.4) return { event: null, state: state };
    const crossed = tl.side === 'ask' ? price > tl.price : price < tl.price;
    if (!crossed) return { event: null, state: state };

    const breakoutSide = tl.side === 'ask' ? 'buy' : 'sell';
    const windowTrades = (trades || []).filter(function (tr) { return tr.t >= tl.firstSeenAt && Math.abs(tr.price - tl.price) / tl.price <= priceTolerance * 3; });
    const executedInDirection = windowTrades.filter(function (tr) { return tr.side === breakoutSide; }).reduce(function (a, tr) { return a + tr.price * tr.qty; }, 0);
    if (executedInDirection <= 0) return { event: null, state: state };

    const absorptionDurationS = Math.round((cur.t - tl.firstSeenAt) / 1000);
    const distNow = candidate ? candidate.dist : 0;
    const factors = {
      context: Math.min(1, tl.testCount / 6),
      trigger: Math.min(1, 1 - remainingLiquidityRatio),
      flow: Math.min(1, executedInDirection / 10000),
      orderbook: Math.max(0, Math.min(1, (maxDistancePct - distNow) / maxDistancePct)),
      volume: Math.min(1, executedInDirection / 20000),
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    const event = {
      detectorKey: 'densityAbsorptionBreakout', direction: tl.side === 'ask' ? 'LONG' : 'SHORT',
      side: tl.side, priceLevel: tl.price, testCount: tl.testCount, absorptionDurationS: absorptionDurationS,
      remainingLiquidityRatioPct: Math.round(remainingLiquidityRatio * 1000) / 10, volumeUsd: Math.round(executedInDirection),
      priceAtSignal: price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
    state.trackedLevel = null;
    return { event: event, state: state };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #7/#8 — PUMP_REVERSAL / DUMP_REVERSAL
  // Экстремальный return по z-score (не фикс. %) + ускорение->замедление + новый экстремум +
  // ослабевающее давление движущей стороны. При отсутствии признаков истощения — событие не
  // возвращается вовсе (не "каждый памп = шорт"); при частичном истощении помечается *_CONTINUATION.
  // ------------------------------------------------------------------------------------------
  function detectPumpReversal(trades, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 400;
    const minReturnZ = opts.minReturnZ != null ? opts.minReturnZ : 2.5;
    if (!trades || trades.length < 40) return null;
    const recent = trades.slice(-lookback);
    const now = recent[recent.length - 1].t;
    const winMs = 60000, stepMs = 20000;
    const bufStart = recent[0].t;
    const moveHistory = [];
    for (let ts = bufStart + winMs; ts <= now; ts += stepMs) {
      const before = priceAtOrBeforeArr(recent, ts - winMs);
      const at = priceAtOrBeforeArr(recent, ts);
      if (before != null && at != null && before > 0) moveHistory.push((at - before) / before);
    }
    if (moveHistory.length < 8) return null;
    const beforeNow = priceAtOrBeforeArr(recent, now - winMs);
    const currentPrice = recent[recent.length - 1].price;
    if (beforeNow == null || beforeNow <= 0) return null;
    const currentMove = (currentPrice - beforeNow) / beforeNow;
    if (currentMove <= 0) return null;
    const moveZ = robustZScore(currentMove, moveHistory);
    if (moveZ < minReturnZ) return null;

    const window60 = recent.filter(function (t) { return t.t >= now - 60000; });
    if (window60.length < 12) return null;
    const half = Math.floor(window60.length / 2);
    const firstVelocity = (window60[half - 1].price - window60[0].price) / (winMs / 2 / 1000);
    const secondVelocity = (window60[window60.length - 1].price - window60[half].price) / (winMs / 2 / 1000);
    const decelerating = firstVelocity > 0 && secondVelocity < firstVelocity * 0.6;

    const maxPrice = Math.max.apply(null, recent.slice(-Math.min(recent.length, 200)).map(function (t) { return t.price; }));
    if (window60[window60.length - 1].price < maxPrice * 0.999) return null; // не на новом хае — нет структуры для разворота

    const buyVolFirst = window60.slice(0, half).filter(function (t) { return t.side === 'buy'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const totalFirst = window60.slice(0, half).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const buyVolSecond = window60.slice(half).filter(function (t) { return t.side === 'buy'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const totalSecond = window60.slice(half).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const buyRatioFirst = totalFirst > 0 ? buyVolFirst / totalFirst : 0;
    const buyRatioSecond = totalSecond > 0 ? buyVolSecond / totalSecond : 0;
    const buyPressureDeclining = buyRatioSecond < buyRatioFirst - 0.1;
    // ВАЖНО (ТЗ): памп сам по себе НЕ гейт для возврата null — если ни decelerating, ни
    // buyPressureDeclining не подтвердились, это ровно случай "flow продолжает усиливаться",
    // который спецификация просит явно пометить PUMP_CONTINUATION, а не молчать вообще.
    const isReversal = decelerating && buyPressureDeclining;
    const volumeUsd = totalFirst + totalSecond;
    const factors = {
      context: Math.min(1, moveZ / 5),
      trigger: decelerating ? Math.min(1, 1 - secondVelocity / (firstVelocity || 1e-9)) : 0.3,
      flow: Math.max(0, buyRatioFirst - buyRatioSecond),
      orderbook: 0.5,
      volume: Math.min(1, volumeUsd / 10000),
      history: 0
    };
    // PUMP_CONTINUATION без признаков истощения — намеренно информационный, честный потолок
    // уверенности (та же идея, что и isHeuristic/maxConfidence у fakeLiquidity): нет оснований
    // считать его торговым сигналом такой же силы, как подтверждённый PUMP_REVERSAL.
    const maxConfidence = isReversal ? undefined : 40;
    let score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    if (maxConfidence != null) score = Math.min(score, maxConfidence);
    return {
      detectorKey: 'pumpReversal', direction: isReversal ? 'SHORT' : 'LONG',
      pumpType: isReversal ? 'PUMP_REVERSAL' : 'PUMP_CONTINUATION',
      maxConfidence: maxConfidence,
      moveZ: Math.round(moveZ * 100) / 100, movePct: Math.round(currentMove * 10000) / 100,
      priceAtSignal: window60[window60.length - 1].price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  function detectDumpReversal(trades, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 400;
    const minReturnZ = opts.minReturnZ != null ? opts.minReturnZ : 2.5;
    if (!trades || trades.length < 40) return null;
    const recent = trades.slice(-lookback);
    const now = recent[recent.length - 1].t;
    const winMs = 60000, stepMs = 20000;
    const bufStart = recent[0].t;
    const moveHistory = [];
    for (let ts = bufStart + winMs; ts <= now; ts += stepMs) {
      const before = priceAtOrBeforeArr(recent, ts - winMs);
      const at = priceAtOrBeforeArr(recent, ts);
      if (before != null && at != null && before > 0) moveHistory.push((at - before) / before);
    }
    if (moveHistory.length < 8) return null;
    const beforeNow = priceAtOrBeforeArr(recent, now - winMs);
    const currentPrice = recent[recent.length - 1].price;
    if (beforeNow == null || beforeNow <= 0) return null;
    const currentMove = (currentPrice - beforeNow) / beforeNow;
    if (currentMove >= 0) return null;
    const moveZ = robustZScore(currentMove, moveHistory);
    if (moveZ > -minReturnZ) return null;

    const window60 = recent.filter(function (t) { return t.t >= now - 60000; });
    if (window60.length < 12) return null;
    const half = Math.floor(window60.length / 2);
    const firstVelocity = (window60[half - 1].price - window60[0].price) / (winMs / 2 / 1000);
    const secondVelocity = (window60[window60.length - 1].price - window60[half].price) / (winMs / 2 / 1000);
    const decelerating = firstVelocity < 0 && secondVelocity > firstVelocity * 0.6;

    const minPrice = Math.min.apply(null, recent.slice(-Math.min(recent.length, 200)).map(function (t) { return t.price; }));
    if (window60[window60.length - 1].price > minPrice * 1.001) return null;

    const sellVolFirst = window60.slice(0, half).filter(function (t) { return t.side === 'sell'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const totalFirst = window60.slice(0, half).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const sellVolSecond = window60.slice(half).filter(function (t) { return t.side === 'sell'; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const totalSecond = window60.slice(half).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const sellRatioFirst = totalFirst > 0 ? sellVolFirst / totalFirst : 0;
    const sellRatioSecond = totalSecond > 0 ? sellVolSecond / totalSecond : 0;
    const sellPressureDeclining = sellRatioSecond < sellRatioFirst - 0.1;
    // Тот же принцип, что и в PUMP_REVERSAL выше: отсутствие признаков истощения — это честный
    // случай DUMP_CONTINUATION, а не повод молчать вообще.
    const isReversal = decelerating && sellPressureDeclining;
    const volumeUsd = totalFirst + totalSecond;
    const factors = {
      context: Math.min(1, Math.abs(moveZ) / 5),
      trigger: decelerating ? Math.min(1, 1 - Math.abs(secondVelocity) / (Math.abs(firstVelocity) || 1e-9)) : 0.3,
      flow: Math.max(0, sellRatioFirst - sellRatioSecond),
      orderbook: 0.5,
      volume: Math.min(1, volumeUsd / 10000),
      history: 0
    };
    const maxConfidence = isReversal ? undefined : 40;
    let score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    if (maxConfidence != null) score = Math.min(score, maxConfidence);
    return {
      detectorKey: 'dumpReversal', direction: isReversal ? 'LONG' : 'SHORT',
      dumpType: isReversal ? 'DUMP_REVERSAL' : 'DUMP_CONTINUATION',
      maxConfidence: maxConfidence,
      moveZ: Math.round(moveZ * 100) / 100, movePct: Math.round(currentMove * 10000) / 100,
      priceAtSignal: window60[window60.length - 1].price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #9 — COMPRESSION_BREAK
  // Волатильность на низком перцентиле СОБСТВЕННОЙ истории монеты (не "vol<1%"), затем реальный
  // триггер расширения (всплеск объёма + пробой диапазона сжатия).
  // ------------------------------------------------------------------------------------------
  function detectCompressionBreak(trades, depthSnapshots, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 400;
    const compressionPercentile = opts.compressionPercentile != null ? opts.compressionPercentile : 0.2;
    if (!trades || trades.length < 60) return null;
    const recent = trades.slice(-lookback);
    const now = recent[recent.length - 1].t;
    const features = computeFeatures(recent, depthSnapshots, now);
    if (features.volatility_percentile == null) return null;

    const priorTrades = recent.filter(function (t) { return t.t <= now - 20000; });
    if (priorTrades.length < 20) return null;
    const priorFeatures = computeFeatures(priorTrades, null, now - 20000);
    const wasCompressed = priorFeatures.volatility_percentile != null && priorFeatures.volatility_percentile <= compressionPercentile;
    if (!wasCompressed) return null;

    const range20 = recent.filter(function (t) { return t.t >= now - 20000; }).map(function (t) { return t.price; });
    if (range20.length < 5) return null;
    const rangeLow = Math.min.apply(null, range20), rangeHigh = Math.max.apply(null, range20);
    const currentPrice = recent[recent.length - 1].price;
    let direction = null;
    if (currentPrice >= rangeHigh) direction = 'LONG';
    else if (currentPrice <= rangeLow) direction = 'SHORT';
    if (!direction) return null;
    if (features.volume_zscore == null || features.volume_zscore < 1.5) return null;

    const factors = {
      context: Math.max(0, Math.min(1, 1 - priorFeatures.volatility_percentile / compressionPercentile)),
      trigger: Math.min(1, features.volume_zscore / 4),
      flow: features.ofi != null ? Math.min(1, Math.abs(features.ofi)) : 0.5,
      orderbook: features.obi_L10 != null ? Math.min(1, Math.abs(features.obi_L10)) : 0.5,
      volume: features.relative_volume != null ? Math.min(1, features.relative_volume / 3) : 0.5,
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'compressionBreak', direction: direction,
      volatilityPercentile: Math.round(priorFeatures.volatility_percentile * 1000) / 10,
      volumeZ: Math.round(features.volume_zscore * 100) / 100, priceAtSignal: currentPrice,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #10 — FAILED_BREAKOUT
  // Прокол диапазона запоминается (state), сигнал выдаётся ТОЛЬКО после реального возврата внутрь
  // диапазона — никогда сразу на первом проколе. Тот же {event, state}-контракт, что и у #6.
  // ------------------------------------------------------------------------------------------
  function detectFailedBreakout(trades, opts, state) {
    opts = opts || {};
    const lookback = opts.lookback || 300;
    const rangeWindowMs = opts.rangeWindowMs || 180000;
    const pierceGraceMs = opts.pierceGraceMs || 60000;
    state = state || {};
    if (!trades || trades.length < 40) return { event: null, state: state };
    const recent = trades.slice(-lookback);
    const now = recent[recent.length - 1].t;
    const currentPrice = recent[recent.length - 1].price;

    if (state.pierce && now - state.pierce.at > pierceGraceMs) state.pierce = null;

    if (!state.pierce) {
      const rangeTrades = recent.filter(function (t) { return t.t >= now - rangeWindowMs && t.t < now - 5000; });
      if (rangeTrades.length < 15) return { event: null, state: state };
      const rangeLow = Math.min.apply(null, rangeTrades.map(function (t) { return t.price; }));
      const rangeHigh = Math.max.apply(null, rangeTrades.map(function (t) { return t.price; }));
      if (currentPrice > rangeHigh) state.pierce = { side: 'above', level: rangeHigh, at: now };
      else if (currentPrice < rangeLow) state.pierce = { side: 'below', level: rangeLow, at: now };
      return { event: null, state: state };
    }

    const p = state.pierce;
    const backInside = p.side === 'above' ? currentPrice < p.level : currentPrice > p.level;
    if (!backInside) return { event: null, state: state };

    const sinceTrades = recent.filter(function (t) { return t.t >= p.at; });
    const oppositeSide = p.side === 'above' ? 'sell' : 'buy';
    const oppositeVol = sinceTrades.filter(function (t) { return t.side === oppositeSide; }).reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const totalVol = sinceTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    if (totalVol <= 0 || oppositeVol / totalVol < 0.5) { state.pierce = null; return { event: null, state: state }; }

    const direction = p.side === 'above' ? 'SHORT' : 'LONG';
    const factors = {
      context: Math.min(1, sinceTrades.length / 20),
      trigger: 1,
      flow: Math.min(1, oppositeVol / totalVol),
      orderbook: 0.5,
      volume: Math.min(1, totalVol / 5000),
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    const event = {
      detectorKey: 'failedBreakout', direction: direction, level: p.level,
      reclaimVolumeUsd: Math.round(totalVol), priceAtSignal: currentPrice,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
    state.pierce = null;
    return { event: event, state: state };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #11 — VOLUME_ANOMALY
  // Необычный объём САМ ПО СЕБЕ — не торговый сигнал (спецификация #11 требует это явно): событие
  // всегда сопровождается классификацией BULLISH/BEARISH/ABSORPTION_NEUTRAL — подтверждён ли
  // всплеск объёма пропорциональным движением цены в сторону доминирующего потока, или объём
  // поглощён без движения (нейтрально/абсорбция), а не автоматически трактуется как сигнал.
  // ------------------------------------------------------------------------------------------
  function detectVolumeAnomaly(trades, depthSnapshots, opts) {
    opts = opts || {};
    const minVolumeZ = opts.minVolumeZ != null ? opts.minVolumeZ : 2.5;
    const minRelativeVolume = opts.minRelativeVolume != null ? opts.minRelativeVolume : 3;
    const bullishMovePct = opts.bullishMovePct != null ? opts.bullishMovePct : 0.005;
    const dominantFlowRatio = opts.dominantFlowRatio != null ? opts.dominantFlowRatio : 0.65;
    if (!trades || trades.length < 40) return null;
    const recent = trades.slice(-(opts.lookback || 400));
    const now = recent[recent.length - 1].t;
    const features = computeFeatures(recent, depthSnapshots, now);
    if (features.volume_zscore == null || features.relative_volume == null) return null;
    if (features.volume_zscore < minVolumeZ && features.relative_volume < minRelativeVolume) return null;

    const totalVol = features.buy_volume + features.sell_volume;
    const buyRatio = totalVol > 1e-9 ? features.buy_volume / totalVol : 0.5;
    const movePct = features.returns[60] != null ? features.returns[60] : (features.returns[30] || 0);
    let eventType, direction;
    if (buyRatio >= dominantFlowRatio && movePct >= bullishMovePct) { eventType = 'BULLISH_VOLUME_EVENT'; direction = 'LONG'; }
    else if (buyRatio <= (1 - dominantFlowRatio) && movePct <= -bullishMovePct) { eventType = 'BEARISH_VOLUME_EVENT'; direction = 'SHORT'; }
    else { eventType = 'ABSORPTION_NEUTRAL_EVENT'; direction = 'BOTH'; }

    const factors = {
      context: Math.min(1, features.relative_volume / (minRelativeVolume * 2)),
      trigger: Math.min(1, features.volume_zscore / (minVolumeZ * 2)),
      flow: Math.abs(buyRatio - 0.5) * 2,
      orderbook: features.obi_L10 != null ? Math.min(1, Math.abs(features.obi_L10)) : 0.5,
      volume: Math.min(1, features.relative_volume / (minRelativeVolume * 3)),
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'volumeAnomaly', direction: direction, eventType: eventType,
      volumeZ: Math.round(features.volume_zscore * 100) / 100, relativeVolume: Math.round(features.relative_volume * 100) / 100,
      tradeCount: features.trade_count, avgTradeSizeUsd: Math.round(features.average_trade_size),
      movePct: Math.round(movePct * 10000) / 100, priceAtSignal: features.last_price,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #13 — LIQUIDITY_WITHDRAWAL
  // Резкое исчезновение ВИДИМОЙ суммарной ликвидности (bidVol/askVol снимка — уже сумма по всем
  // полученным уровням, а не одна "стена", как в density break/absorption) на одной стороне книги
  // рядом с ценой. НЕ называется "spoofing" — публичный стакан не даёт для этого доказательств
  // (спецификация #13 требует именно это разграничение).
  // ------------------------------------------------------------------------------------------
  function detectLiquidityWithdrawal(depthSnapshots, trades, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 200;
    const minSnapshots = opts.minSnapshots || 20;
    const minWithdrawalRatio = opts.minWithdrawalRatio != null ? opts.minWithdrawalRatio : 0.5;
    if (!depthSnapshots || depthSnapshots.length < minSnapshots) return null;
    const recent = depthSnapshots.slice(-lookback);
    const cur = recent[recent.length - 1];
    if (!cur.bestBid || !cur.bestAsk) return null;
    const price = (cur.bestBid + cur.bestAsk) / 2;

    const earlyCount = Math.max(3, Math.floor(recent.length / 3));
    const early = recent.slice(0, earlyCount);
    const earlyAsk = median(early.map(function (s) { return s.askVol; }));
    const earlyBid = median(early.map(function (s) { return s.bidVol; }));
    const curAsk = cur.askVol, curBid = cur.bidVol;
    const askWithdrawalRatio = earlyAsk > 0 ? (earlyAsk - curAsk) / earlyAsk : 0;
    const bidWithdrawalRatio = earlyBid > 0 ? (earlyBid - curBid) / earlyBid : 0;

    let side = null, withdrawalRatio = 0;
    if (askWithdrawalRatio >= minWithdrawalRatio && askWithdrawalRatio >= bidWithdrawalRatio) { side = 'ask'; withdrawalRatio = askWithdrawalRatio; }
    else if (bidWithdrawalRatio >= minWithdrawalRatio) { side = 'bid'; withdrawalRatio = bidWithdrawalRatio; }
    if (!side) return null;

    const t0 = early[early.length - 1].t, t1 = cur.t;
    const reactionSide = side === 'ask' ? 'buy' : 'sell'; // сторона потока, которая заполнила бы возникший вакуум
    const windowTrades = (trades || []).filter(function (tr) { return tr.t >= t0 && tr.t <= t1; });
    const reactionVol = windowTrades.filter(function (tr) { return tr.side === reactionSide; }).reduce(function (a, tr) { return a + tr.price * tr.qty; }, 0);
    const totalVol = windowTrades.reduce(function (a, tr) { return a + tr.price * tr.qty; }, 0);
    const reactionRatio = totalVol > 0 ? reactionVol / totalVol : 0.5;
    if (reactionRatio < 0.55) return null; // ликвидность ушла, но подтверждающего потока в сторону вакуума нет — не событие

    const factors = {
      context: Math.min(1, (side === 'ask' ? earlyAsk : earlyBid) / 20000),
      trigger: Math.min(1, withdrawalRatio),
      flow: reactionRatio,
      orderbook: Math.max(0, Math.min(1, 1 - (side === 'ask' ? curAsk / (earlyAsk || 1) : curBid / (earlyBid || 1)))),
      volume: Math.min(1, totalVol / 10000),
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'liquidityWithdrawal', direction: side === 'ask' ? 'LONG' : 'SHORT', eventType: 'LIQUIDITY_WITHDRAWAL',
      side: side, withdrawalRatioPct: Math.round(withdrawalRatio * 1000) / 10, reactionRatioPct: Math.round(reactionRatio * 1000) / 10,
      volumeUsd: Math.round(totalVol), priceAtSignal: price, scoreAtSignal: score, confidencePct: score, factors: factors
    };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #14 — POSSIBLE_HIDDEN_ABSORPTION
  // Настоящий iceberg по публичному стакану гарантированно не найти (спецификация #14 требует
  // признать это прямо) — поэтому НИКОГДА не утверждается "ICEBERG FOUND", только
  // POSSIBLE_HIDDEN_ABSORPTION: лучший бид/аск многократно "просаживается" исполненными сделками
  // и восстанавливается (replenishment) без пробоя уровня, а исполненный объём через уровень
  // заметно превышает его видимую глубину. {event, state} контракт — то же честное состояние
  // между вызовами, что у #6/#10 (единственный способ посчитать replenishment_count).
  // ------------------------------------------------------------------------------------------
  function detectPossibleHiddenAbsorption(depthSnapshots, trades, opts, state) {
    opts = opts || {};
    const priceTolerance = opts.priceTolerance || 0.0015;
    const maxDistancePct = opts.maxDistancePct != null ? opts.maxDistancePct : 0.8;
    const replenishRatio = opts.replenishRatio != null ? opts.replenishRatio : 0.6;
    const depletedRatio = opts.depletedRatio != null ? opts.depletedRatio : 0.4;
    const minReplenishments = opts.minReplenishments || 2;
    const executedOverVisibleRatio = opts.executedOverVisibleRatio != null ? opts.executedOverVisibleRatio : 3;
    const staleMs = opts.staleMs || 900000;
    const maxConfidence = opts.maxConfidence != null ? opts.maxConfidence : 75; // эвристика без прямого доказательства — честный потолок, как у fakeLiquidity
    state = state || {};
    if (!depthSnapshots || !depthSnapshots.length) return { event: null, state: state };
    const cur = depthSnapshots[depthSnapshots.length - 1];
    if (!cur.bestBid || !cur.bestAsk) return { event: null, state: state };
    const price = (cur.bestBid + cur.bestAsk) / 2;

    if (state.tracked && cur.t - state.tracked.lastUpdateAt > staleMs) state.tracked = null;

    const candidates = [
      { side: 'bid', price: cur.bestBid, qty: (cur.bids && cur.bids[0]) ? cur.bids[0].q : 0 },
      { side: 'ask', price: cur.bestAsk, qty: (cur.asks && cur.asks[0]) ? cur.asks[0].q : 0 }
    ].filter(function (c) { return c.qty > 0 && Math.abs(c.price - price) / price * 100 <= maxDistancePct; });

    let candidate = null;
    if (state.tracked) candidate = candidates.filter(function (c) { return c.side === state.tracked.side; })[0] || null;
    else candidate = candidates[0] || null;
    if (!candidate) return { event: null, state: state };

    const isSameTracked = !!(state.tracked && state.tracked.side === candidate.side &&
      Math.abs(candidate.price - state.tracked.price) / state.tracked.price <= priceTolerance * 5);
    if (!isSameTracked) {
      state.tracked = {
        side: candidate.side, price: candidate.price, initialQty: candidate.qty, lastQty: candidate.qty,
        wasDepleted: false, replenishments: 0, firstSeenAt: cur.t, lastUpdateAt: cur.t
      };
      return { event: null, state: state }; // только что начали отслеживать — рано для событий
    }

    const tl = state.tracked;
    tl.lastUpdateAt = cur.t;
    const ratioNow = tl.initialQty > 0 ? candidate.qty / tl.initialQty : 0;
    if (ratioNow < depletedRatio) tl.wasDepleted = true;
    else if (tl.wasDepleted && ratioNow >= replenishRatio) { tl.replenishments++; tl.wasDepleted = false; }
    tl.lastQty = candidate.qty;

    const priceBrokeLevel = tl.side === 'bid' ? price < tl.price * (1 - priceTolerance) : price > tl.price * (1 + priceTolerance);
    if (priceBrokeLevel) { state.tracked = null; return { event: null, state: state }; } // уровень пройден -> это уже не absorption, а обычный пробой

    const sideForTrades = tl.side === 'bid' ? 'sell' : 'buy'; // агрессивная сторона, которая "ест" этот уровень
    const windowTrades = (trades || []).filter(function (tr) {
      return tr.t >= tl.firstSeenAt && Math.abs(tr.price - tl.price) / tl.price <= priceTolerance * 3 && tr.side === sideForTrades;
    });
    const executedVolumeUsd = windowTrades.reduce(function (a, tr) { return a + tr.price * tr.qty; }, 0);
    const visibleUsd = tl.price * tl.initialQty;

    if (tl.replenishments < minReplenishments) return { event: null, state: state };
    if (visibleUsd <= 0 || executedVolumeUsd / visibleUsd < executedOverVisibleRatio) return { event: null, state: state };

    const durationS = Math.round((cur.t - tl.firstSeenAt) / 1000);
    const factors = {
      context: Math.min(1, tl.replenishments / (minReplenishments * 2)),
      trigger: Math.min(1, (executedVolumeUsd / visibleUsd) / (executedOverVisibleRatio * 2)),
      flow: Math.min(1, executedVolumeUsd / 20000),
      orderbook: Math.max(0, Math.min(1, tl.lastQty / tl.initialQty)),
      volume: Math.min(1, executedVolumeUsd / 30000),
      history: 0
    };
    let score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    score = Math.min(score, maxConfidence);
    const event = {
      detectorKey: 'possibleHiddenAbsorption', direction: tl.side === 'bid' ? 'LONG' : 'SHORT', eventType: 'POSSIBLE_HIDDEN_ABSORPTION',
      isHeuristic: true, maxConfidence: maxConfidence,
      side: tl.side, priceLevel: tl.price, replenishments: tl.replenishments, durationS: durationS,
      executedOverVisibleRatio: Math.round((executedVolumeUsd / visibleUsd) * 10) / 10,
      volumeUsd: Math.round(executedVolumeUsd), priceAtSignal: price,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
    // НЕ сбрасываем state.tracked после срабатывания (в отличие от #6/#10) — absorption на этом
    // уровне может продолжаться (ещё replenishment'ы); повторное открытие сигнала предотвращает
    // session/cooldown-механика на стороне app.js (registerPatternEvent), не эта функция.
    return { event: event, state: state };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #15 — CROSS_EXCHANGE_DIVERGENCE (для SPOT — локальная ценовая неэффективность, не
  // абстрактный арбитраж). Чистая функция: сравнение цен + оценка издержек (комиссия+проскальзывание).
  // Сама подписка на другие биржи и подбор кандидатов — на стороне app.js (там же живут
  // exchangeConnections/coinMap), сюда передаются уже готовые {exchange, price} кандидаты. Если
  // кандидатов нет (ни одна биржа не подключена/не найдена та же монета) — возвращает null, а не
  // выдуманный сигнал (спецификация #15 требует это явно).
  // ------------------------------------------------------------------------------------------
  function detectCrossExchangeDivergence(mexcPrice, candidates, opts, state) {
    opts = opts || {};
    const feeRatePerSide = opts.feeRatePerSide != null ? opts.feeRatePerSide : 0.001;
    const slippagePct = opts.slippagePct != null ? opts.slippagePct : 0.0005;
    const minNetSpreadPct = opts.minNetSpreadPct != null ? opts.minNetSpreadPct : 0.003;
    const minPersistMs = opts.minPersistMs != null ? opts.minPersistMs : 8000;
    const minDistinctUpdates = opts.minDistinctUpdates != null ? opts.minDistinctUpdates : 2;
    const staleMs = opts.staleMs != null ? opts.staleMs : 20000;
    state = state || {};
    if (!(mexcPrice > 0) || !candidates || !candidates.length) return { event: null, state: state };

    const now = opts.now || Date.now();
    const estimatedCost = feeRatePerSide * 2 + slippagePct; // упрощённо: комиссия на обеих ногах + проскальзывание
    let best = null;
    candidates.forEach(function (c) {
      if (!(c.price > 0) || !c.exchange) return;
      const grossSpreadPct = (c.price - mexcPrice) / mexcPrice;
      const netSpreadPct = Math.abs(grossSpreadPct) - estimatedCost;
      let st = state[c.exchange];
      if (!st || now - st.lastSeenAt > staleMs) st = { sinceT: now, lastExtPrice: c.price, distinctUpdates: 1, lastSeenAt: now };
      else {
        st.lastSeenAt = now;
        if (Math.abs(c.price - st.lastExtPrice) / st.lastExtPrice > 1e-6) { st.distinctUpdates++; st.lastExtPrice = c.price; }
      }
      if (netSpreadPct < minNetSpreadPct) { st.sinceT = now; st.distinctUpdates = 1; } // разошлось недостаточно -> сброс отсчёта устойчивости
      state[c.exchange] = st;
      const persistedMs = now - st.sinceT;
      if (netSpreadPct >= minNetSpreadPct && persistedMs >= minPersistMs && st.distinctUpdates >= minDistinctUpdates) {
        if (!best || netSpreadPct > best.netSpreadPct) {
          best = { exchange: c.exchange, extPrice: c.price, grossSpreadPct: grossSpreadPct, netSpreadPct: netSpreadPct, persistedMs: persistedMs };
        }
      }
    });
    if (!best) return { event: null, state: state };

    const factors = {
      context: Math.min(1, best.persistedMs / (minPersistMs * 3)),
      trigger: Math.min(1, best.netSpreadPct / (minNetSpreadPct * 3)),
      flow: 0.5, // нет доступа к order flow другой биржи честно — нейтрально, не выдумываем
      orderbook: 0.5,
      volume: 0.5,
      history: 0
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    const event = {
      detectorKey: 'crossExchangeDivergence', direction: best.grossSpreadPct > 0 ? 'LONG' : 'SHORT', eventType: 'CROSS_EXCHANGE_DIVERGENCE',
      exchange: best.exchange, mexcPrice: mexcPrice, extPrice: best.extPrice,
      grossSpreadPct: Math.round(best.grossSpreadPct * 10000) / 100, netSpreadPct: Math.round(best.netSpreadPct * 10000) / 100,
      persistedS: Math.round(best.persistedMs / 1000), priceAtSignal: mexcPrice,
      scoreAtSignal: score, confidencePct: score, factors: factors
    };
    return { event: event, state: state };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #12 — CYCLICAL_PATTERN
  // "Один из наиболее важных алгоритмов" (спецификация #12) — но НЕ ищет свечи/фиксированный
  // период. Строит per-symbol библиотеку прошлых ЗАКРЫТЫХ эпизодов (impulse -> пауза -> move,
  // любых направлений — pump→pause→dump тоже валиден), сравнивает текущий кандидат с библиотекой
  // упрощённым нормализованным расстоянием (спецификация явно разрешает "DTW или упрощённый
  // distance"), требует минимум наблюдений ПЕРЕД тем, как считать паттерн надёжным. Библиотека —
  // ответственность app.js (localStorage, тот же идиом, что patternHistory); outcomeMovePct
  // каждой записи заполняется СТРОГО ПОЗЖЕ, отдельным sweep'ом в app.js (без look-ahead: во время
  // самого extractCyclicalEpisode следующий отрезок цены ещё не наблюдался).
  // ------------------------------------------------------------------------------------------
  function extractCyclicalEpisode(trades, opts) {
    opts = opts || {};
    const impulseWindowMs = opts.impulseWindowMs || 60000;
    const pauseWindowMs = opts.pauseWindowMs || 60000;
    const moveWindowMs = opts.moveWindowMs || 60000;
    const minImpulsePct = opts.minImpulsePct != null ? opts.minImpulsePct : 0.008;
    if (!trades || trades.length < 40) return null;
    const now = trades[trades.length - 1].t;
    const moveTrades = trades.filter(function (t) { return t.t >= now - moveWindowMs; });
    const pauseTrades = trades.filter(function (t) { return t.t >= now - moveWindowMs - pauseWindowMs && t.t < now - moveWindowMs; });
    const impulseTrades = trades.filter(function (t) {
      return t.t >= now - moveWindowMs - pauseWindowMs - impulseWindowMs && t.t < now - moveWindowMs - pauseWindowMs;
    });
    if (impulseTrades.length < 8 || pauseTrades.length < 5 || moveTrades.length < 8) return null;

    const impulsePct = (impulseTrades[impulseTrades.length - 1].price - impulseTrades[0].price) / impulseTrades[0].price;
    if (Math.abs(impulsePct) < minImpulsePct) return null;
    const pauseHigh = Math.max.apply(null, pauseTrades.map(function (t) { return t.price; }));
    const pauseLow = Math.min.apply(null, pauseTrades.map(function (t) { return t.price; }));
    const pauseRangePct = pauseTrades[0].price > 0 ? (pauseHigh - pauseLow) / pauseTrades[0].price : 1;
    if (pauseRangePct > Math.abs(impulsePct) * 0.5) return null; // движение не остановилось -> не настоящая пауза
    const movePct = (moveTrades[moveTrades.length - 1].price - moveTrades[0].price) / moveTrades[0].price;
    if (Math.abs(movePct) < minImpulsePct * 0.5) return null; // тишина продолжилась -> эпизод ещё не завершился

    const impulseVolUsd = impulseTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    const moveVolUsd = moveTrades.reduce(function (a, t) { return a + t.price * t.qty; }, 0);
    return {
      t: now, impulsePct: impulsePct, movePct: movePct,
      volumeRatio: impulseVolUsd > 0 ? moveVolUsd / impulseVolUsd : 1,
      priceAtSignal: moveTrades[moveTrades.length - 1].price
    };
  }

  function matchCyclicalEpisode(candidate, library, opts) {
    opts = opts || {};
    const maxDistance = opts.maxDistance != null ? opts.maxDistance : 0.5;
    const minObservations = opts.minObservations || 5;
    const successThresholdPct = opts.successThresholdPct != null ? opts.successThresholdPct : 0.3;
    if (!candidate || !library || !library.length) return null;
    const scale = Math.max(Math.abs(candidate.impulsePct), 0.005);
    // Только УЖЕ ЗАКРЫТЫЕ записи (outcomeMovePct заполнен более поздним sweep'ом) участвуют в
    // сравнении — открытые (ещё без исхода) исключены, иначе это было бы использованием будущего.
    const matches = library.filter(function (e) {
      if (e.outcomeMovePct == null) return false;
      const d = Math.sqrt(Math.pow((e.impulsePct - candidate.impulsePct) / scale, 2) + Math.pow((e.movePct - candidate.movePct) / scale, 2));
      return d <= maxDistance;
    });
    if (matches.length < minObservations) return null;
    const sameDirCount = matches.filter(function (e) {
      return Math.sign(e.outcomeMovePct) === Math.sign(candidate.movePct) && Math.abs(e.outcomeMovePct) >= successThresholdPct / 100;
    }).length;
    const winrate = sameDirCount / matches.length;
    const moves = matches.map(function (e) { return e.outcomeMovePct; });
    return {
      count: matches.length, winrate: winrate,
      avgMove: moves.reduce(function (a, b) { return a + b; }, 0) / moves.length, medianMove: median(moves)
    };
  }

  // {event, library} контракт — library — массив закрытых+открытых эпизодов ЭТОЙ монеты,
  // персистентно хранимый и передаваемый app.js (аналог state у #6/#10, но растущий список, а не
  // единичный объект).
  function detectCyclicalPattern(trades, library, opts) {
    opts = opts || {};
    library = library || [];
    const candidate = extractCyclicalEpisode(trades, opts);
    if (!candidate) return { event: null, library: library };
    const dedupWindowMs = opts.dedupWindowMs != null ? opts.dedupWindowMs : 20000;
    const alreadyLogged = library.length && Math.abs(library[library.length - 1].t - candidate.t) < dedupWindowMs;
    const match = matchCyclicalEpisode(candidate, library, opts);
    let event = null;
    const minWinrate = opts.minWinrate != null ? opts.minWinrate : 0.55;
    if (match && match.winrate >= minWinrate) {
      const factors = {
        context: Math.min(1, match.count / ((opts.minObservations || 5) * 3)),
        trigger: Math.min(1, Math.abs(candidate.movePct) / 0.02),
        flow: match.winrate,
        orderbook: 0.5,
        volume: Math.min(1, candidate.volumeRatio),
        history: match.winrate
      };
      const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
      event = {
        detectorKey: 'cyclicalPattern', direction: candidate.movePct > 0 ? 'LONG' : 'SHORT', eventType: 'CYCLICAL_PATTERN',
        observedRepeats: match.count, winratePct: Math.round(match.winrate * 1000) / 10,
        avgMovePct: Math.round(match.avgMove * 10000) / 100, medianMovePct: Math.round(match.medianMove * 10000) / 100,
        impulsePct: Math.round(candidate.impulsePct * 10000) / 100, priceAtSignal: candidate.priceAtSignal,
        scoreAtSignal: score, confidencePct: score, factors: factors
      };
    }
    if (!alreadyLogged) {
      library = library.concat([{ t: candidate.t, impulsePct: candidate.impulsePct, movePct: candidate.movePct, outcomeMovePct: null }]);
      const maxLibrarySize = opts.maxLibrarySize || 300;
      if (library.length > maxLibrarySize) library = library.slice(-maxLibrarySize);
    }
    return { event: event, library: library };
  }

  // ------------------------------------------------------------------------------------------
  // ALGORITHM #16 — REPEATING_TIME_BASED_IMPULSE
  // Не предполагает заранее конкретный период (спецификация #16 требует искать сам, не
  // предполагать 15 минут) — здесь используется час UTC + 15-минутный интервал внутри часа как
  // ГРАНУЛЯРНОСТЬ бакета (не как гипотеза о цикле), ровно так, как в примере спецификации
  // (":00/:15/:30/:45"). Статистика по каждому бакету накапливается РЕАЛЬНЫМ временем работы
  // приложения (app.js, localStorage) — эта функция только читает уже накопленное и требует
  // минимум наблюдений, иначе не считает бакет надёжным (явное требование спецификации).
  // ------------------------------------------------------------------------------------------
  function timeBucketKeyFromDate(d) {
    const hour = d.getUTCHours();
    const qtr = Math.floor(d.getUTCMinutes() / 15) * 15;
    return hour + ':' + (qtr < 10 ? '0' + qtr : String(qtr));
  }

  function recordTimeBucketObservation(bucketStats, obs) {
    bucketStats = bucketStats || { count: 0, upMoves: 0, downMoves: 0, volumes: [] };
    bucketStats.count++;
    if (obs.movePct > 0) bucketStats.upMoves++; else if (obs.movePct < 0) bucketStats.downMoves++;
    bucketStats.volumes = (bucketStats.volumes || []).concat([obs.volumeUsd]);
    if (bucketStats.volumes.length > 200) bucketStats.volumes = bucketStats.volumes.slice(-200);
    bucketStats.medianVolume = median(bucketStats.volumes);
    return bucketStats;
  }

  function evaluateTimeBucket(bucketStats, overallMedianVolume, opts) {
    opts = opts || {};
    const minObservations = opts.minObservations || 10;
    if (!bucketStats || bucketStats.count < minObservations) return null;
    const totalDir = bucketStats.upMoves + bucketStats.downMoves;
    if (totalDir < minObservations) return null;
    const bias = bucketStats.upMoves / totalDir;
    const minBias = opts.minBias != null ? opts.minBias : 0.65;
    if (bias < minBias && bias > (1 - minBias)) return null;
    const volumeMultiplier = (overallMedianVolume > 0 && bucketStats.medianVolume != null) ? bucketStats.medianVolume / overallMedianVolume : 1;
    const minVolumeMultiplier = opts.minVolumeMultiplier != null ? opts.minVolumeMultiplier : 1.5;
    if (volumeMultiplier < minVolumeMultiplier) return null;
    return { bias: bias, volumeMultiplier: volumeMultiplier, observations: bucketStats.count, direction: bias >= minBias ? 'LONG' : 'SHORT' };
  }

  function detectTimeBasedImpulse(bucketStats, overallMedianVolume, priceAtSignal, opts) {
    opts = opts || {};
    const ev = evaluateTimeBucket(bucketStats, overallMedianVolume, opts);
    if (!ev) return null;
    const factors = {
      context: Math.min(1, ev.observations / ((opts.minObservations || 10) * 3)),
      trigger: Math.min(1, ev.volumeMultiplier / 4),
      flow: Math.abs(ev.bias - 0.5) * 2,
      orderbook: 0.5,
      volume: Math.min(1, ev.volumeMultiplier / 3),
      history: Math.abs(ev.bias - 0.5) * 2
    };
    const score = scorePatternEvent(factors, ALGO_SCORE_WEIGHTS);
    return {
      detectorKey: 'timeBasedImpulse', direction: ev.direction, eventType: 'TIME_PATTERN_' + ev.direction,
      observations: ev.observations, biasPct: Math.round(ev.bias * 1000) / 10, volumeMultiplier: Math.round(ev.volumeMultiplier * 100) / 100,
      priceAtSignal: priceAtSignal, scoreAtSignal: score, confidencePct: score, factors: factors
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
    ALGO_SCORE_WEIGHTS: ALGO_SCORE_WEIGHTS,
    priceAtOrBeforeArr: priceAtOrBeforeArr,
    findLevelWall: findLevelWall,
    computeFeatures: computeFeatures,
    classifyRegime: classifyRegime,
    detectDensityBreak: detectDensityBreak,
    detectDensityAbsorption: detectDensityAbsorption,
    detectLiquiditySweep: detectLiquiditySweep,
    detectImpulsePullbackContinuation: detectImpulsePullbackContinuation,
    detectPriceVolumeInefficiency: detectPriceVolumeInefficiency,
    detectDensityAbsorptionBreakout: detectDensityAbsorptionBreakout,
    detectPumpReversal: detectPumpReversal,
    detectDumpReversal: detectDumpReversal,
    detectCompressionBreak: detectCompressionBreak,
    detectFailedBreakout: detectFailedBreakout,
    detectVolumeAnomaly: detectVolumeAnomaly,
    detectLiquidityWithdrawal: detectLiquidityWithdrawal,
    detectPossibleHiddenAbsorption: detectPossibleHiddenAbsorption,
    detectCrossExchangeDivergence: detectCrossExchangeDivergence,
    extractCyclicalEpisode: extractCyclicalEpisode,
    matchCyclicalEpisode: matchCyclicalEpisode,
    detectCyclicalPattern: detectCyclicalPattern,
    timeBucketKeyFromDate: timeBucketKeyFromDate,
    recordTimeBucketObservation: recordTimeBucketObservation,
    evaluateTimeBucket: evaluateTimeBucket,
    detectTimeBasedImpulse: detectTimeBasedImpulse,
    computeOutcomeMetrics: computeOutcomeMetrics,
    shouldOpenNewPatternSession: shouldOpenNewPatternSession,
    prunePatternHistory: prunePatternHistory,
    computePastSuccessRate: computePastSuccessRate,
    computeValidationSplit: computeValidationSplit,
    PATTERN_OUTCOME_CHECKPOINTS_S: PATTERN_OUTCOME_CHECKPOINTS_S
  };
});
