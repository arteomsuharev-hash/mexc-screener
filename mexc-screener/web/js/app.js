(function () {
'use strict';

// ============================================
// MEXC Spot WebSocket (v3, wbs-api.mexc.com) — единственный актуальный публичный эндпоинт.
// Публичные рыночные каналы (miniTickers/deals) отдаются в формате Protobuf, поэтому
// ниже встроена минимальная proto-схема (см. https://github.com/mexcdevelop/websocket-proto)
// и сообщения декодируются через protobufjs перед разбором.
// ============================================

const MEXC_WS = 'wss://wbs-api.mexc.com/ws';
const LEV_RE = /(UP|DOWN|BULL|BEAR|3L|3S|5L|5S)USDT$/;

// --- Protobuf schema (inlined, subset of MEXC's official .proto files) ---
const MEXC_PROTO_SRC = [
  'syntax = "proto3";',
  'message PublicMiniTickerV3Api {',
  '  string symbol = 1;',
  '  string price = 2;',
  '  string rate = 3;',
  '  string zonedRate = 4;',
  '  string high = 5;',
  '  string low = 6;',
  '  string volume = 7;',
  '  string quantity = 8;',
  '  string lastCloseRate = 9;',
  '  string lastCloseZonedRate = 10;',
  '  string lastCloseHigh = 11;',
  '  string lastCloseLow = 12;',
  '}',
  'message PublicMiniTickersV3Api {',
  '  repeated PublicMiniTickerV3Api items = 1;',
  '}',
  'message PublicDealsV3ApiItem {',
  '  string price = 1;',
  '  string quantity = 2;',
  '  int32 tradeType = 3;',
  '  int64 time = 4;',
  '}',
  'message PublicDealsV3Api {',
  '  repeated PublicDealsV3ApiItem deals = 1;',
  '  string eventType = 2;',
  '}',
  // Стакан (partial depth) — только для watchlist-монет (Tier 2, см. ниже), НЕ для всего рынка
  // разом: MEXC отдаёт его отдельным каналом на символ (spot@public.limit.depth.v3.api.pb@<SYM>@20),
  // а не единым потоком, как miniTickers. Схема и номер поля (303) подтверждены живым фреймом
  // MEXC (см. tests/verify_depth_proto.js) и официальным proto-репозиторием mexcdevelop/websocket-proto.
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
  // Приватный канал (только по подписке с ?listenKey= в URL, см. openPrivateDealsStream ниже) —
  // сделки САМОГО аккаунта по ВСЕМ парам сразу (без указания символа в имени канала), в отличие от
  // публичного PublicDealsV3Api. Схема и номер поля (306) — из официального proto-репозитория
  // mexcdevelop/websocket-proto (PrivateDealsV3Api.proto/PushDataV3ApiWrapper.proto).
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
  '    PublicDealsV3Api publicDeals = 301;',
  '    PublicLimitDepthsV3Api publicLimitDepths = 303;',
  '    PrivateDealsV3Api privateDeals = 306;',
  '    PublicMiniTickerV3Api publicMiniTicker = 309;',
  '    PublicMiniTickersV3Api publicMiniTickers = 310;',
  '  }',
  '  optional string symbol = 3;',
  '  optional string symbolId = 4;',
  '  optional int64 createTime = 5;',
  '  optional int64 sendTime = 6;',
  '}'
].join('\n');

let ProtoWrapper = null;
try {
  if (typeof protobuf !== 'undefined') {
    const parsed = protobuf.parse(MEXC_PROTO_SRC, { keepCase: true });
    ProtoWrapper = parsed.root.lookupType('PushDataV3ApiWrapper');
  }
} catch (e) {
  console.error('MEXC proto schema init failed', e);
}

// Общие DOM-независимые утилиты (логирование, withRetry) вынесены в core-utils.js —
// загружается отдельным <script> до этого файла (см. index.html) и переиспользуется тестами из
// tests/ напрямую через require(), без необходимости эмулировать браузерное окружение.
const logD = MexcCore.logD, logI = MexcCore.logI, logW = MexcCore.logW, logE = MexcCore.logE;
const withRetry = MexcCore.withRetry;
const pushRing = MexcCore.pushRing;

let allCoins = [];
const coinMap = new Map();
const snapshots = new Map();
// Предыдущие значения метрик топ-бара (Показано/Сделок/Пары) — чтобы пульснуть свечением только
// при реальном изменении числа, а не при каждой перерисовке.
const prevMetricValues = new Map();
let currentCoin = null;
let startTime = Date.now();
let sidebarCollapsed = false;
let darkTheme = true;
let currentTF = '5';
let chartSymbol = '';
let updateIntervalId = null;
let updateIntervalMs = 10000;
let isLoading = false;
let searchQuery = '';
let sortField = 'vol24';
let sortAsc = false;
let viewMode = 'list';
// Пока курсор наведён на строку таблицы/карточку сетки — держим ПОРЯДОК монет неизменным (значения
// в ячейках по-прежнему обновляются живьём), чтобы монета, которую пользователь разглядывает, не
// "уезжала" из-под курсора от постоянной пересортировки по объёму/цене. См. applySortOnly() и
// делегированные mouseover/mouseout на #tableBody/#gridView в конце файла.
let tableHoverFreezeSymbol = null;
let ws = null;
let wsReconnectAttempts = 0;
let lastMiniTickerAt = 0; // для watchdog'а "сокет открыт, но молчит" — см. connectWs()
let dealsWs = null;
let tradesCount = 0;
let lastRender = 0;
let maxPairs = 400;
let filtersActive = true;
let wsInitialDataLoaded = false;
let activeStrategy = null; // null = обычные профили (Balanced/Aggressive/...), иначе ключ STRATEGY_DEFS
// Внутри активной стратегии по умолчанию список отсортирован по её score() (рекомендованный порядок).
// Если пользователь кликает по заголовку столбца (объём, цена и т.д.), включаем "ручной" режим —
// список остаётся отфильтрованным по правилам стратегии (match()), но порядок теперь по этому столбцу,
// а не по score. Сбрасывается обратно в false при выборе новой стратегии в applyProfile().
let strategyManualSort = false;
// "Свой график" — резервный канделстик-график по собственным данным MEXC (REST /api/v3/klines),
// используется когда TradingView не индексирует пару или недоступен. См. loadOwnChart()/
// drawCandleChart() ниже; основной график — TradingView-виджет, см. loadTradingView() выше.
// ПОПЫТКА встроить настоящую страницу mexc.com/exchange/... в iframe (round 14) была отклонена по
// факту (и это НЕ то же самое, что TradingView-виджет ниже — тот всегда штатно встраиваемый):
// MEXC технически ПОЗВОЛЯЕТ странице загрузиться в iframe (кросс-доменная навигация проходит
// успешно, contentWindow.location.href исправно бросает SecurityError — то есть формальный признак
// "встраивание не заблокировано" срабатывает), но сама страница определяет факт встраивания на
// стороне JS (типовая защита от clickjacking — проверка window.top !== window.self) и показывает
// вместо графика собственную заглушку с иконкой "недоступно". Это подтверждено скриншотом
// пользователя из реального desktop-приложения. Прочитать ВИЗУАЛЬНОЕ содержимое кросс-доменного
// iframe нельзя ни при каких обстоятельствах (в этом весь смысл iframe-изоляции в браузере) — то есть
// отличить программно "загрузился настоящий график" от "загрузилась заглушка-отказ" невозможно
// принципиально, не только в песочнице разработки. Ссылка "Открыть на бирже" по-прежнему ведёт на
// настоящую страницу mexc.com в обычной вкладке браузера (НЕ в iframe), где эта защита не срабатывает.
let ownChartCandles = null;
let ownChartRefreshTimer = null;
// Инструменты рисования на "своём" графике: курсор/панорама, уровень, трендлиния, линейка.
// Масштаб/сдвиг (ownChartView) и построения (ownChartDrawings) хранятся per-symbol и НЕ должны
// сбрасываться на каждый 15-секундный автообновляющий тик — только при смене монеты (ownChartLoadedRaw).
let ownChartTool = 'cursor';
let ownChartView = { offset: 0, visibleCount: 140 };
let ownChartDrawings = [];
let ownChartPendingTrend = null; // { tool, p1: {t,v} } — первая точка отрезка/луча/прямой уже поставлена, ждём вторую
let ownChartRulerDrag = null;    // { x1,y1,t1,v1, x2,y2,t2,v2 } — активный замер линейкой
let ownChartPanDrag = null;      // { startX, startOffset } — активная панорама
let ownChartHover = null;        // { x, y } — последняя позиция курсора над канвасом (для crosshair)
let ownChartLoadedRaw = null;    // raw-символ, для которого сейчас загружены view/drawings
let ownChartLoadedTF = null;     // ТФ, для которого подобран текущий ownChartView (сбрасываем зум при смене ТФ)
let ownChartType = 'candles';    // 'candles' | 'line' | 'area'
let ownChartShowMA = false;      // скользящие средние MA(7)/MA(25) поверх цены
const OWN_CHART_DRAWINGS_KEY = 'mexc_chart_drawings';

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtNum(n, d) {
  d = d == null ? 2 : d;
  if (n == null || !Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return a < 1 ? n.toFixed(d) : n.toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n) || n === 0) return '--';
  if (n < 0.0001) return n.toFixed(8);
  if (n < 0.001) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  if (n < 10) return n.toFixed(3);
  if (n < 1000) return n.toFixed(2);
  return n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getCoinColor(symbol) {
  const colors = {
    BTC: '#F7931A', ETH: '#627EEA', SOL: '#9945FF', XRP: '#23292F', DOGE: '#C2A633',
    TON: '#0088CC', ADA: '#0033AD', AVAX: '#E84142', LINK: '#2A5ADA', DOT: '#E6007A',
    MATIC: '#8247E5', BNB: '#F3BA2F', ARB: '#2D374B', OP: '#FF0420', SUI: '#4DA2FF',
    APT: '#00B4D8', PEPE: '#3CB371', BONK: '#FF7A00', WIF: '#FF6B6B', SHIB: '#FFA409'
  };
  return colors[symbol.replace('/USDT', '')] || '#6B7280';
}

function getSignal(c) {
  if (c.change24 > 3 && c.vol5s > 0.05) return 'BUY';
  if (c.change24 < -3 && c.vol5s > 0.05) return 'SELL';
  if (c.change24 > 5) return 'BUY';
  if (c.change24 < -5) return 'SELL';
  return 'WAIT';
}

// ============================================
// СТРАТЕГИЧЕСКИЕ ПРОФИЛИ (Алгоритмы / Неэффективности / Пробой плотностей)
// ------------------------------------------------------------------
// Важно: у скринера нет подписки на стакан (order book depth) по всем парам —
// это архитектурно невозможно для всего рынка сразу (лимит MEXC ~30 стримов на
// соединение, а пар — тысячи). Поэтому все 3 стратегии ниже — это ЭВРИСТИКИ,
// построенные только на тиковых данных, которые уже есть у каждой монеты:
// цена, объём 24ч (vol24) и метрики, посчитанные по последним ~60с сделок
// (vol5 — объём за 5с, vol5s/vol30s/vol60s — амплитуда движения цены за
// соответствующее окно, в %). Это приближение, а не точный анализ стакана —
// подписаны прямо в интерфейсе (стр. «Профили»), чтобы не создавать иллюзию
// точности, которой тут нет.
// ============================================
function burstRatio(c) {
  const avgVol5 = c.vol24 > 0 ? c.vol24 / 17280 : 0; // ~кол-во 5с-окон в сутках -> средний объём за 5с
  return avgVol5 > 0 ? c.vol5 / avgVol5 : 0;
}

// Персентиль по числовому массиву (0..1). Пустой массив -> 0.
function percentile(values, p) {
  if (!values || !values.length) return 0;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

// Ниже этого объёма 24ч пара практически мертва: пара сделок в стакане способна за секунды
// увести burst-ratio/волатильность в космос просто из-за крошечного знаменателя — не потому,
// что там реально что-то произошло. Общий пол ликвидности для всех 3 стратегий (см. ниже).
const STRATEGY_MIN_LIQUID_VOL24 = 20000;

// Пороги стратегий пересчитываются от ТЕКУЩЕГО состояния рынка (персентили по парам с ХОТЬ КАКОЙ-ТО
// ликвидностью — см. STRATEGY_MIN_LIQUID_VOL24), а не зашиты фиксированными числами. Это и есть
// доведение "до идеала": на спокойном рынке (низкая волатильность у всех) пороги сами опускаются,
// чтобы стратегия не выдавала пустой список; на бурном рынке — поднимаются, чтобы не заваливать
// кандидатами всё подряд. Важно: мёртвые/почти нулевые по объёму пары ИСКЛЮЧЕНЫ из расчёта самих
// персентилей — иначе их шумные, ничем не подкреплённые всплески (burst-ratio в сотни раз на паре
// центовых сделок) искажали бы адаптивные пороги для всего рынка и в итоге либо пропускали такой же
// мусор в выдачу, либо задирали планку для нормальных ликвидных пар.
function computeStrategyStats() {
  const vol24Arr = [], vol30sArr = [], vol60sArr = [], vol5sArr = [], burstArr = [], cvArr = [];
  for (let i = 0; i < allCoins.length; i++) {
    const c = allCoins[i];
    if (c.vol24 > 0) vol24Arr.push(c.vol24);
    if (c.vol24 < STRATEGY_MIN_LIQUID_VOL24) continue; // не даём мёртвым парам засорять адаптивные пороги
    vol30sArr.push(c.vol30s);
    vol60sArr.push(c.vol60s);
    if (c.vol5s > 0) vol5sArr.push(c.vol5s);
    const b = burstRatio(c);
    if (b > 0) burstArr.push(b);
    if (c.rateCV != null) cvArr.push(c.rateCV);
  }
  return {
    vol24Liquid: percentile(vol24Arr, 0.35) || 100000,     // ликвидность не из нижних 35% пар (для порога отбора)
    vol30sCalm: Math.max(percentile(vol30sArr, 0.55), 0.03),  // "спокойное" движение цены
    vol60sCalm: Math.max(percentile(vol60sArr, 0.6), 0.06),
    vol5sSpike: Math.max(percentile(vol5sArr, 0.85), 0.05),   // резкий 5с-скачок = верхние ~15% ЛИКВИДНОГО рынка
    burstSpike: Math.max(percentile(burstArr, 0.85), 2.5),    // всплеск объёма = верхние ~15% по burst-ratio, тоже только среди ликвидных пар
    steadyCV: Math.max(percentile(cvArr, 0.4), 0.35)          // "равномерная" скорость оборота = нижние ~40% по разбросу
  };
}

let strategyStats = null;

// Формулы ниже опираются на общие, известные по литературе о микроструктуре рынка признаки
// (см. пояснения в самих стратегиях на стр. «Профили»): равномерность оборота как признак
// бота/маркет-мейкера, дивергенция цены и объёма как признак неэффективности, и модель
// "консолидация -> всплеск объёма" (объёмный профиль / high-volume node) как признак пробоя
// плотности. Это по-прежнему эвристики на тиковых данных, не анализ реального стакана.
const STRATEGY_DEFS = {
  algo: {
    label: 'Алгоритмы',
    badge: 'ALGO',
    short: 'Равномерный оборот на всех окнах при сдержанном движении цены — признак маркет-мейкера/бота.',
    desc: 'Ищем пары с ликвидностью не хуже среднерыночной (объём 24ч выше нижних ~35% пар), у которых цена ' +
      'почти не отклоняется сразу на всех трёх окнах — 5с, 30с и 60с (волатильность ниже, чем у большей части ' +
      'рынка прямо сейчас, пороги адаптивные). Дополнительно проверяем РАВНОМЕРНОСТЬ скорости оборота между ' +
      'этими тремя окнами (объём/сек за 5с, 30с и 60с должны быть близки друг к другу) — боты и маркет-мейкеры ' +
      'обычно дробят активность на ровные по времени куски, тогда как органические человеческие всплески дают ' +
      'куда более неравномерную скорость между окнами. Сочетание «стабильный оборот, мало движения, ровный темп» ' +
      'типично для маркет-мейкеров и арбитражных ботов.',
    match: function (c, s) {
      return c.vol24 >= s.vol24Liquid && c.vol5 > 0 && c.vol30s <= s.vol30sCalm && c.vol60s <= s.vol60sCalm &&
        c.vol5s <= s.vol30sCalm * 1.5 && (c.rateCV == null || c.rateCV <= s.steadyCV);
    },
    score: function (c, s) {
      const turnover = c.vol5 / (c.vol30s + 0.01);
      const steadiness = c.rateCV != null ? 1 / (1 + c.rateCV) : 0.5;
      return turnover * (0.5 + steadiness);
    }
  },
  ineff: {
    label: 'Неэффективности',
    badge: 'INEFF',
    short: 'Резкое движение цены БЕЗ подтверждающего объёма — расхождение цены и оборота.',
    desc: 'Ищем пары со средней/тонкой ликвидностью (объём 24ч ниже "ликвидного" порога рынка, но не совсем ' +
      'мёртвые — от 20K USDT) с резким движением цены за последние 5с (верхние ~15% рынка по волатильности 5с ' +
      'прямо сейчас, порог адаптивный) — но при этом БЕЗ пропорционального всплеска объёма (burst-ratio не в ' +
      'верхней зоне рынка). Это ключевое отличие от «Пробоя плотностей»: там движение подтверждено объёмом ' +
      '(через плотность реально прошли крупным потоком), здесь — цена дёрнулась почти без объёма, то есть, ' +
      'по сути, на тонком месте книги ордеров, где её сдвинула небольшая заявка. Такое расхождение цены и ' +
      'оборота — типичный признак локальной неэффективности/дислокации цены, а не устоявшегося тренда.',
    match: function (c, s) {
      return c.vol24 >= STRATEGY_MIN_LIQUID_VOL24 && c.vol24 < s.vol24Liquid * 3 && c.vol5s >= s.vol5sSpike && burstRatio(c) < s.burstSpike;
    },
    score: function (c) {
      // *1000 — чисто косметический масштаб: сырое значение обычно лежит в районе 0.0001-0.01,
      // и бейдж в таблице (toFixed(1)) показывал "0.0" абсолютно у всех строк, не давая никакой
      // информации для сравнения монет глазами. На порядок сортировки и на match() (какие монеты
      // вообще проходят в стратегию) множитель не влияет — это разные, независимые вещи.
      return (c.vol5s / Math.sqrt(Math.max(c.vol24, 1000))) / (1 + burstRatio(c)) * 1000;
    }
  },
  density: {
    label: 'Пробой плотностей',
    badge: 'BREAK',
    short: 'Затишье, затем резкий всплеск объёма выше обычного темпа суток + цена пошла и не откатилась мгновенно.',
    desc: 'Точного анализа плотностей/лимитных стен из стакана скринер не делает (нет подписки на depth ' +
      'по всем парам рынка сразу — физический лимит MEXC на потоки соединения). Вместо этого — приближение ' +
      'по модели объёмного профиля: настоящий пробой плотности (high-volume node) выглядит как ЗАТИШЬЕ ' +
      '(консолидация у уровня — цена почти не двигалась 30-60с назад) с последующим РЕЗКИМ всплеском объёма ' +
      'именно в последние 5с. Поэтому, помимо всплеска объёма за 5с сильно выше обычного темпа суток ' +
      '(burst-ratio, верхние ~15% ЛИКВИДНОГО рынка, адаптивно, — мёртвые пары с объёмом ниже 20K USDT в ' +
      'выдачу не попадают вообще, у них ratio скачет от пары центовых сделок и ничего не значит) и заметного ' +
      'текущего движения цены, дополнительно проверяем, что движение ДО всплеска (в промежутке 60с→30с назад) ' +
      'было спокойным — иначе это, скорее, монета, которая уже была волатильна всю последнюю минуту, а не ' +
      'чистый пробой уровня. И последний фильтр — подтверждение пробоя: сверяем направление последних ~2с ' +
      'движения с направлением всего 5с-всплеска; если цена уже разворачивается против него — это, скорее, ' +
      'фитиль/ложный прокол уровня (не было настоящего "поглощения" плотности), а не устойчивый пробой, и ' +
      'такая монета в выдачу не попадает.',
    match: function (c, s) {
      const burst = burstRatio(c);
      const wasCalm = c.preMove == null || c.preMove <= s.vol30sCalm * 1.4;
      return c.vol24 >= STRATEGY_MIN_LIQUID_VOL24 && burst >= s.burstSpike && c.vol5s >= Math.max(0.02, s.vol30sCalm * 0.5) && wasCalm && !c.reverting;
    },
    score: function (c) {
      const calmBonus = c.preMove != null ? 1 / (1 + c.preMove) : 0.5;
      return burstRatio(c) * (1 + c.vol5s) * (1 + calmBonus);
    }
  }
};

// ============================================
// WATCHLIST (Tier 2) — дешёвый предфильтр рынка (выше) отдаёт сюда кандидатов на ГЛУБОКИЙ анализ.
// ------------------------------------------------------------------
// Скоринг ниже НЕ решает, что монета "интересна" в смысле готового паттерна — это делают
// детекторы Tier 2 (следующий этап). Его единственная задача — дёшево (O(1) на монету, уже готовые
// поля с текущего тика) отранжировать рынок по тому, у кого сейчас происходит хоть что-то
// нестандартное, чтобы ограниченный бюджет WS-подключений на сделки/стакан (см. ниже) тратился не
// вслепую по алфавиту, а на действительно активные монеты прямо сейчас.
// ============================================
// Живое наблюдение (после недели работы Tier 2): формула раньше иногда тянула в watchlist тихие,
// почти мёртвые монеты вместо реально активных. Причина — steadyBonus (бонус за "ровный" оборот,
// сигнатура бота/маркет-мейкера) считался ДАЖЕ у монет, где оборота, по сути, нет вообще: пара
// случайных тиков за 60с тоже даёт низкий rateCV чисто от недостатка данных, а не от реальной
// ровности темпа. В спокойный момент рынка, когда у большинства монет burst=0 и move=0, именно
// эта "ложная стабильность" начинала решать весь рейтинг. Фикс: steadyBonus домножается на
// activityFloor — он больше нуля, только если за последние 5с был хоть какой-то реальный оборот
// ($20+, это уже заметно выше среднего темпа для минимально ликвидной по STRATEGY_MIN_LIQUID_VOL24
// монеты — 20000/17280 5с-окон в сутки ≈ $1.15 в среднем на окно).
function computeWatchlistCandidateScore(c) {
  if (c.vol24 < STRATEGY_MIN_LIQUID_VOL24) return -1; // мёртвая пара — никогда не кандидат
  const burst = burstRatio(c);
  const move = c.vol5s || 0;
  const steadyBonus = c.rateCV != null ? 1 / (1 + c.rateCV) : 0;
  const activityFloor = Math.min(1, (c.vol5 || 0) / 20);
  return burst + move * 100 + steadyBonus * activityFloor;
}

function rawSymbol(sym) {
  return String(sym || '').replace('/', '');
}

function tvSymbol(sym) {
  return 'MEXC:' + rawSymbol(sym);
}

// URL реальной торговой страницы (терминала) MEXC для пары, напр. "BTC/USDT" -> mexc.com/exchange/BTC_USDT
function mexcTerminalUrl(sym) {
  return 'https://www.mexc.com/exchange/' + encodeURIComponent(rawSymbol(sym).replace(/USDT$/, '_USDT'));
}

// Открыть монету в торговом терминале MEXC — в новой вкладке браузера, либо, если приложение запущено
// в Electron-обёртке (window.electronAPI, см. preload.js), через системный браузер по умолчанию.
function openInMexcTerminal(symbol) {
  const url = mexcTerminalUrl(symbol);
  if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ------------------------------------------------------------------
// Копирование тикера для стороннего терминала Vataga.terminal.
// ЧЕСТНОЕ ОГРАНИЧЕНИЕ: настоящая автоматическая линковка "клик в скринере → монета сама открылась
// в стакане Vataga" у Vataga.terminal реально существует (см. их интеграцию с CryptoScreener,
// Tiger.com, MetaScalp и др.), но работает через отдельный протокол связи с terminal-приложением
// на машине пользователя, который Vataga не публикует в открытой документации — это координируется
// напрямую с партнёрами. Угадывать порт/формат сообщений вслепую значит рисковать нерабочей кнопкой.
// Пока протокол не получен от поддержки Vataga, даём рабочий compromise: копируем тикер в буфer
// обмена, чтобы вставить его в поиск терминала вручную одним Ctrl+V.
// ------------------------------------------------------------------
let appToastTimer = null;
function showAppToast(msg) {
  let t = document.getElementById('appToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'appToast';
    t.className = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(appToastTimer);
  appToastTimer = setTimeout(function () { t.classList.remove('visible'); }, 2800);
}

function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

function copySymbolForVataga(symbol) {
  const text = rawSymbol(symbol);
  const announce = function () { showAppToast('Скопировано: ' + text + ' — вставьте в поиск Vataga.terminal (Ctrl+V)'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(announce).catch(function () { fallbackCopyText(text); announce(); });
  } else {
    fallbackCopyText(text);
    announce();
  }
}

// Десктоп-версия (Windows) встроена в саму страницу как base64 — ZIP с exe + bat-скриптом авторазблокировки
// (см. <script id="desktopAppData"> в конце файла). Скачивание работает без стороннего хостинга, прямо из HTML.
function downloadDesktopApp() {
  const holder = document.getElementById('desktopAppData');
  if (!holder || !holder.textContent) {
    showModal('Недоступно', 'Файл приложения не встроен в эту сборку скринера.');
    return;
  }
  try {
    const b64 = holder.textContent.trim();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'MEXC-Screener-Windows.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    showModal('Загрузка началась',
      'MEXC-Screener-Windows.zip (~0.8 МБ) сохраняется в папку загрузок браузера.\n\n' +
      'Windows блокирует запуск любого .exe без платной подписи издателя — поэтому внутри архива, ' +
      'помимо MEXC-Screener.exe, лежит файл «Запустить.bat»: он снимает эту блокировку и сразу ' +
      'открывает приложение.\n\n' +
      '1) Распакуйте архив целиком в одну папку (файлы должны остаться рядом друг с другом).\n' +
      '2) Запустите «Запустить.bat» — дальше можно открывать сам .exe напрямую.');
  } catch (e) {
    showModal('Ошибка', 'Не удалось подготовить файл для скачивания: ' + e.message);
  }
}

function cmpOp(op, a, b) {
  if (op === '>') return a > b;
  if (op === '>=') return a >= b;
  if (op === '<') return a < b;
  if (op === '<=') return a <= b;
  return true;
}

function isUsdtSpot(symbol) {
  if (!symbol || !symbol.endsWith('USDT')) return false;
  if (LEV_RE.test(symbol)) return false;
  if (symbol.indexOf('_') !== -1) return false;
  return true;
}

function pushSnap(symbol, price, quoteVol) {
  const now = Date.now();
  let arr = snapshots.get(symbol);
  if (!arr) { arr = []; snapshots.set(symbol, arr); }
  const last = arr[arr.length - 1];
  if (last && now - last.t < 900) {
    last.p = price; last.q = quoteVol; last.t = now;
  } else {
    arr.push({ t: now, p: price, q: quoteVol });
  }
  const cut = now - 70000;
  while (arr.length && arr[0].t < cut) arr.shift();
}

function metricsFromSnaps(symbol, price, quoteVol) {
  const arr = snapshots.get(symbol) || [];
  const now = Date.now();
  function at(ms) {
    const target = now - ms;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].t <= target) return arr[i];
    }
    return arr[0] || null;
  }
  const s2 = at(2000);
  const s5 = at(5000);
  const s30 = at(30000);
  const s60 = at(60000);
  const vol5 = s5 ? Math.max(0, quoteVol - s5.q) : 0;
  const vol30 = s30 ? Math.max(0, quoteVol - s30.q) : 0;
  const vol60 = s60 ? Math.max(0, quoteVol - s60.q) : 0;
  const vol5s = s5 && s5.p ? Math.abs(price - s5.p) / s5.p * 100 : 0;
  const vol30s = s30 && s30.p ? Math.abs(price - s30.p) / s30.p * 100 : 0;
  const vol60s = s60 && s60.p ? Math.abs(price - s60.p) / s60.p * 100 : 0;
  // "Мгновенный откат" — сверяем направление ПОСЛЕДНЕГО отрезка движения (последние ~2с) с
  // направлением всего 5с-всплеска: если цена уже разворачивается против него, это скорее фитиль/
  // ложный прокол уровня, чем устойчивый пробой (см. STRATEGY_DEFS.density — "нет мгновенного
  // возврата" из чек-листа подтверждения пробоя). Тиковых данных стакана нет, поэтому это приближение
  // по двум последним снимкам цены, а не honest tick-by-tick анализ, но оно ловит самый грубый случай:
  // цена дёрнулась и тут же пошла обратно.
  let reverting = false;
  if (s2 && s2.p && s5 && s5.p) {
    const fullMove = price - s5.p;
    const recentMove = price - s2.p;
    if (Math.abs(fullMove) > 1e-12 && Math.abs(recentMove) > 1e-12) {
      reverting = (fullMove > 0) !== (recentMove > 0);
    }
  }
  // "Досплесковая" фаза: движение цены между 60с-назад и 30с-назад, ДО текущего всплеска в
  // последние 5с. Нужно, чтобы отличить настоящий пробой плотности (сначала штиль/консолидация,
  // потом резкий всплеск) от монеты, которая просто уже волатильна последнюю минуту подряд.
  const preMove = (s60 && s30 && s60.p) ? Math.abs(s30.p - s60.p) / s60.p * 100 : null;
  // Цены-границы "досплесковой" зоны (для отображения на панели плотности рядом с графиком) —
  // просто минимум/максимум цены в точках 60с-назад и 30с-назад, без претензии на точный анализ стакана.
  const zoneLow = (s60 && s30) ? Math.min(s60.p, s30.p) : null;
  const zoneHigh = (s60 && s30) ? Math.max(s60.p, s30.p) : null;
  // Скорость оборота (объём/сек) в трёх окнах — устойчивая, почти одинаковая скорость во всех
  // окнах характерна для равномерной алгоритмической/маркет-мейкерской активности (см. заметки
  // исследования: боты часто дробят объём на равномерные по времени куски); резкие человеческие
  // всплески дают куда более неравномерную скорость между окнами.
  const rate5 = vol5 / 5;
  const rate30 = s30 ? vol30 / 30 : null;
  const rate60 = s60 ? vol60 / 60 : null;
  const rates = [rate5, rate30, rate60].filter(function (r) { return r != null; });
  let rateCV = null;
  if (rates.length >= 2) {
    const mean = rates.reduce(function (a, b) { return a + b; }, 0) / rates.length;
    if (mean > 0) {
      const variance = rates.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / rates.length;
      rateCV = Math.sqrt(variance) / mean;
    }
  }
  return { vol5: vol5, vol30: vol30, vol60: vol60, vol5s: vol5s, vol30s: vol30s, vol60s: vol60s, preMove: preMove, rateCV: rateCV, zoneLow: zoneLow, zoneHigh: zoneHigh, reverting: reverting };
}

function upsertCoin(row) {
  const symbolRaw = row.symbol || row.s;
  if (!isUsdtSpot(symbolRaw)) return null;
  const base = symbolRaw.replace(/USDT$/, '');
  const display = base + '/USDT';
  const price = num(row.lastPrice != null ? row.lastPrice : (row.r != null ? row.r : row.price));
  const change24 = num(row.priceChangePercent != null ? row.priceChangePercent : row.p);
  const vol24 = num(row.quoteVolume != null ? row.quoteVolume : row.q);
  const high = num(row.highPrice != null ? row.highPrice : row.h);
  const low = num(row.lowPrice != null ? row.lowPrice : row.l);
  if (!price) return null;

  pushSnap(display, price, vol24);
  const m = metricsFromSnaps(display, price, vol24);
  const prev = coinMap.get(display);
  const coin = {
    symbol: display,
    raw: symbolRaw,
    baseAsset: base,
    price: price,
    change24: change24,
    vol24: vol24,
    high: high,
    low: low,
    vol5: m.vol5,
    vol30: m.vol30,
    vol60: m.vol60,
    vol5s: m.vol5s,
    vol30s: m.vol30s,
    vol60s: m.vol60s,
    preMove: m.preMove,
    rateCV: m.rateCV,
    zoneLow: m.zoneLow,
    zoneHigh: m.zoneHigh,
    reverting: m.reverting,
    fav: prev ? prev.fav : false,
    color: getCoinColor(display)
  };
  coin.signal = getSignal(coin);
  coin.__wlScore = computeWatchlistCandidateScore(coin);
  coinMap.set(display, coin);
  return coin;
}

function rebuildList() {
  if (tableHoverFreezeSymbol) {
    // Курсор на строке — applySortOnly() ниже намеренно не пересортирует (заморозка порядка), но
    // upsertCoin() на каждый тик создаёт НОВЫЙ объект монеты (не мутирует старый), поэтому просто
    // перечитать coinMap.values() всё равно означало бы отдать порядок вставки в Map, а не текущий
    // видимый порядок строк. Сохраняем текущую позицию каждой монеты, обновляя её на свежий объект
    // из coinMap — значения в ячейках живые, порядок строк не скачет, пока курсор не уйдёт со стола.
    const known = new Set();
    allCoins = allCoins.map(function (c) {
      const fresh = coinMap.get(c.symbol);
      if (fresh) known.add(c.symbol);
      return fresh || c;
    });
    coinMap.forEach(function (c, symbol) { if (!known.has(symbol)) allCoins.push(c); });
  } else {
    allCoins = Array.from(coinMap.values());
  }
  applySortOnly();
}

function applySortOnly() {
  if (activeStrategy && STRATEGY_DEFS[activeStrategy]) {
    // Score считаем всегда, пока стратегия активна — он нужен и для бейджа в таблице, и как
    // сортировка по умолчанию. Но если пользователь кликнул по столбцу (strategyManualSort),
    // порядок ниже отдаём обычной сортировке по столбцу — только сам score пересчитываем здесь.
    strategyStats = computeStrategyStats();
    const def = STRATEGY_DEFS[activeStrategy];
    allCoins.forEach(function (c) { c.__score = def.score(c, strategyStats); });
    if (!strategyManualSort) {
      if (tableHoverFreezeSymbol) return; // курсор на строке — значения выше уже обновили, порядок не трогаем
      allCoins.sort(function (a, b) { return b.__score - a.__score; });
      return;
    }
  }
  if (tableHoverFreezeSymbol) return;
  allCoins.sort(function (a, b) {
    let va = a[sortField], vb = b[sortField];
    // Внутри стратегии колонки "Сигнал" как таковой нет (в этом режиме её заменяет score-бейдж) —
    // клик по этому столбцу логично трактовать как "отсортировать по score", а не по пустому полю.
    if (activeStrategy && STRATEGY_DEFS[activeStrategy] && sortField === 'signal') { va = a.__score; vb = b.__score; }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });
}

function parseFilterVal(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const s = String(el.value).trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function coinPassesFilters(c) {
  const q = searchQuery.toLowerCase();
  if (q && c.symbol.toLowerCase().indexOf(q) === -1 && c.baseAsset.toLowerCase().indexOf(q) === -1) return false;
  if (activeStrategy && STRATEGY_DEFS[activeStrategy]) {
    if (!strategyStats) strategyStats = computeStrategyStats();
    if (!STRATEGY_DEFS[activeStrategy].match(c, strategyStats)) return false;
  }

  function check(opId, valId, field) {
    const v = parseFilterVal(valId);
    if (v == null) return true;
    const op = document.getElementById(opId).value;
    return cmpOp(op, c[field], v);
  }
  if (!check('filterVol24Op', 'filterVol24', 'vol24')) return false;
  if (!check('filterVol5Op', 'filterVol5', 'vol5')) return false;
  if (!check('filterVol5sOp', 'filterVol5s', 'vol5s')) return false;
  if (!check('filterVol30sOp', 'filterVol30s', 'vol30s')) return false;
  if (!check('filterChgOp', 'filterChg', 'change24')) return false;
  const from = parseFilterVal('filterPriceFrom');
  const to = parseFilterVal('filterPriceTo');
  if (from != null && c.price < from) return false;
  if (to != null && c.price > to) return false;
  return true;
}

function getFilteredCoins() {
  return allCoins.filter(coinPassesFilters);
}

// Полный список прошедших фильтр (без обрезки maxPairs) + обрезанный до maxPairs список для рендера.
function getVisibleCoins() {
  return getFilteredCoins().slice(0, maxPairs);
}

// Коротко пульсирует свечением значение метрики топ-бара, только если оно реально изменилось
// с прошлой отрисовки — не превращать "Показано/Пары" в мигающий счётчик на каждый тик.
function setMetricValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const str = String(value);
  if (prevMetricValues.get(id) !== str) {
    el.textContent = str;
    if (prevMetricValues.has(id)) {
      el.classList.remove('metric-pulse');
      void el.offsetWidth; // форсируем reflow, чтобы анимация переиграла даже при быстрых повторных изменениях
      el.classList.add('metric-pulse');
    }
    prevMetricValues.set(id, str);
  }
}

function renderTable() {
  const tbody = document.getElementById('tableBody');
  const grid = document.getElementById('gridView');
  const filtered = getFilteredCoins();
  const visible = filtered.slice(0, maxPairs);
  // Первая отрисовка таблицы (пустая на старте) — плитки строк проигрывают лёгкую анимацию
  // появления; на всех последующих (живых) обновлениях анимация не переигрывается, чтобы не мигало.
  const isFirstFill = tbody.children.length === 0 || tbody.querySelector('.empty-state');
  // Если пар, прошедших фильтр, больше чем "Максимум пар в таблице" (Настройки), часть монет
  // не попадёт в таблицу — это отдельный лимит, не связанный с фильтрами. Показываем оба числа,
  // чтобы не создавалось впечатление, будто монета "не прошла фильтр", когда она просто обрезана лимитом.
  document.getElementById('filterCount').textContent = filtered.length > visible.length
    ? visible.length + ' из ' + filtered.length + ' (лимит) / ' + allCoins.length
    : visible.length + ' / ' + allCoins.length;
  if (activeStrategy && STRATEGY_DEFS[activeStrategy]) {
    const hintCountEl = document.getElementById('strategyHintCount');
    if (hintCountEl) hintCountEl.textContent = filtered.length + ' из ' + allCoins.length + ' пар';
  }
  setMetricValue('metricShown', visible.length);
  setMetricValue('metricCoins', allCoins.length);
  document.getElementById('navFavBadge').textContent = allCoins.filter(function (c) { return c.fav; }).length;

  if (!allCoins.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state"><i class="ri-database-2-line"></i>Нет данных MEXC. Ожидание WebSocket...</td></tr>';
    grid.innerHTML = '';
    return;
  }
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state"><i class="ri-filter-off-line"></i>Нет пар по текущим фильтрам. Сбросьте фильтры или подождите накопления 5с-метрик.</td></tr>';
    grid.innerHTML = '';
    return;
  }

  const stratDef = activeStrategy ? STRATEGY_DEFS[activeStrategy] : null;
  tbody.innerHTML = visible.map(function (c, i) {
    const chg = c.change24 || 0;
    const sel = currentCoin && c.symbol === currentCoin.symbol;
    const sig = (c.signal || 'WAIT').toLowerCase();
    const signalCell = stratDef
      ? '<span class="signal-badge signal-strategy" title="' + stratDef.short.replace(/"/g, '&quot;') + '"><span class="dot dot-strategy"></span>' + stratDef.badge + ' ' + (c.__score || 0).toFixed(1) + '</span>'
      : '<span class="signal-badge signal-' + sig + '"><span class="dot dot-' + sig + '"></span>' + c.signal + '</span>';
    const rowAnim = isFirstFill ? ' row-enter" style="animation-delay:' + Math.min(i, 24) * 12 + 'ms' : '';
    return '<tr data-symbol="' + c.symbol + '" class="' + (sel ? 'selected' : '') + rowAnim + '">' +
      '<td><i class="ri-star-line star ' + (c.fav ? 'active' : '') + '" data-symbol="' + c.symbol + '"></i></td>' +
      '<td>' + (i + 1) + '</td>' +
      '<td><div class="coin-cell"><div class="coin-icon" style="background:' + c.color + '">' + c.baseAsset.charAt(0) + '</div><span>' + c.symbol + '</span></div></td>' +
      '<td class="cell-price">' + fmtPrice(c.price) + '</td>' +
      '<td class="' + (chg >= 0 ? 'price-up' : 'price-down') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</td>' +
      '<td>' + fmtNum(c.vol24) + '</td>' +
      '<td>' + fmtNum(c.vol5) + '</td>' +
      '<td>' + c.vol5s.toFixed(3) + '%</td>' +
      '<td>' + c.vol30s.toFixed(3) + '%</td>' +
      '<td>' + c.vol60s.toFixed(3) + '%</td>' +
      '<td>' + signalCell + '</td></tr>';
  }).join('');

  grid.innerHTML = visible.map(function (c) {
    const chg = c.change24 || 0;
    const sel = currentCoin && c.symbol === currentCoin.symbol;
    return '<div class="grid-card ' + (sel ? 'selected' : '') + '" data-symbol="' + c.symbol + '">' +
      '<div class="grid-card-top"><div class="coin-icon" style="background:' + c.color + '">' + c.baseAsset.charAt(0) + '</div><strong>' + c.symbol + '</strong></div>' +
      '<div class="grid-card-price">' + fmtPrice(c.price) + '</div>' +
      '<div class="' + (chg >= 0 ? 'price-up' : 'price-down') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div>' +
      '<div class="grid-card-meta"><span>24ч ' + fmtNum(c.vol24) + '</span><span>5с ' + fmtNum(c.vol5) + '</span></div></div>';
  }).join('');

  function bindSelect(el) {
    el.addEventListener('click', function (e) {
      if (e.target.closest('.star')) return;
      selectCoin(el.dataset.symbol);
    });
  }
  tbody.querySelectorAll('tr[data-symbol]').forEach(bindSelect);
  grid.querySelectorAll('.grid-card').forEach(bindSelect);
  tbody.querySelectorAll('.star').forEach(function (star) {
    star.addEventListener('click', function (e) {
      e.stopPropagation();
      const coin = coinMap.get(this.dataset.symbol);
      if (!coin) return;
      coin.fav = !coin.fav;
      this.classList.toggle('active', coin.fav);
      updateFavoritesPage();
      updateFavButton();
      document.getElementById('navFavBadge').textContent = allCoins.filter(function (c) { return c.fav; }).length;
    });
  });

  updateProfilesPage();
}

// Один раз на статичных контейнерах (не на строках — те пересоздаются каждый рендер) — делегированное
// наведение, включает/выключает tableHoverFreezeSymbol (см. её объявление и использование в applySortOnly).
// mouseover/mouseout (а не mouseenter/mouseleave) специально — те не всплывают, делегирование через
// closest() работает только с всплывающими событиями.
(function wireTableHoverFreeze() {
  function onOver(e) {
    const row = e.target.closest('tr[data-symbol], .grid-card[data-symbol]');
    if (row) tableHoverFreezeSymbol = row.dataset.symbol;
  }
  function onOut(e) {
    const row = e.target.closest('tr[data-symbol], .grid-card[data-symbol]');
    if (!row) return;
    // Если ушли на дочерний элемент той же строки — ещё не покинули её, курсор всё ещё внутри.
    if (row.contains(e.relatedTarget)) return;
    if (tableHoverFreezeSymbol === row.dataset.symbol) tableHoverFreezeSymbol = null;
  }
  const tbody = document.getElementById('tableBody');
  const grid = document.getElementById('gridView');
  if (tbody) { tbody.addEventListener('mouseover', onOver); tbody.addEventListener('mouseout', onOut); }
  if (grid) { grid.addEventListener('mouseover', onOver); grid.addEventListener('mouseout', onOut); }
})();

// Клик по карточке паттерна (стр. «Паттерны») — открыть график + стакан этой монеты на «Скринере».
// Делегирование на статичном #patternsGrid, а не на самих карточках — те пересоздаются каждый прогон
// детекторов (раз в PATTERN_DETECT_INTERVAL_MS), навешивать заново незачем.
function openCoinFromPattern(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin) return;
  switchPage('screener');
  selectCoin(symbol, true);
}
(function wirePatternCardClick() {
  const grid = document.getElementById('patternsGrid');
  if (!grid) return;
  grid.addEventListener('click', function (e) {
    const card = e.target.closest('.pattern-card[data-symbol]');
    if (card) openCoinFromPattern(card.dataset.symbol);
  });
})();

function selectCoin(symbol, forceChart) {
  const coin = coinMap.get(symbol);
  if (!coin) return;
  currentCoin = coin;
  updateInfoPanel();
  renderTable();
  loadTrades(coin.raw);
  if (forceChart || chartSymbol !== coin.symbol) {
    loadExchangeChart(coin.symbol, currentTF);
  }
}

// Основной график — TradingView-виджет по умолчанию (не встраивание САМОЙ страницы mexc.com — та
// попытка была заблокирована биржей, см. docs/14-round14.md, — а официальный embeddable-виджет
// TradingView, штатно предназначенный именно для встраивания). Не все пары MEXC индексируются
// TradingView — для них (и вручную, кнопкой) доступен резервный canvas-график по собственным
// данным MEXC (REST /api/v3/klines, см. loadOwnChart ниже). Выбор запоминается per-symbol
// (ownChartModeMemory) — если для конкретной пары один раз переключились на свой график, при
// следующем открытии этой же пары снова не будет попытки грузить заведомо неработающий TradingView.
const CHART_MODE_KEY = 'mexc_chart_mode';
let ownChartModeMemory = (function loadChartModeMemory() {
  try {
    const raw = localStorage.getItem(CHART_MODE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) { return {}; }
})();
function rememberChartMode(symbol, mode) {
  if (mode === 'own') ownChartModeMemory[symbol] = 'own';
  else delete ownChartModeMemory[symbol];
  try { persistSet(CHART_MODE_KEY, JSON.stringify(ownChartModeMemory)); } catch (e) { /* переживём без сохранения между сессиями */ }
}

function loadExchangeChart(symbol, tf) {
  const container = document.getElementById('tv_chart_container');
  if (!container || !symbol) return;
  chartSymbol = symbol;
  currentTF = tf || currentTF;

  const mexcLink = document.getElementById('openOnMexcLink');
  if (mexcLink) {
    mexcLink.href = mexcTerminalUrl(symbol);
    mexcLink.style.display = 'inline-flex';
  }
  const copyBtn = document.getElementById('copyForVatagaBtn');
  if (copyBtn) copyBtn.style.display = 'inline-flex';
  const toggleBtn = document.getElementById('toggleOwnChartBtn');
  if (toggleBtn) toggleBtn.style.display = 'inline-flex';
  updateToggleChartBtnLabel();

  if (ownChartModeMemory[symbol] === 'own') {
    switchToOwnChartUi();
    loadOwnChart();
    startOwnChartAutoRefresh();
  } else {
    loadTradingView(symbol, tf);
  }
}

function updateToggleChartBtnLabel() {
  const label = document.getElementById('toggleOwnChartLabel');
  if (!label || !chartSymbol) return;
  label.textContent = ownChartModeMemory[chartSymbol] === 'own' ? 'TradingView' : 'Свой график';
}

function switchToTradingViewUi() {
  const tvBox = document.getElementById('tv_chart_container');
  const ownBox = document.getElementById('ownChartContainer');
  const ph = document.getElementById('chartPlaceholder');
  stopOwnChartAutoRefresh();
  if (ownBox) ownBox.style.display = 'none';
  if (ph) ph.style.display = 'none';
  if (tvBox) tvBox.style.display = 'block';
}

function switchToOwnChartUi() {
  const tvBox = document.getElementById('tv_chart_container');
  const ownBox = document.getElementById('ownChartContainer');
  const ph = document.getElementById('chartPlaceholder');
  if (tvBox) tvBox.style.display = 'none';
  if (ph) ph.style.display = 'none';
  if (ownBox) ownBox.style.display = 'flex';
}

// Официальный embeddable-виджет TradingView (s3.tradingview.com/tv.js, подключён в index.html).
// Если библиотека не загрузилась (нет сети до TradingView, заблокирована и т.п.) или сам виджет
// бросил исключение при инициализации — тихий откат на свой график, тот же принцип, что и раньше
// у ручного переключения (нельзя программно узнать, что TradingView "не смог" именно НЕ НАЙТИ пару —
// не путать со сбоем загрузки библиотеки, который проверяем явно).
const TV_INTERVAL_MAP = { '1': '1', '5': '5', '15': '15', '30': '30', '60': '60', '240': '240', 'D': 'D' };
function loadTradingView(symbol, tf) {
  const container = document.getElementById('tv_chart_container');
  if (!container) return;
  if (typeof TradingView === 'undefined' || !TradingView.widget) {
    logW('Chart', 'библиотека TradingView не загрузилась (нет сети или заблокирована) — откат на свой график');
    rememberChartMode(symbol, 'own');
    switchToOwnChartUi();
    loadOwnChart();
    startOwnChartAutoRefresh();
    updateToggleChartBtnLabel();
    return;
  }
  switchToTradingViewUi();
  container.innerHTML = '';
  try {
    new TradingView.widget({
      container_id: 'tv_chart_container',
      autosize: true,
      symbol: tvSymbol(symbol),
      interval: TV_INTERVAL_MAP[tf] || '5',
      timezone: 'Etc/UTC',
      theme: darkTheme ? 'dark' : 'light',
      style: '1',
      locale: 'ru',
      toolbar_bg: darkTheme ? '#131722' : '#f1f3f6',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      details: false,
      hotlist: false,
      calendar: false
    });
  } catch (e) {
    logW('Chart', 'TradingView widget не смог инициализироваться (' + e.message + ') — откат на свой график');
    rememberChartMode(symbol, 'own');
    switchToOwnChartUi();
    loadOwnChart();
    startOwnChartAutoRefresh();
    updateToggleChartBtnLabel();
  }
}

// ------------------------------------------------------------------
// "Свой график" — резервный график по собственным данным MEXC (REST /api/v3/klines, публичный
// эндпоинт, подписи не требует), для пар, которые TradingView не показывает вообще ("этого
// инструмента не существует"). Переключается вручную кнопкой у графика — определить автоматически,
// что TradingView не смог отрисовать нужный символ, нельзя (кросс-доменный iframe, см. комментарий
// в loadTradingView выше), поэтому решение оставляем за пользователем.
// ------------------------------------------------------------------
function mexcKlineInterval(tf) {
  const map = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '60m', '240': '4h', 'D': '1d' };
  return map[tf] || '5m';
}

async function fetchKlines(raw, tf, limit) {
  const url = MEXC_REST + '/api/v3/klines?symbol=' + encodeURIComponent(raw) + '&interval=' + mexcKlineInterval(tf) + '&limit=' + (limit || 200);
  let bodyText = null;
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, 10000);
    if (!res.ok) throw new Error('MEXC ответил ' + res.status);
    bodyText = await res.text();
  } catch (browserErr) {
    // Браузер не смог достучаться ("Failed to fetch" — CORS, сеть или антивирус блокирует запрос) —
    // в desktop-приложении пробуем в обход через curl.exe, точно так же, как для подписанных запросов
    // аккаунта (см. mexcSignedRequest/nativeCurlGet). В обычной веб-версии обходного пути нет —
    // тогда просто отдаём исходную ошибку браузера.
    let native = null;
    try {
      native = await nativeCurlGet(url, null);
    } catch (nativeErr) {
      throw new Error('Браузер не смог загрузить данные (' + browserErr.message + '), запасной путь через curl.exe тоже не сработал: ' + nativeErr.message);
    }
    if (!native) throw browserErr;
    bodyText = native.body;
  }
  let data;
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error('Некорректный ответ MEXC'); }
  if (!Array.isArray(data)) throw new Error((data && data.msg) ? data.msg : 'Некорректный ответ MEXC');
  return data.map(function (k) {
    return { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) };
  }).filter(function (k) { return Number.isFinite(k.o) && Number.isFinite(k.c) && Number.isFinite(k.h) && Number.isFinite(k.l); });
}

// Последние сделки по паре через публичный REST (без подписи) — используется для мгновенного
// "затравочного" наполнения панели "Последние сделки", чтобы не держать пользователя перед вечным
// спиннером в ожидании первой живой сделки по WebSocket (для тихих пар это может занять минуты).
async function fetchRecentTrades(raw, limit) {
  const url = MEXC_REST + '/api/v3/trades?symbol=' + encodeURIComponent(raw) + '&limit=' + (limit || 30);
  let bodyText = null;
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, 10000);
    if (!res.ok) throw new Error('MEXC ответил ' + res.status);
    bodyText = await res.text();
  } catch (browserErr) {
    let native = null;
    try {
      native = await nativeCurlGet(url, null);
    } catch (nativeErr) {
      throw new Error('Браузер не смог загрузить данные (' + browserErr.message + '), запасной путь через curl.exe тоже не сработал: ' + nativeErr.message);
    }
    if (!native) throw browserErr;
    bodyText = native.body;
  }
  let data;
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error('Некорректный ответ MEXC'); }
  if (!Array.isArray(data)) throw new Error((data && data.msg) ? data.msg : 'Некорректный ответ MEXC');
  // isBuyerMaker=true — сделка исполнена по встречной заявке покупателя (агрессор был продавцом) → SELL.
  return data.map(function (d) {
    return { price: Number(d.price), qty: Number(d.qty), time: Number(d.time), buy: !d.isBuyerMaker };
  }).filter(function (d) { return Number.isFinite(d.price) && Number.isFinite(d.qty); });
}

// Один DOM-узел строки в ленте сделок — переиспользуется и для REST-затравки (история), и для
// живых сделок по WebSocket (animate=true даёт fade-in анимацию только для только что пришедших).
function createTradeRow(price, qty, buy, timeMs, animate) {
  const row = document.createElement('div');
  row.className = 'trade-row' + (animate ? ' flash-in' : '') + ' ' + (buy ? 'side-buy' : 'side-sell');
  const time = new Date(timeMs || Date.now()).toTimeString().slice(0, 8);
  row.innerHTML = '<span class="trade-time">' + time + '</span>' +
    '<span class="trade-side ' + (buy ? 'price-up' : 'price-down') + '">' + (buy ? 'BUY' : 'SELL') + '</span>' +
    '<span class="trade-price">' + fmtPrice(price) + '</span>' +
    '<span class="trade-amount">' + fmtNum(qty, 4) + '</span>';
  return row;
}

// Построения (уровни/трендлинии) хранятся в localStorage по raw-символу, чтобы не потерять их
// при переключении между монетами. Трендлинии хранят АБСОЛЮТНЫЕ метки времени точек (не индексы
// свечей), т.к. при каждой перезагрузке окно свечей сдвигается — переводим t → x через интервал.
function loadOwnChartDrawings(raw) {
  try {
    const all = JSON.parse(localStorage.getItem(OWN_CHART_DRAWINGS_KEY) || '{}');
    return Array.isArray(all[raw]) ? all[raw] : [];
  } catch (e) { return []; }
}
function saveOwnChartDrawings(raw, drawings) {
  try {
    const all = JSON.parse(localStorage.getItem(OWN_CHART_DRAWINGS_KEY) || '{}');
    if (drawings.length) all[raw] = drawings; else delete all[raw];
    persistSet(OWN_CHART_DRAWINGS_KEY, JSON.stringify(all));
  } catch (e) { /* localStorage недоступен — молча игнорируем */ }
}

function setOwnChartTool(tool) {
  ownChartTool = tool;
  ownChartPendingTrend = null;
  document.querySelectorAll('.ochart-tool[data-tool]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tool') === tool);
  });
  updateOchartHint();
}

function updateOchartHint() {
  const hint = document.getElementById('ochartHint');
  if (!hint) return;
  const hints = {
    cursor: 'Колесо мыши — масштаб, зажать и тащить — панорама',
    hline: 'Кликните по графику, чтобы поставить уровень',
    trend: 'Кликните дважды — начало и конец отрезка',
    ray: 'Кликните дважды — точка старта и направление луча',
    xline: 'Кликните дважды — прямая пройдёт через обе точки',
    ruler: 'Зажмите и тащите для замера цены/времени/баров'
  };
  hint.textContent = hints[ownChartTool] || '';
}

async function loadOwnChart() {
  const canvas = document.getElementById('ownCandleChart');
  const emptyEl = document.getElementById('ownChartEmpty');
  if (!canvas || !currentCoin) return;
  const watermarkEl = document.getElementById('ochartWatermark');
  if (watermarkEl) watermarkEl.textContent = currentCoin.symbol;
  // Построения (уровни/трендлинии) подгружаются только при смене монеты — иначе периодический
  // автообновляющий тик (каждые 15с) стирал бы их. Масштаб/сдвиг (ownChartView) сбрасываем и при
  // смене монеты, и при смене таймфрейма — окно, подобранное для 5м, бессмысленно на графике 1д.
  const symbolChanged = currentCoin.raw !== ownChartLoadedRaw;
  if (symbolChanged) {
    ownChartDrawings = loadOwnChartDrawings(currentCoin.raw);
    ownChartPendingTrend = null;
    ownChartRulerDrag = null;
    ownChartLoadedRaw = currentCoin.raw;
  }
  if (symbolChanged || currentTF !== ownChartLoadedTF) {
    ownChartView = { offset: 0, visibleCount: 140 };
    ownChartLoadedTF = currentTF;
  }
  if (emptyEl && !ownChartCandles) {
    emptyEl.style.display = 'flex';
    emptyEl.innerHTML = '<i class="ri-loader-4-line spin-icon"></i><span>Загружаем данные MEXC...</span>';
  }
  try {
    const candles = await fetchKlines(currentCoin.raw, currentTF, 300);
    if (!candles.length) throw new Error('Нет данных по этой паре');
    ownChartCandles = candles;
    if (emptyEl) emptyEl.style.display = 'none';
    drawCandleChart(canvas, candles);
    wireOwnChartInteractions(canvas);
  } catch (e) {
    ownChartCandles = null;
    if (emptyEl) {
      emptyEl.style.display = 'flex';
      emptyEl.innerHTML = '<i class="ri-error-warning-line"></i><span>Не удалось загрузить данные MEXC: ' + (e && e.message ? e.message : e) + '</span>';
    }
  }
}

function startOwnChartAutoRefresh() {
  stopOwnChartAutoRefresh();
  ownChartRefreshTimer = setInterval(function () {
    if (currentCoin) loadOwnChart();
  }, 15000);
}
function stopOwnChartAutoRefresh() {
  if (ownChartRefreshTimer) { clearInterval(ownChartRefreshTimer); ownChartRefreshTimer = null; }
}

function ochartTimeLabel(t, spanMs) {
  const d = new Date(t);
  // Если видимое окно короче суток — показываем только время, иначе дату+время.
  if (spanMs < 24 * 3600 * 1000) return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const OCHART_UP = '#26A69A', OCHART_DOWN = '#EF5350';
const OCHART_MA1 = '#FFB800', OCHART_MA2 = '#1E80FF';

// Простая скользящая средняя по закрытиям, посчитанная по ВСЕМУ массиву свечей (не по видимому
// срезу) — иначе значения на левом краю видимого окна были бы неверны/отсутствовали бы.
function ochartSMA(candles, period) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= period) sum -= candles[i - period].c;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Канделстик/линия/область-график: сетка (гориз.+верт.), подписи цены справа и времени снизу,
// объём отдельной панелью снизу (как в TradingView), опциональные MA(7)/MA(25), watermark с
// тикером, построения пользователя (уровни/трендлинии), линейка, полный crosshair с легендой
// OHLC+Vol в левом верхнем углу и подсвеченный бейдж последней цены на правой оси.
function drawCandleChart(canvas, candles) {
  if (!canvas || !candles || candles.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 400, h = canvas.clientHeight || 260;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padRight = 58, padTop = 10, padBottom = 20;
  const plotW = w - padRight, plotHTotal = h - padTop - padBottom;
  const volumeH = Math.round(plotHTotal * 0.16);
  const paneGap = 6;
  const plotH = plotHTotal - volumeH - paneGap;
  const volTop = padTop + plotH + paneGap;

  const n = candles.length;
  const intervalMs = (candles[1].t - candles[0].t) || 60000;

  // --- видимое окно (зум/пан) ---
  let visibleCount = Math.round(ownChartView.visibleCount || 140);
  visibleCount = Math.max(20, Math.min(n, visibleCount));
  const maxOffset = Math.max(0, n - visibleCount);
  let offset = Math.round(ownChartView.offset || 0);
  offset = Math.max(0, Math.min(maxOffset, offset));
  ownChartView.visibleCount = visibleCount;
  ownChartView.offset = offset;

  const startIdx = n - visibleCount - offset;
  const endIdx = n - offset;
  const slice = candles.slice(startIdx, endIdx);
  if (!slice.length) return;

  const liveBtn = document.getElementById('ochartLiveBtn');
  if (liveBtn) liveBtn.classList.toggle('show', offset > 0);

  let min = Math.min.apply(null, slice.map(function (k) { return k.l; }));
  let max = Math.max.apply(null, slice.map(function (k) { return k.h; }));
  if (min === max) { min -= 1; max += 1; }
  const pricePad = (max - min) * 0.08;
  min -= pricePad; max += pricePad;

  let maxVol = Math.max.apply(null, slice.map(function (k) { return k.v; }));
  if (!Number.isFinite(maxVol) || maxVol <= 0) maxVol = 1;

  const slot = plotW / visibleCount;
  const firstT = candles[startIdx].t;

  function yOf(v) { return padTop + plotH - ((v - min) / (max - min)) * plotH; }
  function priceOfY(y) { return min + ((padTop + plotH - y) / plotH) * (max - min); }
  function xOfTime(t) { return ((t - firstT) / intervalMs) * slot + slot / 2; }
  function timeOfX(x) { return firstT + ((x - slot / 2) / slot) * intervalMs; }
  function volYOf(vv) { return volTop + volumeH - (vv / maxVol) * volumeH; }

  ctx.font = '10px var(--font-mono, monospace)';
  ctx.textBaseline = 'middle';
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const v = min + (max - min) * (i / gridLines);
    const y = yOf(v);
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.38)';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(v), plotW + 6, Math.min(padTop + plotH, Math.max(padTop, y)));
  }

  // Подписи времени по нижней оси + слабые вертикальные линии сетки на всю высоту (обе панели).
  const timeTicks = 4;
  ctx.textAlign = 'center';
  for (let i = 0; i <= timeTicks; i++) {
    const idx = Math.round((i / timeTicks) * (slice.length - 1));
    const k = slice[idx];
    if (!k) continue;
    const x = xOfTime(k.t);
    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, volTop + volumeH);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.3)';
    ctx.fillText(ochartTimeLabel(k.t, slice[slice.length - 1].t - slice[0].t), Math.max(20, Math.min(plotW - 20, x)), h - 8);
  }
  ctx.textAlign = 'left';

  // --- объём (панель снизу) ---
  const bodyW = Math.max(1, Math.min(9, slot * 0.62));
  slice.forEach(function (k, i) {
    const x = i * slot + slot / 2;
    const up = k.c >= k.o;
    ctx.fillStyle = up ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)';
    const vy = volYOf(k.v);
    ctx.fillRect(x - bodyW / 2, vy, bodyW, (volTop + volumeH) - vy);
  });

  // --- цена: свечи / линия / область ---
  if (ownChartType === 'candles') {
    slice.forEach(function (k, i) {
      const x = i * slot + slot / 2;
      const up = k.c >= k.o;
      const color = up ? OCHART_UP : OCHART_DOWN;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yOf(k.h));
      ctx.lineTo(x, yOf(k.l));
      ctx.stroke();
      const yo = yOf(k.o), yc = yOf(k.c);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
    });
  } else {
    // Линия/область — сглаженный путь через цены закрытия (та же техника, что в drawPnlChart).
    ctx.save();
    ctx.beginPath();
    slice.forEach(function (k, i) {
      const x = i * slot + slot / 2, y = yOf(k.c);
      if (i === 0) { ctx.moveTo(x, y); return; }
      const px = (i - 1) * slot + slot / 2, py = yOf(slice[i - 1].c);
      ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
    });
    const lastX = (slice.length - 1) * slot + slot / 2, lastY = yOf(slice[slice.length - 1].c);
    ctx.lineTo(lastX, lastY);
    if (ownChartType === 'area') {
      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      grad.addColorStop(0, 'rgba(30,128,255,.32)');
      grad.addColorStop(1, 'rgba(30,128,255,0)');
      ctx.save();
      ctx.lineTo(lastX, padTop + plotH);
      ctx.lineTo(slot / 2, padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      slice.forEach(function (k, i) {
        const x = i * slot + slot / 2, y = yOf(k.c);
        if (i === 0) { ctx.moveTo(x, y); return; }
        const px = (i - 1) * slot + slot / 2, py = yOf(slice[i - 1].c);
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      });
      ctx.lineTo(lastX, lastY);
    }
    ctx.strokeStyle = '#1E80FF';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  // --- скользящие средние MA(7)/MA(25), поверх цены ---
  if (ownChartShowMA) {
    [[7, OCHART_MA1], [25, OCHART_MA2]].forEach(function (pair) {
      const period = pair[0], color = pair[1];
      const sma = ochartSMA(candles, period);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      let started = false;
      for (let i = startIdx; i < endIdx; i++) {
        if (sma[i] == null) continue;
        const x = (i - startIdx) * slot + slot / 2, y = yOf(sma[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      }
      if (started) ctx.stroke();
      ctx.restore();
    });
  }

  // Последняя цена — пунктирная линия + подсвеченный бейдж на оси, только когда видна самая
  // свежая свеча (offset===0), как в настоящих терминалах.
  if (offset === 0) {
    const last = candles[n - 1];
    const ly = yOf(last.c);
    const lastColor = last.c >= last.o ? OCHART_UP : OCHART_DOWN;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = lastColor + '8c';
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(plotW, ly);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = lastColor;
    ctx.fillRect(plotW + 1, ly - 9, padRight - 2, 18);
    ctx.fillStyle = '#0b0e14';
    ctx.font = 'bold 10px var(--font-mono, monospace)';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(last.c), plotW + 6, ly);
    ctx.font = '10px var(--font-mono, monospace)';
  }

  // --- построения пользователя: уровни (hline), отрезки/лучи/прямые (trend/ray/xline) ---
  ownChartDrawings.forEach(function (dr) {
    if (dr.type === 'hline') {
      const y = yOf(dr.v);
      if (y < padTop - 20 || y > h - padBottom + 20) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,193,7,.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#131722';
      ctx.fillRect(plotW + 1, y - 8, padRight - 2, 16);
      ctx.fillStyle = '#FFC107';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(dr.v), plotW + 6, y);
    } else if (dr.type === 'trend' || dr.type === 'ray' || dr.type === 'xline') {
      const x1 = xOfTime(dr.p1.t), y1 = yOf(dr.p1.v);
      const x2 = xOfTime(dr.p2.t), y2 = yOf(dr.p2.v);
      const dx = x2 - x1, dy = y2 - y1;
      let seg = { x1: x1, y1: y1, x2: x2, y2: y2 };
      if (dr.type !== 'trend' && (dx !== 0 || dy !== 0)) {
        const clipped = clipRayToRect(x1, y1, dx, dy, 0, plotW, padTop, padTop + plotH,
          dr.type === 'ray' ? 0 : -Infinity, Infinity);
        if (clipped) seg = clipped;
      }
      ctx.save();
      ctx.strokeStyle = 'rgba(30,128,255,.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
      ctx.restore();
      // Опорные точки рисуем на исходных p1/p2 (не на обрезанных концах луча/прямой), как в TradingView.
      ctx.fillStyle = 'rgba(30,128,255,.85)';
      [[x1, y1], [x2, y2]].forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  });

  // Предпросмотр трендлинии, пока выбрана только первая точка.
  if (ownChartPendingTrend && ownChartHover) {
    const x1 = xOfTime(ownChartPendingTrend.p1.t), y1 = yOf(ownChartPendingTrend.p1.v);
    ctx.save();
    ctx.strokeStyle = 'rgba(30,128,255,.5)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(ownChartHover.x, ownChartHover.y);
    ctx.stroke();
    ctx.restore();
  }

  // --- линейка (замер) ---
  if (ownChartRulerDrag) {
    const r = ownChartRulerDrag;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.x1, r.y1);
    ctx.lineTo(r.x2, r.y2);
    ctx.stroke();
    ctx.restore();
    const dv = r.v2 - r.v1;
    const dPct = r.v1 !== 0 ? (dv / r.v1) * 100 : 0;
    const dBars = Math.round((r.t2 - r.t1) / intervalMs);
    const up = dv >= 0;
    const label = (up ? '+' : '') + fmtPrice(dv) + '  (' + (up ? '+' : '') + dPct.toFixed(2) + '%)  ' + dBars + ' бар' + (Math.abs(dBars) === 1 ? '' : 'ов');
    ctx.font = '11px var(--font-mono, monospace)';
    const tw = ctx.measureText(label).width;
    const bx = Math.min(Math.max(r.x2, tw / 2 + 6), plotW - tw / 2 - 6);
    const by = r.y2 < 20 ? r.y2 + 18 : r.y2 - 14;
    ctx.fillStyle = up ? 'rgba(0,192,118,.92)' : 'rgba(248,73,96,.92)';
    ctx.fillRect(bx - tw / 2 - 6, by - 10, tw + 12, 20);
    ctx.fillStyle = '#0b0e14';
    ctx.textAlign = 'center';
    ctx.fillText(label, bx, by);
    ctx.textAlign = 'left';
  }

  // --- crosshair с подписями по осям (заменяет старый DOM-tooltip) ---
  const hoverActive = ownChartHover && !ownChartPanDrag &&
    ownChartHover.x >= 0 && ownChartHover.x <= plotW && ownChartHover.y >= padTop && ownChartHover.y <= volTop + volumeH;
  if (hoverActive) {
    const hx = ownChartHover.x, hy = ownChartHover.y;
    const inPricePane = hy >= padTop && hy <= padTop + plotH;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    if (inPricePane) { ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(plotW, hy); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(hx, padTop); ctx.lineTo(hx, volTop + volumeH); ctx.stroke();
    ctx.restore();

    if (inPricePane) {
      const hoverPrice = priceOfY(hy);
      ctx.fillStyle = '#1E80FF';
      ctx.fillRect(plotW + 1, hy - 8, padRight - 2, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(hoverPrice), plotW + 6, hy);
    }

    const hoverTime = timeOfX(hx);
    const timeStr = ochartTimeLabel(hoverTime, slice[slice.length - 1].t - slice[0].t);
    ctx.font = '10px var(--font-mono, monospace)';
    const tw2 = ctx.measureText(timeStr).width;
    ctx.fillStyle = '#1E80FF';
    ctx.fillRect(Math.max(0, Math.min(plotW - tw2 - 10, hx - tw2 / 2 - 5)), h - padBottom, tw2 + 10, padBottom);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(timeStr, Math.max(tw2 / 2 + 5, Math.min(plotW - tw2 / 2 - 5, hx)), h - padBottom / 2 + 1);
    ctx.textAlign = 'left';
  }

  // --- легенда OHLC+Vol в левом верхнем углу: последняя свеча по умолчанию, наведённая — при
  // наведении курсора (как в TradingView). Показывается всегда, не только при наведении. ---
  {
    let legendCandle = slice[slice.length - 1];
    if (hoverActive) {
      let idx = Math.floor(ownChartHover.x / slot);
      idx = Math.max(0, Math.min(slice.length - 1, idx));
      legendCandle = slice[idx];
    }
    if (legendCandle) {
      const k = legendCandle;
      const up = k.c >= k.o;
      const chg = k.o !== 0 ? ((k.c - k.o) / k.o) * 100 : 0;
      const ohlc = 'O ' + fmtPrice(k.o) + '  H ' + fmtPrice(k.h) + '  L ' + fmtPrice(k.l) + '  C ' + fmtPrice(k.c) +
        '  ' + (up ? '+' : '') + chg.toFixed(2) + '%' + '   Vol ' + fmtNum(k.v, 2);
      ctx.font = '11px var(--font-mono, monospace)';
      ctx.fillStyle = 'rgba(19,23,34,.82)';
      const ow = ctx.measureText(ohlc).width;
      ctx.fillRect(6, padTop, ow + 14, 18);
      ctx.fillStyle = up ? OCHART_UP : OCHART_DOWN;
      ctx.fillText(ohlc, 12, padTop + 9);
    }
  }

  canvas.__candles = candles;
  canvas.__chart = {
    startIdx: startIdx, endIdx: endIdx, slot: slot, min: min, max: max,
    plotW: plotW, plotH: plotH, padTop: padTop, padBottom: padBottom,
    volTop: volTop, volumeH: volumeH,
    intervalMs: intervalMs, firstT: firstT,
    yOf: yOf, priceOfY: priceOfY, xOfTime: xOfTime, timeOfX: timeOfX
  };
}

// Взаимодействие с "своим" графиком: наведение (crosshair), колесо мыши (зум к курсору),
// зажать-и-тащить (панорама либо линейка/трендлиния — в зависимости от активного инструмента
// ownChartTool), правая кнопка мыши (удалить ближайшее построение). Слушатели вешаются один раз
// на canvas (idempotent), дальше используют актуальные canvas.__candles/__chart, которые
// drawCandleChart обновляет при каждой перерисовке.
function wireOwnChartInteractions(canvas) {
  if (!canvas || canvas.__ownWired) return;
  canvas.__ownWired = true;

  function redraw() { if (ownChartCandles) drawCandleChart(canvas, ownChartCandles); }

  canvas.addEventListener('wheel', function (ev) {
    const chart = canvas.__chart;
    if (!ownChartCandles || !chart) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = ev.clientX - rect.left;
    const timeAtCursor = chart.timeOfX(mouseX);
    const factor = ev.deltaY > 0 ? 1.15 : (1 / 1.15);
    const n = ownChartCandles.length;
    let newVisible = Math.round(ownChartView.visibleCount * factor);
    newVisible = Math.max(20, Math.min(n, newVisible));
    const newSlot = chart.plotW / newVisible;
    const idxInWindow = mouseX / newSlot;
    const globalIdxAtCursor = (timeAtCursor - ownChartCandles[0].t) / chart.intervalMs;
    let newStartIdx = Math.round(globalIdxAtCursor - idxInWindow);
    newStartIdx = Math.max(0, Math.min(n - newVisible, newStartIdx));
    ownChartView.visibleCount = newVisible;
    ownChartView.offset = n - newVisible - newStartIdx;
    redraw();
  }, { passive: false });

  canvas.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0) return;
    const chart = canvas.__chart;
    if (!chart) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (ownChartTool === 'cursor') {
      ownChartPanDrag = { startX: x, startOffset: ownChartView.offset };
      canvas.classList.add('panning');
    } else if (ownChartTool === 'hline') {
      const v = chart.priceOfY(y);
      ownChartDrawings.push({ type: 'hline', v: v });
      if (currentCoin) saveOwnChartDrawings(currentCoin.raw, ownChartDrawings);
      setOwnChartTool('cursor');
      redraw();
    } else if (ownChartTool === 'trend' || ownChartTool === 'ray' || ownChartTool === 'xline') {
      // Отрезок/луч/прямая ставятся одинаково — двумя кликами; тип фиксируется в момент первого
      // клика (в ownChartPendingTrend.tool), чтобы переключение инструмента между кликами не путало.
      const t = chart.timeOfX(x), v = chart.priceOfY(y);
      if (!ownChartPendingTrend) {
        ownChartPendingTrend = { tool: ownChartTool, p1: { t: t, v: v } };
      } else {
        ownChartDrawings.push({ type: ownChartPendingTrend.tool, p1: ownChartPendingTrend.p1, p2: { t: t, v: v } });
        if (currentCoin) saveOwnChartDrawings(currentCoin.raw, ownChartDrawings);
        ownChartPendingTrend = null;
        setOwnChartTool('cursor');
      }
      redraw();
    } else if (ownChartTool === 'ruler') {
      ownChartRulerDrag = { x1: x, y1: y, t1: chart.timeOfX(x), v1: chart.priceOfY(y), x2: x, y2: y, t2: chart.timeOfX(x), v2: chart.priceOfY(y) };
      redraw();
    }
  });

  window.addEventListener('mousemove', function (ev) {
    const chart = canvas.__chart;
    if (!chart) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (ownChartPanDrag) {
      const deltaCandles = (x - ownChartPanDrag.startX) / chart.slot;
      const n = ownChartCandles.length;
      const maxOffset = Math.max(0, n - ownChartView.visibleCount);
      ownChartView.offset = Math.max(0, Math.min(maxOffset, ownChartPanDrag.startOffset + deltaCandles));
      redraw();
      return;
    }
    if (ownChartRulerDrag) {
      ownChartRulerDrag.x2 = x; ownChartRulerDrag.y2 = y;
      ownChartRulerDrag.t2 = chart.timeOfX(x); ownChartRulerDrag.v2 = chart.priceOfY(y);
      redraw();
      return;
    }
    if (x < 0 || x > chart.plotW || y < 0 || y > (chart.volTop + chart.volumeH + chart.padBottom)) {
      if (ownChartHover) { ownChartHover = null; redraw(); }
      return;
    }
    ownChartHover = { x: x, y: y };
    redraw();
  });

  window.addEventListener('mouseup', function () {
    if (ownChartPanDrag) { ownChartPanDrag = null; canvas.classList.remove('panning'); }
    if (ownChartRulerDrag) { ownChartRulerDrag = null; redraw(); }
  });

  canvas.addEventListener('mouseleave', function () {
    if (!ownChartPanDrag && !ownChartRulerDrag) { ownChartHover = null; redraw(); }
  });

  canvas.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    const chart = canvas.__chart;
    if (!chart || !ownChartDrawings.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const threshold = 8;
    let bestIdx = -1, bestDist = threshold;
    ownChartDrawings.forEach(function (dr, i) {
      let dist = Infinity;
      if (dr.type === 'hline') {
        dist = Math.abs(chart.yOf(dr.v) - y);
      } else if (dr.type === 'trend' || dr.type === 'ray' || dr.type === 'xline') {
        const x1 = chart.xOfTime(dr.p1.t), y1 = chart.yOf(dr.p1.v);
        const x2 = chart.xOfTime(dr.p2.t), y2 = chart.yOf(dr.p2.v);
        const tLo = dr.type === 'xline' ? -Infinity : 0;
        const tHi = dr.type === 'trend' ? 1 : Infinity;
        dist = distToSegment(x, y, x1, y1, x2, y2, tLo, tHi);
      }
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    });
    if (bestIdx >= 0) {
      ownChartDrawings.splice(bestIdx, 1);
      if (currentCoin) saveOwnChartDrawings(currentCoin.raw, ownChartDrawings);
      redraw();
      showAppToast('Построение удалено');
    }
  });
}

// tLo/tHi по умолчанию 0..1 (обычный отрезок). Для луча передают 0..Infinity, для прямой — -Infinity..Infinity.
function distToSegment(px, py, x1, y1, x2, y2, tLo, tHi) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  const lo = tLo == null ? 0 : tLo, hi = tHi == null ? 1 : tHi;
  t = Math.max(lo, Math.min(hi, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Обрезает бесконечную (или однонаправленную — луч) линию, заданную точкой (x1,y1) и направлением
// (dx,dy), по прямоугольнику [xmin,xmax]x[ymin,ymax] методом Лианга-Барски. tLo/tHi ограничивают
// параметр t по направлению (0..Infinity — луч вперёд от p1, -Infinity..Infinity — вся прямая).
// Возвращает {x1,y1,x2,y2} обрезанного видимого отрезка или null, если линия не пересекает прямоугольник.
function clipRayToRect(x1, y1, dx, dy, xmin, xmax, ymin, ymax, tLo, tHi) {
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - xmin, xmax - x1, y1 - ymin, ymax - y1];
  let t0 = tLo, t1 = tHi;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  if (t0 > t1) return null;
  return { x1: x1 + t0 * dx, y1: y1 + t0 * dy, x2: x1 + t1 * dx, y2: y1 + t1 * dy };
}

function activityScore(c) {
  if (!c) return 0;
  const volScore = Math.min(40, Math.log10(Math.max(c.vol24, 1)) * 5);
  const moveScore = Math.min(35, Math.abs(c.change24) * 3);
  const shortScore = Math.min(25, c.vol5s * 20 + c.vol30s * 8);
  return Math.max(0, Math.min(100, Math.round(volScore + moveScore + shortScore)));
}

// Компактный стакан (bid/ask лесенка) — только для монет из watchlist Tier 2 (см. страницу
// «Паттерны»), у которых реально есть подписка на канал стакана (tier2Depth). Для остального
// рынка данных физически нет (см. её же плашку про глубокий анализ) — честно показываем заглушку
// с объяснением, а не пустую панель без причины.
function renderOrderBookPanel(c) {
  const miniEl = document.getElementById('orderbookMini');
  const unavailEl = document.getElementById('orderbookUnavailable');
  const rowsEl = document.getElementById('orderbookRows');
  const ageEl = document.getElementById('orderbookAge');
  if (!miniEl || !unavailEl || !rowsEl || !ageEl) return;

  const snapshots = tier2Depth.get(c.symbol);
  const snap = snapshots && snapshots.length ? snapshots[snapshots.length - 1] : null;
  if (!snap) {
    miniEl.style.display = 'none';
    unavailEl.style.display = 'flex';
    return;
  }
  unavailEl.style.display = 'none';
  miniEl.style.display = 'block';
  ageEl.textContent = Math.max(0, Math.round((Date.now() - snap.t) / 1000)) + 'с назад';

  const LEVELS = 6;
  const asks = (snap.asks || []).slice(0, LEVELS);
  const bids = (snap.bids || []).slice(0, LEVELS);
  let maxQty = 1e-9;
  asks.forEach(function (x) { if (x.q > maxQty) maxQty = x.q; });
  bids.forEach(function (x) { if (x.q > maxQty) maxQty = x.q; });

  function rowHtml(item, cls) {
    const pct = Math.min(100, (item.q / maxQty) * 100);
    return '<div class="ob-row ' + cls + '"><div class="ob-depth-bar" style="width:' + pct.toFixed(0) + '%"></div>' +
      '<span class="ob-price">' + fmtPrice(item.p) + '</span><span class="ob-qty">' + fmtNum(item.q) + '</span></div>';
  }
  const asksHtml = asks.slice().reverse().map(function (x) { return rowHtml(x, 'ob-ask'); }).join('');
  const bidsHtml = bids.map(function (x) { return rowHtml(x, 'ob-bid'); }).join('');
  const bestAsk = asks.length ? asks[0].p : null;
  const bestBid = bids.length ? bids[0].p : null;
  const spreadHtml = (bestAsk != null && bestBid != null && bestBid > 0)
    ? '<div class="ob-spread-row">Спред ' + fmtPrice(bestAsk - bestBid) + ' (' + ((bestAsk - bestBid) / bestBid * 100).toFixed(3) + '%)</div>'
    : '';
  rowsEl.innerHTML = asksHtml + spreadHtml + bidsHtml;
}

function updateInfoPanel() {
  if (!currentCoin) return;
  const c = coinMap.get(currentCoin.symbol) || currentCoin;
  currentCoin = c;
  document.getElementById('infoCoinName').textContent = c.symbol;
  document.getElementById('infoCoinIcon').textContent = c.baseAsset.charAt(0);
  document.getElementById('infoCoinIcon').style.background = c.color;
  document.getElementById('infoPrice').textContent = fmtPrice(c.price);
  document.getElementById('chartPrice').textContent = fmtPrice(c.price) + ' USDT';
  const chg = c.change24 || 0;
  const chgStr = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
  const el = document.getElementById('infoChange');
  el.textContent = chgStr;
  el.className = 'coin-change ' + (chg >= 0 ? 'price-up' : 'price-down');
  document.getElementById('infoChange24').textContent = chgStr;
  document.getElementById('infoChange24').className = 'info-value ' + (chg >= 0 ? 'price-up' : 'price-down');
  document.getElementById('infoVol24').textContent = fmtNum(c.vol24);
  document.getElementById('infoVol5').textContent = fmtNum(c.vol5);
  document.getElementById('infoHL').textContent = fmtPrice(c.high) + ' / ' + fmtPrice(c.low);
  renderOrderBookPanel(c);

  const score = activityScore(c);
  document.getElementById('gaugeValue').textContent = score;
  document.getElementById('gaugeFill').setAttribute('stroke-dasharray', (score / 100 * 188.5) + ' 188.5');
  const statusEl = document.getElementById('algoStatus');
  const gaugeFill = document.getElementById('gaugeFill');
  const algoPanel = document.querySelector('.algo-panel');
  // gaugeFill.style.color управляет и SVG-обводкой (currentColor в CSS), и ambient-свечением
  // всего виджета (--gauge-glow), чтобы цвет статуса, глоу вокруг дуги и фон совпадали.
  if (score >= 75) {
    statusEl.innerHTML = '<i class="ri-fire-line"></i> Высокая активность';
    statusEl.style.color = 'var(--green)';
    gaugeFill.setAttribute('stroke', 'var(--green)');
    gaugeFill.style.color = 'var(--green)';
    if (algoPanel) algoPanel.style.setProperty('--gauge-glow', 'rgba(0,192,118,.14)');
  } else if (score >= 45) {
    statusEl.innerHTML = '<i class="ri-pulse-line"></i> Средняя активность';
    statusEl.style.color = 'var(--orange)';
    gaugeFill.setAttribute('stroke', 'var(--orange)');
    gaugeFill.style.color = 'var(--orange)';
    if (algoPanel) algoPanel.style.setProperty('--gauge-glow', 'rgba(240,185,11,.14)');
  } else {
    statusEl.innerHTML = '<i class="ri-moon-line"></i> Спокойный рынок';
    statusEl.style.color = 'var(--text-secondary)';
    gaugeFill.setAttribute('stroke', 'var(--text-muted)');
    gaugeFill.style.color = 'var(--text-muted)';
    if (algoPanel) algoPanel.style.setProperty('--gauge-glow', 'rgba(255,255,255,.06)');
  }
  updateFavButton();
  loadMyOrdersForCoin(c);
  updateDensityLevelsPanel(c);
}

function updateFavButton() {
  const favBtn = document.getElementById('addFav');
  if (!currentCoin) return;
  favBtn.classList.toggle('is-fav', !!currentCoin.fav);
  favBtn.innerHTML = currentCoin.fav
    ? '<i class="ri-star-fill"></i> В избранном'
    : '<i class="ri-star-line"></i> Добавить в избранное';
}

async function loadTrades(raw) {
  const list = document.getElementById('tradesList');
  if (!list) return;

  list.innerHTML = '<div class="trades-empty"><i class="ri-loader-4-line spin-icon"></i><span>Загружаем последние сделки MEXC...</span></div>';

  // Сначала мгновенно наполняем панель историей через REST (не ждём первой живой сделки — для
  // тихих пар по WebSocket это может занять минуты), затем подписываемся на живой поток сверху.
  try {
    const trades = await fetchRecentTrades(raw, 30);
    if (currentCoin && currentCoin.raw === raw && list.isConnected) {
      const placeholder = list.querySelector('.trades-empty');
      if (placeholder) placeholder.remove();
      trades.slice().sort(function (a, b) { return a.time - b.time; }).forEach(function (t) {
        list.insertBefore(createTradeRow(t.price, t.qty, t.buy, t.time, false), list.firstChild);
      });
      while (list.children.length > 40) list.removeChild(list.lastChild);
      const cnt = list.querySelectorAll('.trade-row').length;
      document.getElementById('tradesCount').textContent = cnt;
    }
  } catch (e) {
    // История недоступна — не страшно, ниже всё равно подключаем живой поток.
  }

  subscribeDeals(raw);

  // Если за 20с не появилось НИ истории, ни живых сделок — честно говорим об этом вместо того,
  // чтобы вечно держать спиннер "ожидаем", который выглядит как зависшее приложение.
  setTimeout(function () {
    if (!currentCoin || currentCoin.raw !== raw) return;
    const stillPlaceholder = list.querySelector('.trades-empty');
    if (stillPlaceholder && !list.querySelector('.trade-row')) {
      stillPlaceholder.innerHTML = '<i class="ri-moon-clear-line"></i><span>По этой паре давно не было сделок</span>';
    }
  }, 20000);
}

function setStatus(mode, text) {
  const badge = document.getElementById('connectionStatus');
  badge.className = 'status-badge' + (mode === 'ok' ? '' : mode === 'warn' ? ' warn' : ' off');
  document.getElementById('statusText').textContent = text;
  const pill = document.getElementById('sidebarConn');
  pill.className = 'conn-pill ' + (mode === 'ok' ? 'ok' : mode === 'warn' ? 'warn' : 'err');
  document.getElementById('sidebarConnText').textContent = text;
  const ds = document.getElementById('dataStatus');
  ds.textContent = 'Поток: ' + text;
  ds.className = 'status-item ' + (mode === 'ok' ? 'status-green' : 'status-red');
  document.getElementById('dataSource').textContent = 'MEXC Spot (WebSocket)';
}

// Нормализация одного элемента protobuf PublicMiniTickerV3Api под форму,
// которую ожидает upsertCoin() (row.symbol / row.lastPrice / row.priceChangePercent / row.quoteVolume / row.highPrice / row.lowPrice).
function normalizeMiniTicker(item) {
  return {
    symbol: item.symbol,
    lastPrice: item.price,
    priceChangePercent: num(item.rate) * 100, // rate — доля (-0.0233 = -2.33%)
    quoteVolume: item.volume,                  // "volume" в протоколе MEXC — это оборот в квоте (USDT)
    highPrice: item.high,
    lowPrice: item.low
  };
}

function ingestMiniTickerItems(items) {
  lastMiniTickerAt = Date.now();
  if (!items || !items.length) return 0;
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    if (upsertCoin(normalizeMiniTicker(items[i]))) n++;
  }
  if (n) {
    rebuildList();
    scheduleRender();
  }
  return n;
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(function () {
    renderTimer = null;
    renderTable();
    if (currentCoin) updateInfoPanel();
    document.getElementById('lastUpdate').textContent = new Date().toTimeString().slice(0, 8);
    if (!wsInitialDataLoaded && allCoins.length) {
      wsInitialDataLoaded = true;
      const loader = document.getElementById('loadingIndicator');
      if (loader) loader.classList.remove('show');
    }
  }, 400);
}

// Декодирует бинарный protobuf-фрейм PushDataV3ApiWrapper в обычный JS-объект.
function decodeProtoFrame(data) {
  if (!ProtoWrapper) return null;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
    const msg = ProtoWrapper.decode(bytes);
    return ProtoWrapper.toObject(msg, { longs: Number, defaults: false });
  } catch (e) {
    return null;
  }
}

// Подписка на все тикеры рынка (единственный публичный канал, покрывающий весь спот-рынок MEXC одним потоком).
function requestInitialData() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    method: 'SUBSCRIPTION',
    params: ['spot@public.miniTickers.v3.api.pb@UTC+8']
  }));
}

function connectWs() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

  const loader = document.getElementById('loadingIndicator');
  if (loader && !allCoins.length) loader.classList.add('show');

  try {
    ws = new WebSocket(MEXC_WS);
    ws.binaryType = 'arraybuffer';
  } catch (e) {
    setStatus('warn', 'WebSocket ошибка');
    scheduleReconnect();
    return;
  }

  let pingTimer = null;

  ws.onopen = function () {
    wsReconnectAttempts = 0;
    lastMiniTickerAt = Date.now(); // грейс-период до первого реального сообщения, чтобы watchdog не сработал мгновенно
    setStatus('ok', 'MEXC LIVE');
    requestInitialData();

    pingTimer = setInterval(function () {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ method: 'PING' })); } catch (e) {}
      }
    }, 15000);
  };

  ws.onmessage = function (ev) {
    // Служебные сообщения (ack подписки, PING/PONG, ошибки) приходят текстовым JSON-фреймом,
    // рыночные данные — бинарным protobuf-фреймом (см. decodeProtoFrame).
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.msg === 'PONG' || msg.method === 'PONG') return;
        if (msg.code !== undefined && msg.code !== 0) {
          console.warn('MEXC WS:', msg);
        }
      } catch (e) {}
      return;
    }
    const obj = decodeProtoFrame(ev.data);
    if (!obj) return;
    if (obj.publicMiniTickers && obj.publicMiniTickers.items) {
      ingestMiniTickerItems(obj.publicMiniTickers.items);
    } else if (obj.publicMiniTicker) {
      ingestMiniTickerItems([obj.publicMiniTicker]);
    }
  };

  ws.onclose = function () {
    ws = null;
    if (pingTimer) clearInterval(pingTimer);
    setStatus('warn', 'RECONNECT...');
    scheduleReconnect();
  };

  ws.onerror = function () {
    try { ws.close(); } catch (e) {}
  };
}

function scheduleReconnect() {
  wsReconnectAttempts++;
  const delay = Math.min(30000, 3000 * Math.pow(1.5, wsReconnectAttempts - 1));
  setTimeout(connectWs, delay);
}

// Watchdog "сокет открыт, но молчит": onclose/onerror у самого MEXC WS могут просто не сработать,
// если сервер держит TCP-соединение живым, но перестал слать данные (в отличие от честного разрыва
// связи) — раньше в этом случае статус-бейдж навсегда оставался "MEXC LIVE" зелёным, хотя таблица
// давно не обновляется. lastMiniTickerAt обновляется на каждом реальном сообщении с рыночными
// данными (ingestMiniTickerItems); если сокет технически open, но не прислал ничего дольше 30с —
// считаем его мёртвым и форсируем переподключение по уже существующему пути (onclose → scheduleReconnect).
const WS_STALL_TIMEOUT_MS = 30000;
setInterval(function () {
  if (!ws || ws.readyState !== 1) return;
  const silentFor = Date.now() - lastMiniTickerAt;
  if (silentFor > WS_STALL_TIMEOUT_MS) {
    logW('WS', 'основной поток открыт, но молчит ' + Math.round(silentFor / 1000) + 'с — принудительный реконнект');
    setStatus('warn', 'МОЛЧИТ, RECONNECT...');
    try { ws.close(); } catch (e) {}
  }
}, 15000);

let dealsReconnectTimer = null;
let dealsReconnectRaw = null;

function subscribeDeals(raw) {
  try { if (dealsWs) { dealsWs.onclose = null; dealsWs.close(); } } catch (e) {}
  dealsWs = null;
  clearTimeout(dealsReconnectTimer);
  dealsReconnectRaw = raw;
  try {
    dealsWs = new WebSocket(MEXC_WS);
    dealsWs.binaryType = 'arraybuffer';
  } catch (e) { return; }
  dealsWs.onopen = function () {
    dealsWs.send(JSON.stringify({ method: 'SUBSCRIPTION', params: ['spot@public.deals.v3.api.pb@' + raw] }));
  };
  dealsWs.onmessage = function (ev) {
    if (typeof ev.data === 'string') {
      // Ack/ошибка подписки текстовым JSON-фреймом. MEXC умеет явно ОТКЛОНИТЬ подписку на канал
      // сделок (замечено на практике: "Reason： Blocked!" — похоже на защиту от слишком частых/
      // массовых подписок на этот конкретный канал с одного IP) — раньше такой отказ просто уходил
      // в console.warn и лента молча оставалась пустой НАВСЕГДА (сокет технически "открыт", просто
      // ничего не пришлёт), выглядя для пользователя как "по этой паре нет сделок". Явно отличаем
      // этот случай и показываем причину прямо в ленте, вместо вечной тишины.
      try {
        const msg = JSON.parse(ev.data);
        if (msg.code !== undefined && msg.code !== 0) {
          logW('WS', 'подписка на сделки отклонена MEXC (' + raw + '): ' + (msg.msg || msg.code));
          if (currentCoin && currentCoin.raw === raw) {
            const list = document.getElementById('tradesList');
            if (list) list.innerHTML = '<div class="trades-empty"><i class="ri-error-warning-line"></i>' +
              '<span>MEXC отклонил подписку на ленту сделок: ' + String(msg.msg || 'причина не указана').replace(/</g, '&lt;') + '</span></div>';
          }
        }
      } catch (e) {}
      return;
    }
    const obj = decodeProtoFrame(ev.data);
    if (!obj || !obj.publicDeals || !obj.publicDeals.deals) return;
    if (!currentCoin || currentCoin.raw !== raw) return;
    const list = document.getElementById('tradesList');
    if (!list) return;
    const placeholder = list.querySelector('.trades-empty');
    if (placeholder) placeholder.remove();
    obj.publicDeals.deals.forEach(function (d) {
      const price = num(d.price);
      const qty = num(d.quantity);
      const buy = d.tradeType === 1; // 1 = BUY, 2 = SELL (MEXC PublicDealsV3ApiItem.tradeType)
      list.insertBefore(createTradeRow(price, qty, buy, d.time, true), list.firstChild);
      while (list.children.length > 40) list.removeChild(list.lastChild);
      tradesCount++;
      document.getElementById('tradesCount').textContent = list.querySelectorAll('.trade-row').length;
      document.getElementById('metricTrades').textContent = tradesCount;
    });
  };
  // Раньше у этого сокета не было ни onerror, ни onclose — если он тихо падал (сеть, разрыв),
  // лента сделок замирала навсегда без единого признака проблемы. Теперь при разрыве пробуем
  // переподключиться через 3с (пока выбрана та же монета), и не оставляем пользователя без сигнала.
  dealsWs.onerror = function () {};
  dealsWs.onclose = function () {
    if (!currentCoin || currentCoin.raw !== dealsReconnectRaw) return;
    clearTimeout(dealsReconnectTimer);
    dealsReconnectTimer = setTimeout(function () {
      if (currentCoin && currentCoin.raw === dealsReconnectRaw) subscribeDeals(dealsReconnectRaw);
    }, 3000);
  };
}

// ============================================================================
// TIER 2 — WATCHLIST: глубокий анализ (сделки + стакан) для ОГРАНИЧЕННОГО списка монет
// ------------------------------------------------------------------
// Подписки на сделки/стакан — отдельное WS-соединение НА КАЖДЫЙ символ (MEXC не мультиплексирует
// их в общий miniTickers-поток, см. комментарий у STRATEGY_DEFS), а тысячи пар рынка физически
// нельзя держать открытыми одновременно — ни по ресурсам браузера, ни из вежливости к MEXC. Поэтому
// тиковый + стаканный анализ ведётся не по всему рынку, а по watchlist — динамическому списку из
// WATCHLIST_SIZE (+ форсированные — открытая монета/избранное) самых "интересных прямо сейчас" по
// дешёвому Tier-1 скору (computeWatchlistCandidateScore выше). Список пересматривается раз в
// WATCHLIST_EVAL_INTERVAL_MS с гистерезисом (MexcCore.computeWatchlistTransitions, юнит-тест —
// tests/verify_watchlist_hysteresis.js), чтобы монета на границе топа не дёргала WS туда-обратно
// каждый цикл.
// ============================================================================
const WATCHLIST_SIZE = 20;
// Жёсткий потолок общего размера watchlist (см. комментарий у MexcCore.computeWatchlistTransitions
// про то, почему "топ-N по рангу" без явного потолка не ограничивает суммарный размер списка на
// волатильном рынке) — WATCHLIST_SIZE обычных мест + запас на форсированные (открытая монета +
// избранное), которые добавляются вне очереди рейтинга.
const WATCHLIST_HARD_CAP = 25;
const WATCHLIST_EVICT_MARGIN = 10;
const WATCHLIST_ADD_STREAK = 2;
const WATCHLIST_EVICT_STREAK = 3;
const WATCHLIST_EVAL_INTERVAL_MS = 20000;
const WATCHLIST_MAX_RECONNECT_FAILS = 10;
const WATCHLIST_COOLDOWN_MS = 5 * 60 * 1000;
const WATCHLIST_DEPTH_LEVELS = 20;
const TIER2_TRADES_CAP = 2000;
const TIER2_DEPTH_CAP = 600;
const TIER2_DEPTH_THROTTLE_MS = 500;
const WATCHLIST_RECONNECT_DELAY_MS = 3000;
// Живой эксперимент против настоящего MEXC (2026-09) показал: канал СДЕЛОК (spot@public.deals)
// заметно строже защищён от частых/массовых подписок, чем канал стакана — быстрая серия
// подписок/отписок на разные символы (ровно то, что делает цикл гистерезиса ниже при первом
// заполнении watchlist) привела к явному отказу MEXC "Reason： Blocked!" для этого IP на канале
// сделок, при этом канал стакана в той же сессии продолжал работать нормально. Поэтому НОВЫЕ
// подписки watchlist растягиваются по времени (см. очередь ниже), а не открываются заливом по
// WATCHLIST_ADD_STREAK-кандидатам одного цикла разом.
const WATCHLIST_SUBSCRIBE_STAGGER_MS = 2000;
// Отказ по политике MEXC ("Blocked") — это не транзиентный сбой сети, быстрый повтор его не
// исправит и может выглядеть для MEXC ещё более подозрительно. Уходим сразу в тот же cooldown,
// что и после WATCHLIST_MAX_RECONNECT_FAILS обычных неудач, не тратя быстрые попытки впустую.
const WATCHLIST_BLOCKED_RE = /blocked/i;

const tier2Trades = new Map();      // symbol ("BTC/USDT") -> ring buffer [{t, price, qty, side:'buy'|'sell'}], cap TIER2_TRADES_CAP
const tier2Depth = new Map();       // symbol -> ring buffer [{t, bids, asks, bestBid, bestAsk, bidVol, askVol}], cap TIER2_DEPTH_CAP, троттлинг TIER2_DEPTH_THROTTLE_MS
const watchlist = new Map();        // symbol -> {raw, addedAt, dealsWs, depthWs, dealsFailStreak, depthFailStreak, lastDepthPushAt}
const watchlistPending = new Set(); // символы, поставленные в очередь на подписку (см. ниже), но ещё физически не подключённые
const watchlistSubscribeQueue = [];
let watchlistSubscribeQueueTimer = null;
const watchlistCandidateStreaks = new Map();
const watchlistEvictStreaks = new Map();
const watchlistCooldowns = new Map(); // symbol -> until (ms) — временно исключена из кандидатов после WATCHLIST_MAX_RECONNECT_FAILS подряд

// Здоровье Tier 2 — счётчики для будущей панели диагностики (этап 7 плана), уже сейчас доступны
// из консоли разработчика для проверки, что watchlist вообще работает (window.__tier2Health, см.
// самый конец файла).
const tier2Health = { watchlistSize: 0, watchlistPending: 0, lastEvalAt: 0, tradesIngested: 0, depthPushesIngested: 0, connectionAttempts: 0, cooldownDrops: 0, patternEventsActive: 0 };

function watchlistInCooldown(symbol) {
  const until = watchlistCooldowns.get(symbol);
  if (!until) return false;
  if (until <= Date.now()) { watchlistCooldowns.delete(symbol); return false; }
  return true;
}

function tier2ForcedSymbols() {
  const forced = new Set();
  if (currentCoin) forced.add(currentCoin.symbol);
  allCoins.forEach(function (c) { if (c.fav) forced.add(c.symbol); });
  return forced;
}

function watchlistHandleConnFail(symbol, kind) {
  logW('Watchlist', symbol + ': ' + kind + ' — ' + WATCHLIST_MAX_RECONNECT_FAILS + ' неудачных попыток подряд, уходит в cooldown на ' + Math.round(WATCHLIST_COOLDOWN_MS / 60000) + ' мин');
  watchlistCooldowns.set(symbol, Date.now() + WATCHLIST_COOLDOWN_MS);
  tier2Health.cooldownDrops++;
  unsubscribeWatchlistSymbol(symbol);
}

function openWatchlistDealsWs(symbol, raw, entry) {
  tier2Health.connectionAttempts++;
  let sock;
  try {
    sock = new WebSocket(MEXC_WS);
    sock.binaryType = 'arraybuffer';
  } catch (e) { watchlistHandleConnFail(symbol, 'сделки (не удалось создать сокет)'); return; }
  entry.dealsWs = sock;
  sock.onopen = function () {
    entry.dealsFailStreak = 0;
    sock.send(JSON.stringify({ method: 'SUBSCRIPTION', params: ['spot@public.deals.v3.api.pb@' + raw] }));
  };
  sock.onmessage = function (ev) {
    if (typeof ev.data === 'string') {
      // Явный отказ подписки текстовым control-фреймом (code !== 0) — особенно "Blocked ", см.
      // комментарий у WATCHLIST_SUBSCRIBE_STAGGER_MS. Не разрываем соединение здесь напрямую —
      // просто помечаем причину и закрываем сокет; ЕДИНСТВЕННОЕ место, которое решает, что делать
      // дальше (обычный реконнект или сразу cooldown) — onclose ниже, чтобы не задваивать логику.
      try {
        const msg = JSON.parse(ev.data);
        if (msg.code !== undefined && msg.code !== 0) {
          logW('Watchlist', symbol + ': сделки — MEXC отклонил подписку (' + (msg.msg || msg.code) + ')');
          if (WATCHLIST_BLOCKED_RE.test(msg.msg || '')) entry.dealsBlocked = true;
          try { sock.close(); } catch (e2) {}
        }
      } catch (e) {}
      return;
    }
    const obj = decodeProtoFrame(ev.data);
    if (!obj || !obj.publicDeals || !obj.publicDeals.deals) return;
    obj.publicDeals.deals.forEach(function (d) {
      pushRing(tier2Trades, symbol, { t: Number(d.time) || Date.now(), price: num(d.price), qty: num(d.quantity), side: d.tradeType === 1 ? 'buy' : 'sell' }, TIER2_TRADES_CAP);
      tier2Health.tradesIngested++;
    });
  };
  sock.onerror = function () {};
  sock.onclose = function () {
    if (entry.dealsWs !== sock) return; // сокет уже заменён/символ отписан — не реагируем на устаревшее событие
    entry.dealsWs = null;
    if (!watchlist.has(symbol)) return;
    if (entry.dealsBlocked) { watchlistHandleConnFail(symbol, 'сделки заблокированы MEXC для этого IP'); return; }
    entry.dealsFailStreak++;
    if (entry.dealsFailStreak >= WATCHLIST_MAX_RECONNECT_FAILS) {
      watchlistHandleConnFail(symbol, 'сделки');
    } else {
      setTimeout(function () { if (watchlist.has(symbol)) openWatchlistDealsWs(symbol, raw, entry); }, WATCHLIST_RECONNECT_DELAY_MS);
    }
  };
}

function openWatchlistDepthWs(symbol, raw, entry) {
  tier2Health.connectionAttempts++;
  let sock;
  try {
    sock = new WebSocket(MEXC_WS);
    sock.binaryType = 'arraybuffer';
  } catch (e) { watchlistHandleConnFail(symbol, 'стакан (не удалось создать сокет)'); return; }
  entry.depthWs = sock;
  sock.onopen = function () {
    entry.depthFailStreak = 0;
    sock.send(JSON.stringify({ method: 'SUBSCRIPTION', params: ['spot@public.limit.depth.v3.api.pb@' + raw + '@' + WATCHLIST_DEPTH_LEVELS] }));
  };
  sock.onmessage = function (ev) {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.code !== undefined && msg.code !== 0) {
          logW('Watchlist', symbol + ': стакан — MEXC отклонил подписку (' + (msg.msg || msg.code) + ')');
          if (WATCHLIST_BLOCKED_RE.test(msg.msg || '')) entry.depthBlocked = true;
          try { sock.close(); } catch (e2) {}
        }
      } catch (e) {}
      return;
    }
    const obj = decodeProtoFrame(ev.data);
    if (!obj || !obj.publicLimitDepths) return;
    const now = Date.now();
    if (now - entry.lastDepthPushAt < TIER2_DEPTH_THROTTLE_MS) return; // троттлинг — не каждое обновление стакана попадает в буфер
    entry.lastDepthPushAt = now;
    const d = obj.publicLimitDepths;
    const bids = (d.bids || []).map(function (x) { return { p: num(x.price), q: num(x.quantity) }; });
    const asks = (d.asks || []).map(function (x) { return { p: num(x.price), q: num(x.quantity) }; });
    const bidVol = bids.reduce(function (a, x) { return a + x.p * x.q; }, 0);
    const askVol = asks.reduce(function (a, x) { return a + x.p * x.q; }, 0);
    pushRing(tier2Depth, symbol, {
      t: now, bids: bids, asks: asks,
      bestBid: bids.length ? bids[0].p : null, bestAsk: asks.length ? asks[0].p : null,
      bidVol: bidVol, askVol: askVol
    }, TIER2_DEPTH_CAP);
    tier2Health.depthPushesIngested++;
  };
  sock.onerror = function () {};
  sock.onclose = function () {
    if (entry.depthWs !== sock) return;
    entry.depthWs = null;
    if (!watchlist.has(symbol)) return;
    if (entry.depthBlocked) { watchlistHandleConnFail(symbol, 'стакан заблокирован MEXC для этого IP'); return; }
    entry.depthFailStreak++;
    if (entry.depthFailStreak >= WATCHLIST_MAX_RECONNECT_FAILS) {
      watchlistHandleConnFail(symbol, 'стакан');
    } else {
      setTimeout(function () { if (watchlist.has(symbol)) openWatchlistDepthWs(symbol, raw, entry); }, WATCHLIST_RECONNECT_DELAY_MS);
    }
  };
}

// Публичная точка входа для evaluateWatchlist() ниже — НЕ подключается немедленно, а становится в
// очередь (см. WATCHLIST_SUBSCRIBE_STAGGER_MS выше) вместе с остальными кандидатами этого цикла,
// чтобы не открывать десяток новых подписок на сделки залпом.
function subscribeWatchlistSymbol(symbol, raw) {
  if (watchlist.has(symbol) || watchlistPending.has(symbol)) return;
  watchlistPending.add(symbol);
  watchlistSubscribeQueue.push({ symbol: symbol, raw: raw });
  drainWatchlistSubscribeQueue();
}

function drainWatchlistSubscribeQueue() {
  if (watchlistSubscribeQueueTimer) return; // уже идёт отсчёт до следующей подписки в очереди
  const next = watchlistSubscribeQueue.shift();
  if (!next) return;
  watchlistPending.delete(next.symbol);
  subscribeWatchlistSymbolNow(next.symbol, next.raw);
  watchlistSubscribeQueueTimer = setTimeout(function () {
    watchlistSubscribeQueueTimer = null;
    drainWatchlistSubscribeQueue();
  }, WATCHLIST_SUBSCRIBE_STAGGER_MS);
}

function subscribeWatchlistSymbolNow(symbol, raw) {
  if (watchlist.has(symbol)) return;
  const entry = { raw: raw, addedAt: Date.now(), dealsWs: null, depthWs: null, dealsFailStreak: 0, depthFailStreak: 0, dealsBlocked: false, depthBlocked: false, lastDepthPushAt: 0 };
  watchlist.set(symbol, entry);
  logI('Watchlist', symbol + ' добавлена в глубокий анализ (' + raw + ')');
  openWatchlistDealsWs(symbol, raw, entry);
  openWatchlistDepthWs(symbol, raw, entry);
}

function unsubscribeWatchlistSymbol(symbol) {
  // Символ мог быть только ПОСТАВЛЕН в очередь на подписку (см. subscribeWatchlistSymbol) и ещё
  // не успеть физически подключиться к моменту, когда его решили вылистить — снимаем и из очереди тоже.
  watchlistPending.delete(symbol);
  for (let i = watchlistSubscribeQueue.length - 1; i >= 0; i--) {
    if (watchlistSubscribeQueue[i].symbol === symbol) watchlistSubscribeQueue.splice(i, 1);
  }
  const entry = watchlist.get(symbol);
  if (!entry) return;
  try { if (entry.dealsWs) { entry.dealsWs.onclose = null; entry.dealsWs.close(); } } catch (e) {}
  try { if (entry.depthWs) { entry.depthWs.onclose = null; entry.depthWs.close(); } } catch (e) {}
  watchlist.delete(symbol);
  watchlistEvictStreaks.delete(symbol);
  logI('Watchlist', symbol + ' исключена из глубокого анализа');
}

// Раз в WATCHLIST_EVAL_INTERVAL_MS пересчитывает, кто должен быть в watchlist — вся РЕШАЮЩАЯ логика
// (гистерезис) в MexcCore.computeWatchlistTransitions (core-utils.js, юнит-тестируется отдельно),
// здесь только сбор входных данных (ранжированный список + форсированные монеты) и побочные эффекты
// (реальные под-/отписки).
function evaluateWatchlist() {
  const now = Date.now();
  const ranked = allCoins
    .filter(function (c) { return c.__wlScore >= 0 && !watchlistInCooldown(c.symbol); })
    .slice()
    .sort(function (a, b) { return b.__wlScore - a.__wlScore; })
    .map(function (c) { return c.symbol; });

  const forced = tier2ForcedSymbols();
  // "Уже участник" для целей гистерезиса включает и тех, кто ещё физически не подключился, но уже
  // стоит в очереди на подключение (watchlistPending) — иначе один и тот же кандидат попал бы в
  // toAdd повторно на следующем цикле, пока очередь ещё не дошла до него.
  const currentMembers = new Set(watchlist.keys());
  watchlistPending.forEach(function (s) { currentMembers.add(s); });

  const transitions = MexcCore.computeWatchlistTransitions({
    rankedSymbols: ranked,
    currentMembers: currentMembers,
    candidateStreaks: watchlistCandidateStreaks,
    evictStreaks: watchlistEvictStreaks,
    size: WATCHLIST_SIZE,
    evictMargin: WATCHLIST_EVICT_MARGIN,
    addStreakNeeded: WATCHLIST_ADD_STREAK,
    evictStreakNeeded: WATCHLIST_EVICT_STREAK,
    forced: forced,
    maxSize: WATCHLIST_HARD_CAP
  });

  transitions.toEvict.forEach(unsubscribeWatchlistSymbol);
  transitions.toAdd.forEach(function (symbol) {
    const coin = coinMap.get(symbol);
    if (coin) subscribeWatchlistSymbol(symbol, coin.raw);
  });

  tier2Health.watchlistSize = watchlist.size;
  tier2Health.watchlistPending = watchlistPending.size;
  tier2Health.lastEvalAt = now;
  if (transitions.toAdd.length || transitions.toEvict.length) {
    logD('Watchlist', 'цикл оценки: +' + transitions.toAdd.length + ' -' + transitions.toEvict.length + ', сейчас ' + watchlist.size + '/' + WATCHLIST_SIZE);
  }
}
setInterval(evaluateWatchlist, WATCHLIST_EVAL_INTERVAL_MS);
setTimeout(evaluateWatchlist, 5000); // не ждать первые 20с бездействия — рынок к этому времени уже наполнен

// ============================================================================
// PATTERN DETECTION ENGINE — детекторы Tier 2, работают ТОЛЬКО по watchlist-монетам (см. выше),
// на буферах tier2Trades/tier2Depth. Реестр DETECTOR_DEFS — СВОЙ, отдельный от STRATEGY_DEFS
// (Tier 1, весь рынок, mutually-exclusive выбор одной стратегии в UI): здесь одновременно может
// "смотреть" сколько угодно детекторов на одну монету — это не взаимоисключающие профили, а разные
// одновременно проверяемые гипотезы.
//
// Контракт детектора: detect(symbol) -> event-объект или null. Внутри — только чтение
// tier2Trades/tier2Depth/coinMap, никаких побочных эффектов (не трогает DOM/WS/локальные хранилища)
// — раннер (runPatternDetectors) сам решает, что делать с результатом.
// ============================================================================
const PATTERN_CLUSTER_TOLERANCE = 0.15; // ±15% — тот же допуск, что и для циклов в ТЗ (не "секунда в секунду")
const PATTERN_MIN_SCORE = 55;           // ТЗ #8 — показываем только по-настоящему интересное, не всё подряд
const PATTERN_DETECT_INTERVAL_MS = 2000;
const PATTERN_LOOKBACK_TRADES = 200;    // сколько последних сделок буфера рассматривает detect() за раз

// Сами детекторы — чистые функции (trades[], opts) -> event|null в core-utils.js (переиспользуются
// tests/ на синтетических данных, см. verify_repeat_size_detector.js и соседние). Обёртки ниже
// читают буфер конкретного символа и достраивают symbol/detectedAt, которые сама чистая функция не знает.
const PATTERN_BURST_BUCKET_MS = 10000;
function detectRepeatedTradeSizes(symbol) {
  const ev = MexcCore.detectRepeatedTradeSizes(tier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatSize.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatedIntervals(symbol) {
  const ev = MexcCore.detectRepeatedIntervals(tier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatInterval.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectBurstNoFollowThrough(symbol) {
  const ev = MexcCore.detectBurstNoFollowThrough(tier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.burstNoFollow.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCyclicity(symbol) {
  const ev = MexcCore.detectCyclicity(tier2Trades.get(symbol), {
    bucketMs: 2000, minRepeats: DETECTOR_DEFS.cycle.minRepeats, tolerance: PATTERN_CLUSTER_TOLERANCE, lookback: 2000
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatingSequence(symbol) {
  const ev = MexcCore.detectRepeatingSequence(tier2Trades.get(symbol), {
    minLen: 3, maxLen: 6, minRepeats: DETECTOR_DEFS.sequence.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLadder(symbol) {
  const ev = MexcCore.detectLadder(tier2Trades.get(symbol), {
    tolerance: 0.3, minRepeats: DETECTOR_DEFS.ladder.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectErshik(symbol) {
  const ev = MexcCore.detectErshik(tier2Trades.get(symbol), {
    tolerance: 0.2, minRepeats: DETECTOR_DEFS.ershik.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// Детекторы ниже читают tier2Depth — доступны ТОЛЬКО для watchlist-монет (см. Tier 2 выше), для
// которых реально подключён канал стакана; на буфере, которого ещё нет (монета только что попала
// в watchlist), MexcCore-функции сами корректно возвращают null (недостаточно снимков), крашей нет.
function detectImbalance(symbol) {
  const ev = MexcCore.detectImbalance(tier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.imbalance.minRepeats, minZ: 2.5, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectAbsorption(symbol) {
  const ev = MexcCore.detectAbsorption(tier2Depth.get(symbol), tier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.absorption.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFakeLiquidity(symbol) {
  const ev = MexcCore.detectFakeLiquidity(tier2Depth.get(symbol), tier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.fakeLiquidity.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectExhaustion(symbol) {
  const ev = MexcCore.detectExhaustion(tier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.exhaustion.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectZoneReturn(symbol) {
  const ev = MexcCore.detectZoneReturn(tier2Trades.get(symbol), {
    tolerance: 0.005, minRepeats: DETECTOR_DEFS.zoneReturn.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}

const DETECTOR_DEFS = {
  repeatSize: { label: 'Идентичные размеры сделок', badge: 'SIZE', category: 'repeat', minRepeats: 5, detect: detectRepeatedTradeSizes },
  repeatInterval: { label: 'Идентичные интервалы', badge: 'INTVL', category: 'repeat', minRepeats: 5, detect: detectRepeatedIntervals },
  burstNoFollow: { label: 'Всплеск без продолжения', badge: 'BURST', category: 'inefficiency', minRepeats: 3, detect: detectBurstNoFollowThrough },
  cycle: { label: 'Цикличность', badge: 'CYCLE', category: 'cycle', minRepeats: 8, detect: detectCyclicity },
  sequence: { label: 'Повторяющаяся последовательность', badge: 'SEQ', category: 'sequence', minRepeats: 5, detect: detectRepeatingSequence },
  ladder: { label: 'Лесенка', badge: 'LADDER', category: 'sequence', minRepeats: 8, detect: detectLadder },
  ershik: { label: 'Ёршик', badge: 'ERSHIK', category: 'sequence', minRepeats: 8, detect: detectErshik },
  imbalance: { label: 'Дисбаланс стакана', badge: 'IMBAL', category: 'depth', minRepeats: 20, detect: detectImbalance },
  absorption: { label: 'Поглощение плотности', badge: 'ABSORB', category: 'depth', minRepeats: 20, detect: detectAbsorption },
  fakeLiquidity: { label: 'Возможная фейковая ликвидность', badge: 'FAKE?', category: 'heuristic-lowconf', minRepeats: 20, detect: detectFakeLiquidity },
  exhaustion: { label: 'Истощение импульса', badge: 'EXHAUST', category: 'inefficiency', minRepeats: 3, detect: detectExhaustion },
  zoneReturn: { label: 'Повторная реакция на зону', badge: 'ZONE', category: 'repeat', minRepeats: 5, detect: detectZoneReturn }
};

// Человекочитаемое объяснение "почему сработало" — та же идея, что explainCoinForStrategy() у
// Tier-1 стратегий (генерируется из реальных чисел конкретного события, не шаблон-заглушка), но
// обобщено на любой ключ DETECTOR_DEFS вместо ветвления по 3 захардкоженным стратегиям.
function explainPatternEvent(ev) {
  if (ev.detectorKey === 'repeatSize') {
    return 'Обнаружено ' + ev.repeatCount + ' сделок с похожим размером ($' + ev.sizeRangeUsd[0] + '–$' + ev.sizeRangeUsd[1] +
      ') среди последних ' + PATTERN_LOOKBACK_TRADES + ' сделок. Суммарный объём кластера ≈ $' + ev.volumeUsd + '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'repeatInterval') {
    return 'Обнаружено ' + ev.repeatCount + ' пар сделок с похожим интервалом между собой (~' + ev.avgIntervalS + 'с, допуск ±' +
      Math.round(PATTERN_CLUSTER_TOLERANCE * 100) + '%). Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'burstNoFollow') {
    return 'Всплеск объёма (' + ev.repeatCount + ' сделок за ' + (PATTERN_BURST_BUCKET_MS / 1000) + 'с, $' + ev.volumeUsd +
      ') заметно выше обычного для этой монеты, но цена сдвинулась лишь на ' + (ev.priceMovePct * 100).toFixed(2) +
      '% — нет пропорционального продолжения. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'cycle') {
    return 'Обнаружена цикличность: ' + ev.repeatCount + ' повторов с интервалом ~' + ev.cycleS + 'с (допуск ±' +
      Math.round(PATTERN_CLUSTER_TOLERANCE * 100) + '%)' +
      (ev.buyRangeUsd ? '. BUY-события: $' + ev.buyRangeUsd[0] + '–$' + ev.buyRangeUsd[1] : '') +
      (ev.sellRangeUsd ? ', SELL-события: $' + ev.sellRangeUsd[0] + '–$' + ev.sellRangeUsd[1] : '') +
      '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'sequence') {
    return 'Обнаружена повторяющаяся последовательность "' + ev.sequencePattern + '" (B=покупка, S=продажа), ' +
      ev.repeatCount + ' непересекающихся повторов, значимость заметно выше случайной. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'ladder') {
    return 'Лесенка ' + ev.direction + ': ' + ev.repeatCount + ' последовательных шагов ~' + ev.avgStepPct +
      '% каждый, средний интервал ~' + ev.avgIntervalS + 'с, объём ≈ $' + ev.volumeUsd + '. Длина забега статистически ' +
      'значимо превышает ожидаемую для случайного блуждания. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'ershik') {
    return 'Структурированное чередование покупок/продаж: ' + ev.repeatCount + ' сделок подряд со сменой стороны, ' +
      'подтверждено ' + ev.structureSignals + ' из 3 структурных признаков (похожие размеры / похожие интервалы / ' +
      'цена в узком диапазоне) — не просто рыночный шум. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'imbalance') {
    return 'Дисбаланс стакана: объём на ' + (ev.direction === 'LONG' ? 'покупку' : 'продажу') + ' заметно выше обычного ' +
      'для этой монеты (bid $' + ev.bidVolUsd.toLocaleString('ru-RU') + ' / ask $' + ev.askVolUsd.toLocaleString('ru-RU') +
      '), устойчиво держится последние ' + ev.repeatCount + ' снимков стакана. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'absorption') {
    return 'Плотность на уровне ' + fmtPrice(ev.priceLevel) + ' усохла на ' + ev.shrinkPct + '% за ' + ev.repeatCount +
      ' снимков стакана, и это подтверждено реальным исполненным объёмом ($' + ev.volumeUsd.toLocaleString('ru-RU') +
      ') у этой же цены — заявку "съели" потоком сделок, цена уровень не пробила. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'fakeLiquidity') {
    return '⚠ ЭВРИСТИКА (не подтверждённый факт): крупная плотность на уровне ' + fmtPrice(ev.priceLevel) + ' исчезла (усохла на ' +
      ev.shrinkPct + '%) за ' + ev.repeatCount + ' снимков стакана БЕЗ соответствующего исполненного объёма — похоже на ' +
      'снятую/переставленную заявку, но по публичному стакану MEXC отличить это от иных причин невозможно. Confidence ' +
      ev.confidencePct + '% (сознательно ограничен сверху).';
  }
  if (ev.detectorKey === 'exhaustion') {
    return 'Истощение импульса: после всплеска объём монотонно снижается ' + ev.repeatCount + ' периодов подряд ' +
      '(упал на ' + ev.volumeDeclinePct + '% от пика) — активность угасает. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'zoneReturn') {
    return 'Цена ' + ev.repeatCount + ' раз возвращалась к зоне ' + fmtPrice(ev.zonePrice) + ' и каждый раз отскакивала ' +
      'в среднем на ' + ev.avgReactionPct + '% — похоже на устойчивый уровень поддержки/сопротивления. Confidence ' +
      ev.confidencePct + '%.';
  }
  return '';
}

// ------------------------------------------------------------------
// История паттернов + отслеживание исхода БЕЗ LOOK-AHEAD BIAS (ТЗ #9, план Phase 6). Тот же
// localStorage-идиом, что и BALANCE_HISTORY_KEY (age-cutoff → per-symbol cap → total cap,
// см. loadBalanceHistory/pushBalanceHistory) — не новый механизм хранения.
// ------------------------------------------------------------------
const PATTERN_HISTORY_KEY = 'mexc_pattern_history';
const PATTERN_HISTORY_MAX_PER_SYMBOL = 500;
const PATTERN_HISTORY_MAX_TOTAL = 5000;
const PATTERN_HISTORY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const PATTERN_SESSION_GRACE_MS = 15000; // см. MexcCore.shouldOpenNewPatternSession — один и тот же держащийся паттерн не плодит новую запись каждые 2с
const PATTERN_SUCCESS_THRESHOLD_PCT = 0.3;
const PATTERN_OUTCOME_KEYS = ['at30s', 'at2m', 'at10m', 'at30m']; // соответствует индексам MexcCore.PATTERN_OUTCOME_CHECKPOINTS_S

let patternHistorySeq = 0;
let patternHistory = (function loadPatternHistory() {
  try {
    const raw = localStorage.getItem(PATTERN_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    patternHistorySeq = arr.reduce(function (m, e) { return Math.max(m, e.id || 0); }, 0);
    return arr;
  } catch (e) { return []; }
})();

function savePatternHistory() {
  try { persistSet(PATTERN_HISTORY_KEY, JSON.stringify(patternHistory)); } catch (e) { /* переживём без сохранения между сессиями */ }
}

const patternActiveSessions = new Map(); // symbol+'|'+detectorKey -> {historyId, lastSeenAt}

// Регистрирует эпизод паттерна. Продолжающийся (тот же symbol+detectorKey держится без перерыва
// дольше PATTERN_SESSION_GRACE_MS) — просто обновляет lastSeenAt, НЕ трогает уже замороженный
// scoreAtSignal исходной записи (это и есть контракт "не look-ahead": сигнал не переоценивается
// постфактум просто потому, что продолжает выполняться). Новый эпизод — считает pastSuccess
// ИСКЛЮЧИТЕЛЬНО из уже ЗАКРЫТЫХ прошлых записей этого детектора (MexcCore.computePastSuccessRate),
// пересчитывает финальный score через MexcCore.applyPatternScore (уважает maxConfidence — см.
// fakeLiquidity) и кладёт новую запись в patternHistory.
function registerPatternEvent(ev, now) {
  const key = ev.symbol + '|' + ev.detectorKey;
  const session = patternActiveSessions.get(key);
  if (!MexcCore.shouldOpenNewPatternSession(session ? session.lastSeenAt : null, now, PATTERN_SESSION_GRACE_MS)) {
    session.lastSeenAt = now;
    ev.historyId = session.historyId;
    return;
  }
  const pastSuccess = MexcCore.computePastSuccessRate(patternHistory, ev.detectorKey, {
    checkpointKey: 'at2m', successThresholdPct: PATTERN_SUCCESS_THRESHOLD_PCT
  });
  ev.factors.pastSuccess = pastSuccess ? pastSuccess.rate : 0;
  MexcCore.applyPatternScore(ev);

  const id = ++patternHistorySeq;
  ev.historyId = id;
  patternHistory.push({
    id: id, symbol: ev.symbol, detectorKey: ev.detectorKey, detectedAt: now,
    direction: ev.direction, confidencePct: ev.confidencePct, scoreAtSignal: ev.scoreAtSignal,
    priceAtSignal: ev.priceAtSignal, repeatCount: ev.repeatCount,
    outcome: { at30s: null, at2m: null, at10m: null, at30m: null }
  });
  patternHistory = MexcCore.prunePatternHistory(patternHistory, {
    maxPerSymbol: PATTERN_HISTORY_MAX_PER_SYMBOL, maxTotal: PATTERN_HISTORY_MAX_TOTAL, maxAgeMs: PATTERN_HISTORY_MAX_AGE_MS, now: now
  });
  savePatternHistory();
  patternActiveSessions.set(key, { historyId: id, lastSeenAt: now });
}

// Раз в 10с проверяет, не пересекли ли записи истории очередную контрольную точку (30с/2м/10м/30м
// после детекции) — и если да, считает MFE/MAE по цене, РЕАЛЬНО НАБЛЮДАВШЕЙСЯ с момента детекции
// (буфер Tier 2, если монета всё ещё в watchlist; если нет — единственная доступная точка, текущая
// цена из coinMap, честная деградация вместо вечно висящего незакрытым чекпоинта).
function sweepPatternOutcomes() {
  const now = Date.now();
  let changed = false;
  patternHistory.forEach(function (record) {
    MexcCore.PATTERN_OUTCOME_CHECKPOINTS_S.forEach(function (s, idx) {
      const outcomeKey = PATTERN_OUTCOME_KEYS[idx];
      if (record.outcome[outcomeKey] != null) return; // уже закрыт
      if (now - record.detectedAt < s * 1000) return; // ещё не время
      const trades = tier2Trades.get(record.symbol);
      let pricesSince = trades ? trades.filter(function (t) { return t.t >= record.detectedAt; }).map(function (t) { return t.price; }) : [];
      if (!pricesSince.length) {
        const coin = coinMap.get(record.symbol);
        if (coin && coin.price) pricesSince = [coin.price];
      }
      const outcome = MexcCore.computeOutcomeMetrics(record.priceAtSignal, record.direction, pricesSince);
      if (outcome) { record.outcome[outcomeKey] = outcome; changed = true; }
    });
  });
  if (changed) savePatternHistory();
}
setInterval(sweepPatternOutcomes, 10000);

// Текущий срез активных паттернов (последний прогон) — витрина для UI; постоянная история —
// отдельно, в patternHistory выше.
let activePatternEvents = [];

// Отключённые пользователем детекторы (стр. «Паттерны», чипы-переключатели) — не считаются вообще
// (не тратится даже дешёвый бюджет вычислений на watchlist-монетах), а не просто скрываются в UI.
// Персистентность — тот же localStorage-идиом, что и у остальных настроек интерфейса.
const DETECTOR_ENABLED_KEY = 'mexc_detector_enabled';
let disabledDetectorKeys = (function loadDisabledDetectors() {
  try {
    const raw = localStorage.getItem(DETECTOR_ENABLED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
})();
function saveDisabledDetectors() {
  try { persistSet(DETECTOR_ENABLED_KEY, JSON.stringify(Array.from(disabledDetectorKeys))); } catch (e) { /* переживём без сохранения между сессиями */ }
}
function toggleDetectorEnabled(key) {
  if (disabledDetectorKeys.has(key)) disabledDetectorKeys.delete(key);
  else disabledDetectorKeys.add(key);
  saveDisabledDetectors();
  renderDetectorFilterRow();
}
function renderDetectorFilterRow() {
  const row = document.getElementById('detectorFilterRow');
  if (!row) return;
  row.innerHTML = Object.keys(DETECTOR_DEFS).map(function (key) {
    const def = DETECTOR_DEFS[key];
    const on = !disabledDetectorKeys.has(key);
    const catCls = def.category === 'heuristic-lowconf' ? ' cat-heuristic' : '';
    return '<span class="detector-chip ' + (on ? 'on' : 'off') + catCls + '" data-detector="' + key + '">' +
      '<span class="chip-dot"></span>' + def.label + '</span>';
  }).join('');
  row.querySelectorAll('.detector-chip[data-detector]').forEach(function (chip) {
    chip.addEventListener('click', function () { toggleDetectorEnabled(this.dataset.detector); });
  });
}

function runPatternDetectors() {
  const events = [];
  watchlist.forEach(function (entry, symbol) {
    Object.keys(DETECTOR_DEFS).forEach(function (key) {
      if (disabledDetectorKeys.has(key)) return;
      let ev;
      try {
        ev = DETECTOR_DEFS[key].detect(symbol);
      } catch (e) {
        logE('Pattern', key + '/' + symbol + ': детектор упал с исключением — ' + e.message);
        return;
      }
      if (ev && ev.scoreAtSignal >= PATTERN_MIN_SCORE) events.push(ev);
    });
  });

  // Мульти-детекторное подтверждение (ТЗ #8, фактор "confirmation") — если на одной монете в ОДНОМ
  // прогоне сработало ≥2 разных детектора, это взаимное подтверждение: пересчитываем им score с
  // confirmation=1 через applyPatternScore (НЕ прямым scorePatternEvent — тот не знает про
  // maxConfidence и молча снял бы честный потолок confidence у fakeLiquidity при подтверждении).
  const bySymbol = new Map();
  events.forEach(function (ev) {
    if (!bySymbol.has(ev.symbol)) bySymbol.set(ev.symbol, []);
    bySymbol.get(ev.symbol).push(ev);
  });
  events.forEach(function (ev) {
    if (bySymbol.get(ev.symbol).length > 1) {
      ev.factors.confirmation = 1;
      MexcCore.applyPatternScore(ev);
    }
  });

  const now = Date.now();
  events.forEach(function (ev) { registerPatternEvent(ev, now); });

  events.sort(function (a, b) { return b.scoreAtSignal - a.scoreAtSignal; });
  activePatternEvents = events;
  tier2Health.patternEventsActive = activePatternEvents.length;
  const badge = document.getElementById('navPatternBadge');
  if (badge) badge.textContent = activePatternEvents.length;
  updatePatternsPage();
}
setInterval(runPatternDetectors, PATTERN_DETECT_INTERVAL_MS);

// ------------------------------------------------------------------
// UI страницы "Паттерны" — карточки найденных событий + сводка здоровья Tier 2 (watchlist,
// соединения, обработанные сделки/стакан). Переиспользует визуальный язык .profile-strategy-card
// (те же карточки, что у Профилей/Стратегий) и .finres-stat-card (те же плитки, что у Финреза) —
// сознательно, а не отдельный "язык дизайна" для этой страницы (см. план).
// ------------------------------------------------------------------
function watchlistStatusText() {
  const size = watchlist.size;
  const pending = watchlistPending.size;
  return 'Глубокий анализ: ' + size + '/' + WATCHLIST_SIZE + ' монет' + (pending ? ' (+' + pending + ' подключается)' : '') +
    ' · соединений: ' + (size * 2) + ' · сделок обработано: ' + tier2Health.tradesIngested +
    ' · обновлений стакана: ' + tier2Health.depthPushesIngested;
}

function patternStatCard(label, valueHtml, cls) {
  return '<div class="finres-stat-card"><div class="finres-stat-label">' + label + '</div>' +
    '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div></div>';
}

// Последние WARNING/ERROR из общего кольцевого лога (MexcCore.logRing, собирается с Phase 1 —
// WS-разрывы, отказы подписки MEXC, сбои Финреза и т.д.), но раньше нигде не показывался в UI,
// только в консоли разработчика. Показываем только предупреждения/ошибки — не спамим DEBUG/INFO.
function renderPatternLogPanel() {
  const panel = document.getElementById('patternLogPanel');
  const list = document.getElementById('patternLogList');
  if (!panel || !list) return;
  const entries = MexcCore.logRing.filter(function (e) { return e.level === 'WARNING' || e.level === 'ERROR'; }).slice(-20).reverse();
  if (!entries.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  list.innerHTML = entries.map(function (e) {
    const time = new Date(e.t).toTimeString().slice(0, 8);
    return '<div class="pattern-log-row">' +
      '<span class="pattern-log-time">' + time + '</span>' +
      '<span class="pattern-log-level ' + e.level + '">' + e.level + '</span>' +
      '<span class="pattern-log-scope">[' + e.scope + ']</span>' +
      '<span class="pattern-log-msg" title="' + String(e.msg).replace(/"/g, '&quot;') + '">' + e.msg + '</span>' +
      '</div>';
  }).join('');
}

function patternCardHtml(ev) {
  const def = DETECTOR_DEFS[ev.detectorKey];
  const dirCls = ev.direction === 'LONG' ? 'signal-buy' : (ev.direction === 'SHORT' ? 'signal-sell' : 'signal-wait');
  const details = [];
  if (ev.repeatCount != null) details.push(ev.repeatCount + ' повторов');
  if (ev.cycleS != null) details.push('цикл ~' + ev.cycleS + 'с');
  if (ev.avgStepPct != null) details.push('шаг ~' + ev.avgStepPct + '%');
  if (ev.avgIntervalS != null) details.push('~' + ev.avgIntervalS + 'с');
  if (ev.sizeRangeUsd) details.push('$' + ev.sizeRangeUsd[0] + '–$' + ev.sizeRangeUsd[1]);
  if (ev.buyRangeUsd) details.push('BUY $' + ev.buyRangeUsd[0] + '–$' + ev.buyRangeUsd[1]);
  if (ev.sellRangeUsd) details.push('SELL $' + ev.sellRangeUsd[0] + '–$' + ev.sellRangeUsd[1]);
  if (ev.sequencePattern) details.push('"' + ev.sequencePattern + '"');
  if (ev.imbalanceRatio != null) details.push('ratio ' + ev.imbalanceRatio);
  if (ev.priceLevel != null) details.push('уровень ' + fmtPrice(ev.priceLevel));
  if (ev.shrinkPct != null) details.push('усохло ' + ev.shrinkPct + '%');
  if (ev.volumeDeclinePct != null) details.push('спад ' + ev.volumeDeclinePct + '%');
  if (ev.zonePrice != null) details.push('зона ' + fmtPrice(ev.zonePrice));
  if (ev.avgReactionPct != null) details.push('реакция ' + ev.avgReactionPct + '%');
  if (ev.volumeUsd != null) details.push('$' + Math.round(ev.volumeUsd).toLocaleString('ru-RU'));
  const ago = Math.max(0, Math.round((Date.now() - ev.detectedAt) / 1000));
  const heuristicCls = ev.isHeuristic ? ' pattern-card-heuristic' : '';
  return '<div class="profile-strategy-card pattern-card' + heuristicCls + '" data-symbol="' + ev.symbol.replace(/"/g, '&quot;') + '" title="Открыть график и стакан ' + ev.symbol.replace(/"/g, '&quot;') + '">' +
    '<div class="card-top"><span class="card-icon"><i class="ri-radar-2-line"></i></span>' +
    '<h4>' + ev.symbol.replace(/</g, '&lt;') + '<span class="card-count">' + ev.confidencePct + '%</span></h4></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin:6px 0 8px;flex-wrap:wrap;">' +
    '<span class="signal-badge ' + dirCls + '">' + ev.direction + '</span>' +
    '<span style="font-size:11px;color:var(--text-muted);">' + def.label + ' · ' + ago + 'с назад</span>' +
    (ev.isHeuristic ? '<span style="font-size:10px;color:var(--orange);border:1px solid rgba(255,159,10,.4);border-radius:4px;padding:1px 6px;">ЭВРИСТИКА</span>' : '') +
    '</div>' +
    '<p>' + explainPatternEvent(ev) + '</p>' +
    (details.length ? '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">' + details.join(' · ') + '</div>' : '') +
    '</div>';
}

function updatePatternsPage() {
  const page = document.getElementById('page-patterns');
  if (!page || !page.classList.contains('active')) return;

  const statusEl = document.getElementById('watchlistStatusText');
  if (statusEl) statusEl.textContent = watchlistStatusText();

  const healthGrid = document.getElementById('patternsHealthGrid');
  if (healthGrid) {
    const wsAgeS = Math.round((Date.now() - lastMiniTickerAt) / 1000);
    const wsOk = ws && ws.readyState === 1 && wsAgeS < 30;
    healthGrid.innerHTML =
      patternStatCard('Основной поток', wsOk ? 'LIVE' : 'МОЛЧИТ/ОБРЫВ', wsOk ? 'up' : 'down') +
      patternStatCard('Watchlist', watchlist.size + '/' + WATCHLIST_SIZE) +
      patternStatCard('WS-соединений (Tier 2)', watchlist.size * 2) +
      patternStatCard('Подключений всего', tier2Health.connectionAttempts) +
      patternStatCard('Сделок обработано', tier2Health.tradesIngested) +
      patternStatCard('Обновлений стакана', tier2Health.depthPushesIngested) +
      patternStatCard('Активных паттернов', activePatternEvents.length, activePatternEvents.length ? 'up' : null) +
      patternStatCard('В истории', patternHistory.length) +
      patternStatCard('В cooldown', tier2Health.cooldownDrops, tier2Health.cooldownDrops ? 'down' : null);
  }
  renderPatternLogPanel();

  const grid = document.getElementById('patternsGrid');
  const countEl = document.getElementById('patternsCount');
  // ТЗ #8/#9: "лучше 5 действительно интересных ситуаций, чем 100 слабых" — теперь, когда весь
  // движок (12 детекторов) собран, сужаем до буквально ~5, как и просили.
  const top = activePatternEvents.slice(0, 5);
  if (countEl) countEl.textContent = activePatternEvents.length + ' активных';
  if (grid) {
    if (!top.length) {
      grid.innerHTML = '<div class="finres-empty" style="grid-column:1/-1;"><i class="ri-radar-2-line"></i>' +
        (watchlist.size === 0
          ? 'Watchlist ещё наполняется — паттерны появятся, когда накопится история сделок по отслеживаемым монетам.'
          : 'Пока не найдено ни одного паттерна с достаточной уверенностью — это нормально, показываем только то, что реально выглядит неслучайным, а не любой шум.') +
        '</div>';
    } else {
      grid.innerHTML = top.map(patternCardHtml).join('');
    }
  }

  updatePatternValidationPanel();
}

// Простая train/test валидация против переобучения (ТЗ #15) — по КАЖДОМУ детектору, у которого уже
// накопилось достаточно ЗАКРЫТЫХ (outcome.at2m заполнен) записей истории, сравнивает винрейт
// "reference" (закрыто раньше 24ч назад) против "recent" (закрыто позже) — MexcCore.computeValidationSplit.
// Заметная просадка recent относительно reference помечается прямо в таблице, а не скрывается.
const PATTERN_VALIDATION_MIN_SAMPLE = 5;
function updatePatternValidationPanel() {
  const el = document.getElementById('patternValidationBody');
  if (!el) return;
  const rows = Object.keys(DETECTOR_DEFS).map(function (key) {
    const split = MexcCore.computeValidationSplit(patternHistory, key, { checkpointKey: 'at2m', successThresholdPct: PATTERN_SUCCESS_THRESHOLD_PCT });
    return { key: key, label: DETECTOR_DEFS[key].label, split: split };
  }).filter(function (r) { return r.split.reference.sampleSize >= PATTERN_VALIDATION_MIN_SAMPLE || r.split.recent.sampleSize >= PATTERN_VALIDATION_MIN_SAMPLE; });

  if (!rows.length) {
    el.innerHTML = '<tr><td colspan="4" class="finres-empty" style="padding:20px;"><i class="ri-flask-line"></i>' +
      'Пока недостаточно закрытых сигналов (нужно дождаться истечения окна +2 минуты после детекции) — таблица наполнится по мере работы.</td></tr>';
    return;
  }
  el.innerHTML = rows.map(function (r) {
    const refPct = r.split.reference.rate != null ? Math.round(r.split.reference.rate * 100) + '%' : '—';
    const recPct = r.split.recent.rate != null ? Math.round(r.split.recent.rate * 100) + '%' : '—';
    const recCls = r.split.degraded ? 'down' : (r.split.recent.rate != null && r.split.reference.rate != null && r.split.recent.rate >= r.split.reference.rate ? 'up' : '');
    return '<tr>' +
      '<td>' + r.label + '</td>' +
      '<td>' + refPct + ' <span style="color:var(--text-muted);font-size:10px;">(n=' + r.split.reference.sampleSize + ')</span></td>' +
      '<td class="' + recCls + '">' + recPct + ' <span style="color:var(--text-muted);font-size:10px;">(n=' + r.split.recent.sampleSize + ')</span></td>' +
      '<td>' + (r.split.degraded ? '<span style="color:var(--orange);">⚠ просадка ≥20 п.п.</span>' : (r.split.reference.sampleSize >= PATTERN_VALIDATION_MIN_SAMPLE && r.split.recent.sampleSize >= PATTERN_VALIDATION_MIN_SAMPLE ? '<span style="color:var(--green);">стабильно</span>' : '—')) + '</td>' +
      '</tr>';
  }).join('');
}

function sortCoins(field) {
  if (sortField === field) sortAsc = !sortAsc;
  else { sortField = field; sortAsc = false; }
  if (activeStrategy && STRATEGY_DEFS[activeStrategy]) strategyManualSort = true;
  applySortOnly();
  document.querySelectorAll('#coinTable th[data-sort]').forEach(function (th) {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === field) th.classList.add(sortAsc ? 'sorted-asc' : 'sorted-desc');
  });
  renderTable();
}

function updateFavoritesPage() {
  const container = document.getElementById('favoritesContainer');
  const favs = allCoins.filter(function (c) { return c.fav; });
  document.getElementById('favCount').textContent = favs.length + ' монет';
  document.getElementById('navFavBadge').textContent = favs.length;
  if (!favs.length) {
    container.innerHTML = '<div class="empty-state"><i class="ri-star-line"></i>Нет избранных пар. Отметьте звездой в таблице.</div>';
    return;
  }
  container.innerHTML = '<div class="favorites-grid">' + favs.map(function (c) {
    return '<div class="fav-card" data-symbol="' + c.symbol + '">' +
      '<div class="coin-icon" style="background:' + c.color + ';margin:0 auto 8px;width:40px;height:40px;font-size:18px;">' + c.baseAsset.charAt(0) + '</div>' +
      '<div class="fav-symbol">' + c.symbol + '</div>' +
      '<div class="fav-price">' + fmtPrice(c.price) + '</div>' +
      '<div class="fav-change ' + (c.change24 >= 0 ? 'price-up' : 'price-down') + '">' + (c.change24 >= 0 ? '+' : '') + c.change24.toFixed(2) + '%</div>' +
      '<button class="fav-remove" data-symbol="' + c.symbol + '">Убрать</button></div>';
  }).join('') + '</div>';
  container.querySelectorAll('.fav-card').forEach(function (card) {
    card.addEventListener('click', function (e) {
      if (e.target.closest('.fav-remove')) return;
      selectCoin(this.dataset.symbol, true);
      switchPage('screener');
    });
  });
  container.querySelectorAll('.fav-remove').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const coin = coinMap.get(this.dataset.symbol);
      if (coin) coin.fav = false;
      updateFavoritesPage();
      renderTable();
      updateFavButton();
    });
  });
}

function updateAnalytics() {
  function list(arr, fmt) {
    return arr.map(function (c) {
      return '<div class="rank-row"><span>' + c.symbol + '</span><span>' + fmt(c) + '</span></div>';
    }).join('') || '<div class="rank-row">Нет данных</div>';
  }
  const copy = allCoins.slice();
  document.getElementById('topGainers').innerHTML = list(copy.slice().sort(function (a, b) { return b.change24 - a.change24; }).slice(0, 8), function (c) {
    return '<span class="price-up">+' + c.change24.toFixed(2) + '%</span>';
  });
  document.getElementById('topLosers').innerHTML = list(copy.slice().sort(function (a, b) { return a.change24 - b.change24; }).slice(0, 8), function (c) {
    return '<span class="price-down">' + c.change24.toFixed(2) + '%</span>';
  });
  document.getElementById('topVolume').innerHTML = list(copy.slice().sort(function (a, b) { return b.vol24 - a.vol24; }).slice(0, 8), function (c) {
    return fmtNum(c.vol24);
  });
  document.getElementById('topVolat').innerHTML = list(copy.slice().sort(function (a, b) { return b.vol60s - a.vol60s; }).slice(0, 8), function (c) {
    return c.vol60s.toFixed(3) + '%';
  });
}

function updateAlerts() {
  const thr = num(document.getElementById('priceAlertThreshold').value) || 8;
  const hits = allCoins.filter(function (c) { return Math.abs(c.change24) >= thr; })
    .sort(function (a, b) { return Math.abs(b.change24) - Math.abs(a.change24); })
    .slice(0, 30);
  document.getElementById('navAlertBadge').textContent = hits.length;
  const box = document.getElementById('alertsList');
  if (!hits.length) {
    box.innerHTML = '<div class="empty-state"><i class="ri-notification-off-line"></i>Нет пар с движением ≥ ' + thr + '% за 24ч.</div>';
    return;
  }
  box.innerHTML = hits.map(function (c) {
    return '<div class="alert-row"><div class="coin-icon" style="background:' + c.color + '">' + c.baseAsset.charAt(0) + '</div>' +
      '<strong>' + c.symbol + '</strong><span>' + fmtPrice(c.price) + '</span>' +
      '<span class="' + (c.change24 >= 0 ? 'price-up' : 'price-down') + '">' + (c.change24 >= 0 ? '+' : '') + c.change24.toFixed(2) + '%</span></div>';
  }).join('');
}

function switchPage(pageId) {
  document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
  const target = document.getElementById('page-' + pageId);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(function (n) {
    n.classList.toggle('active', n.dataset.page === pageId);
  });
  if (pageId === 'favorites') updateFavoritesPage();
  if (pageId === 'analytics') updateAnalytics();
  if (pageId === 'alerts') updateAlerts();
  if (pageId === 'profiles') updateProfilesPage();
  if (pageId === 'patterns') { renderDetectorFilterRow(); updatePatternsPage(); }
  if (pageId === 'account') refreshAccountBalancesIfConnected();
  if (pageId === 'finres') {
    // Сразу красим хиро/вкладку из уже закешированного lastBalanceState (если он есть — например,
    // юзер уже был на этой странице раньше в сессии), не дожидаясь ответа сети — и параллельно
    // запрашиваем свежие данные.
    renderFinresHero();
    renderFinresTab();
    refreshAccountBalancesIfConnected();
  }
}

// Подсвечивает карточку текущего активного профиля на стр. "Профили" (синяя рамка + бейдж "АКТИВЕН"),
// чтобы сразу было видно, какой профиль сейчас применён в скринере, без необходимости смотреть в выпадающий список.
function updateActiveProfileCards(name) {
  document.querySelectorAll('.profile-strategy-card[data-profile]').forEach(function (card) {
    card.classList.toggle('active', card.dataset.profile === name);
  });
}

// Считает, сколько монет прямо сейчас проходит match() каждой стратегии, и показывает
// live-счётчик на карточках профилей (стр. "Профили") — удобно оценить, не слишком ли узкие/широкие пороги.
function updateProfilesPage() {
  const page = document.getElementById('page-profiles');
  if (!page || !page.classList.contains('active')) return;
  const stats = computeStrategyStats();
  const ids = { algo: 'cardCountAlgo', ineff: 'cardCountIneff', density: 'cardCountDensity' };
  Object.keys(ids).forEach(function (key) {
    const def = STRATEGY_DEFS[key];
    let n = 0;
    for (let i = 0; i < allCoins.length; i++) { if (def.match(allCoins[i], stats)) n++; }
    const el = document.getElementById(ids[key]);
    if (el) el.textContent = n + ' монет сейчас';
  });
  const sel = document.getElementById('profileSelect');
  if (sel) updateActiveProfileCards(sel.value);
}

function showModal(title, text) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').textContent = text;
  document.getElementById('modal').classList.add('active');
}

// Показывает/скрывает и заполняет очень короткую подсказку "что за алгоритм" над таблицей —
// текст берётся из STRATEGY_DEFS[key].short (та же строка, что и в title у бейджа сигнала в
// строке таблицы, и на карточке профиля). Живой счётчик обновляется отдельно из renderTable()
// (там уже посчитано, сколько монет прошло match(), пересчитывать второй раз незачем).
function updateStrategyHintBar() {
  const bar = document.getElementById('strategyHintBar');
  if (!bar) return;
  const def = activeStrategy ? STRATEGY_DEFS[activeStrategy] : null;
  bar.classList.toggle('visible', !!def);
  if (!def) return;
  document.getElementById('strategyHintBadge').textContent = def.badge;
  document.getElementById('strategyHintText').textContent = def.label + ': ' + def.short;
}

function applyProfile(name) {
  updateActiveProfileCards(name);
  const map = {
    conservative: { vol24: '5000000', vol5: '', vol5s: '', vol30s: '', chg: '', from: '', to: '' },
    balanced: { vol24: '100000', vol5: '', vol5s: '', vol30s: '', chg: '', from: '', to: '' },
    aggressive: { vol24: '20000', vol5: '', vol5s: '0.02', vol30s: '', chg: '', from: '', to: '' },
    movers: { vol24: '50000', vol5: '', vol5s: '', vol30s: '', chg: '5', from: '', to: '' },
    custom: null
  };

  // Стратегические профили (Алгоритмы/Неэффективности/Пробой плотностей): своя логика отбора
  // и скоринга живёт в STRATEGY_DEFS (match/score), здесь просто сбрасываем ручные числовые
  // фильтры (чтобы они не мешали match()) и включаем нужную стратегию.
  if (STRATEGY_DEFS[name]) {
    activeStrategy = name;
    strategyManualSort = false; // новая стратегия — снова показываем рекомендованный порядок по score
    ['filterVol24', 'filterVol5', 'filterVol5s', 'filterVol30s', 'filterChg', 'filterPriceFrom', 'filterPriceTo'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
    applySortOnly();
    updateStrategyHintBar();
    renderTable();
    refreshDensityPanelForCurrentCoin();
    return;
  }

  activeStrategy = null;
  updateStrategyHintBar();
  refreshDensityPanelForCurrentCoin();
  const p = map[name];
  if (!p) { renderTable(); return; }
  document.getElementById('filterVol24').value = p.vol24;
  document.getElementById('filterVol5').value = p.vol5;
  document.getElementById('filterVol5s').value = p.vol5s;
  document.getElementById('filterVol30s').value = p.vol30s;
  document.getElementById('filterChg').value = p.chg;
  document.getElementById('filterChgOp').value = name === 'movers' ? '>=' : '>=';
  document.getElementById('filterPriceFrom').value = p.from;
  document.getElementById('filterPriceTo').value = p.to;
  applySortOnly();
  renderTable();
}

// Показывает/скрывает панель "Плотность" у графика в зависимости от того, активна ли сейчас
// стратегия "Пробой плотностей" — вызывается и при смене профиля, и при выборе новой монеты.
function refreshDensityPanelForCurrentCoin() {
  if (!currentCoin) { updateDensityLevelsPanel(null); return; }
  updateDensityLevelsPanel(coinMap.get(currentCoin.symbol) || currentCoin);
}

function updateDensityLevelsPanel(c) {
  updateCoinAnalysisBar(c);
  const bar = document.getElementById('densityLevelsBar');
  if (!bar) return;
  if (!c || activeStrategy !== 'density') { bar.classList.remove('visible'); return; }
  const zoneText = document.getElementById('densityZoneText');
  const breakText = document.getElementById('densityBreakText');
  if (zoneText) {
    zoneText.innerHTML = (c.zoneLow != null && c.zoneHigh != null && c.zoneHigh > c.zoneLow)
      ? '<span class="lvl-tag">зона:</span>' + fmtPrice(c.zoneLow) + '–' + fmtPrice(c.zoneHigh)
      : '<span class="lvl-tag">зона:</span>копим данные…';
  }
  if (breakText) breakText.innerHTML = '<span class="lvl-tag">пробой:</span>' + fmtPrice(c.price);
  bar.classList.add('visible');
}

// Живой, посчитанный по РЕАЛЬНЫМ метрикам открытой монеты разбор: почему она попадает (или пока
// не дотягивает) под активную стратегию отбора. В отличие от .strategy-hint-bar (статичное
// описание алгоритма вообще) — это объяснение именно ЭТОЙ монеты, пересчитывается заново при
// каждом выборе монеты и при каждой смене активной стратегии.
function pctText(v) { return v == null ? '—' : v.toFixed(2) + '%'; }

function explainCoinForStrategy(c, key, s) {
  if (!c || !key || !STRATEGY_DEFS[key]) return '';
  const matched = STRATEGY_DEFS[key].match(c, s);
  const prefix = matched ? 'Совпадает с профилем. ' : 'Пока не дотягивает до профиля. ';
  const burst = burstRatio(c);
  if (key === 'algo') {
    const cvText = c.rateCV != null ? (c.rateCV * 100).toFixed(0) + '%' : '—';
    return prefix + 'Скорость оборота почти не меняется между окнами 5с/30с/60с (разброс ' + cvText +
      '), а цена держится в узком диапазоне: ' + pctText(c.vol5s) + ' за 5с, ' + pctText(c.vol30s) + ' за 30с, ' +
      pctText(c.vol60s) + ' за 60с. Сочетание "ровный темп сделок + минимум движения цены" типично для ' +
      'маркет-мейкера или арбитражного бота, а не для органической торговли людьми.';
  }
  if (key === 'ineff') {
    return prefix + 'Цена сдвинулась на ' + pctText(c.vol5s) + ' всего за 5 секунд, но объём при этом вырос лишь ' +
      'в ' + burst.toFixed(1) + '× от обычного темпа этой монеты — заметно меньше, чем бывает при реальном ' +
      'потоке заявок. Движение цены опережает подтверждающий его объём: похоже, что её сдвинула небольшая ' +
      'заявка на тонком участке книги ордеров, а не устойчивый спрос/предложение.';
  }
  if (key === 'density') {
    const calmText = c.preMove != null ? pctText(c.preMove) : 'нет данных';
    const revertText = c.reverting
      ? ' Но в последние ~2с цена уже разворачивается против этого всплеска — больше похоже на фитиль/ложный ' +
        'прокол уровня, чем на устойчивый пробой, поэтому в выдачу она не попадёт.'
      : (matched ? ' Разворота против движения в последние ~2с не видно — похоже на устойчивый пробой.' : '');
    return prefix + 'Перед всплеском (60с→30с назад) движение было спокойным: ' + calmText + '. За последние 5с ' +
      'объём резко вырос — в ' + burst.toFixed(1) + '× от обычного дневного темпа этой монеты, и цена пошла на ' +
      pctText(c.vol5s) + '.' + revertText;
  }
  return '';
}

function updateCoinAnalysisBar(c) {
  const bar = document.getElementById('coinAnalysisBar');
  if (!bar) return;
  if (!c || !activeStrategy || !STRATEGY_DEFS[activeStrategy]) { bar.classList.remove('visible'); bar.classList.remove('matched'); return; }
  const s = strategyStats || computeStrategyStats();
  const def = STRATEGY_DEFS[activeStrategy];
  const matched = def.match(c, s);
  bar.classList.add('visible');
  bar.classList.toggle('matched', matched);
  const badgeEl = document.getElementById('coinAnalysisBadge');
  if (badgeEl) badgeEl.textContent = def.badge + (matched ? ' ✓ совпадает' : ' — не совпадает');
  const textEl = document.getElementById('coinAnalysisText');
  if (textEl) {
    const explanation = explainCoinForStrategy(c, activeStrategy, s);
    textEl.textContent = explanation;
    textEl.title = explanation; // полный текст по наведению — сама плашка теперь однострочная (см. CSS), чтобы не отъедать высоту у графика
  }
}

// ============================================
// АККАУНТ MEXC (вход по API-ключу)
// ------------------------------------------------------------------
// Полностью клиентская интеграция: секрет никогда не покидает это устройство,
// подпись HMAC-SHA256 считается прямо в браузере (Web Crypto API), запрос уходит
// напрямую в api.mexc.com. Только просмотр (баланс + мои открытые ордера по
// выбранной паре) — никаких вызовов на создание/отмену ордеров скринер не делает.
// ============================================
const MEXC_REST = 'https://api.mexc.com';
let mexcApiKey = '';
let mexcApiSecret = '';
let accountConnected = false;
let acctOrdersReqSeq = 0;

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// fetch() без таймаута может зависнуть на десятки секунд/минуты, если сеть просто "молчит"
// (пакеты тихо дропаются файрволом/антивирусом) — это выглядит как "долго идёт подключение".
// Обрываем сами через AbortController, чтобы быстро перейти к запасному пути (curl.exe).
function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  return fetch(url, Object.assign({}, opts, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

// Оборачивает промис жёстким таймаутом — на случай, если сам процесс (curl.exe) зависнет
// по причине, не покрытой его собственным max-time (например, проблема с запуском процесса).
function withHardTimeout(promise, ms, timeoutMsg) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error(timeoutMsg)); }, ms);
    promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
  });
}

function stripQuotes(s) {
  return String(s).replace(/"/g, '');
}

// ============================================================================
// СОБСТВЕННЫЙ МОСТ К NATIVE-БЭКЕНДУ NEUTRALINO (в обход штатного Neutralino.init()/l()).
//
// Диагностика показала: "сырой" WebSocket до внутреннего сервера приложения (тот же порт,
// тот же формат connectToken, что использует сама библиотека) открывается МГНОВЕННО и
// стабильно, когда мы пробуем его вручную по кнопке "Проверить подключение". А вот штатные
// Neutralino.app.getConfig()/Neutralino.os.execCommand() зависают на полный таймаут КАЖДЫЙ РАЗ.
//
// Разгадка — в самой библиотеке neutralino.js: она открывает свой единственный WebSocket ОДИН
// РАЗ при вызове Neutralino.init() (сразу на старте страницы) и, если это самое первое
// подключение не открывается с первой попытки (например, внутренний WS-сервер приложения ещё
// на Windows не успел полностью подняться к моменту, когда страница уже отрисовалась и наш код
// выполнился) — переподключения НЕТ вообще. Все дальнейшие вызовы молча складываются во
// внутреннюю очередь и ждут события "open", которое уже никогда не наступит. Это конкретный,
// воспроизводимый баг именно в тайминге старта, а не антивирус и не IPv4/IPv6.
//
// Обход: свой WebSocket-клиент к тому же серверу, с тем же протоколом (он был получен из кода
// самой библиотеки), но с реальным переподключением при необходимости — используется вместо
// Neutralino.os.execCommand()/Neutralino.app.getConfig() везде в этом файле.
let _nlBridgeWs = null;
let _nlBridgeHandlers = {};

function nlBridgeConnect() {
  return new Promise(function (resolve, reject) {
    if (_nlBridgeWs && _nlBridgeWs.readyState === WebSocket.OPEN) { resolve(_nlBridgeWs); return; }
    if (typeof window.NL_PORT === 'undefined' || typeof window.NL_TOKEN === 'undefined' || !window.NL_TOKEN) {
      reject(new Error('NL_PORT/NL_TOKEN недоступны (нет desktop-обёртки)'));
      return;
    }
    const rawToken = String(window.NL_TOKEN);
    const dotIdx = rawToken.indexOf('.');
    const connectToken = dotIdx !== -1 ? rawToken.split('.')[1] : rawToken;
    const url = 'ws://127.0.0.1:' + window.NL_PORT + '?connectToken=' + encodeURIComponent(connectToken);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      reject(new Error('таймаут подключения к native-мосту приложения (6с)'));
    }, 6000);
    ws.onopen = function () {
      clearTimeout(timer);
      _nlBridgeWs = ws;
      resolve(ws);
    };
    ws.onerror = function () {
      clearTimeout(timer);
      reject(new Error('ошибка подключения к native-мосту приложения'));
    };
    ws.onclose = function () {
      if (_nlBridgeWs === ws) _nlBridgeWs = null;
    };
    ws.onmessage = function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.id || !_nlBridgeHandlers[msg.id]) return;
      const h = _nlBridgeHandlers[msg.id];
      delete _nlBridgeHandlers[msg.id];
      if (msg.data && msg.data.error) {
        h.reject(new Error((msg.data.error.message || msg.data.error.code || 'ошибка native-моста')));
      } else if (msg.data && msg.data.success) {
        h.resolve(msg.data.hasOwnProperty('returnValue') ? msg.data.returnValue : msg.data);
      } else {
        h.resolve(msg.data);
      }
    };
  });
}

// Вызов нативного метода Neutralino (например "os.execCommand", "app.getConfig") напрямую
// через собственный мост, с автоматическим (пере)подключением при необходимости.
async function nlCall(method, data, timeoutMs) {
  const ws = await nlBridgeConnect();
  return new Promise(function (resolve, reject) {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const timer = setTimeout(function () {
      if (_nlBridgeHandlers[id]) {
        delete _nlBridgeHandlers[id];
        reject(new Error('native-мост не ответил на "' + method + '" за ' + (timeoutMs || 8000) + 'мс'));
      }
    }, timeoutMs || 8000);
    _nlBridgeHandlers[id] = {
      resolve: function (v) { clearTimeout(timer); resolve(v); },
      reject: function (e) { clearTimeout(timer); reject(e); }
    };
    try {
      ws.send(JSON.stringify({ id: id, method: method, data: data || {}, accessToken: String(window.NL_TOKEN || '') }));
    } catch (e) {
      clearTimeout(timer);
      delete _nlBridgeHandlers[id];
      reject(e);
    }
  });
}

// ============================================================================
// ДОЛГОВЕЧНОЕ ХРАНИЛИЩЕ ПОВЕРХ localStorage (только desktop-обёртка).
//
// Баг "после обновления теряется история/API-ключи": localStorage в WebView2 привязан к
// конкретному ФАЙЛУ .exe (см. docs про два разных .exe с изолированными профилями), а не к самому
// приложению — новая сборка exe (даже с тем же именем, но, например, из новой папки, или после
// смены имени файла) может получить пустой профиль WebView2. Neutralino.storage, наоборот,
// привязан к applicationId из neutralino.config.json ("com.mexcscreener.app") и живёт в файле на
// диске рядом с приложением — переживает пересборку/переименование exe. Через штатный
// Neutralino.storage.* эти вызовы виснут (тот же уже задокументированный баг тайминга старта,
// см. комментарий у nlCall выше) — используем тот же собственный WS-мост.
//
// localStorage остаётся основным, СИНХРОННЫМ источником на каждый день (ничего в существующем коде
// не меняется) — Neutralino.storage только теневая резервная копия: пишется вдогонку при каждом
// сохранении (persistSet/persistRemove ниже) и читается один раз при старте, только если локальный
// профиль оказался пустым (см. hydrateFromNativeStorageIfNeeded).
function nlStorageSet(key, value) {
  if (!window.Neutralino) return;
  nlCall('storage.setData', { key: key, data: value }, 8000).catch(function (e) {
    logD('Storage', 'не удалось продублировать "' + key + '" в постоянное хранилище: ' + e.message);
  });
}
async function nlStorageGet(key) {
  if (!window.Neutralino) return null;
  try {
    const v = await nlCall('storage.getData', { key: key }, 8000);
    return (typeof v === 'string' && v) ? v : null;
  } catch (e) {
    return null; // ключа там ещё нет (или сам мост недоступен) — не ошибка, просто нечего восстанавливать
  }
}
// Единая точка сохранения для всего, что должно пережить пересборку desktop-приложения — localStorage
// как и раньше синхронно, плюс (только в desktop-обёртке, best-effort, никогда не блокирует UI) теневая
// копия в Neutralino.storage.
function persistSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
  nlStorageSet(key, value);
}
function persistRemove(key) {
  try { localStorage.removeItem(key); } catch (e) {}
  nlStorageSet(key, ''); // у Neutralino.storage нет отдельного "удалить" — пустая строка это и есть удаление
}

// Быстрая самопроверка: вообще способен ли native-мост запускать процессы на этой машине.
// Если зависает даже тривиальная команда — дело не в curl/PowerShell и не в сети (которая
// уже подтверждена рабочей), а в том, что что-то (чаще всего антивирус/EDR) блокирует или подвешивает
// ЛЮБОЙ дочерний процесс, порождаемый этим .exe. Короткий таймаут (5с) — эхо должно быть мгновенным.
async function execCommandSelfTest() {
  try {
    const ping = await nlCall('os.execCommand', { command: 'cmd.exe /C echo ping', background: false }, 5000);
    if (!ping || ping.exitCode !== 0) {
      throw new Error('запуск процессов вернул код ' + (ping && ping.exitCode));
    }
  } catch (pingErr) {
    throw new Error('Запуск процессов из приложения не работает на этой машине (' + pingErr.message + '). ' +
      'Похоже, антивирус блокирует или задерживает дочерние процессы у MEXC-Screener.exe. Добавьте ' +
      'MEXC-Screener.exe в исключения антивируса (Защитник Windows: Параметры → Безопасность Windows → ' +
      'Защита от вирусов и угроз → Управление настройками → Добавление или удаление исключений) и попробуйте снова.');
  }
}

// Запасной путь для десктоп-приложения (Neutralino): выполняет HTTP-запрос через curl.exe (входит
// в Windows 10/11 по умолчанию) — это ОТДЕЛЬНЫЙ ОС-процесс, не запрос браузера, поэтому на него не
// распространяются ограничения CORS. curl.exe — обычный скомпилированный бинарник (в отличие от
// PowerShell с закодированным скриптом, который антивирусы чаще проверяют дольше как потенциально
// подозрительный). Используется автоматически, только если обычный fetch() не сработал.
async function nativeCurlGet(url, apiKey, method) {
  if (!window.Neutralino) {
    return null; // нативный путь недоступен (не десктоп-приложение)
  }
  await execCommandSelfTest(); // бросит понятную ошибку, если процессы вообще не запускаются

  // apiKey нужен только для приватных подписанных запросов — публичные эндпоинты (например klines)
  // вызывают эту же функцию без ключа, тогда заголовок просто не добавляем.
  const header = apiKey ? ' -H "X-MEXC-APIKEY: ' + stripQuotes(apiKey) + '"' : '';
  // -X нужен только для не-GET (например POST/PUT/DELETE /api/v3/userDataStream — см. listenKeyRequest
  // ниже); MEXC у этих эндпоинтов, как и у GET, ожидает подписанные параметры в query string, тело
  // запроса не нужно, поэтому просто меняем метод, а не добавляем -d.
  const methodFlag = (method && method !== 'GET') ? ' -X ' + method : '';
  const cmd = 'curl.exe -s -S --max-time 10' + methodFlag + header + ' "' + stripQuotes(url) + '"';
  const result = await nlCall('os.execCommand', { command: cmd, background: false }, 14000);
  if (result && result.exitCode === 0) {
    return { ok: true, body: result.stdOut };
  }
  throw new Error('curl.exe: ' + ((result && (result.stdErr || result.stdOut)) || ('exit code ' + (result && result.exitCode))));
}

// Подписанный GET-запрос к приватному REST API MEXC (timestamp + HMAC-SHA256 подпись параметров).
// Сначала пробует обычный fetch() из браузера; если MEXC блокирует его по CORS (частая практика
// бирж для приватных эндпоинтов) — в десктоп-приложении автоматически пробует нативный запрос
// через curl.exe в обход браузерных ограничений. В обычной веб-версии (без десктоп-обёртки)
// обходного пути нет — CORS проверяется сервером MEXC, а не нашим кодом.
// Собирает подписанный URL со СВЕЖИМ timestamp — вынесено отдельно, чтобы пересобирать подпись
// заново перед каждой попыткой (браузер / native-фолбэк), а не переиспользовать один и тот же
// timestamp, вычисленный ещё до долгой попытки через fetch(). Иначе, пока fetch() ждёт таймаута
// или CORS-отказа (до 8с), время "утекает", и когда до MEXC доходит запрос через curl.exe —
// исходная подпись уже может оказаться вне recvWindow, даже если часы на компьютере верны.
// Это и есть частая причина ошибки "Timestamp for this request is outside of the recvWindow.".
async function buildSignedUrl(path, params) {
  const p = Object.assign({}, params, { timestamp: Date.now(), recvWindow: 10000 });
  const qs = Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
  const signature = await hmacSha256Hex(mexcApiSecret, qs);
  return MEXC_REST + path + '?' + qs + '&signature=' + signature;
}

async function mexcSignedRequest(path, params, onProgress, method) {
  method = method || 'GET';
  let url = await buildSignedUrl(path, params);

  let text = null;
  let httpOk = true;
  if (onProgress) onProgress('browser');
  try {
    const res = await fetchWithTimeout(url, { method: method, headers: { 'X-MEXC-APIKEY': mexcApiKey } }, 8000);
    text = await res.text();
    httpOk = res.ok;
    if (!httpOk) {
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* оставляем null */ }
      throw new Error((data && (data.msg || data.message)) || text || ('HTTP ' + res.status));
    }
  } catch (fetchErr) {
    // fetch() либо не смог даже начать запрос (сеть/CORS/таймаут — сообщение браузера скрывает точную
    // причину), либо MEXC ответил ошибкой уже после соединения (httpOk === false, тогда пробрасываем как есть).
    if (!httpOk) throw fetchErr;
    const fetchReason = fetchErr && fetchErr.name === 'AbortError' ? 'таймаут 8с' : (fetchErr && fetchErr.message) || 'сеть/CORS';
    if (onProgress) onProgress('native');
    url = await buildSignedUrl(path, params); // свежий timestamp/подпись перед native-попыткой
    let native = null;
    try {
      native = await nativeCurlGet(url, mexcApiKey, method);
    } catch (nativeErr) {
      throw new Error('Браузер не смог достучаться до api.mexc.com напрямую (' + fetchReason + '), и запасной способ через curl.exe тоже не сработал: ' + nativeErr.message);
    }
    if (!native) {
      throw new Error('Не удалось связаться с api.mexc.com напрямую из браузера (' + fetchReason + '). Похоже, MEXC блокирует такие запросы из браузера для этого источника. ' +
        'В desktop-приложении (пункт «Скачать приложение» в боковой панели) тот же запрос идёт в обход браузера и должен сработать.');
    }
    text = native.body;
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {
    throw new Error('MEXC вернул нераспознаваемый ответ: ' + String(text).slice(0, 200));
  }
  // Некоторые ошибки MEXC приходят с HTTP 200 (в т.ч. через curl-путь, где статус не проверяется),
  // но телом вида {code, msg} — отличаем это от успешного ответа (объект аккаунта или массив ордеров).
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.code === 'number' &&
      data.code !== 200 && data.code !== 0 && typeof data.balances === 'undefined') {
    const msg = data.msg || ('Ошибка MEXC (код ' + data.code + ')');
    // "Timestamp for this request is outside of the recvWindow" — MEXC сверяет наш timestamp со
    // своими часами; чаще всего дело в том, что системные часы на этом компьютере спешат/отстают.
    // Добавляем понятную подсказку прямо к ошибке, а не просто пробрасываем английский текст MEXC.
    if (/recvWindow|Timestamp for this request/i.test(msg)) {
      throw new Error(msg + ' Похоже, системные часы на этом компьютере расходятся с реальным временем — ' +
        'проверьте дату/время (Windows: Параметры → Время и язык → «Синхронизировать сейчас») и попробуйте подключиться снова.');
    }
    throw new Error(msg);
  }
  return data;
}

// ============================================================================
// ПРИВАТНЫЙ ПОТОК СДЕЛОК АККАУНТА (spot@private.deals.v3.api.pb) — автоматическое обнаружение монет
// для Финреза, без ручного поиска на вкладке "Сделки".
//
// Проблема, которую это решает: Финрез строит историю только по монетам ИЗ ТЕКУЩЕГО БАЛАНСА +
// knownSymbols (см. её комментарий выше) — если позицию открыли и полностью закрыли (что для
// скальпера/дневного трейдера, торгующего через внешний терминал, обычное дело много раз за день),
// монета никогда не появится в балансе САМА и остаётся невидимой, пока её не найдут вручную.
//
// MEXC не отдаёт REST-эндпоинт "все сделки по всем парам" (см. комментарий у finresLoadRealizedCore) —
// зато отдаёт приватный WebSocket-канал, который присылает СОБЫТИЕ по КАЖДОЙ сделке аккаунта сразу по
// ВСЕМ парам (без символа в названии канала, в отличие от публичных потоков). Ловим эти события только
// чтобы УЗНАТЬ, что такой символ вообще существует в истории (rememberSymbol — тот же механизм, что и
// у ручного поиска) — саму историю цен/объёмов всё равно тянет обычный REST-путь через
// finresLoadRealizedCore, он и так отдаёт ПОЛНУЮ историю по символу, а не только то, что произошло,
// пока это WS-соединение было открыто.
//
// Честное ограничение (то же самое "не обманываем" правило, что и у остальной статистики): это
// работает только ВПЕРЁД, с момента как этот поток впервые подключился. Сделки, совершённые раньше
// (в том числе до появления этой функции) или пока приложение было полностью закрыто, автоматически
// не найдутся — для них по-прежнему нужен разовый ручной поиск на вкладке "Сделки".
let privateDealsWs = null;
let privateListenKey = null;
let privateListenKeyKeepaliveTimer = null;
let privateDealsReconnectAttempts = 0;
let privateDealsReconnectTimer = null;

async function obtainListenKey() {
  const data = await mexcSignedRequest('/api/v3/userDataStream', {}, null, 'POST');
  if (!data || !data.listenKey) throw new Error('MEXC не вернул listenKey: ' + JSON.stringify(data));
  return data.listenKey;
}

// MEXC: "Doing a PUT on a listenKey will extend its validity for 60 minutes... recommended every 30
// minutes" — держим с запасом.
async function keepAliveListenKey() {
  if (!privateListenKey) return;
  try {
    await mexcSignedRequest('/api/v3/userDataStream', { listenKey: privateListenKey }, null, 'PUT');
  } catch (e) {
    logW('Finrez', 'не удалось продлить listenKey приватного потока сделок: ' + e.message);
  }
}

// Best-effort, не блокирует отключение аккаунта, если MEXC не ответит вовремя — listenKey и так
// сам протухнет через 60 минут без keepalive.
function closeListenKeyBestEffort() {
  if (!privateListenKey) return;
  mexcSignedRequest('/api/v3/userDataStream', { listenKey: privateListenKey }, null, 'DELETE').catch(function () {});
}

function openPrivateDealsWs() {
  if (!privateListenKey) return;
  if (privateDealsWs && (privateDealsWs.readyState === 0 || privateDealsWs.readyState === 1)) return;
  let sock;
  try {
    sock = new WebSocket(MEXC_WS + '?listenKey=' + encodeURIComponent(privateListenKey));
    sock.binaryType = 'arraybuffer';
  } catch (e) {
    scheduleReconnectPrivateDeals();
    return;
  }
  privateDealsWs = sock;
  sock.onopen = function () {
    privateDealsReconnectAttempts = 0;
    try { sock.send(JSON.stringify({ method: 'SUBSCRIPTION', params: ['spot@private.deals.v3.api.pb'] })); } catch (e) {}
    logI('Finrez', 'приватный поток сделок подключён — новые монеты для Финреза теперь обнаруживаются автоматически');
  };
  sock.onmessage = function (ev) {
    if (typeof ev.data === 'string') return; // ack подписки/PONG — не несёт данных о сделке
    const obj = decodeProtoFrame(ev.data);
    if (!obj || !obj.privateDeals || !obj.symbol) return;
    handlePrivateDeal(obj.symbol, obj.privateDeals);
  };
  sock.onclose = function () {
    if (privateDealsWs === sock) privateDealsWs = null;
    if (accountConnected) scheduleReconnectPrivateDeals();
  };
  sock.onerror = function () { try { sock.close(); } catch (e) {} };
}

function scheduleReconnectPrivateDeals() {
  if (!accountConnected) return;
  privateDealsReconnectAttempts++;
  const delay = Math.min(60000, 3000 * Math.pow(1.5, privateDealsReconnectAttempts - 1));
  if (privateDealsReconnectTimer) clearTimeout(privateDealsReconnectTimer);
  privateDealsReconnectTimer = setTimeout(function () {
    // Если соединение долго не удавалось восстановить, старый listenKey мог протухнуть (живёт 60 минут
    // без keepalive/подключения) — на всякий случай запрашиваем новый с нуля, а не ломимся тем же самым.
    if (privateDealsReconnectAttempts > 5) { startPrivateDealsStream(); return; }
    openPrivateDealsWs();
  }, delay);
}

async function startPrivateDealsStream() {
  stopPrivateDealsStream(); // на случай повторного вызова (например, смена ключа без полного disconnect)
  try {
    privateListenKey = await obtainListenKey();
  } catch (e) {
    logW('Finrez', 'не удалось открыть приватный поток сделок — автообнаружение новых монет работать не будет, ' +
      'но ручной поиск на вкладке "Сделки" по-прежнему работает как раньше: ' + e.message);
    return;
  }
  openPrivateDealsWs();
  privateListenKeyKeepaliveTimer = setInterval(keepAliveListenKey, 30 * 60 * 1000);
}

function stopPrivateDealsStream() {
  if (privateListenKeyKeepaliveTimer) { clearInterval(privateListenKeyKeepaliveTimer); privateListenKeyKeepaliveTimer = null; }
  if (privateDealsReconnectTimer) { clearTimeout(privateDealsReconnectTimer); privateDealsReconnectTimer = null; }
  if (privateDealsWs) { try { privateDealsWs.close(); } catch (e) {} privateDealsWs = null; }
  closeListenKeyBestEffort();
  privateListenKey = null;
  privateDealsReconnectAttempts = 0;
}

// Единственная реальная "полезная нагрузка" всего модуля выше — см. общий комментарий у него.
// Сам объект deal (price/quantity/tradeType/...) не используется для чисел, только для лога:
// реальные цифры для PnL всё равно идут через REST myTrades по этому же символу.
function handlePrivateDeal(symbol, deal) {
  if (!isUsdtSpot(symbol)) return; // не наш профиль пар (не USDT-спот) — не пытаемся угадать asset
  const asset = symbol.replace(/USDT$/, '');
  rememberSymbol(asset, symbol);
  logI('Finrez', 'сделка (приватный поток): ' + asset + '/USDT — ' + (deal.tradeType === 1 ? 'BUY' : 'SELL') + ' ' + deal.quantity + ' по ' + deal.price);
}

function setAccountStatus(state, msg) {
  const badge = document.getElementById('acctStatusBadge');
  const text = document.getElementById('acctStatusText');
  const navDot = document.getElementById('navAccountDot');
  if (!badge || !text) return;
  badge.classList.remove('off', 'warn');
  navDot.classList.remove('connected', 'error');
  if (state === 'connected') {
    text.textContent = 'Подключено';
    navDot.classList.add('connected');
    navDot.title = 'API подключён';
  } else if (state === 'connecting') {
    badge.classList.add('warn');
    text.textContent = msg || 'Подключение...';
    navDot.title = 'Подключение...';
  } else if (state === 'error') {
    badge.classList.add('off');
    text.textContent = 'Ошибка: ' + (msg || 'не удалось подключиться');
    navDot.classList.add('error');
    navDot.title = 'Ошибка подключения';
  } else {
    badge.classList.add('off');
    text.textContent = 'Не подключено';
    navDot.title = 'Не подключено';
  }
}

// ------------------------------------------------------------------
// Оценка баланса в USDT + история стоимости портфеля (для графика "P&L").
// У read-only API-ключа нет доступа к истории сделок/доходности биржи — поэтому "P&L" здесь
// честно означает "изменение стоимости портфеля в USDT во времени по нашим собственным снимкам",
// а не биржевой realized/unrealized PnL. Снимки копятся в localStorage прямо на этом устройстве.
// ------------------------------------------------------------------
const BALANCE_HISTORY_KEY = 'mexc_balance_history';
const BALANCE_HISTORY_MAX_POINTS = 1000;
const BALANCE_HISTORY_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 дней
const STABLECOINS = { USDT: 1, USDC: 1, FDUSD: 1, DAI: 1, TUSD: 1, USDP: 1 };

function mexcUsdtPrice(asset) {
  const c = coinMap.get(asset + '/USDT');
  if (c && c.price) return c.price;
  if (STABLECOINS.hasOwnProperty(asset)) return STABLECOINS[asset];
  return null;
}

function loadBalanceHistory() {
  try {
    const raw = localStorage.getItem(BALANCE_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

// assetValues — {asset: usdtValue} для текущего снимка, копится вместе с total, чтобы потом
// можно было посчитать "сколько заработано" не только по портфелю целиком, но и по каждой монете.
function pushBalanceHistory(total, assetValues) {
  if (!(total > 0)) return loadBalanceHistory();
  let hist = loadBalanceHistory();
  const now = Date.now();
  const last = hist[hist.length - 1];
  // Не копим точку на точке: новая точка — не чаще раза в 60с, если стоимость почти не изменилась.
  if (last && (now - last.t) < 60000 && Math.abs(last.v - total) / total < 0.0005) {
    return hist;
  }
  const a = {};
  Object.keys(assetValues || {}).forEach(function (k) { a[k] = Math.round(assetValues[k] * 100) / 100; });
  hist.push({ t: now, v: total, a: a });
  const cutoff = now - BALANCE_HISTORY_MAX_AGE_MS;
  hist = hist.filter(function (p) { return p.t >= cutoff; });
  if (hist.length > BALANCE_HISTORY_MAX_POINTS) hist = hist.slice(hist.length - BALANCE_HISTORY_MAX_POINTS);
  try { persistSet(BALANCE_HISTORY_KEY, JSON.stringify(hist)); } catch (e) {}
  return hist;
}

// Периоды фильтра над графиком/списком "заработано". 'all' — с самой первой сохранённой точки.
const BALANCE_PERIODS = {
  day: { label: '1Д', ms: 24 * 3600 * 1000 },
  week: { label: '1Н', ms: 7 * 24 * 3600 * 1000 },
  month: { label: '1М', ms: 30 * 24 * 3600 * 1000 },
  all: { label: 'Всё', ms: null }
};
let balancePeriod = 'day';

// Находит точку истории, ближайшую (но не позже) к "сейчас минус periodMs" — точка сравнения для
// расчёта изменения за период. Если такой точки нет (история короче периода) — берёт самую раннюю.
function findReferencePoint(hist, periodMs) {
  if (!hist || !hist.length) return null;
  if (periodMs == null) return hist[0];
  const cutoff = Date.now() - periodMs;
  let ref = hist[0];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].t <= cutoff) ref = hist[i]; else break;
  }
  return ref;
}

// Изменение стоимости портфеля целиком за выбранный период.
function computeBalanceDelta(hist, currentTotal, periodKey) {
  if (!hist || hist.length < 2) return null;
  const period = BALANCE_PERIODS[periodKey] || BALANCE_PERIODS.day;
  const ref = findReferencePoint(hist, period.ms);
  if (!ref || !(ref.v > 0)) return null;
  const abs = currentTotal - ref.v;
  const pct = abs / ref.v * 100;
  const fullPeriod = period.ms == null || ref.t <= (Date.now() - period.ms);
  return { abs: abs, pct: pct, period: fullPeriod ? period.label : 'с начала наблюдения' };
}

// "Заработано" по каждой сейчас удерживаемой монете за период: текущая USDT-стоимость минус
// стоимость этой же монеты в точке сравнения (0, если монеты тогда не было — считаем это "новой" покупкой).
function computeAssetEarnings(hist, currentRows, periodKey) {
  if (!hist || !hist.length) return [];
  const period = BALANCE_PERIODS[periodKey] || BALANCE_PERIODS.day;
  const ref = findReferencePoint(hist, period.ms);
  const refAssets = (ref && ref.a) || {};
  return currentRows.map(function (r) {
    const before = refAssets.hasOwnProperty(r.asset) ? refAssets[r.asset] : 0;
    return { asset: r.asset, before: before, now: r.usdtValue, earned: r.usdtValue - before };
  }).filter(function (e) { return Math.abs(e.earned) >= 0.01; })
    .sort(function (a, b) { return Math.abs(b.earned) - Math.abs(a.earned); });
}

// Лёгкий canvas-график изменения стоимости портфеля (без сторонних библиотек): линия + заливка градиентом.
function drawPnlChart(canvas, points) {
  if (!canvas || !points || points.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 400, h = canvas.clientHeight || 90;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Отступ справа под подписи цены + сверху/снизу, чтобы линия не упиралась в край — тот же
  // визуальный язык, что и у канделстик-графика (drawCandleChart) выше.
  const padRight = 44, padTop = 6, padBottom = 6;
  const plotW = Math.max(10, w - padRight), plotH = Math.max(10, h - padTop - padBottom);

  const values = points.map(function (p) { return p.v; });
  let min = Math.min.apply(null, values), max = Math.max.apply(null, values);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.14;
  min -= pad; max += pad;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const tSpan = Math.max(1, t1 - t0);
  const up = values[values.length - 1] >= values[0];
  const lineColor = up ? '#00D084' : '#FF4D5A';

  function xOf(p) { return (( p.t - t0) / tSpan) * plotW; }
  function yOf(p) { return padTop + plotH - ((p.v - min) / (max - min)) * plotH; }

  ctx.font = '9px var(--font-mono, monospace)';
  ctx.textBaseline = 'middle';
  [max - pad, (min + max) / 2, min + pad].forEach(function (v) {
    const y = padTop + plotH - ((v - min) / (max - min)) * plotH;
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillText(fmtUsd(v), plotW + 5, Math.min(h - 4, Math.max(6, y)));
  });

  // Сглаженная линия (квадратичные кривые через середины отрезков) — плавнее ломаной, но каждая
  // фактическая точка данных всё равно точно лежит на кривой.
  function tracePath() {
    ctx.beginPath();
    points.forEach(function (p, i) {
      const x = xOf(p), y = yOf(p);
      if (i === 0) { ctx.moveTo(x, y); return; }
      const prev = points[i - 1];
      const mx = (xOf(prev) + x) / 2, my = (yOf(prev) + y) / 2;
      ctx.quadraticCurveTo(xOf(prev), yOf(prev), mx, my);
      if (i === points.length - 1) ctx.lineTo(x, y);
    });
  }

  tracePath();
  ctx.lineTo(xOf(points[points.length - 1]), padTop + plotH);
  ctx.lineTo(xOf(points[0]), padTop + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
  grad.addColorStop(0, up ? 'rgba(0,208,132,.22)' : 'rgba(255,77,90,.22)');
  grad.addColorStop(1, up ? 'rgba(0,208,132,0)' : 'rgba(255,77,90,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  tracePath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(xOf(last), yOf(last), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(xOf(last), yOf(last), 5, 0, Math.PI * 2);
  ctx.strokeStyle = up ? 'rgba(0,208,132,.35)' : 'rgba(255,77,90,.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  canvas.__pnlPoints = points;
  canvas.__pnlPlotW = plotW;
  canvas.__pnlT0 = t0;
  canvas.__pnlTSpan = tSpan;
}

// Наведение мышью на PnL-график — вертикальный курсор ищет ближайшую по времени точку истории
// и показывает её значение и момент снятия снимка.
function wirePnlChartCrosshair(canvas, tooltipEl) {
  if (!canvas || !tooltipEl) return;
  canvas.addEventListener('mousemove', function (ev) {
    const points = canvas.__pnlPoints;
    if (!points || !points.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, x / (canvas.__pnlPlotW || rect.width)));
    const targetT = canvas.__pnlT0 + frac * canvas.__pnlTSpan;
    let nearest = points[0], bestDiff = Infinity;
    points.forEach(function (p) {
      const diff = Math.abs(p.t - targetT);
      if (diff < bestDiff) { bestDiff = diff; nearest = p; }
    });
    const d = new Date(nearest.t);
    const timeStr = d.toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    tooltipEl.style.display = 'block';
    tooltipEl.style.left = Math.min(Math.max(rect.width - 120, 0), Math.max(4, x + 10)) + 'px';
    tooltipEl.style.top = '4px';
    const base = points[0].v;
    const chPct = base !== 0 ? ((nearest.v - base) / Math.abs(base) * 100) : 0;
    const chCls = chPct >= 0 ? 'up' : 'down';
    tooltipEl.innerHTML = '<div class="chart-tip-time">' + timeStr + '</div><div><b>' + fmtUsd(nearest.v) + '</b></div>' +
      '<div class="chart-tip-change ' + chCls + '">' + (chPct >= 0 ? '+' : '') + chPct.toFixed(2) + '%</div>';
  });
  canvas.addEventListener('mouseleave', function () { tooltipEl.style.display = 'none'; });
}

// Лёгкий canvas donut-график распределения портфеля по активам.
// Статический (без зума/панорамы/инструментов рисования — это read-only иллюстрация истории, а не
// рабочий инструмент анализа) канделстик-график для модалки "Журнал сделок": свечи по выбранной
// монете + треугольные маркеры входа (зелёный, снизу от свечи) и выхода (красный, сверху) в точках
// реальных сделок аккаунта. Цветовая палитра свечей — та же, что и у основного "своего графика"
// (#26A69A/#EF5350, см. round5.md), маркеры — акцентные --green/--red приложения.
// Раунд "маркеры сливаются в кашу + график должен быть живой и масштабируемый как в TradingView":
// собственное окно зума/пана (journalChartState.view), НЕ завязанное на глобальный ownChartView
// главного "своего графика" скринера — своя, изолированная реализация той же техники (см.
// wireJournalChartInteractions/drawCandleChart выше по файлу), чтобы не трогать уже рабочий
// основной график ради модалки журнала.
// Наведение мышью на график журнала — своё, изолированное состояние (не ownChartHover главного
// графика), см. wireJournalChartInteractions.
let journalChartHover = null; // { x, y }

function drawJournalChart(canvas, candles) {
  if (!canvas || !candles || !candles.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 380;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Раунд "сделай как на референсе (tradermake.money)": добавлена панель объёма снизу (как у
  // "своего графика" на главной странице скринера, см. drawCandleChart выше по файлу — тот же
  // приём volTop/volumeH, просто изолированная копия, не общий global state), вертикальная сетка
  // и легенда OHLC+Vol сверху слева (следует за курсором, как в TradingView).
  const padLeft = 8, padRight = 58, padTop = 26, padBottom = 22;
  const plotWTotal = Math.max(10, w - padLeft - padRight), plotHTotal = Math.max(10, h - padTop - padBottom);
  const volumeH = Math.round(plotHTotal * 0.16);
  const paneGap = 6;
  const plotW = plotWTotal;
  const plotH = plotHTotal - volumeH - paneGap;
  const volTop = padTop + plotH + paneGap;

  const n = candles.length;
  const intervalMs = n > 1 ? (candles[1].t - candles[0].t) : 60000;

  // --- окно зума/пана ---
  // По умолчанию (пока пользователь ни разу не покрутил колесо) — НЕ вся история разом (n свечей
  // могло быть 1000, впритык на ~800px ширины панели каждая свеча — доли пикселя, а плотный кластер
  // сделок за пару минут схлопывается в одну точку независимо от того, как рисуются сами маркеры).
  // 120 свечей — тот же порядок, что у "своего графика" на главной странице скринера (там 140) —
  // разумный масштаб для чтения, пользователь может отдалить колесом, если нужен весь диапазон.
  const stateView = (journalChartState && journalChartState.view) || {};
  let visibleCount = Math.round(stateView.visibleCount || Math.min(n, 120));
  visibleCount = Math.max(6, Math.min(n, visibleCount));
  const maxOffset = Math.max(0, n - visibleCount);
  let offset = Math.round(stateView.offset || 0);
  offset = Math.max(0, Math.min(maxOffset, offset));
  if (journalChartState) journalChartState.view = { visibleCount: visibleCount, offset: offset };

  const startIdx = n - visibleCount - offset;
  const endIdx = n - offset;
  const slice = candles.slice(startIdx, endIdx);
  if (!slice.length) return;

  let min = Math.min.apply(null, slice.map(function (c) { return c.l; }));
  let max = Math.max.apply(null, slice.map(function (c) { return c.h; }));
  const pricePad = (max - min) * 0.12 || (max * 0.01) || 1;
  min -= pricePad; max += pricePad;

  let maxVol = Math.max.apply(null, slice.map(function (c) { return c.v; }));
  if (!Number.isFinite(maxVol) || maxVol <= 0) maxVol = 1;

  const slot = plotW / visibleCount;
  const bodyW = Math.max(1.5, Math.min(slot * 0.62, 9));
  const firstT = candles[startIdx].t;

  function xOfTime(t) { return padLeft + ((t - firstT) / intervalMs) * slot + slot / 2; }
  function timeOfX(x) { return firstT + ((x - padLeft - slot / 2) / slot) * intervalMs; }
  function yOf(v) { return padTop + plotH - ((v - min) / (max - min)) * plotH; }
  function priceOfY(y) { return min + ((padTop + plotH - y) / plotH) * (max - min); }
  function volYOf(vv) { return volTop + volumeH - (vv / maxVol) * volumeH; }

  // Метаданные окна — читает wireJournalChartInteractions ниже для колеса мыши/панорамы/hover.
  canvas.__journalChart = {
    xOfTime: xOfTime, timeOfX: timeOfX, priceOfY: priceOfY, plotW: plotW, plotH: plotH,
    padLeft: padLeft, padTop: padTop, slot: slot, intervalMs: intervalMs, volTop: volTop, volumeH: volumeH
  };

  // --- горизонтальная сетка + подписи цены ---
  ctx.font = '9px var(--font-mono, monospace)';
  ctx.textBaseline = 'middle';
  [max - pricePad, (min + max) / 2, min + pricePad].forEach(function (v) {
    const y = yOf(v);
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(padLeft + plotW, y); ctx.stroke();
    const label = fmtPrice(v);
    const labelW = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    ctx.fillRect(padLeft + plotW + 2, y - 7, labelW + 6, 14);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.fillText(label, padLeft + plotW + 5, y);
  });

  // --- вертикальная сетка по временным меткам, на всю высоту (обе панели) ---
  const timeTicks = 4;
  for (let i = 0; i <= timeTicks; i++) {
    const idx = Math.round((i / timeTicks) * (slice.length - 1));
    const c = slice[idx];
    if (!c) continue;
    const x = xOfTime(c.t);
    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, volTop + volumeH); ctx.stroke();
  }

  // --- объём (панель снизу) ---
  slice.forEach(function (c) {
    const x = xOfTime(c.t);
    const up = c.c >= c.o;
    ctx.fillStyle = up ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)';
    const vy = volYOf(c.v);
    ctx.fillRect(x - bodyW / 2, vy, bodyW, (volTop + volumeH) - vy);
  });

  slice.forEach(function (c) {
    const x = xOfTime(c.t);
    const up = c.c >= c.o;
    const color = up ? '#26A69A' : '#EF5350';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yOf(c.h)); ctx.lineTo(x, yOf(c.l)); ctx.stroke();
    const openY = yOf(c.o), closeY = yOf(c.c);
    const top = Math.min(openY, closeY), bh = Math.max(1, Math.abs(closeY - openY));
    const bodyGrad = ctx.createLinearGradient(0, top, 0, top + bh);
    bodyGrad.addColorStop(0, up ? '#2FBFAF' : '#FF6B7A');
    bodyGrad.addColorStop(1, color);
    ctx.fillStyle = bodyGrad;
    ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
  });

  // Раунд "1 в 1 как на tradermake.money": вместо маркера на КАЖДУЮ сделку (что на активном
  // скальпинге неизбежно упирается в кашу — сколько ни разводи и ни зумируй, у трейдера с полусотней
  // сделок в день их физически некуда деть на одном экране) — график показывает ОДНУ выбранную
  // позицию целиком: точку входа (зелёный шеврон ^) и точку выхода (красный крестик ×), с пунктирной
  // линией-уровнем на каждой цене и подписью результата в процентах — ровно тот же язык, что в
  // референсе. Какая позиция выбрана — journalChartState.selectedPairIndex, туда же ведёт клик по
  // строке в списке справа (см. renderJournalTradesList/wireJournalTradesListClick).
  const selPair = journalChartState && journalChartState.pairs && journalChartState.pairs[journalChartState.selectedPairIndex];
  if (selPair) {
    const entryX = xOfTime(selPair.entryTime), entryY = yOf(selPair.entryPrice);
    const exitX = xOfTime(selPair.exitTime), exitY = yOf(selPair.exitPrice);
    const win = selPair.pnl >= 0;

    function dashedLevel(y, color) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(padLeft + plotW, y); ctx.stroke();
      ctx.restore();
    }
    dashedLevel(entryY, '#00C076');
    dashedLevel(exitY, '#F84960');

    // Точка входа — зелёный шеврон ^ (та же простая "чайка", что уже была).
    ctx.save();
    ctx.strokeStyle = '#00C076';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(entryX - 6, entryY + 6); ctx.lineTo(entryX, entryY); ctx.lineTo(entryX + 6, entryY + 6);
    ctx.stroke();
    ctx.restore();

    // Точка выхода — красный крестик × (как в референсе, вместо шеврона вниз).
    ctx.save();
    ctx.strokeStyle = '#F84960';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(exitX - 5, exitY - 5); ctx.lineTo(exitX + 5, exitY + 5);
    ctx.moveTo(exitX + 5, exitY - 5); ctx.lineTo(exitX - 5, exitY + 5);
    ctx.stroke();
    ctx.restore();

    const pctLabel = (selPair.pnlPct >= 0 ? '+' : '') + selPair.pnlPct.toFixed(2) + '%';
    ctx.font = '700 11px var(--font-mono, monospace)';
    ctx.fillStyle = win ? '#00C076' : '#F84960';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(pctLabel, padLeft + plotW - 4, Math.max(padTop + 10, exitY - 6));
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.font = '9px var(--font-mono, monospace)';
  ctx.textBaseline = 'alphabetic';
  const sn = slice.length;
  [0, Math.floor(sn / 2), sn - 1].forEach(function (i) {
    const c = slice[i];
    if (!c) return;
    const d = new Date(c.t);
    const label = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    ctx.textAlign = i === 0 ? 'left' : (i === sn - 1 ? 'right' : 'center');
    ctx.fillText(label, xOfTime(c.t), h - 6);
  });
  ctx.textAlign = 'left';

  // --- crosshair при наведении (своё состояние journalChartHover, не общее с главным графиком) ---
  const hoverActive = journalChartHover && !journalPanDrag &&
    journalChartHover.x >= padLeft && journalChartHover.x <= padLeft + plotW &&
    journalChartHover.y >= padTop && journalChartHover.y <= volTop + volumeH;
  if (hoverActive) {
    const hx = journalChartHover.x, hy = journalChartHover.y;
    const inPricePane = hy >= padTop && hy <= padTop + plotH;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    if (inPricePane) { ctx.beginPath(); ctx.moveTo(padLeft, hy); ctx.lineTo(padLeft + plotW, hy); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(hx, padTop); ctx.lineTo(hx, volTop + volumeH); ctx.stroke();
    ctx.restore();

    if (inPricePane) {
      const hoverPrice = priceOfY(hy);
      const priceLabel = fmtPrice(hoverPrice);
      ctx.font = '10px var(--font-mono, monospace)';
      ctx.fillStyle = '#1E80FF';
      ctx.fillRect(padLeft + plotW + 1, hy - 8, padRight - 2, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(priceLabel, padLeft + plotW + 5, hy);
    }

    const hoverTime = timeOfX(hx);
    const timeStr = ochartTimeLabel(hoverTime, slice[slice.length - 1].t - slice[0].t);
    ctx.font = '10px var(--font-mono, monospace)';
    const tw2 = ctx.measureText(timeStr).width;
    ctx.fillStyle = '#1E80FF';
    ctx.fillRect(Math.max(padLeft, Math.min(padLeft + plotW - tw2 - 10, hx - tw2 / 2 - 5)), h - padBottom, tw2 + 10, padBottom);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(timeStr, Math.max(padLeft + tw2 / 2 + 5, Math.min(padLeft + plotW - tw2 / 2 - 5, hx)), h - padBottom / 2 + 4);
    ctx.textAlign = 'left';
  }

  // --- легенда OHLC+Vol сверху слева: последняя видимая свеча по умолчанию, наведённая — при
  // наведении курсора (как в TradingView/референсе — строка "T: ... O: ... H: ... L: ... C: ... V: ..."). ---
  {
    let legendCandle = slice[slice.length - 1];
    if (hoverActive) {
      let idx = Math.floor((journalChartHover.x - padLeft) / slot);
      idx = Math.max(0, Math.min(slice.length - 1, idx));
      legendCandle = slice[idx];
    }
    if (legendCandle) {
      const k = legendCandle;
      const up = k.c >= k.o;
      const chg = k.o !== 0 ? ((k.c - k.o) / k.o) * 100 : 0;
      const d = new Date(k.t);
      const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const ohlc = dateStr + '   O ' + fmtPrice(k.o) + '  H ' + fmtPrice(k.h) + '  L ' + fmtPrice(k.l) + '  C ' + fmtPrice(k.c) +
        '  ' + (up ? '+' : '') + chg.toFixed(2) + '%' + '   Vol ' + fmtNum(k.v, 2);
      ctx.font = '10.5px var(--font-mono, monospace)';
      ctx.fillStyle = 'rgba(19,23,34,.82)';
      const ow = ctx.measureText(ohlc).width;
      ctx.fillRect(padLeft - 2, 2, ow + 14, 18);
      ctx.fillStyle = up ? '#26A69A' : '#EF5350';
      ctx.textBaseline = 'middle';
      ctx.fillText(ohlc, padLeft + 4, 11);
    }
  }
}

// Колесо мыши (зум к позиции курсора) + зажать-и-тащить (панорама) на графике журнала сделок —
// та же техника, что у wireOwnChartInteractions выше по файлу, но с собственным, изолированным
// состоянием (journalChartState.view / journalPanDrag), чтобы не трогать глобальный ownChartView
// главного графика скринера. Слушатели вешаются один раз на canvas (idempotent).
let journalPanDrag = null;
function wireJournalChartInteractions(canvas) {
  if (!canvas || canvas.__journalWired) return;
  canvas.__journalWired = true;

  function redraw() {
    if (journalChartState) drawJournalChart(canvas, journalChartState.candles);
  }

  canvas.addEventListener('wheel', function (ev) {
    const chart = canvas.__journalChart;
    if (!journalChartState || !chart) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = ev.clientX - rect.left;
    const timeAtCursor = chart.timeOfX(mouseX);
    const factor = ev.deltaY > 0 ? 1.15 : (1 / 1.15);
    const candles = journalChartState.candles;
    const n = candles.length;
    const view = journalChartState.view || { visibleCount: n, offset: 0 };
    let newVisible = Math.round(view.visibleCount * factor);
    newVisible = Math.max(6, Math.min(n, newVisible));
    const newSlot = chart.plotW / newVisible;
    const idxInWindow = (mouseX - chart.padLeft) / newSlot;
    const globalIdxAtCursor = (timeAtCursor - candles[0].t) / chart.intervalMs;
    let newStartIdx = Math.round(globalIdxAtCursor - idxInWindow);
    newStartIdx = Math.max(0, Math.min(n - newVisible, newStartIdx));
    journalChartState.view = { visibleCount: newVisible, offset: n - newVisible - newStartIdx };
    redraw();
  }, { passive: false });

  canvas.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0 || !canvas.__journalChart) return;
    const rect = canvas.getBoundingClientRect();
    journalPanDrag = { startX: ev.clientX - rect.left, startOffset: (journalChartState && journalChartState.view && journalChartState.view.offset) || 0 };
    canvas.classList.add('panning');
  });

  window.addEventListener('mousemove', function (ev) {
    const chart = canvas.__journalChart;
    if (!chart || !journalChartState) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (journalPanDrag) {
      const deltaCandles = (x - journalPanDrag.startX) / chart.slot;
      const n = journalChartState.candles.length;
      const visibleCount = (journalChartState.view && journalChartState.view.visibleCount) || n;
      const maxOffset = Math.max(0, n - visibleCount);
      const newOffset = Math.max(0, Math.min(maxOffset, journalPanDrag.startOffset + deltaCandles));
      journalChartState.view = { visibleCount: visibleCount, offset: newOffset };
      redraw();
      return;
    }
    // Курсор вне холста (событие всё равно приходит через window, не только canvas) — гасим hover.
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
      if (journalChartHover) { journalChartHover = null; redraw(); }
      return;
    }
    journalChartHover = { x: x, y: y };
    redraw();
  });

  canvas.addEventListener('mouseleave', function () {
    if (!journalPanDrag && journalChartHover) { journalChartHover = null; redraw(); }
  });

  window.addEventListener('mouseup', function () {
    if (journalPanDrag) { journalPanDrag = null; canvas.classList.remove('panning'); }
  });
}

function drawDonutChart(canvas, segments) {
  if (!canvas || !segments || !segments.length) return;
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 140;
  canvas.width = size * dpr; canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2, rOuter = size / 2 - 4, rInner = rOuter * 0.6;
  const total = segments.reduce(function (s, seg) { return s + seg.value; }, 0);
  if (!(total > 0)) return;
  let angle = -Math.PI / 2;
  segments.forEach(function (seg) {
    const slice = (seg.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, angle, angle + slice);
    ctx.arc(cx, cy, rInner, angle + slice, angle, true);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    angle += slice;
  });
}

const fmtUsd = function (n) { return '$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

// Хранит данные последнего рендера баланса (текущие priced-строки, итог, история), чтобы при
// переключении периода (1Д/1Н/1М/Всё) можно было пересчитать только период-зависимые части
// (дельту, график, список "заработано") без повторного запроса к бирже и без перестройки доната/списка активов.
let lastBalanceState = null;
// Сырые балансы последнего ответа биржи — нужны, чтобы перерисовать баланс при переключении
// тумблера "мелкие остатки" без нового запроса к API.
let lastRawBalances = null;
// Итог предыдущего рендера — нужен, чтобы понять, изменилась ли сумма портфеля между авто-обновлениями,
// и проиграть count-up анимацию + лёгкий пульс свечения только когда значение реально сдвинулось.
let lastRenderedBalanceTotal = null;
// Данные последнего открытого журнала сделок ({candles, trades}) — нужны, чтобы перерисовать
// график журнала при ресайзе окна, пока модалка открыта.
let journalChartState = null;

// Плавно "прокручивает" текстовое содержимое элемента от одного числа к другому (ease-out), используется
// для count-up анимации hero-значения портфеля при авто-обновлении баланса.
function animateNumberText(el, from, to, duration, formatFn) {
  if (!el) return;
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = formatFn(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = formatFn(to);
  }
  requestAnimationFrame(tick);
}

// Строит HTML сетки из 4 статистических плиток над списком активов: 1Д/1Н/1М — реализованный PnL по
// СДЕЛКАМ за период (не изменение стоимости портфеля, как было раньше, см. её же комментарий у
// computeDailyRealizedPnlMap: та же причина смены подхода — у активного трейдера, который между
// сделками возвращается в USDT, стоимость портфеля почти не меняется, и старые плитки почти всегда
// показывали "+0.00%", даже при реальном плюсе/минусе по сделкам) + количество учитываемых активов.
function buildBalanceStatsGridHtml(trades, assetCount, dustCount) {
  const defs = [{ key: '1d', label: '1Д' }, { key: '7d', label: '1Н' }, { key: '30d', label: '1М' }];
  const tiles = defs.map(function (d) {
    const agg = trades && trades.length ? finresAggregate(finresFilterByPeriod(trades, d.key)) : null;
    const hasTrades = !!(agg && agg.count);
    const cls = !hasTrades ? 'flat' : (agg.pnl > 0.005 ? 'up' : (agg.pnl < -0.005 ? 'down' : 'flat'));
    const icon = cls === 'up' ? 'ri-arrow-up-line' : (cls === 'down' ? 'ri-arrow-down-line' : 'ri-subtract-line');
    const valueHtml = hasTrades
      ? '<span class="stat-tile-pct">' + (agg.pnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(agg.pnl)).slice(1) + '</span>' +
        '<span class="stat-tile-abs">' + agg.count + ' сделок, винрейт ' + agg.winRate.toFixed(0) + '%</span>'
      : '<span class="stat-tile-abs muted">нет сделок</span>';
    return '<div class="stat-tile ' + cls + '"><div class="stat-tile-label"><i class="' + icon + '"></i>' + d.label + '</div>' +
      '<div class="stat-tile-value">' + valueHtml + '</div></div>';
  }).join('');
  const assetsTile = '<div class="stat-tile neutral"><div class="stat-tile-label"><i class="ri-coins-line"></i>Активы</div>' +
    '<div class="stat-tile-value"><span class="stat-tile-pct">' + assetCount + '</span>' +
    '<span class="stat-tile-abs muted">' + (dustCount > 0 ? dustCount + ' мелких скрыто' : 'монет учтено') + '</span></div></div>';
  return tiles + assetsTile;
}

// --- Календарь P&L: результат ПО ЗАКРЫТЫМ СДЕЛКАМ за каждый день (сумма pnl всех realized-сделок
// с этой датой), а не изменение общей стоимости портфеля по снимкам баланса, как было раньше.
// Причина смены подхода: изменение стоимости портфеля требует снимка ЗА ПРЕДЫДУЩИЙ день как опорную
// точку (старая computeDailyPnlMap(hist), см. git-историю) — для активного скальпера/дневного трейдера, у которого
// баланс большую часть времени лежит в USDT между сделками, это часто даёт "+0.00%" за сегодня, даже
// если реальный результат по сделкам за сегодня ощутимо в плюсе (просто ЗА ВЧЕРА снимка ещё не было,
// не с чем сравнить). Реализованный PnL по сделкам не требует никакой "опорной точки" — работает
// с первой же сделки, ровно то же число, что уже показывают "Обзор"/P&L-плитки/"Лучший день" на Рисках.
const RU_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
let balanceCalendarMonth = new Date(); // какой месяц сейчас показан в календаре (число дня не важно)

function balCalDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Map dayKey -> { abs, count } — сумма pnl всех реализованных сделок за этот день + их количество
// (количество показывается в подсказке при наведении, см. renderBalanceCalendarWithTrades).
function computeDailyRealizedPnlMap(trades) {
  const map = new Map();
  if (!trades || !trades.length) return map;
  trades.forEach(function (t) {
    const key = balCalDayKey(new Date(t.time));
    const entry = map.get(key) || { abs: 0, count: 0 };
    entry.abs += t.pnl;
    entry.count++;
    map.set(key, entry);
  });
  return map;
}

// animate=false — используется при "лёгком" фоновом обновлении раз в 3с (см. lightRefreshFinresContent),
// чтобы значения дня обновлялись живьём, но карточки не переигрывали анимацию появления каждый тик.
// animate=true (по умолчанию) — при открытии вкладки P&L и при навигации по месяцам.
//
// Сама сетка строится синхронно из УЖЕ закешированных сделок (если finresRealized уже когда-либо
// грузился в этой сессии — типичный случай при переключении вкладок туда-обратно), чтобы не мигать
// пустым календарём на каждое открытие вкладки, и одновременно фоново запрашивает свежие данные
// (тот же 60с-кэш finresLoadRealized, что и у остальной статистики Финреза).
function renderBalanceCalendar(animate) {
  if (finresRealized && !finresRealized.loading) renderBalanceCalendarWithTrades(finresRealized.trades, animate);
  finresLoadRealized(false).then(function (data) {
    if (finresTab !== 'pnl') return;
    renderBalanceCalendarWithTrades(data.trades, animate);
  });
}

function renderBalanceCalendarWithTrades(trades, animate) {
  animate = animate !== false;
  const grid = document.getElementById('balCalGrid');
  const label = document.getElementById('balCalMonthLabel');
  const summaryEl = document.getElementById('balCalSummary');
  if (!grid || !label || !summaryEl) return;

  const dailyMap = computeDailyRealizedPnlMap(trades);
  const year = balanceCalendarMonth.getFullYear();
  const month = balanceCalendarMonth.getMonth();
  label.textContent = RU_MONTHS[month] + ' ' + year;

  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // getDay(): вс=0..сб=6 → переводим на пн-старт недели
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const now = new Date();
  const todayKey = balCalDayKey(now);

  let maxAbs = 0;
  dailyMap.forEach(function (v) { maxAbs = Math.max(maxAbs, Math.abs(v.abs)); });

  let html = '';
  for (let i = 0; i < firstWeekday; i++) html += '<div class="balcal-cell empty"></div>';
  let monthDelta = 0, monthDaysWithData = 0, cellIndex = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month, d);
    const key = balCalDayKey(dt);
    const entry = dailyMap.get(key);
    const isToday = key === todayKey;
    const isFuture = dt > now && !isToday;
    const weekday = (dt.getDay() + 6) % 7; // 0=пн..6=вс
    const isWeekend = weekday >= 5;
    let cls = 'balcal-cell' + (isToday ? ' today' : '') + (isWeekend ? ' weekend' : '');
    let innerCls = 'balcal-cell-inner';
    let styleAttr = '--cell-i:' + cellIndex;
    let amountHtml = '';
    if (entry) {
      monthDaysWithData++;
      monthDelta += entry.abs;
      innerCls += entry.abs > 0.005 ? ' up' : (entry.abs < -0.005 ? ' down' : ' flat');
      const intensity = maxAbs > 0 ? Math.min(1, Math.abs(entry.abs) / maxAbs) : 0;
      styleAttr += ';--intensity:' + (0.16 + intensity * 0.6).toFixed(2);
      amountHtml = '<span class="balcal-amount">' + (entry.abs >= 0 ? '+' : '-') + fmtUsd(Math.abs(entry.abs)).slice(1) + '</span>';
    } else {
      innerCls += isFuture ? ' future' : ' no-data';
    }
    cellIndex++;
    const titleAttr = entry
      ? (key + ': ' + (entry.abs >= 0 ? '+' : '-') + fmtUsd(Math.abs(entry.abs)).slice(1) + ' (' + entry.count + ' сдел' + (entry.count === 1 ? 'ка' : (entry.count < 5 ? 'ки' : 'ок')) + ')')
      : key;
    html += '<div class="' + cls + '" title="' + titleAttr + '">' +
      '<div class="' + innerCls + '" style="' + styleAttr + '"><span class="balcal-daynum">' + d + '</span>' + amountHtml + '</div></div>';
  }
  grid.classList.toggle('animate', animate);
  grid.innerHTML = html;

  summaryEl.innerHTML = monthDaysWithData
    ? 'За месяц: <span class="' + (monthDelta >= 0 ? 'up' : 'down') + '">' + (monthDelta >= 0 ? '+' : '-') + fmtUsd(Math.abs(monthDelta)).slice(1) + '</span> · дней со сделками: ' + monthDaysWithData
    : 'Пока нет реализованных сделок за этот месяц.';
}

// ============================================================================================
// ФИНРЕЗ — отдельная страница аналитики по счёту (реализованный PnL, журнал сделок, риски, активы).
// Живёт независимо от страницы "Настройки аккаунта": использует те же module-level lastBalanceState/
// lastRawBalances (обновляются в renderAccountBalances), но собственные вкладки и собственный DOM
// под #finresContent. "Обзор" и "Сделки" дополнительно тянут реальную историю исполненных сделок по
// каждой монете из баланса (см. finresLoadRealized) — это отдельный, более тяжёлый запрос к MEXC
// (по одному /api/v3/myTrades на каждую монету), поэтому он НЕ переспрашивается на каждый 3-секундный
// тик автообновления баланса, а только по явному действию юзера (открыл вкладку/нажал "Обновить").
// ============================================================================================
let finresTab = 'overview';
let finresPeriod = '7d'; // 1d | 7d | 30d | 90d | all — период для вкладки "Обзор"
// Кэш реализованного PnL по сделкам: { trades: [{time, asset, pnl}], loadedAt, loading, error }
let finresRealized = null;

const FINRES_PERIODS = {
  '1d': { label: '1Д', ms: 24 * 3600 * 1000 },
  '7d': { label: '7Д', ms: 7 * 24 * 3600 * 1000 },
  '30d': { label: '30Д', ms: 30 * 24 * 3600 * 1000 },
  '90d': { label: '90Д', ms: 90 * 24 * 3600 * 1000 },
  'all': { label: 'Всё', ms: null }
};

function switchFinresTab(tab) {
  finresTab = tab;
  document.querySelectorAll('.finres-tab[data-finres-tab]').forEach(function (b) {
    b.classList.toggle('active', b.dataset.finresTab === tab);
  });
  renderFinresTab();
}
document.querySelectorAll('.finres-tab[data-finres-tab]').forEach(function (b) {
  b.addEventListener('click', function () { switchFinresTab(this.dataset.finresTab); });
});

function renderFinresTab() {
  const el = document.getElementById('finresContent');
  if (!el) return;
  if (!accountConnected) {
    el.innerHTML = '<div class="finres-empty"><i class="ri-key-2-line"></i>Подключите API-ключ на странице «Настройки аккаунта», чтобы увидеть финансовый результат.</div>';
    return;
  }
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-empty"><i class="ri-loader-4-line spin-icon"></i>Загрузка баланса...</div>';
    return;
  }
  if (finresTab === 'overview') renderFinresOverview(el);
  else if (finresTab === 'pnl') renderFinresPnlTab(el);
  else if (finresTab === 'trades') renderFinresTradesTab(el);
  else if (finresTab === 'risk') renderFinresRiskTab(el);
  else if (finresTab === 'assets') renderFinresAssetsTab(el);
}

// Скачивает CSV с реализованными сделками, попавшими в текущий отфильтрованный по периоду список —
// клиентский экспорт без сервера, тот же Blob+ссылка паттерн, что и у downloadDesktopApp().
function exportFinresCsv(trades) {
  const header = 'Дата,Монета,Цена закрытия,Объём,Результат USDT\n';
  const rows = trades.map(function (t) {
    const d = new Date(t.time).toISOString();
    return d + ',' + t.asset + ',' + t.price + ',' + t.qty + ',' + t.pnl.toFixed(2);
  }).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'finres-pnl-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}

// Вкладка "Обзор" — реализованный PnL по сделкам: 5 карточек, график кумулятивного PnL, донат
// прибыльных/убыточных сделок, таблица PnL по фиксированным периодам (День/Неделя/Месяц).
function renderFinresOverview(el, animate) {
  animate = animate !== false;
  const wasLoaded = finresRealized && !finresRealized.loading;
  if (!wasLoaded) {
    el.innerHTML = '<div class="finres-empty"><i class="ri-loader-4-line spin-icon"></i>Загрузка истории сделок по монетам из баланса...</div>';
  }
  finresLoadRealized(false).then(function (data) {
    if (finresTab !== 'overview') return; // юзер уже переключился на другую вкладку
    renderFinresOverviewContent(el, data, animate);
  });
  if (wasLoaded) renderFinresOverviewContent(el, finresRealized, animate);
}

function renderFinresOverviewContent(el, data, animate) {
  animate = animate !== false;
  if (!data.trades.length) {
    el.innerHTML =
      '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
      '<div class="finres-head"><h2>Обзор</h2></div>' +
      '<div class="finres-empty"><i class="ri-inbox-line"></i>' +
      (data.error
        ? 'Не удалось загрузить часть истории сделок: ' + data.error
        : 'Реализованных сделок пока нет. Как только по какой-то монете из баланса появится закрытая (проданная) позиция — здесь появится статистика.') +
      '</div></div>';
    return;
  }

  const filtered = finresFilterByPeriod(data.trades, finresPeriod);
  const agg = finresAggregate(filtered);

  const periodPillsHtml = Object.keys(FINRES_PERIODS).map(function (key) {
    return '<button type="button" class="finres-period-pill' + (key === finresPeriod ? ' active' : '') + '" data-finres-period="' + key + '">' + FINRES_PERIODS[key].label + '</button>';
  }).join('');

  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + label + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }
  const pnlCls = agg.pnl >= 0 ? 'up' : 'down';
  const statsHtml =
    statCard('Общий PnL', (agg.pnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(agg.pnl)).slice(1), pnlCls,
      agg.pct !== 0 ? (agg.pct >= 0 ? '+' : '') + agg.pct.toFixed(2) + '%' : null) +
    statCard('Прибыль', '+' + fmtUsd(agg.profit).slice(1), 'up', agg.winCount + ' сделок') +
    statCard('Убытки', (agg.loss <= 0 ? '-' : '') + fmtUsd(Math.abs(agg.loss)).slice(1), 'down', agg.lossCount + ' сделок') +
    statCard('Сделки', String(agg.count), null, 'за ' + FINRES_PERIODS[finresPeriod].label.toLowerCase()) +
    statCard('Винрейт', agg.winRate.toFixed(2) + '%', agg.winRate >= 50 ? 'up' : 'down', agg.winCount + '/' + agg.count);

  // Кумулятивный PnL — переиспользуем drawPnlChart (та же линия+градиент, что у графика стоимости
  // портфеля в "Настройки аккаунта"), просто с накопительной суммой реализованных сделок вместо
  // снимков общей стоимости.
  let cum = 0;
  const cumPoints = filtered.map(function (t) { cum += t.pnl; return { t: t.time, v: cum }; });

  const donutSegments = [
    { asset: 'Прибыльные', value: agg.winCount, color: '#00D084' },
    { asset: 'Убыточные', value: agg.lossCount, color: '#FF4D5A' }
  ];

  el.innerHTML =
    '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
    '<div class="finres-head"><h2>Обзор</h2>' +
      '<div class="finres-head-right">' +
        '<div class="finres-period-pills">' + periodPillsHtml + '</div>' +
        '<button type="button" class="finres-export-btn" id="finresExportBtn"><i class="ri-download-2-line"></i> Экспорт</button>' +
      '</div>' +
    '</div>' +
    finresStaleErrorBannerHtml(data) +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '">' + statsHtml + '</div>' +
    '<div class="finres-chart-row">' +
      '<div class="finres-card">' +
        '<div class="finres-card-head"><span class="finres-card-title">Динамика PnL</span>' +
        '<select class="finres-card-select" disabled><option>Кумулятивный</option></select></div>' +
        '<div class="finres-pnl-chart-wrap" id="finresPnlChartWrap"></div>' +
      '</div>' +
      '<div class="finres-card">' +
        '<div class="finres-card-head"><span class="finres-card-title">Распределение сделок</span></div>' +
        '<div class="finres-donut-wrap"><canvas id="finresDonut"></canvas>' +
          '<div class="finres-donut-center"><div class="finres-donut-center-value">' + agg.count + '</div><div class="finres-donut-center-label">Сделок</div></div>' +
        '</div>' +
        '<div class="finres-donut-legend">' +
          '<div class="finres-donut-legend-row"><span class="finres-donut-legend-dot" style="background:#00D084"></span>' +
            '<span class="finres-donut-legend-label">Прибыльные</span><span class="finres-donut-legend-value">' + agg.winCount + '</span>' +
            '<span class="finres-donut-legend-pct">(' + (agg.count ? (agg.winCount / agg.count * 100).toFixed(2) : '0.00') + '%)</span></div>' +
          '<div class="finres-donut-legend-row"><span class="finres-donut-legend-dot" style="background:#FF4D5A"></span>' +
            '<span class="finres-donut-legend-label">Убыточные</span><span class="finres-donut-legend-value">' + agg.lossCount + '</span>' +
            '<span class="finres-donut-legend-pct">(' + (agg.count ? (agg.lossCount / agg.count * 100).toFixed(2) : '0.00') + '%)</span></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    buildFinresPeriodTableHtml(data.trades) +
    '</div>';

  const pnlWrap = document.getElementById('finresPnlChartWrap');
  if (cumPoints.length >= 2) {
    pnlWrap.innerHTML = '<canvas id="finresPnlChart"></canvas><div class="chart-tip" id="finresPnlTip"></div>';
    drawPnlChart(document.getElementById('finresPnlChart'), cumPoints);
    wirePnlChartCrosshair(document.getElementById('finresPnlChart'), document.getElementById('finresPnlTip'));
  } else {
    pnlWrap.innerHTML = '<div class="balance-chart-empty">Недостаточно закрытых сделок за этот период для графика</div>';
  }
  const donutCanvas = document.getElementById('finresDonut');
  if (donutCanvas) drawDonutChart(donutCanvas, donutSegments);

  document.querySelectorAll('.finres-period-pill[data-finres-period]').forEach(function (pill) {
    pill.addEventListener('click', function () {
      finresPeriod = this.dataset.finresPeriod;
      renderFinresOverviewContent(el, data);
    });
  });
  const exportBtn = document.getElementById('finresExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', function () { exportFinresCsv(filtered); });
}

// Таблица "PnL по периодам" — три ФИКСИРОВАННЫХ строки (День/Неделя/Месяц), не зависят от пилюль
// периода наверху (те управляют только карточками/графиком/донатом).
function buildFinresPeriodTableHtml(allTrades) {
  const rows = [
    { key: '1d', label: 'День' },
    { key: '7d', label: 'Неделя' },
    { key: '30d', label: 'Месяц' }
  ];
  const rowsHtml = rows.map(function (r) {
    const agg = finresAggregate(finresFilterByPeriod(allTrades, r.key));
    const pnlCls = agg.pnl >= 0 ? 'up' : 'down';
    return '<tr>' +
      '<td class="finres-period-name">' + r.label + '</td>' +
      '<td class="' + pnlCls + '">' + (agg.pnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(agg.pnl)).slice(1) + '</td>' +
      '<td class="' + pnlCls + '">' + (agg.pct >= 0 ? '+' : '') + agg.pct.toFixed(2) + '%</td>' +
      '<td class="up">+' + fmtUsd(agg.profit).slice(1) + '</td>' +
      '<td class="down">' + (agg.loss <= 0 ? '-' : '') + fmtUsd(Math.abs(agg.loss)).slice(1) + '</td>' +
      '<td>' + agg.count + '</td>' +
      '<td>' + agg.winRate.toFixed(2) + '%</td>' +
      '</tr>';
  }).join('');
  return '<div class="finres-table-card"><div class="finres-table-title">PnL по периодам</div>' +
    '<table class="finres-table"><thead><tr><th>Период</th><th>PnL</th><th>Изменение %</th><th>Прибыль</th><th>Убытки</th><th>Сделки</th><th>Винрейт</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table></div>';
}

// Ключи FINRES_PERIODS (используются finresFilterByPeriod) для каждого значения пилюль периода
// вкладки "P&L" (finresPnlPeriod, свои BALANCE_PERIODS-ключи day/week/month/all).
const FINRES_PNL_PERIOD_MAP = { day: '1d', week: '7d', month: '30d', all: 'all' };

// Показывается, когда на экране уже есть РАНЕЕ успешно загруженные данные (data.trades.length > 0),
// но САМАЯ ПОСЛЕДНЯЯ попытка обновить их не удалась (data.error всё ещё установлен) — то есть
// пользователь смотрит на честные, но потенциально устаревшие цифры, а не на "как будто бы всё ок".
// Отдельно от пустого состояния (там ошибка уже показывается как основной текст) — здесь мы должны
// показать И старые данные, И тот факт, что их не удалось освежить, не заслоняя одно другим.
function finresStaleErrorBannerHtml(data) {
  if (!data || !data.error || !data.trades || !data.trades.length) return '';
  return '<div class="finres-stale-banner"><i class="ri-error-warning-line"></i>' +
    'Не удалось обновить часть истории сделок (' + data.error + ') — показаны последние загруженные данные' +
    (data.loadedAt ? ' от ' + new Date(data.loadedAt).toTimeString().slice(0, 8) : '') + '.</div>';
}

function finresStatPlaceholder(n) {
  let html = '';
  for (let i = 0; i < n; i++) html += '<div class="finres-stat-card"><div class="finres-stat-label">···</div><div class="finres-stat-value">···</div></div>';
  return html;
}

// Собственно HTML 6 карточек — вынесено отдельно от renderFinresPnlStats ниже, чтобы её можно было
// вызвать И синхронно (renderFinresPnlTab, если finresRealized уже есть в кэше — без "···"-заглушки
// на каждое открытие вкладки, см. её же комментарий), И из настоящего async-обновления.
function buildFinresPnlStatsHtml(data) {
  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + label + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }
  if (!data || !data.trades.length) {
    return '<div class="finres-empty" style="grid-column:1/-1;padding:20px"><i class="ri-bar-chart-line"></i>' +
      (data && data.error ? 'Не удалось загрузить часть истории сделок: ' + data.error : 'Реализованных сделок пока нет — статистика появится после первой закрытой позиции.') +
      '</div>';
  }
  const filtered = finresFilterByPeriod(data.trades, FINRES_PNL_PERIOD_MAP[finresPnlPeriod] || 'all');
  const agg = finresAggregate(filtered);
  const stats = computeFinresTradeStats(filtered);
  const pnlCls = agg.pnl >= 0 ? 'up' : 'down';
  const avgPnl = agg.count ? agg.pnl / agg.count : 0;
  const pf = !stats ? '—' : (stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2));
  return statCard('Общий PnL', (agg.pnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(agg.pnl)).slice(1), pnlCls, agg.count + ' сделок') +
    statCard('Средний PnL', (avgPnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(avgPnl)).slice(1), avgPnl >= 0 ? 'up' : 'down', 'на сделку') +
    statCard('Лучший день', stats ? (stats.bestDay >= 0 ? '+' : '-') + fmtUsd(Math.abs(stats.bestDay)).slice(1) : '—', stats && stats.bestDay >= 0 ? 'up' : null, null) +
    statCard('Худший день', stats ? (stats.worstDay >= 0 ? '+' : '-') + fmtUsd(Math.abs(stats.worstDay)).slice(1) : '—', stats && stats.worstDay < 0 ? 'down' : null, null) +
    statCard('Profit Factor', pf, stats && stats.profitFactor >= 1.5 ? 'up' : (stats && stats.profitFactor < 1 ? 'down' : null), null) +
    statCard('Винрейт', agg.winRate.toFixed(2) + '%', agg.winRate >= 50 ? 'up' : 'down', agg.winCount + '/' + agg.count);
}

// Компактная строка из 6 показателей по РЕАЛИЗОВАННЫМ сделкам (Общий/Средний PnL, Лучший/Худший
// день, Profit Factor, Винрейт) над календарём вкладки "P&L" — использует тот же кэш
// finresLoadRealized(), что и "Обзор", без дублирующих запросов к MEXC.
function renderFinresPnlStats(animate) {
  animate = animate !== false;
  finresLoadRealized(false).then(function (data) {
    if (finresTab !== 'pnl') return;
    const grid = document.getElementById('finresPnlStatsGrid');
    if (!grid) return;
    grid.classList.toggle('no-anim', !animate);
    grid.innerHTML = buildFinresPnlStatsHtml(data);
  });
}

// ------------------------------------------------------------------------------------------
// Финрез — вкладка "P&L": календарь изменения стоимости портфеля по дням + список "заработано/
// потеряно по монетам". Раньше жили на странице "Настройки аккаунта", перенесены сюда целиком
// (страница "Настройки аккаунта" баланс больше вообще не показывает — см. .acct-finres-note).
// Использует общую историю снимков баланса (lastBalanceState.hist), без доп. запросов к MEXC.
// ------------------------------------------------------------------------------------------
let finresPnlPeriod = 'day'; // day | week | month | all — свой период, независимый от balancePeriod хиро-карточки

function renderFinresPnlTab(el) {
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.</div></div>';
    return;
  }
  const periodPillsHtml = Object.keys(BALANCE_PERIODS).map(function (key) {
    return '<span class="balance-period-pill' + (key === finresPnlPeriod ? ' active' : '') + '" data-period="' + key + '">' + BALANCE_PERIODS[key].label + '</span>';
  }).join('');

  // Если сделки уже загружены в этой сессии (переключились на другую вкладку и обратно) — рисуем
  // их сразу, без "···"-заглушки: та секунду-другую и так почти всегда пустая трата времени (кэш
  // finresLoadRealized свежий), но ощущалась как "P&L снова грузится с нуля" при каждом заходе.
  const cachedStatsHtml = (finresRealized && !finresRealized.loading) ? buildFinresPnlStatsHtml(finresRealized) : finresStatPlaceholder(6);
  el.innerHTML =
    '<div class="finres-tab-body finres-anim-in">' +
    '<div class="finres-head"><h2>P&amp;L</h2></div>' +
    '<div class="finres-stats-grid" id="finresPnlStatsGrid">' + cachedStatsHtml + '</div>' +
    '<div class="balance-calendar-card">' +
      '<div class="balance-calendar-header">' +
        '<div class="balance-calendar-title"><i class="ri-calendar-2-line"></i> Календарь P&amp;L</div>' +
        '<div class="balance-calendar-nav">' +
          '<button type="button" class="balance-calendar-navbtn" id="balCalPrev"><i class="ri-arrow-left-s-line"></i></button>' +
          '<span class="balance-calendar-month" id="balCalMonthLabel">—</span>' +
          '<button type="button" class="balance-calendar-navbtn" id="balCalNext"><i class="ri-arrow-right-s-line"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="balance-calendar-weekdays"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div>' +
      '<div class="balance-calendar-grid" id="balCalGrid"></div>' +
      '<div class="balance-calendar-summary" id="balCalSummary"></div>' +
      '<div class="balance-calendar-legend">' +
        '<span class="balance-calendar-legend-item"><span class="balance-calendar-legend-dot up"></span>Прибыльный день</span>' +
        '<span class="balance-calendar-legend-item"><span class="balance-calendar-legend-dot down"></span>Убыточный день</span>' +
        '<span class="balance-calendar-legend-item"><span class="balance-calendar-legend-dot empty-dot"></span>Нет данных</span>' +
      '</div>' +
    '</div>' +
    '<div class="balance-period-pills" id="finresPnlPeriodPills">' + periodPillsHtml + '</div>' +
    '<div class="balance-earnings" id="finresEarnList"></div>' +
    '</div>';

  const balCalPrevEl = document.getElementById('balCalPrev');
  const balCalNextEl = document.getElementById('balCalNext');
  if (balCalPrevEl) balCalPrevEl.addEventListener('click', function () {
    balanceCalendarMonth = new Date(balanceCalendarMonth.getFullYear(), balanceCalendarMonth.getMonth() - 1, 1);
    renderBalanceCalendar(true);
  });
  if (balCalNextEl) balCalNextEl.addEventListener('click', function () {
    balanceCalendarMonth = new Date(balanceCalendarMonth.getFullYear(), balanceCalendarMonth.getMonth() + 1, 1);
    renderBalanceCalendar(true);
  });
  renderBalanceCalendar(true);
  renderFinresPnlStats();

  const pillsEl = document.getElementById('finresPnlPeriodPills');
  if (pillsEl) {
    pillsEl.querySelectorAll('.balance-period-pill[data-period]').forEach(function (pill) {
      pill.addEventListener('click', function () {
        finresPnlPeriod = this.dataset.period;
        pillsEl.querySelectorAll('.balance-period-pill[data-period]').forEach(function (p) {
          p.classList.toggle('active', p.dataset.period === finresPnlPeriod);
        });
        renderFinresPnlEarnings();
        renderFinresPnlStats();
      });
    });
  }
  renderFinresPnlEarnings();
}

function renderFinresPnlEarnings() {
  const earnEl = document.getElementById('finresEarnList');
  if (!earnEl || !lastBalanceState) return;
  const period = BALANCE_PERIODS[finresPnlPeriod] || BALANCE_PERIODS.day;
  const earnings = computeAssetEarnings(lastBalanceState.hist, lastBalanceState.priced, finresPnlPeriod);
  earnEl.innerHTML = buildBalanceEarnCardsHtml(earnings, period, lastBalanceState.hist.length);
}

// ------------------------------------------------------------------------------------------
// Финрез — вкладка "Сделки": журнал сделок (список монет-чипов из текущего баланса → клик
// открывает модалку #journalModal с графиком точек входа/выхода). Раньше жил на странице
// "Настройки аккаунта" (см. renderAccountBalances — там больше не рендерится), клик по чипам
// делегирован один раз на #finresContent (см. addEventListener ниже по файлу).
// ------------------------------------------------------------------------------------------
let finresTradesSearch = '';
let finresTradesSort = { key: 'time', dir: 'desc' };
let finresTradesLimit = 25; // "показать ещё" — сколько строк из отфильтрованного/отсортированного списка сейчас рендерим

// Раунд 12: символ REST-пары MEXC для спотовой USDT-пары — ВСЕГДА ровно "АКТИВUSDT" без разделителя
// (см. isUsdtSpot/upsertCoin — raw = row.symbol, base = raw без хвоста USDT). Раньше список монет в
// "Сделках" и клик по монете жёстко зависели от того, успел ли coinMap уже получить тикер по этой
// паре из живого WS-потока — если конкретная (обычно менее ликвидная) монета из баланса ещё не
// "засветилась" в потоке к моменту открытия вкладки, она просто пропадала из чипов/поиска/таблицы,
// хотя человек ей реально торговал. Символ не нужно "знать" из WS — он детерминированно строится из
// тикера актива, поэтому берём его из coinMap только для цвета/цены, а raw всегда есть.
function assetToRawSymbol(asset) {
  return String(asset || '').toUpperCase() + 'USDT';
}

// Монеты из текущего баланса — для /api/v3/myTrades и открытия графика точек входа/выхода —
// переиспользуется и чипами быстрого доступа, и таблицей ниже. Больше не пропускает монету, если
// WS ещё не успел прислать по ней тикер (см. assetToRawSymbol выше).
function buildJournalChipsHtml() {
  return lastBalanceState.priced.map(function (r) {
    const c = coinMap.get(r.asset + '/USDT');
    const raw = (c && c.raw) || assetToRawSymbol(r.asset);
    const color = getCoinColor(r.asset);
    return '<button type="button" class="journal-chip" data-asset="' + r.asset + '" data-raw="' + raw + '">' +
      '<span class="journal-chip-avatar" style="background:' + color + '">' + r.asset.slice(0, 3) + '</span>' + r.asset + '</button>';
  }).join('');
}

function renderFinresTradesTab(el, animate) {
  animate = animate !== false;
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.</div></div>';
    return;
  }
  const journalChipsHtml = buildJournalChipsHtml();
  el.innerHTML =
    '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
    '<div class="finres-head"><h2>Сделки</h2></div>' +
    '<div class="balance-journal-card">' +
      '<div class="balance-journal-header">' +
        '<div class="balance-journal-title"><i class="ri-file-list-3-line"></i> График входа/выхода по монете</div>' +
        '<span class="balance-journal-hint">Выберите монету — покажем сделки и точки входа/выхода на графике</span>' +
      '</div>' +
      '<div class="finres-coin-search">' +
        '<div class="finres-coin-search-box"><i class="ri-search-line"></i>' +
          '<input type="text" id="finresCoinSearchInput" autocomplete="off" placeholder="Найти любую монету (в т.ч. полностью закрытые позиции)...">' +
        '</div>' +
        '<div class="finres-coin-search-results" id="finresCoinSearchResults"></div>' +
      '</div>' +
      '<div class="balance-journal-subtitle">Из текущего баланса</div>' +
      '<div class="balance-journal-chips">' + (journalChipsHtml || '<span class="balance-journal-empty">Сейчас в балансе нет монет с известной USDT-парой — найдите нужную через поиск выше.</span>') + '</div>' +
    '</div>' +
    '<div class="finres-table-card" id="finresTradesTableCard"><div class="finres-empty"><i class="ri-loader-4-line spin-icon"></i>Загрузка истории сделок...</div></div>' +
    '</div>';

  wireFinresCoinSearch();

  finresTradesLimit = 25;
  const wasLoaded = finresRealized && !finresRealized.loading;
  finresLoadRealized(false).then(function (data) {
    if (finresTab !== 'trades') return;
    renderFinresTradesTable(data);
  });
  if (wasLoaded) renderFinresTradesTable(finresRealized);
}

// Строит выпадающий список совпадений по тикеру среди ВСЕХ пар USDT, которые скринер сейчас знает
// (coinMap — полный рынок MEXC, а не только текущий баланс), чтобы можно было найти и полностью
// закрытую (проданную в ноль) монету, а не только то, что сейчас в кошельке.
function buildCoinSearchResultsHtml(query) {
  const q = query.trim().toUpperCase();
  if (!q) return '';
  const seen = {};
  const matches = [];
  coinMap.forEach(function (c, key) {
    if (!c || !c.raw || key.slice(-5) !== '/USDT') return;
    const asset = c.baseAsset || key.split('/')[0];
    if (seen[asset] || asset.toUpperCase().indexOf(q) === -1) return;
    seen[asset] = true;
    matches.push({ asset: asset, raw: c.raw });
  });
  matches.sort(function (a, b) {
    // Совпадения, начинающиеся с запроса — выше тех, где запрос встретился в середине.
    const aStarts = a.asset.toUpperCase().indexOf(q) === 0 ? 0 : 1;
    const bStarts = b.asset.toUpperCase().indexOf(q) === 0 ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.asset.localeCompare(b.asset);
  });
  const top = matches.slice(0, 8);
  if (!top.length) return '<div class="finres-coin-search-empty">Ничего не найдено — монета ещё не встречалась в потоке котировок MEXC.</div>';
  return top.map(function (m) {
    const color = getCoinColor(m.asset);
    const known = knownSymbols[m.asset] ? '<span class="finres-coin-search-known"><i class="ri-check-line"></i>в журнале</span>' : '';
    return '<div class="finres-coin-search-item" data-asset="' + m.asset + '" data-raw="' + m.raw + '">' +
      '<span class="balance-asset-avatar" style="background:' + color + '">' + m.asset.slice(0, 3) + '</span>' +
      '<span>' + m.asset + '/USDT</span>' + known + '</div>';
  }).join('');
}

// Подключает живой поиск по всем парам MEXC (не только текущему балансу): выбор монеты запоминает
// её символ навсегда (rememberSymbol — попадёт во всю статистику Финреза, не только в этот график)
// и сразу открывает журнал точек входа/выхода.
let coinSearchDocListenerWired = false;
function wireFinresCoinSearch() {
  const input = document.getElementById('finresCoinSearchInput');
  const results = document.getElementById('finresCoinSearchResults');
  if (!input || !results) return;
  input.addEventListener('input', function () {
    results.innerHTML = buildCoinSearchResultsHtml(this.value);
    results.classList.toggle('open', !!this.value.trim());
  });
  input.addEventListener('focus', function () {
    if (this.value.trim()) results.classList.add('open');
  });
  // Документный клик-снаружи-закрывает-дропдаун вешаем ОДИН раз за всё время жизни страницы (иначе
  // при каждом заходе на вкладку "Сделки" копился бы новый listener на document) — ищем актуальные
  // input/results заново по id при каждом клике, а не через замыкание на конкретные DOM-узлы.
  if (!coinSearchDocListenerWired) {
    coinSearchDocListenerWired = true;
    document.addEventListener('click', function (e) {
      const curInput = document.getElementById('finresCoinSearchInput');
      const curResults = document.getElementById('finresCoinSearchResults');
      if (!curInput || !curResults) return;
      if (e.target !== curInput && !curResults.contains(e.target)) curResults.classList.remove('open');
    });
  }
  results.addEventListener('click', function (e) {
    const item = e.target.closest('.finres-coin-search-item');
    if (!item) return;
    const asset = item.dataset.asset, raw = item.dataset.raw;
    rememberSymbol(asset, raw);
    input.value = '';
    results.innerHTML = '';
    results.classList.remove('open');
    openJournalForAsset(asset, raw);
    // Новый символ мог добавиться впервые — форсируем перезагрузку кэша реализованных сделок, чтобы
    // он тут же попал в таблицу/статистику, а не ждал следующего естественного обновления.
    finresLoadRealized(true).then(function (data) {
      if (finresTab === 'trades') renderFinresTradesTable(data);
    });
  });
}

const FINRES_TRADES_SORT_KEYS = {
  time: function (t) { return t.time; },
  asset: function (t) { return t.asset; },
  pnl: function (t) { return t.pnl; },
  pnlPct: function (t) { return t.cost > 0 ? t.pnl / t.cost : 0; }
};

// Профессиональная таблица реализованных сделок: поиск по монете, сортировка по клику на заголовок,
// подгрузка "показать ещё". Источник — тот же finresRealized, что и у "Обзор"/"P&L" (без лишних
// запросов к MEXC), клик по строке открывает тот же журнал-график, что и чипы монет выше.
function renderFinresTradesTable(data) {
  const card = document.getElementById('finresTradesTableCard');
  if (!card) return;
  if (!data.trades.length) {
    card.innerHTML = '<div class="finres-empty"><i class="ri-inbox-line"></i>' +
      (data.error
        ? 'Не удалось загрузить часть истории сделок: ' + data.error
        : 'Реализованных сделок пока нет ни по одной известной монете. Если нужная монета уже полностью продана — найдите её через поиск выше, чтобы добавить в журнал.') +
      '</div>';
    return;
  }
  const q = finresTradesSearch.trim().toUpperCase();
  const rows = q ? data.trades.filter(function (t) { return t.asset.toUpperCase().indexOf(q) !== -1; }) : data.trades.slice();
  const sortFn = FINRES_TRADES_SORT_KEYS[finresTradesSort.key] || FINRES_TRADES_SORT_KEYS.time;
  const dir = finresTradesSort.dir === 'asc' ? 1 : -1;
  rows.sort(function (a, b) { const av = sortFn(a), bv = sortFn(b); return av < bv ? -1 * dir : (av > bv ? 1 * dir : 0); });

  const shown = rows.slice(0, finresTradesLimit);
  function sortIc(key) {
    if (finresTradesSort.key !== key) return '';
    return '<i class="sort-ic ri-arrow-' + (finresTradesSort.dir === 'asc' ? 'up' : 'down') + '-s-line"></i>';
  }
  function pluralSdelka(n) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return 'сделка';
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 'сделки';
    return 'сделок';
  }

  const rowsHtml = shown.map(function (t) {
    const d = new Date(t.time);
    const dateStr = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getFullYear()).slice(2);
    const timeStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const entryPrice = t.qty > 0 ? t.cost / t.qty : 0;
    const pnlPct = t.cost > 0 ? (t.pnl / t.cost * 100) : 0;
    const win = t.pnl >= 0;
    const cls = win ? 'up' : 'down';
    const color = getCoinColor(t.asset);
    const c = coinMap.get(t.asset + '/USDT');
    const rowRaw = (c && c.raw) || assetToRawSymbol(t.asset);
    return '<tr data-asset="' + t.asset + '" data-raw="' + rowRaw + '">' +
      '<td>' + dateStr + '</td>' +
      '<td class="finres-mono-sub">' + timeStr + '</td>' +
      '<td><span class="balance-asset-avatar" style="background:' + color + ';width:20px;height:20px;font-size:9px;margin-right:6px;vertical-align:middle">' + t.asset.slice(0, 3) + '</span>' + t.asset + '/USDT</td>' +
      '<td>' + fmtPrice(entryPrice) + '</td>' +
      '<td>' + fmtPrice(t.price) + '</td>' +
      '<td>' + fmtNum(t.qty, 4) + '</td>' +
      '<td><span class="finres-pnl-chip ' + cls + '">' + (win ? '+' : '-') + fmtUsd(Math.abs(t.pnl)) + '</span></td>' +
      '<td class="' + cls + '">' + (win ? '+' : '') + pnlPct.toFixed(2) + '%</td>' +
      '<td><span class="finres-result-badge ' + (win ? 'win' : 'loss') + '">' + (win ? 'WIN' : 'LOSS') + '</span></td>' +
      '</tr>';
  }).join('');

  card.innerHTML =
    finresStaleErrorBannerHtml(data) +
    '<div class="finres-toolbar">' +
      '<div class="finres-search"><i class="ri-search-line"></i><input type="text" id="finresTradesSearchInput" placeholder="Поиск по монете..." value="' + finresTradesSearch.replace(/"/g, '&quot;') + '"></div>' +
      '<span class="finres-trades-count">' + rows.length + ' ' + pluralSdelka(rows.length) + '</span>' +
    '</div>' +
    '<div style="overflow-x:auto">' +
    '<table class="finres-table"><thead><tr>' +
      '<th class="sortable" data-sort="time">Дата' + sortIc('time') + '</th>' +
      '<th>Время</th>' +
      '<th class="sortable" data-sort="asset">Монета' + sortIc('asset') + '</th>' +
      '<th>Цена входа</th>' +
      '<th>Цена выхода</th>' +
      '<th>Объём</th>' +
      '<th class="sortable" data-sort="pnl">PnL' + sortIc('pnl') + '</th>' +
      '<th class="sortable" data-sort="pnlPct">PnL %' + sortIc('pnlPct') + '</th>' +
      '<th>Результат</th>' +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
    '</div>' +
    (rows.length > shown.length ? '<button type="button" class="finres-load-more" id="finresTradesLoadMore">Показать ещё (' + (rows.length - shown.length) + ')</button>' : '');

  const searchInput = document.getElementById('finresTradesSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      finresTradesSearch = this.value;
      finresTradesLimit = 25;
      renderFinresTradesTable(data);
      const el2 = document.getElementById('finresTradesSearchInput');
      if (el2) { el2.focus(); const p = finresTradesSearch.length; el2.setSelectionRange(p, p); }
    });
  }
  card.querySelectorAll('.finres-table th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      const key = this.dataset.sort;
      if (finresTradesSort.key === key) finresTradesSort = { key: key, dir: finresTradesSort.dir === 'asc' ? 'desc' : 'asc' };
      else finresTradesSort = { key: key, dir: key === 'asset' ? 'asc' : 'desc' };
      renderFinresTradesTable(data);
    });
  });
  const loadMoreBtn = document.getElementById('finresTradesLoadMore');
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', function () { finresTradesLimit += 25; renderFinresTradesTable(data); });
  card.querySelectorAll('.finres-table tbody tr[data-raw]').forEach(function (tr) {
    tr.addEventListener('click', function () {
      const raw = this.dataset.raw;
      if (raw) openJournalForAsset(this.dataset.asset, raw);
    });
  });
}

// ------------------------------------------------------------------------------------------
// Финрез — вкладка "Активы": донат распределения портфеля + список активов. Данные берутся из
// уже посчитанного lastBalanceState (тот же снимок, что питает донат/список на странице
// "Настройки аккаунта") — без дополнительных запросов к MEXC.
// ------------------------------------------------------------------------------------------
function renderFinresAssetsTab(el, animate) {
  animate = animate !== false;
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.</div></div>';
    return;
  }
  const priced = lastBalanceState.priced, total = lastBalanceState.total, donutSegments = lastBalanceState.donutSegments || [];
  const unpriced = lastBalanceState.unpriced || [], dust = lastBalanceState.dust || [], dustTotal = lastBalanceState.dustTotal || 0;

  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card"><div class="finres-stat-label">' + label + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }
  const availableValue = priced.reduce(function (s, r) { return s + (r.free * (r.price || 0)); }, 0);
  const lockedValue = priced.reduce(function (s, r) { return s + (r.locked * (r.price || 0)); }, 0);
  const dayDelta = computeBalanceDelta(lastBalanceState.hist, total, 'day');
  const deltaCls = !dayDelta ? null : (dayDelta.abs > 0.005 ? 'up' : (dayDelta.abs < -0.005 ? 'down' : null));
  const summaryHtml =
    statCard('Общий баланс', fmtUsd(total), null, priced.length + ' актив' + (priced.length === 1 ? '' : (priced.length >= 2 && priced.length <= 4 ? 'а' : 'ов'))) +
    statCard('Доступно', fmtUsd(availableValue), null, total > 0 ? (availableValue / total * 100).toFixed(1) + '% от портфеля' : null) +
    statCard('В ордерах', fmtUsd(lockedValue), lockedValue > 0.01 ? null : 'muted', total > 0 && lockedValue > 0 ? (lockedValue / total * 100).toFixed(1) + '% от портфеля' : 'нет активных ордеров') +
    statCard('Изменение за 24ч', dayDelta ? (dayDelta.abs >= 0 ? '+' : '-') + fmtUsd(Math.abs(dayDelta.abs)).slice(1) : '—', deltaCls, dayDelta ? (dayDelta.abs >= 0 ? '+' : '') + dayDelta.pct.toFixed(2) + '%' : 'копим историю');

  const legendHtml = donutSegments.map(function (seg) {
    const pct = total > 0 ? (seg.value / total * 100) : 0;
    return '<div class="finres-donut-legend-row"><span class="finres-donut-legend-dot" style="background:' + seg.color + '"></span>' +
      '<span class="finres-donut-legend-label">' + seg.asset + '</span><span class="finres-donut-legend-value">' + fmtUsd(seg.value) + '</span>' +
      '<span class="finres-donut-legend-pct">(' + pct.toFixed(1) + '%)</span></div>';
  }).join('');

  const assetRowsHtml = priced.map(function (r, i) {
    const pct = total > 0 ? (r.usdtValue / total * 100) : 0;
    const color = getCoinColor(r.asset);
    return '<div class="balance-asset-row" style="--row-i:' + i + '">' +
      '<span class="balance-asset-avatar" style="background:' + color + '">' + r.asset.slice(0, 3) + '</span>' +
      '<div class="balance-asset-mid">' +
        '<div class="balance-asset-name-row"><span class="balance-asset-name">' + r.asset + '</span>' +
        '<span class="balance-asset-amount">' + r.amount.toLocaleString('en', { maximumFractionDigits: 8 }) + '</span></div>' +
        '<div class="balance-asset-bar-track"><div class="balance-asset-bar-fill" style="width:' + Math.max(pct, 1.5) + '%;background:' + color + '"></div></div>' +
      '</div>' +
      '<div class="balance-asset-right"><div class="balance-asset-usdt">' + fmtUsd(r.usdtValue) + '</div><div class="balance-asset-pct">' + pct.toFixed(1) + '%</div>' +
      (r.locked > 0 ? '<div class="balance-asset-locked">в ордерах: ' + r.locked.toLocaleString('en', { maximumFractionDigits: 8 }) + '</div>' : '') +
      '</div></div>';
  }).join('');

  const unpricedHtml = unpriced.length
    ? '<div class="balance-unpriced-note"><i class="ri-information-line"></i> Без USDT-пары в скринере (не учтено в общей стоимости): ' +
      unpriced.map(function (r) { return r.asset + ' ' + r.amount.toLocaleString('en', { maximumFractionDigits: 8 }); }).join(', ') + '</div>'
    : '';
  const dustToggleHtml = dust.length
    ? '<div class="balance-dust-toggle" id="finresDustToggle">' +
      (hideDustBalances
        ? '<i class="ri-eye-line"></i> Показать мелкие остатки (&lt;$1): ' + dust.length + ' актив' + (dust.length === 1 ? '' : (dust.length < 5 ? 'а' : 'ов')) + ' на ' + fmtUsd(dustTotal)
        : '<i class="ri-eye-off-line"></i> Скрыть мелкие остатки (&lt;$1) — как на самой бирже') +
      '</div>'
    : '';

  el.innerHTML =
    '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
    '<div class="finres-head"><h2>Активы</h2></div>' +
    '<div class="finres-stats-grid">' + summaryHtml + '</div>' +
    '<div class="finres-chart-row">' +
      '<div class="finres-card">' +
        '<div class="finres-card-head"><span class="finres-card-title">Распределение портфеля</span></div>' +
        '<div class="finres-donut-wrap"><canvas id="finresAssetsDonut"></canvas>' +
          '<div class="finres-donut-center"><div class="finres-donut-center-value small">' + fmtUsd(total) + '</div><div class="finres-donut-center-label">Всего</div></div>' +
        '</div>' +
        '<div class="finres-donut-legend">' + (legendHtml || '<div class="balance-earnings-empty">Нет ценообразованных активов.</div>') + '</div>' +
      '</div>' +
      '<div class="finres-card">' +
        '<div class="finres-card-head"><span class="finres-card-title">Список активов</span></div>' +
        '<div class="balance-asset-list no-anim">' + (assetRowsHtml || '<div class="balance-earnings-empty">Нет ценообразованных активов.</div>') + '</div>' +
        unpricedHtml + dustToggleHtml +
      '</div>' +
    '</div>' +
    '</div>';

  const donutCanvas = document.getElementById('finresAssetsDonut');
  if (donutCanvas) drawDonutChart(donutCanvas, donutSegments);

  const dustToggleEl = document.getElementById('finresDustToggle');
  if (dustToggleEl) {
    dustToggleEl.addEventListener('click', function () {
      hideDustBalances = !hideDustBalances;
      try { persistSet('mexc_hide_dust', hideDustBalances ? '1' : '0'); } catch (e) {}
      // renderAccountBalances пересчитает снимок и сама вызовет lightRefreshFinresContent(), которая
      // (раз мы сейчас на вкладке "Активы") тут же перерисует донат/список с новым набором активов.
      renderAccountBalances(lastRawBalances);
    });
  }
}

// ------------------------------------------------------------------------------------------
// Финрез — вкладка "Риски": концентрация портфеля (доля крупнейшего актива, топ-3) и просадка
// по эквити-кривой реализованных сделок. Концентрация считается на лету из lastBalanceState —
// без новых запросов к MEXC.
// ------------------------------------------------------------------------------------------
// Стейблкоины намеренно исключены из "крупнейший актив/топ-3": для активного трейдера, который между
// сделками возвращается в USDT (баланс между округлениями почти целиком в кэше), буквальная
// концентрация "100% в USDT" технически верна, но вводит в заблуждение — это не риск в том смысле,
// в каком им является 100% в одной волатильной монете. Проценты при этом всё равно считаются от
// ОБЩЕЙ стоимости портфеля (не только от суммы нестейбл-активов) — так цифра честно отражает реальную
// долю риска в портфеле целиком, а не раздувается искусственно, если нестейблов совсем немного.
function computeFinresConcentration(priced, total) {
  const nonStable = priced.filter(function (r) { return !STABLECOINS.hasOwnProperty(r.asset); });
  if (!nonStable.length || !(total > 0)) return { top1: null, top1Pct: 0, top3Pct: 0 };
  const top1 = nonStable[0]; // priced уже отсортирован по usdtValue убыв. (см. renderAccountBalances)
  const top1Pct = top1.usdtValue / total * 100;
  const top3Pct = nonStable.slice(0, 3).reduce(function (s, r) { return s + r.usdtValue; }, 0) / total * 100;
  return { top1: top1, top1Pct: top1Pct, top3Pct: top3Pct };
}

// Максимальная просадка ЭКВИТИ-КРИВОЙ реализованных сделок (нарастающая сумма pnl по времени) от
// собственного пика — не просадка стоимости портфеля по снимкам баланса, как было раньше (см.
// комментарий у computeDailyRealizedPnlMap: та же причина смены подхода — портфель активного
// трейдера большую часть времени лежит в USDT между сделками, и его "просадка" почти всегда 0%,
// даже когда серия убыточных сделок реально просадила P&L). pct считается от пика в деньгах — если
// эквити ещё ни разу не выходила в плюс (пик <= 0), процент показать честно не от чего, тогда null.
function computeFinresMaxDrawdownFromTrades(trades) {
  if (!trades || trades.length < 2) return null;
  const sorted = trades.slice().sort(function (a, b) { return a.time - b.time; });
  let cum = 0, peak = 0, maxDdAbs = 0, peakAtMaxDd = 0;
  sorted.forEach(function (t) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDdAbs) { maxDdAbs = dd; peakAtMaxDd = peak; }
  });
  return { abs: maxDdAbs, pct: peakAtMaxDd > 1e-9 ? (maxDdAbs / peakAtMaxDd * 100) : null };
}

// Показатели РИСКА по реализованным сделкам (в отличие от computeFinresConcentration/MaxDrawdown
// выше, которые считаются по стоимости портфеля): лучший/худший день по сумме pnl закрытых сделок,
// максимальные серии подряд идущих побед/убытков, Profit Factor (прибыль/|убыток|) и
// Risk/Reward (средняя прибыльная сделка / средняя убыточная).
function computeFinresTradeStats(trades) {
  if (!trades || !trades.length) return null;
  const dayMap = {};
  trades.forEach(function (t) {
    const d = new Date(t.time);
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    dayMap[key] = (dayMap[key] || 0) + t.pnl;
  });
  const dayValues = Object.keys(dayMap).map(function (k) { return dayMap[k]; });
  const bestDay = dayValues.length ? Math.max.apply(null, dayValues) : 0;
  const worstDay = dayValues.length ? Math.min.apply(null, dayValues) : 0;

  let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0;
  let profit = 0, loss = 0, winCount = 0, lossCount = 0;
  trades.forEach(function (t) {
    if (t.pnl > 1e-6) {
      profit += t.pnl; winCount++;
      curWin++; curLoss = 0; if (curWin > maxWin) maxWin = curWin;
    } else if (t.pnl < -1e-6) {
      loss += t.pnl; lossCount++;
      curLoss++; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss;
    } else { curWin = 0; curLoss = 0; }
  });
  const avgWin = winCount ? profit / winCount : 0;
  const avgLoss = lossCount ? Math.abs(loss) / lossCount : 0;
  const profitFactor = Math.abs(loss) > 1e-9 ? (profit / Math.abs(loss)) : (profit > 0 ? Infinity : 0);
  const riskReward = avgLoss > 1e-9 ? (avgWin / avgLoss) : (avgWin > 0 ? Infinity : 0);
  return { bestDay: bestDay, worstDay: worstDay, maxWinStreak: maxWin, maxLossStreak: maxLoss, profitFactor: profitFactor, riskReward: riskReward };
}

// Вторая строка вкладки "Риски" — показатели по сделкам (лучший/худший день, серии, Profit Factor,
// Risk/Reward). Грузится асинхронно через тот же кэш finresLoadRealized(), что "Обзор"/"P&L", поэтому
// первая строка (концентрация портфеля, не требует сделок) отрисовывается мгновенно, а эта — following.
function renderFinresRiskTradeStatsHtml(data, loading) {
  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + label + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }
  if (loading) {
    return statCard('Лучший день', '···', null, null) +
      statCard('Худший день', '···', null, null) +
      statCard('Серии подряд', '···', null, null) +
      statCard('Profit Factor', '···', null, null) +
      statCard('Просадка эквити', '···', null, null);
  }
  const stats = data && data.trades.length ? computeFinresTradeStats(data.trades) : null;
  if (!stats) {
    return '<div class="finres-empty" style="grid-column:1/-1;padding:24px"><i class="ri-bar-chart-line"></i>Реализованных сделок пока нет — как только появятся закрытые позиции, здесь появится статистика по сериям и Profit Factor.</div>';
  }
  const pf = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
  const rr = stats.riskReward === Infinity ? '∞' : stats.riskReward.toFixed(2);
  const dd = computeFinresMaxDrawdownFromTrades(data.trades);
  return statCard('Лучший день', (stats.bestDay >= 0 ? '+' : '-') + fmtUsd(Math.abs(stats.bestDay)).slice(1), stats.bestDay >= 0 ? 'up' : 'down', 'по реализованному PnL') +
    statCard('Худший день', (stats.worstDay >= 0 ? '+' : '-') + fmtUsd(Math.abs(stats.worstDay)).slice(1), stats.worstDay >= 0 ? 'up' : 'down', 'по реализованному PnL') +
    statCard('Серии подряд', stats.maxWinStreak + ' / ' + stats.maxLossStreak, null, 'макс. побед / макс. убытков') +
    statCard('Profit Factor', pf, stats.profitFactor >= 1.5 ? 'up' : (stats.profitFactor < 1 ? 'down' : null), 'Risk/Reward ' + rr) +
    statCard('Просадка эквити', dd ? '-' + fmtUsd(Math.abs(dd.abs)).slice(1) : '$0.00', dd && dd.abs < -0.01 ? 'down' : 'muted', dd && dd.pct != null ? dd.pct.toFixed(2) + '% от пика P&L' : 'ещё не выходили в плюс');
}

// Раунд 12 ("доработать Риски"): третья строка — риск ОТКРЫТЫХ (ещё не проданных) позиций, которого
// раньше на вкладке не было вовсе (только реализованные закрытые сделки). Использует ту же
// finresLoadRealized(), т.к. openPositions считается там же по реальной истории /api/v3/myTrades.
function renderFinresOpenRiskHtml(data, loading) {
  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + label + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }
  if (loading) {
    return statCard('Открытых позиций', '···', null, null) +
      statCard('Нереализованный PnL', '···', null, null) +
      statCard('Самая рискованная', '···', null, null);
  }
  const positions = (data && data.openPositions) || [];
  if (!positions.length) {
    return '<div class="finres-empty" style="grid-column:1/-1;padding:24px"><i class="ri-shield-check-line"></i>Открытых позиций без учтённой продажи не найдено в загруженной истории сделок.</div>';
  }
  const totalUnrealized = positions.reduce(function (s, p) { return s + p.unrealizedPnl; }, 0);
  const totalCost = positions.reduce(function (s, p) { return s + p.costBasis; }, 0);
  const totalPct = totalCost > 1e-9 ? (totalUnrealized / totalCost * 100) : 0;
  const worst = positions[0]; // отсортировано по |unrealizedPnl| убыв. в finresLoadRealized
  return statCard('Открытых позиций', String(positions.length), null, 'без учтённой продажи в истории') +
    statCard('Нереализованный PnL', (totalUnrealized >= 0 ? '+' : '-') + fmtUsd(Math.abs(totalUnrealized)).slice(1), totalUnrealized >= 0 ? 'up' : 'down', (totalPct >= 0 ? '+' : '') + totalPct.toFixed(2) + '% от вложенного') +
    statCard('Самая рискованная', worst.asset, worst.unrealizedPnl >= 0 ? 'up' : 'down', (worst.unrealizedPnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(worst.unrealizedPnl)).slice(1) + ' (' + (worst.unrealizedPct >= 0 ? '+' : '') + worst.unrealizedPct.toFixed(1) + '%)');
}

function renderFinresRiskTab(el, animate) {
  animate = animate !== false;
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.</div></div>';
    return;
  }
  const priced = lastBalanceState.priced, total = lastBalanceState.total;
  const conc = computeFinresConcentration(priced, total);
  // "Просадка от пика" переехала во вторую строку (эквити-кривая реализованных сделок, см.
  // computeFinresMaxDrawdownFromTrades) — просадка стоимости ПОРТФЕЛЯ здесь была почти всегда 0% для
  // активного трейдера (баланс между сделками в основном в кэше), вводила в заблуждение.
  const stableValue = priced.filter(function (r) { return STABLECOINS.hasOwnProperty(r.asset); })
    .reduce(function (s, r) { return s + r.usdtValue; }, 0);
  const stablePct = total > 0 ? (stableValue / total * 100) : 0;

  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + label + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }

  const top1Cls = conc.top1Pct >= 50 ? 'down' : (conc.top1Pct >= 30 ? null : 'up');
  const statsHtml =
    statCard('Крупнейший актив', conc.top1 ? conc.top1.asset : '—', top1Cls, conc.top1 ? conc.top1Pct.toFixed(1) + '% портфеля' : (priced.length ? 'нет открытых позиций' : null)) +
    statCard('Топ-3 концентрация', conc.top3Pct.toFixed(1) + '%', conc.top3Pct >= 70 ? 'down' : null, 'доля трёх крупнейших НЕ-стейблкоинов') +
    statCard('В кэше (USDT/USDC…)', stablePct.toFixed(1) + '%', null, fmtUsd(stableValue) + ' вне рынка') +
    statCard('Активов в портфеле', String(priced.length), null, 'учтено в общей стоимости');

  const warnHtml = conc.top1 && conc.top1Pct >= 50
    ? '<div class="finres-warn-banner"><i class="ri-alert-line"></i> Высокая концентрация: ' + conc.top1.asset + ' занимает ' + conc.top1Pct.toFixed(1) + '% портфеля — просадка по этой монете сильно повлияет на весь баланс.</div>'
    : '';

  const topRowsHtml = priced.slice(0, 10).map(function (r) {
    const pct = total > 0 ? (r.usdtValue / total * 100) : 0;
    const color = getCoinColor(r.asset);
    return '<div class="balance-asset-row">' +
      '<span class="balance-asset-avatar" style="background:' + color + '">' + r.asset.slice(0, 3) + '</span>' +
      '<div class="balance-asset-mid">' +
        '<div class="balance-asset-name-row"><span class="balance-asset-name">' + r.asset + '</span>' +
        '<span class="balance-asset-amount">' + pct.toFixed(1) + '% портфеля</span></div>' +
        '<div class="balance-asset-bar-track"><div class="balance-asset-bar-fill" style="width:' + Math.max(pct, 1.5) + '%;background:' + color + '"></div></div>' +
      '</div>' +
      '<div class="balance-asset-right"><div class="balance-asset-usdt">' + fmtUsd(r.usdtValue) + '</div></div>' +
      '</div>';
  }).join('');

  el.innerHTML =
    '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
    '<div class="finres-head"><h2>Риски</h2></div>' +
    '<div class="finres-card-title" style="margin-bottom:10px">Концентрация портфеля</div>' +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '">' + statsHtml + '</div>' +
    warnHtml +
    '<div class="finres-card-title" style="margin:18px 0 10px">Показатели по сделкам</div>' +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '" id="finresRiskTradeStats">' + renderFinresRiskTradeStatsHtml(null, true) + '</div>' +
    '<div class="finres-card-title" style="margin:18px 0 10px">Открытые позиции</div>' +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '" id="finresOpenRiskStats">' + renderFinresOpenRiskHtml(null, true) + '</div>' +
    '<div class="finres-table-card" style="margin-top:18px"><div class="finres-table-title">Концентрация по активам (топ-10)</div>' +
    '<div class="balance-asset-list no-anim">' + (topRowsHtml || '<div class="balance-earnings-empty">Нет ценообразованных активов.</div>') + '</div></div>' +
    '</div>';

  finresLoadRealized(false).then(function (data) {
    if (finresTab !== 'risk') return;
    const grid = document.getElementById('finresRiskTradeStats');
    if (grid) grid.innerHTML = renderFinresRiskTradeStatsHtml(data, false);
    const openGrid = document.getElementById('finresOpenRiskStats');
    if (openGrid) openGrid.innerHTML = renderFinresOpenRiskHtml(data, false);
  });
}

// MEXC (как и большинство бирж) по умолчанию прячет в своём интерфейсе активы дешевле $1 —
// это часто "пыль" от комиссионных скидок и т.п. Скринер честно видит ВСЕ балансы через API,
// поэтому без этого фильтра его "общая стоимость портфеля" может быть немного больше, чем то,
// что человек привык видеть на самой бирже. Прячем мелочь по умолчанию, чтобы цифры совпадали,
// но даём переключатель, чтобы посмотреть точный список включая пыль.
const DUST_USD_THRESHOLD = 1;
let hideDustBalances = (function () {
  try { return localStorage.getItem('mexc_hide_dust') !== '0'; } catch (e) { return true; }
})();

// --- "Известные" символы для журнала сделок/реализованного PnL ---
// MEXC не отдаёт единый список сделок сразу по ВСЕМ парам — только /api/v3/myTrades?symbol=X по
// конкретному символу. Раньше список символов, для которых вообще имело смысл запрашивать историю,
// строился ТОЛЬКО из текущего баланса (lastBalanceState.priced) — значит, стоило продать позицию
// в ноль, и она тут же исчезала из "Обзора"/"P&L"/"Рисков"/журнала, хотя реальные закрытые сделки
// по ней никуда не делись. Чтобы список монет был "настоящим" (отражал реальную историю, а не
// только текущий кошелёк), запоминаем НАВСЕГДА (localStorage) каждый символ, который хоть раз видели
// в балансе за время работы приложения, плюс те, что пользователь вручную нашёл через поиск на
// вкладке "Сделки" (см. renderFinresTradesTab). finresLoadRealized() ниже берёт объединение этого
// списка с текущим балансом — так однажды проданная в ноль монета остаётся в статистике.
const KNOWN_SYMBOLS_KEY = 'mexc_known_trade_symbols';
let knownSymbols = {}; // { BTC: 'BTCUSDT', ... }
// Именованная (не анонимная IIFE), т.к. её нужно повторно вызвать из hydrateFromNativeStorageIfNeeded
// ниже — если локальный localStorage-профиль оказался пустым (см. её комментарий), но резервная копия
// нашлась в Neutralino.storage, нужно перечитать localStorage ещё раз уже ПОСЛЕ восстановления.
function loadKnownSymbols() {
  try {
    const raw = localStorage.getItem(KNOWN_SYMBOLS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    let hadStablecoin = false;
    if (Array.isArray(arr)) arr.forEach(function (e) {
      if (!e || !e.asset || !e.raw) return;
      // Стейблкоин сам против себя ("USDTUSDT" и т.п.) — не реальная спот-пара, MEXC всегда ответит
      // "Invalid symbol". Раньше такие записи могли попасть сюда (до того как эта проверка появилась
      // и в rememberSymbol ниже, и в finresLoadRealizedCore для текущего баланса) и с тех пор молча
      // пережёвывались на каждое обновление Финреза — один гарантированно провальный запрос впустую.
      if (STABLECOINS.hasOwnProperty(e.asset)) { hadStablecoin = true; return; }
      knownSymbols[e.asset] = e.raw;
    });
    if (hadStablecoin) {
      const arr2 = Object.keys(knownSymbols).map(function (a) { return { asset: a, raw: knownSymbols[a] }; });
      persistSet(KNOWN_SYMBOLS_KEY, JSON.stringify(arr2));
    }
  } catch (e) { /* localStorage недоступен — просто не будет "памяти" между сессиями, не критично */ }
}
loadKnownSymbols();
function rememberSymbol(asset, raw) {
  if (!asset || !raw || knownSymbols[asset] === raw) return;
  if (STABLECOINS.hasOwnProperty(asset)) return; // см. комментарий в loadKnownSymbols
  knownSymbols[asset] = raw;
  try {
    const arr = Object.keys(knownSymbols).map(function (a) { return { asset: a, raw: knownSymbols[a] }; });
    persistSet(KNOWN_SYMBOLS_KEY, JSON.stringify(arr));
  } catch (e) { /* переживём без сохранения между сессиями */ }
}

// Разбирает сырые балансы аккаунта в единый снимок (lastBalanceState/lastRawBalances), которым
// пользуется ВСЯ аналитика Финреза (хиро-панель, P&L, активы, риски). Страница "Настройки
// аккаунта" сама баланс больше не показывает (см. .acct-finres-note в её HTML) — вся визуализация
// живёт на странице "Финрез" (renderFinresHero + renderFinresTab / lightRefreshFinresContent).
function renderAccountBalances(balances) {
  lastRawBalances = balances;
  const nonzero = (balances || [])
    .filter(function (b) { return parseFloat(b.free) > 0 || parseFloat(b.locked) > 0; });

  if (!nonzero.length) {
    lastBalanceState = null;
  } else {
    const rows = nonzero.map(function (b) {
      const free = parseFloat(b.free) || 0, locked = parseFloat(b.locked) || 0;
      const amount = free + locked;
      const price = mexcUsdtPrice(b.asset);
      return { asset: b.asset, free: free, locked: locked, amount: amount, price: price, usdtValue: price != null ? price * amount : null };
    });
    const pricedAll = rows.filter(function (r) { return r.usdtValue != null; }).sort(function (a, b) { return b.usdtValue - a.usdtValue; });
    const unpriced = rows.filter(function (r) { return r.usdtValue == null; });
    // Запоминаем символ каждой монеты, у которой сейчас ненулевой баланс — на будущее, на случай если
    // её потом продадут в ноль (см. комментарий у KNOWN_SYMBOLS_KEY выше).
    pricedAll.forEach(function (r) {
      const c = coinMap.get(r.asset + '/USDT');
      rememberSymbol(r.asset, (c && c.raw) || assetToRawSymbol(r.asset));
    });
    const dust = pricedAll.filter(function (r) { return r.usdtValue < DUST_USD_THRESHOLD; });
    const dustTotal = dust.reduce(function (s, r) { return s + r.usdtValue; }, 0);
    const priced = hideDustBalances ? pricedAll.filter(function (r) { return r.usdtValue >= DUST_USD_THRESHOLD; }) : pricedAll;
    const total = priced.reduce(function (s, r) { return s + r.usdtValue; }, 0);

    const assetValues = {};
    priced.forEach(function (r) { assetValues[r.asset] = r.usdtValue; });
    const hist = pushBalanceHistory(total, assetValues);

    const donutColors = ['#4C7DFF', '#00D084', '#F0B90B', '#FF4D5A', '#9945FF', '#627EEA', '#FF7A00', '#8247E5'];
    const donutSegments = priced.slice(0, 8).map(function (r, i) { return { asset: r.asset, value: r.usdtValue, color: donutColors[i % donutColors.length] }; });
    const otherValue = priced.slice(8).reduce(function (s, r) { return s + r.usdtValue; }, 0);
    if (otherValue > 0) donutSegments.push({ asset: 'Другое', value: otherValue, color: '#5E6673' });

    lastBalanceState = {
      priced: priced, total: total, hist: hist, donutSegments: donutSegments,
      unpriced: unpriced, dust: dust, dustTotal: dustTotal
    };
  }

  // Рисуем Финрез, только если его страница сейчас реально видна — иначе canvas-графики (хиро-график,
  // донат) рисовались бы в контейнер нулевого размера (display:none) и остались бы пустыми.
  const finresPage = document.getElementById('page-finres');
  if (finresPage && finresPage.classList.contains('active')) {
    renderFinresHero();
    lightRefreshFinresContent();
  }
}

// Хиро-панель Финреза: общая стоимость портфеля + дельта + стат-плитки (24ч/7д/30д/активы) +
// встроенный график стоимости за период. Раньше это была верхняя часть баланса на "Настройки
// аккаунта" — перенесена сюда целиком, видна над всеми вкладками Финреза одновременно.
function renderFinresHero() {
  const el = document.getElementById('finresHeroBar');
  if (!el) return;
  if (!accountConnected || !lastBalanceState) { el.innerHTML = ''; return; }

  // Уже была отрисована hero-карточка — значит, это авто-обновление, а не первый показ страницы:
  // плитки не должны заново проигрывать анимацию появления при каждом тике/переключении вкладок.
  const isRefresh = !!el.querySelector('.balance-hero');
  const total = lastBalanceState.total, hist = lastBalanceState.hist, priced = lastBalanceState.priced;

  const periodPillsHtml = Object.keys(BALANCE_PERIODS).map(function (key) {
    return '<span class="balance-period-pill' + (key === balancePeriod ? ' active' : '') + '" data-period="' + key + '">' + BALANCE_PERIODS[key].label + '</span>';
  }).join('');
  // 1Д/1Н/1М-плитки — по реализованным сделкам (finresRealized), не по снимкам портфеля (см. её же
  // комментарий у buildBalanceStatsGridHtml). Если сделки ещё не грузились в этой сессии — рисуем из
  // того, что уже закешировано (может быть null при самом первом заходе), и точечно обновляем плитки
  // ниже, как только придёт ответ finresLoadRealized — без полного повторного рендера всей hero-панели.
  const statsGridHtml = buildBalanceStatsGridHtml(finresRealized ? finresRealized.trades : null, priced.length, lastBalanceState.dust.length);
  const animCls = isRefresh ? ' no-anim' : '';

  el.innerHTML =
    '<div class="balance-hero">' +
      '<div class="balance-hero-main">' +
        '<div class="balance-hero-toprow">' +
          '<div class="balance-hero-label">Общая стоимость портфеля</div>' +
          '<button type="button" class="finres-refresh-btn" id="finresRefreshBtn" title="Обновить данные Финреза сейчас, не дожидаясь автообновления">' +
            '<i class="ri-refresh-line"></i><span>Обновить</span>' +
          '</button>' +
        '</div>' +
        '<div class="balance-hero-value">' + fmtUsd(total) + '</div>' +
        '<div id="balanceDeltaContainer"></div>' +
        '<div class="finres-last-updated" id="finresLastUpdated"></div>' +
      '</div>' +
      '<div class="balance-hero-chart" id="balanceChartContainer"></div>' +
    '</div>' +
    '<div class="balance-stats-grid' + animCls + '">' + statsGridHtml + '</div>' +
    '<div class="balance-period-pills" id="finresHeroPeriodPills">' + periodPillsHtml + '</div>';

  const refreshBtn = document.getElementById('finresRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', manualRefreshFinres);
  markFinresUpdatedNow();

  // Count-up + лёгкий пульс свечения на hero-сумме, только если значение реально сдвинулось между
  // авто-обновлениями (не при первом показе — там достаточно статичного числа сразу).
  const heroValueEl = el.querySelector('.balance-hero-value');
  if (heroValueEl) {
    const prevTotal = lastRenderedBalanceTotal;
    if (isRefresh && prevTotal != null && Math.abs(total - prevTotal) > 0.005) {
      animateNumberText(heroValueEl, prevTotal, total, 500, fmtUsd);
      heroValueEl.classList.add('pulse');
      setTimeout(function () { heroValueEl.classList.remove('pulse'); }, 650);
    }
    lastRenderedBalanceTotal = total;
  }

  // Пилюли периода хиро-графика намеренно ищутся только внутри #finresHeroPeriodPills — на вкладке
  // P&L есть СВОИ пилюли с тем же классом .balance-period-pill (для календаря/списка "заработано",
  // свой period finresPnlPeriod), без этого scope-а клик по ним заодно триггерил бы и хиро.
  const pillsEl = document.getElementById('finresHeroPeriodPills');
  if (pillsEl) {
    pillsEl.querySelectorAll('.balance-period-pill[data-period]').forEach(function (pill) {
      pill.addEventListener('click', function () {
        balancePeriod = this.dataset.period;
        updateFinresHeroPeriodView();
      });
    });
  }

  updateFinresHeroPeriodView();

  // Точечно обновляем ТОЛЬКО плитки 1Д/1Н/1М свежими сделками — без полного повторного рендера
  // hero-панели (finresLoadRealized сам решит, нужен ли реальный сетевой запрос, см. её 60с-кэш).
  finresLoadRealized(false).then(function (data) {
    const gridEl = document.querySelector('#finresHeroBar .balance-stats-grid');
    if (!gridEl || !accountConnected || !lastBalanceState) return;
    gridEl.innerHTML = buildBalanceStatsGridHtml(data.trades, lastBalanceState.priced.length, lastBalanceState.dust.length);
  });
}

// Отметка "Обновлено ЧЧ:ММ:СС" под суммой портфеля — ставится при каждом успешном рендере hero
// (т.е. при каждом успешном ответе баланса, примерно раз в 3с в норме). Даёт простой визуальный
// признак того, что Финрез реально жив: если время перестало меняться — автообновление где-то
// застряло, и это сразу видно на глаз, а не только по факту, что цифры "не такие".
let finresLastUpdatedAt = 0;
function markFinresUpdatedNow() {
  finresLastUpdatedAt = Date.now();
  const el = document.getElementById('finresLastUpdated');
  if (el) {
    el.textContent = 'Обновлено ' + new Date(finresLastUpdatedAt).toTimeString().slice(0, 8);
    el.classList.remove('stale');
  }
}

// Кнопка «Обновить» в Финрезе — форсирует и свежий баланс, и свежую историю сделок прямо сейчас,
// не дожидаясь ни 3с-тика автообновления, ни 60с-кэша finresLoadRealized. В паре с фиксом самого
// finresLoadRealized() (см. её комментарий выше про finresLoadPromise) это даёт пользователю
// гарантированный способ "разбудить" Финрез вручную, даже если по какой-то ещё не увиденной причине
// автообновление перестало тикать само.
async function manualRefreshFinres() {
  const btn = document.getElementById('finresRefreshBtn');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  try {
    const results = await Promise.all([
      refreshAccountBalancesIfConnected(),
      finresLoadRealized(true)
    ]);
    lightRefreshFinresContent();
    // refreshAccountBalancesIfConnected() и finresLoadRealized() сами свои сетевые ошибки не
    // пробрасывают (см. их комментарии) — сбой виден только по finresRealized.error, поэтому
    // проверяем его отдельно, а не полагаемся на то, что Promise.all вообще может отклониться.
    const tradesResult = results[1];
    if (tradesResult && tradesResult.error) {
      showAppToast('Обновлено с ошибкой: ' + tradesResult.error);
    } else {
      showAppToast('Финрез обновлён');
    }
  } catch (e) {
    showAppToast('Не удалось обновить Финрез: ' + ((e && e.message) || 'неизвестная ошибка'));
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

// Обновляет только период-зависимые части хиро-панели Финреза (дельта + встроенный график стоимости
// портфеля) из уже сохранённого lastBalanceState — без перестройки стат-плиток.
function updateFinresHeroPeriodView() {
  if (!lastBalanceState) return;
  const total = lastBalanceState.total, hist = lastBalanceState.hist;

  document.querySelectorAll('#finresHeroPeriodPills .balance-period-pill[data-period]').forEach(function (pill) {
    pill.classList.toggle('active', pill.dataset.period === balancePeriod);
  });

  const delta = computeBalanceDelta(hist, total, balancePeriod);
  const deltaClass = !delta ? 'flat' : (delta.abs > 0.005 ? 'up' : (delta.abs < -0.005 ? 'down' : 'flat'));
  const deltaIcon = deltaClass === 'up' ? 'ri-arrow-up-line' : (deltaClass === 'down' ? 'ri-arrow-down-line' : 'ri-subtract-line');
  const deltaHtml = delta
    ? '<div class="balance-hero-delta ' + deltaClass + '"><i class="' + deltaIcon + '"></i>' +
      (delta.abs >= 0 ? '+' : '') + delta.pct.toFixed(2) + '% (' + (delta.abs >= 0 ? '+' : '-') + fmtUsd(Math.abs(delta.abs)).slice(1) + ')' +
      '<span class="delta-note">за ' + delta.period + '</span></div>'
    : '<div class="balance-hero-delta flat"><span class="delta-note">Копим историю для графика — загляните сюда попозже</span></div>';
  const deltaEl = document.getElementById('balanceDeltaContainer');
  if (deltaEl) deltaEl.innerHTML = deltaHtml;

  const period = BALANCE_PERIODS[balancePeriod] || BALANCE_PERIODS.day;
  const ref = findReferencePoint(hist, period.ms);
  const chartPoints = ref ? hist.filter(function (p) { return p.t >= ref.t; }) : hist;
  const chartContainer = document.getElementById('balanceChartContainer');
  if (chartContainer) {
    if (chartPoints && chartPoints.length >= 2) {
      chartContainer.innerHTML = '<canvas id="balancePnlChart"></canvas><div class="chart-tip" id="balancePnlTip"></div>';
      const pnlCanvas = document.getElementById('balancePnlChart');
      drawPnlChart(pnlCanvas, chartPoints);
      wirePnlChartCrosshair(pnlCanvas, document.getElementById('balancePnlTip'));
    } else {
      chartContainer.innerHTML = '<div class="balance-chart-empty">График появится после нескольких снимков баланса</div>';
    }
  }

  // Календарь P&L и список "заработано по монетам" переехали на страницу Финрез → вкладка P&L
  // (см. renderFinresPnlTab/renderFinresPnlEarnings) — здесь, в хиро-панели, больше не рендерятся.
}

// "Лёгкое" обновление содержимого текущей вкладки Финреза на каждом 3-секундном тике авто-обновления
// баланса — В ОТЛИЧИЕ от renderFinresTab() (полный ремоунт вкладки с анимацией появления, вызывается
// только при реальном переключении вкладки/страницы), здесь мы точечно обновляем только значения:
// календарь+список "заработано" на P&L, донат+список на Активах, стат-плитки на Рисках и Обзоре — без
// пересоздания обёрток и БЕЗ анимации (animate:false), чтобы вкладка не "мигала" каждые 3с.
//
// Раунд 12 ("очень важно, чтобы данные Финреза обновлялись в реальном времени, и были корректны"):
// раньше "Обзор" и "Сделки" вообще не входили сюда — открыв "Обзор" один раз, можно было просидеть
// на нём сколько угодно и ни разу не увидеть свежих данных без ручного переключения вкладок туда-обратно.
// Теперь "Обзор" тоже точечно обновляется (у него нет полей ввода — полный ремоунт с animate:false не
// мешает), а "Сделки" обновляет ТОЛЬКО тело таблицы (renderFinresTradesTable), не трогая обёртку с
// строкой поиска — иначе каждые 3с сбрасывался бы фокус/курсор в поле поиска монеты, если юзер как раз печатает.
function lightRefreshFinresContent() {
  const el = document.getElementById('finresContent');
  if (!el || !accountConnected || !lastBalanceState) return;
  if (finresTab === 'overview') {
    renderFinresOverview(el, false);
  } else if (finresTab === 'pnl') {
    renderBalanceCalendar(false);
    renderFinresPnlEarnings();
    renderFinresPnlStats(false);
  } else if (finresTab === 'trades') {
    finresLoadRealized(false).then(function (data) {
      if (finresTab !== 'trades') return;
      if (document.getElementById('finresTradesTableCard')) renderFinresTradesTable(data);
    });
  } else if (finresTab === 'assets') {
    renderFinresAssetsTab(el, false);
  } else if (finresTab === 'risk') {
    renderFinresRiskTab(el, false);
  }
}

// Общий рендер карточек "заработано/потеряно по монетам" — используется на вкладке Финрез → P&L.
function buildBalanceEarnCardsHtml(earnings, period, histLen) {
  if (!earnings.length) {
    return '<div class="balance-earnings-empty">За выбранный период заметных изменений по монетам не найдено' + (histLen < 2 ? ' — копим историю.' : '.') + '</div>';
  }
  return '<div class="balance-earnings-title">Заработано по монетам за ' + period.label + '</div>' +
    '<div class="balance-earn-list">' +
    earnings.map(function (e) {
      const cls = e.earned > 0.005 ? 'up' : (e.earned < -0.005 ? 'down' : 'flat');
      const icon = cls === 'up' ? 'ri-arrow-up-line' : (cls === 'down' ? 'ri-arrow-down-line' : 'ri-subtract-line');
      const sign = e.earned >= 0 ? '+' : '-';
      const pct = e.before > 0 ? ' <span class="balance-earn-pct">(' + (e.earned >= 0 ? '+' : '') + (e.earned / e.before * 100).toFixed(1) + '%)</span>' : '';
      const color = getCoinColor(e.asset);
      return '<div class="balance-earn-card">' +
        '<span class="balance-earn-avatar" style="background:' + color + '">' + e.asset.slice(0, 3) + '</span>' +
        '<div class="balance-earn-mid"><div class="balance-earn-name">' + e.asset + '</div>' +
        '<div class="balance-earn-sub">' + fmtUsd(e.before) + ' → ' + fmtUsd(e.now) + '</div></div>' +
        '<div class="balance-earn-right ' + cls + '"><i class="' + icon + '"></i>' + sign + fmtUsd(Math.abs(e.earned)).slice(1) + pct + '</div>' +
        '</div>';
    }).join('') +
    '</div>';
}

// Отдельный, более частый таймер для баланса — независимо от общего интервала "Автообновление"
// в настройках (который может быть выставлен на 30-60с для аналитики). Баланс обновляется каждые
// 3с, пока открыта страница "Настройки аккаунта" и есть подключение — это ощущается как
// "почти в реальном времени", не упираясь при этом в лимиты MEXC (один GET-запрос раз в 3с).
let balanceRefreshTimer = null;
function startBalanceAutoRefresh() {
  stopBalanceAutoRefresh();
  balanceRefreshTimer = setInterval(function () {
    const acctPage = document.getElementById('page-account');
    const finresPage = document.getElementById('page-finres');
    const acctActive = acctPage && acctPage.classList.contains('active');
    const finresActive = finresPage && finresPage.classList.contains('active');
    if (acctActive || finresActive) refreshAccountBalancesIfConnected();
  }, 3000);
}
function stopBalanceAutoRefresh() {
  if (balanceRefreshTimer) { clearInterval(balanceRefreshTimer); balanceRefreshTimer = null; }
}

// Раунд 13 ("Финрез сбрасывается/устаревает при сворачивании окна или уходе на другую страницу"):
// когда вкладка/окно свёрнуты или неактивны дольше нескольких минут, Chromium замораживает таймеры
// фоновой страницы (Page Lifecycle) — обычный 3с-таймер баланса и часовой кэш finresLoadRealized
// просто не тикают, пока окно скрыто. Само по себе это не "сброс" (никакие данные не обнуляются —
// см. renderAccountBalances/finresLoadRealized, ни один код-путь не зануляет lastBalanceState или
// finresRealized при простом уходе со страницы), но при возврате пользователь видит УСТАРЕВШИЕ
// цифры, пока не подождёт до следующего тика — и это легко воспринимается как "всё сбросилось".
// Стандартное решение: как только окно/вкладка снова видимы — форсируем немедленное обновление
// баланса И принудительно сбрасываем часовой кэш finresLoadRealized, не дожидаясь таймеров.
function forceRefreshFinresOnVisible() {
  if (!accountConnected) return;
  const acctPage = document.getElementById('page-account');
  const finresPage = document.getElementById('page-finres');
  const acctActive = acctPage && acctPage.classList.contains('active');
  const finresActive = finresPage && finresPage.classList.contains('active');
  if (!acctActive && !finresActive) return;
  refreshAccountBalancesIfConnected();
  if (finresActive) {
    // finresLoadRealized(true) обновляет ОБЩИЙ кэш (finresRealized) сразу; последующий
    // lightRefreshFinresContent() ниже точечно, БЕЗ полного ремоунта и анимации (см. её же
    // определение) подставит уже свежие данные в текущую под-вкладку — своих повторных запросов
    // к MEXC он не сделает, т.к. кэш только что обновился.
    finresLoadRealized(true).then(function () {
      if (finresPage.classList.contains('active')) lightRefreshFinresContent();
    });
  }
}
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) forceRefreshFinresOnVisible();
});
window.addEventListener('focus', forceRefreshFinresOnVisible);
// visibilitychange/focus покрывают "окно свернули/переключили", но не покрывают "отвалился и
// восстановился Wi-Fi/сеть без смены фокуса окна" — ноутбук может часами простоять на одной и той
// же активной вкладке, потерять и восстановить сеть несколько раз, и ни один из двух обработчиков
// выше на это не сработает. Пользователю пришлось бы кликнуть в другое окно и обратно вручную.
window.addEventListener('online', function () {
  logI('WS', 'navigator.onLine: сеть восстановлена — форсируем обновление Финреза и (при необходимости) WS-переподключение');
  forceRefreshFinresOnVisible();
  if (!ws || ws.readyState === 3 /* CLOSED */) {
    wsReconnectAttempts = 0; // сеть точно восстановлена — не нужно доигрывать уже накопленный backoff
    connectWs();
  }
});

// --- Журнал сделок (Задача: "точки входа и выхода на графике по монете") ---

// Реальная история исполненных сделок по конкретной паре — подписанный приватный эндпоинт MEXC
// (тот же путь fetch()→curl.exe, что и у mexcSignedRequest в целом). MEXC не отдаёт единый список
// сделок по ВСЕМ парам сразу, поэтому журнал строится только по монетам из текущего баланса —
// по ним уже точно известен нужный symbol для запроса.
async function fetchMyTrades(raw, limit) {
  const data = await mexcSignedRequest('/api/v3/myTrades', { symbol: raw, limit: limit || 500 });
  if (!Array.isArray(data)) throw new Error((data && (data.msg || data.message)) || 'Некорректный ответ MEXC');
  return data.map(function (t) {
    return { price: Number(t.price), qty: Number(t.qty), time: Number(t.time), buy: !!t.isBuyer };
  }).filter(function (t) {
    return Number.isFinite(t.price) && Number.isFinite(t.qty) && Number.isFinite(t.time);
  }).sort(function (a, b) { return a.time - b.time; });
}

const JOURNAL_TF_MS = { '5': 5 * 60000, '15': 15 * 60000, '60': 3600000, '240': 4 * 3600000, 'D': 86400000 };
// Подбирает таймфрейм свечей так, чтобы диапазон "от самой ранней сделки до сейчас" уложился в
// разумное число свечей (лимит запроса klines — 1000) — иначе старая сделка окажется за пределами
// загруженного графика.
function pickJournalTf(backMs) {
  const order = ['5', '15', '60', '240', 'D'];
  for (let i = 0; i < order.length; i++) {
    if (backMs / JOURNAL_TF_MS[order[i]] <= 900) return order[i];
  }
  return 'D';
}

// --- Реализованный PnL по методу средней цены входа (average cost) ---
// BUY-сделки наращивают позицию и её среднюю цену входа, но сами по себе PnL не реализуют.
// Каждая SELL-сделка закрывает часть/всю открытую позицию по этой средней цене — разница
// (цена продажи − средняя цена входа) × закрытый объём = реализованный результат ИМЕННО этой продажи.
// Продажа, для которой в загруженной истории нет открытой позиции (например, покупка была раньше
// глубины истории, которую отдаёт API), честно пропускается — не додумываем несуществующие данные.
function computeRealizedPnlForSymbol(trades) {
  let position = 0, costBasis = 0;
  const realized = [];
  trades.forEach(function (t) {
    if (t.buy) {
      position += t.qty;
      costBasis += t.qty * t.price;
    } else if (position > 1e-9) {
      const avgCost = costBasis / position;
      const closedQty = Math.min(t.qty, position);
      const cost = avgCost * closedQty;
      realized.push({ time: t.time, pnl: (t.price - avgCost) * closedQty, price: t.price, qty: closedQty, cost: cost });
      costBasis -= cost;
      position -= closedQty;
      if (position < 1e-9) { position = 0; costBasis = 0; }
    }
  });
  return realized;
}

// Вход/выход ОДНОЙ позиции целиком (не отдельные BUY/SELL-филлы) — для графика в модалке журнала
// (см. drawJournalChart) по образцу tradermake.money: там график показывает ровно ОДНУ выбранную
// сделку (одна зелёная точка входа, одна красная точка выхода, две пунктирные линии-уровня), а не
// все филлы разом — чем и решается "каша" из предыдущих раундов честнее, чем любая раздвижка/зум.
// Тот же учёт по средней цене, что и у computeRealizedPnlForSymbol (числа остаются согласованными
// с остальным Финрезом), но вдобавок запоминаем episodeStart — момент, когда позиция открылась
// с нуля (первая покупка новой позиции) — им размечается точка входа на графике. Для типичного
// скальпинга (открыл-закрыл, редко доливая) это даёт честную и понятную пару точек; при нескольких
// покупках в рамках одной позиции точка входа стоит на ПЕРВОЙ из них, а цена — средняя по всем.
function computeTradePairsForChart(trades) {
  let position = 0, costBasis = 0, episodeStart = null;
  const pairs = [];
  trades.forEach(function (t) {
    if (t.buy) {
      if (position < 1e-9) episodeStart = t.time;
      position += t.qty;
      costBasis += t.qty * t.price;
    } else if (position > 1e-9) {
      const avgCost = costBasis / position;
      const closedQty = Math.min(t.qty, position);
      const pnl = (t.price - avgCost) * closedQty;
      pairs.push({
        entryTime: episodeStart, entryPrice: avgCost,
        exitTime: t.time, exitPrice: t.price,
        qty: closedQty, pnl: pnl, pnlPct: avgCost > 1e-12 ? (t.price - avgCost) / avgCost * 100 : 0
      });
      costBasis -= avgCost * closedQty;
      position -= closedQty;
      if (position < 1e-9) { position = 0; costBasis = 0; }
    }
  });
  return pairs;
}

// Раунд 12 ("доработать Риски"): остаток ОТКРЫТОЙ позиции после разбора всей загруженной истории —
// тот же метод средней цены, что и computeRealizedPnlForSymbol выше, но возвращает не закрытые сделки,
// а то, что осталось "в рынке". Read-only API-ключ не отдаёт unrealized PnL напрямую — считаем его
// честно сами: (текущая цена − средняя цена входа по РЕАЛЬНОЙ истории покупок) × открытый объём.
function computeOpenPositionForSymbol(trades) {
  let position = 0, costBasis = 0;
  (trades || []).forEach(function (t) {
    if (t.buy) {
      position += t.qty; costBasis += t.qty * t.price;
    } else if (position > 1e-9) {
      const avgCost = costBasis / position;
      const closedQty = Math.min(t.qty, position);
      costBasis -= avgCost * closedQty;
      position -= closedQty;
      if (position < 1e-9) { position = 0; costBasis = 0; }
    }
  });
  return position > 1e-9 ? { qty: position, costBasis: costBasis, avgCost: costBasis / position } : null;
}

// Сколько символов тянуть ОДНОВРЕМЕННО в finresLoadRealizedCore ниже. Раньше было строго
// последовательно ("безопаснее для лимитов MEXC") — но для активного скальпера/дневного трейдера
// (см. автообнаружение монет через приватный поток сделок выше) knownSymbols легко разрастается
// до полусотни+ монет, а каждый запрос при этом ещё и падает по CORS в браузере и уходит в куда более
// медленный native-фолбэк через curl.exe (отдельный процесс на КАЖДЫЙ запрос) — строго
// последовательно это реально могло растягиваться на десятки секунд и ощущалось как "Финрез завис/
// не грузится". 5 одновременных запросов — весь список уходит кратно быстрее, а MEXC даже для
// подписанных приватных эндпоинтов даёт заметно больший запас по лимиту, чем 5 req/s.
const FINRES_LOAD_CONCURRENCY = 5;

// Тянет /api/v3/myTrades по каждой монете из текущего баланса (батчами по FINRES_LOAD_CONCURRENCY
// одновременно, см. её комментарий) и считает реализованный PnL. Чистая "рабочая" часть загрузки —
// НЕ трогает finresRealized/флаг loading сама, этим управляет обёртка finresLoadRealized() ниже
// (см. её комментарий про самовосстановление после сбоя).
async function finresLoadRealizedCore() {
  // Символы для запроса — объединение ТЕКУЩЕГО баланса и всего, что когда-либо было "замечено"
  // (knownSymbols, см. выше): так полностью закрытая (проданная в ноль) позиция не выпадает из
  // статистики, если её видели в балансе раньше или искали вручную на вкладке "Сделки".
  const priced = (lastBalanceState && lastBalanceState.priced) || [];
  const targetMap = {};
  priced.forEach(function (r) {
    // Стейблкоины (USDT/USDC/FDUSD/...) в балансе не имеют осмысленной "истории сделок против USDT" —
    // конструировать для них raw-символ через assetToRawSymbol бессмысленно (на споте MEXC такой пары,
    // как правило, просто нет) и раньше приводило к лишнему запросу, падающему с "Invalid symbol".
    if (STABLECOINS.hasOwnProperty(r.asset)) return;
    const c = coinMap.get(r.asset + '/USDT');
    targetMap[r.asset] = (c && c.raw) || assetToRawSymbol(r.asset);
  });
  Object.keys(knownSymbols).forEach(function (asset) { targetMap[asset] = knownSymbols[asset]; });
  const targets = Object.keys(targetMap).map(function (asset) { return { asset: asset, raw: targetMap[asset] }; });

  const allRealized = [];
  const bySymbol = {};
  const openPositions = [];
  let lastError = null;
  // Каждый "воркер" вынимает следующий ещё не обработанный символ из общей очереди targets и обрабатывает
  // его целиком (включая retry/backoff) — как только освобождается, берёт следующий. Общий обход
  // завершается, когда очередь пуста; PnL/allRealized/openPositions — общие массивы, но т.к. JS
  // однопоточный и мутация происходит только между await (никогда параллельно), гонок здесь нет.
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < targets.length) {
      const t = targets[nextIndex++];
      try {
        const trades = await withRetry(function () { return fetchMyTrades(t.raw, 1000); }, 3, [1000, 3000, 8000], 'Finrez:' + t.asset, function (err) {
          return !/invalid symbol/i.test((err && err.message) || '');
        });
        bySymbol[t.asset] = trades;
        computeRealizedPnlForSymbol(trades).forEach(function (r) {
          allRealized.push({ time: r.time, asset: t.asset, pnl: r.pnl, price: r.price, qty: r.qty, cost: r.cost });
        });
        // Нереализованный риск открытой позиции (для вкладки "Риски") — только если знаем текущую
        // живую цену актива (из текущего баланса или тикера); без цены оценить риск честно нельзя.
        const openPos = computeOpenPositionForSymbol(trades);
        if (openPos) {
          const priceRow = priced.filter(function (r) { return r.asset === t.asset; })[0];
          const currentPrice = priceRow ? priceRow.price : mexcUsdtPrice(t.asset);
          if (currentPrice != null) {
            const value = openPos.qty * currentPrice;
            const unrealizedPnl = value - openPos.costBasis;
            openPositions.push({
              asset: t.asset, qty: openPos.qty, avgCost: openPos.avgCost, currentPrice: currentPrice,
              costBasis: openPos.costBasis, value: value, unrealizedPnl: unrealizedPnl,
              unrealizedPct: openPos.costBasis > 1e-9 ? (unrealizedPnl / openPos.costBasis * 100) : 0
            });
          }
        }
      } catch (e) {
        // "Invalid symbol" значит, что для этого актива на споте MEXC вообще нет такой пары (например,
        // raw пришлось честно угадать через assetToRawSymbol, и угадка не подтвердилась) — это НЕ сбой
        // подключения и не повод пугать пользователя сырым текстом ошибки API, поэтому такую конкретную
        // причину пропускаем молча. Любую другую ошибку (сеть, лимиты, авторизация) по-прежнему показываем.
        if (/invalid symbol/i.test(e.message || '')) {
          logD('Finrez', t.asset + ': invalid symbol (' + t.raw + '), пропущено');
        } else {
          lastError = e.message;
          logW('Finrez', t.asset + ' (' + t.raw + '): не удалось загрузить сделки после повторов — ' + e.message);
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FINRES_LOAD_CONCURRENCY, targets.length) }, worker)
  );
  allRealized.sort(function (a, b) { return a.time - b.time; });
  openPositions.sort(function (a, b) { return Math.abs(b.unrealizedPnl) - Math.abs(a.unrealizedPnl); });
  return { trades: allRealized, bySymbol: bySymbol, openPositions: openPositions, loadedAt: Date.now(), loading: false, error: lastError };
}

// НАЙДЕННАЯ и исправленная причина "Финрез зависает/сбрасывается спустя время": раньше признаком
// "загрузка идёт" служило простое поле finresRealized.loading, которое взводилось в true в начале
// функции и сбрасывалось в false ТОЛЬКО в самом конце, после успешного прохода всего цикла по
// монетам. Цикл по монетам свои ошибки ловит и не бросает наружу — но код ДО цикла (сборка списка
// монет из lastBalanceState/knownSymbols) и ПОСЛЕ него (сортировки) исключений не ловил вообще. Если
// бы там хоть раз что-то бросило (в т.ч. гипотетически, при будущих правках) — loading остался бы
// true НАВСЕГДА, а функция начиналась с "if (loading) return finresRealized;" — то есть ВСЕ
// последующие попытки обновиться (авто-тик раз в 3с, форс при возврате видимости окна, теперь и
// кнопка «Обновить») просто молча возвращали замороженный объект и ничего не перезапускали. Именно
// так выглядело бы "Финрез слетел и больше не оживает" — без единой ошибки в консоли.
// Теперь единственный признак "уже грузится" — сам промис finresLoadPromise, который гарантированно
// обнуляется в .finally() при ЛЮБОМ исходе (успех/ошибка/что угодно ещё), поэтому зависнуть навсегда
// он не может: следующий же вызов (даже без force) увидит finresLoadPromise === null и запустит
// новую попытку.
let finresLoadPromise = null;

async function finresLoadRealized(force) {
  if (__designTestMode) return finresRealized;
  if (finresLoadPromise) return finresLoadPromise;
  if (!force && finresRealized && !finresRealized.loading && (Date.now() - finresRealized.loadedAt) < 60000) return finresRealized;
  // Пока грузим — не стираем уже показанные данные в пустоту (раньше именно так и делали), а просто
  // помечаем их как "обновляются": если экран уже что-то показывал, он и продолжит это показывать,
  // пока не придёт свежий ответ.
  finresRealized = Object.assign({ trades: [], bySymbol: {}, openPositions: [], loadedAt: 0, error: null }, finresRealized, { loading: true });
  finresLoadPromise = finresLoadRealizedCore()
    .then(function (result) { finresRealized = result; return result; })
    .catch(function (e) {
      // Не должно происходить (вся сетевая логика уже ловит свои ошибки по каждой монете отдельно
      // внутри цикла), но если что-то всё же бросит исключение выше — честно показываем это как
      // ошибку загрузки, а не оставляем интерфейс замороженным в состоянии "загрузка" навсегда.
      const msg = (e && e.message) || 'Неизвестная ошибка загрузки Финреза';
      logE('Finrez', 'finresLoadRealizedCore выбросил исключение целиком (неожиданно, все per-symbol ошибки должны ловиться внутри цикла): ' + msg);
      finresRealized = Object.assign({}, finresRealized, { loading: false, error: msg });
      return finresRealized;
    })
    .finally(function () { finresLoadPromise = null; });
  return finresLoadPromise;
}

function finresFilterByPeriod(trades, periodKey) {
  const period = FINRES_PERIODS[periodKey] || FINRES_PERIODS['7d'];
  if (period.ms == null) return trades;
  const cutoff = Date.now() - period.ms;
  return trades.filter(function (t) { return t.time >= cutoff; });
}

// Сводка по набору реализованных сделок: сумма прибыли/убытка отдельно, счётчики для винрейта,
// и % доходности относительно вложенного в закрытые позиции капитала (сумма cost по всем сделкам).
function finresAggregate(trades) {
  let profit = 0, loss = 0, winCount = 0, lossCount = 0, totalCost = 0;
  trades.forEach(function (t) {
    totalCost += t.cost || 0;
    if (t.pnl > 1e-6) { profit += t.pnl; winCount++; }
    else if (t.pnl < -1e-6) { loss += t.pnl; lossCount++; }
  });
  const count = trades.length;
  return {
    pnl: profit + loss, profit: profit, loss: loss, count: count,
    winCount: winCount, lossCount: lossCount,
    winRate: count > 0 ? (winCount / count * 100) : 0,
    pct: totalCost > 0 ? ((profit + loss) / totalCost * 100) : 0
  };
}

// Портфельная история (BALANCE_HISTORY_KEY) и "известные" символы (KNOWN_SYMBOLS_KEY) раньше
// сохранялись НАВСЕГДА в localStorage без привязки к тому, каким именно API-ключом они были
// накоплены — если пользователь отключал один аккаунт и подключал другой (или просто вводил другой
// ключ поверх старого), график стоимости портфеля и список монет для истории сделок Финреза
// продолжали показывать данные ПРЕДЫДУЩЕГО аккаунта, смешанные с новым. Это прямо противоречит
// требованию "Финрез должен быть 100% точным". Храним короткий отпечаток последнего подключённого
// ключа (не сам ключ второй раз — он уже и так лежит в mexc_api_key открытым текстом) и, если при
// успешном подключении отпечаток не совпадает с сохранённым, считаем это другим аккаунтом и чистим
// то, что реально зависит от конкретного аккаунта, прежде чем что-либо из этого будет использовано.
const ACCOUNT_KEY_FINGERPRINT_KEY = 'mexc_account_key_fingerprint';
function scopeAccountStorageToKey(apiKey) {
  const fingerprint = MexcCore.computeApiKeyFingerprint(apiKey);
  let prev = null;
  try { prev = localStorage.getItem(ACCOUNT_KEY_FINGERPRINT_KEY); } catch (e) { return; }
  if (prev && prev !== fingerprint) {
    logI('Finrez', 'обнаружена смена API-ключа — сбрасываю историю портфеля и список известных символов предыдущего аккаунта');
    try { persistRemove(BALANCE_HISTORY_KEY); } catch (e) {}
    try { persistRemove(KNOWN_SYMBOLS_KEY); } catch (e) {}
    knownSymbols = {};
  }
  try { persistSet(ACCOUNT_KEY_FINGERPRINT_KEY, fingerprint); } catch (e) {}
}

async function connectMexcAccount(silent) {
  const keyEl = document.getElementById('acctApiKey');
  const secEl = document.getElementById('acctApiSecret');
  const key = keyEl.value.trim();
  const secret = secEl.value.trim();
  if (!key || !secret) {
    if (!silent) showModal('Аккаунт', 'Введите и API Key, и Secret Key.');
    return;
  }
  mexcApiKey = key;
  mexcApiSecret = secret;
  setAccountStatus('connecting');
  try {
    const data = await mexcSignedRequest('/api/v3/account', {}, function (stage) {
      setAccountStatus('connecting', stage === 'native'
        ? 'Браузер не ответил, пробуем в обход через curl.exe...'
        : 'Подключение через браузер...');
    });
    accountConnected = true;
    scopeAccountStorageToKey(key);
    persistSet('mexc_api_key', key);
    persistSet('mexc_api_secret', secret);
    renderAccountBalances(data && data.balances);
    setAccountStatus('connected');
    startBalanceAutoRefresh();
    startPrivateDealsStream(); // автообнаружение новых монет для Финреза, см. её комментарий выше
    if (currentCoin) loadMyOrdersForCoin(currentCoin);
  } catch (e) {
    accountConnected = false;
    setAccountStatus('error', e.message);
    if (!silent) showModal('Не удалось подключить аккаунт', e.message);
  }
}

function disconnectMexcAccount() {
  // Порядок важен: accountConnected=false СНАЧАЛА — иначе onclose у privateDealsWs (сработает
  // внутри stopPrivateDealsStream() ниже) увидит ещё "подключено" и сам попробует переподключиться
  // сразу после того, как мы его намеренно закрыли. А сами ключи очищаем ПОСЛЕ stopPrivateDealsStream(),
  // т.к. closeListenKeyBestEffort() внутри нужно подписать ещё действующим mexcApiSecret — иначе
  // DELETE уйдёт с невалидной подписью и MEXC-листенкей провисит лишний час до истечения по таймауту.
  accountConnected = false;
  stopPrivateDealsStream();
  mexcApiKey = '';
  mexcApiSecret = '';
  stopBalanceAutoRefresh();
  persistRemove('mexc_api_key');
  persistRemove('mexc_api_secret');
  document.getElementById('acctApiKey').value = '';
  document.getElementById('acctApiSecret').value = '';
  lastBalanceState = null;
  lastRawBalances = null;
  lastRenderedBalanceTotal = null;
  // Баланс на "Настройки аккаунта" больше не рендерится — только на Финрезе; очищаем его, если
  // страница сейчас видна, чтобы не показывать устаревшие цифры отключённого аккаунта.
  const heroEl = document.getElementById('finresHeroBar');
  if (heroEl) heroEl.innerHTML = '';
  const finresPage = document.getElementById('page-finres');
  if (finresPage && finresPage.classList.contains('active')) renderFinresTab();
  setAccountStatus('disconnected');
  const block = document.getElementById('myOrdersBlock');
  if (block) block.style.display = 'none';
}

// Только для __fakeFinresLogin (ручная проверка дизайна без реального API-ключа) — реальные сетевые
// попытки с пустым секретом просто сыпали бы ошибками HMAC и затирали тестовые данные. В обычной
// работе всегда false, ни на что не влияет.
let __designTestMode = false;

let balanceRefreshInFlight = false;
let balanceRefreshFailStreak = 0;
function refreshAccountBalancesIfConnected() {
  if (__designTestMode) return Promise.resolve();
  if (!accountConnected || balanceRefreshInFlight) return Promise.resolve(); // не копим параллельные запросы, если предыдущий ещё не ответил
  balanceRefreshInFlight = true;
  // return — чтобы вызывающий код (например, кнопка «Обновить» в Финрезе) мог дождаться реального
  // завершения запроса, а не только поставить его в очередь.
  return mexcSignedRequest('/api/v3/account', {}).then(function (data) {
    balanceRefreshFailStreak = 0;
    renderAccountBalances(data && data.balances);
    // Раз соединение с MEXC прямо сейчас реально работает — статус должен это отражать, даже если
    // до этого была временная ошибка (сеть моргнула, MEXC на секунду не ответил и т.п.). Иначе
    // бейдж "Ошибка" мог бы навсегда зависнуть в интерфейсе даже после того, как всё восстановилось.
    setAccountStatus('connected');
  }).catch(function (e) {
    balanceRefreshFailStreak++;
    // Не дёргаем статус в "Ошибка" на каждый одиночный сбой (короткий сетевой сбой раз в 3с —
    // это нормально и само пройдёт). Показываем ошибку только если не получилось несколько раз подряд.
    if (balanceRefreshFailStreak >= 3) setAccountStatus('error', e.message);
    // Не пробрасываем ошибку дальше — этот промис теперь возвращается и другим вызывающим кодом
    // (кнопка «Обновить» в Финрезе), которые не всегда ставят свой .catch(), а сбой обновления баланса
    // уже полностью отражён через setAccountStatus() выше и не должен всплывать необработанным отказом.
  }).finally(function () { balanceRefreshInFlight = false; });
}

// Мои открытые ордера по конкретно выбранной в скринере паре (не запрашиваем по всему рынку —
// на большинстве бирж, включая MEXC, openOrders без символа не предназначен для частых опросов).
async function loadMyOrdersForCoin(coin) {
  const block = document.getElementById('myOrdersBlock');
  const list = document.getElementById('myOrdersList');
  if (!block || !list) return;
  if (!accountConnected || !coin) { block.style.display = 'none'; return; }
  block.style.display = 'block';
  list.textContent = 'Загрузка...';
  const seq = ++acctOrdersReqSeq;
  try {
    const orders = await mexcSignedRequest('/api/v3/openOrders', { symbol: coin.raw });
    if (seq !== acctOrdersReqSeq) return; // пришёл ответ на уже неактуальный выбор монеты
    if (!orders || !orders.length) {
      list.textContent = 'Нет открытых ордеров по ' + coin.symbol + '.';
      return;
    }
    list.innerHTML = orders.map(function (o) {
      const side = String(o.side || '').toUpperCase();
      return '<div class="order-row"><span class="' + (side === 'BUY' ? 'price-up' : 'price-down') + '">' + side + '</span>' +
        '<span>' + fmtPrice(parseFloat(o.price)) + '</span><span>' + parseFloat(o.origQty) + '</span></div>';
    }).join('');
  } catch (e) {
    if (seq !== acctOrdersReqSeq) return;
    list.textContent = 'Не удалось загрузить ордера: ' + e.message;
  }
}

// Диагностика для случаев, когда подключение к аккаунту не работает и непонятно, на каком именно
// этапе (нет ли desktop-обёртки вообще, не связался ли JS с native-бэкендом Neutralino, не блокирует
// ли что-то запуск дочерних процессов). Результат — простой текст, который можно скопировать/
// сфотографировать и прислать для диагностики, без необходимости открывать консоль разработчика.

// Прямая проверка WebSocket в обход клиентской библиотеки Neutralino — нужна, чтобы отличить
// "весь native-мост не работает" от "конкретно резолвинг localhost -> IPv6 ::1 ломает подключение",
// т.к. известен класс багов именно с таким симптомом (см. Mozilla Bugzilla #1769994).
function rawWebSocketProbe(url, timeoutMs) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    let settled = false;
    let ws;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { if (ws) ws.close(); } catch (e) {}
      resolve({ ok: false, ms: Date.now() - t0, error: 'таймаут ' + timeoutMs + 'мс' });
    }, timeoutMs);
    try {
      ws = new WebSocket(url);
      ws.onopen = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        resolve({ ok: true, ms: Date.now() - t0 });
      };
      ws.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, ms: Date.now() - t0, error: 'ошибка соединения' });
      };
      ws.onclose = function (ev) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, ms: Date.now() - t0, error: 'закрыт сразу, code=' + ev.code });
      };
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, ms: Date.now() - t0, error: e.message });
      }
    }
  });
}

async function runDiagnostics() {
  const btn = document.getElementById('acctDiagBtn');
  const out = document.getElementById('acctDiagOutput');
  if (!out) return;
  out.style.display = 'block';
  out.textContent = 'Проверяю...';
  if (btn) btn.disabled = true;
  const lines = [];

  lines.push('window.Neutralino: ' + (window.Neutralino ? 'есть (desktop-режим)' : 'НЕТ (веб-версия в браузере)'));
  lines.push('NL_PORT: ' + (typeof window.NL_PORT !== 'undefined' ? window.NL_PORT : 'не задан'));
  lines.push('NL_TOKEN: ' + (typeof window.NL_TOKEN !== 'undefined' && window.NL_TOKEN ? 'есть (' + String(window.NL_TOKEN).length + ' симв.)' : 'НЕ задан'));
  lines.push('NL_OS: ' + (typeof window.NL_OS !== 'undefined' ? window.NL_OS : '—'));
  lines.push('NL_CVERSION: ' + (typeof window.NL_CVERSION !== 'undefined' ? window.NL_CVERSION : '—'));

  if (typeof window.NL_PORT !== 'undefined') {
    // ВАЖНО: сама библиотека neutralino.js берёт НЕ весь NL_TOKEN целиком, а вторую часть
    // после разбиения по точке (похоже на payload JWT-подобного токена) — см. функцию d() в
    // client-библиотеке: `const e = m().split(".")[1]; ... new WebSocket('ws://'+o+':'+port+'?connectToken='+e)`.
    // Если слать сюда сырой NL_TOKEN целиком (как было раньше), сервер может мгновенно отбрасывать
    // соединение просто из-за неверного формата токена — это выглядит как "блокировка", но ей не является.
    const rawToken = (typeof window.NL_TOKEN !== 'undefined' && window.NL_TOKEN) ? String(window.NL_TOKEN) : '';
    const hasDot = rawToken.indexOf('.') !== -1;
    const properToken = hasDot ? rawToken.split('.')[1] : rawToken;
    lines.push('NL_TOKEN содержит точку (JWT-подобный формат): ' + (rawToken ? (hasDot ? 'да' : 'нет') : 'н/д'));
    const wsToken = properToken ? ('?connectToken=' + encodeURIComponent(properToken)) : '';
    const r127 = await rawWebSocketProbe('ws://127.0.0.1:' + window.NL_PORT + wsToken, 6000);
    lines.push('WebSocket ws://127.0.0.1:' + window.NL_PORT + ' (как настоящий клиент): ' + (r127.ok ? ('OK за ' + r127.ms + 'мс') : ('ОШИБКА за ' + r127.ms + 'мс — ' + r127.error)));
    const rLocalhost = await rawWebSocketProbe('ws://localhost:' + window.NL_PORT + wsToken, 6000);
    lines.push('WebSocket ws://localhost:' + window.NL_PORT + ' (как настоящий клиент): ' + (rLocalhost.ok ? ('OK за ' + rLocalhost.ms + 'мс') : ('ОШИБКА за ' + rLocalhost.ms + 'мс — ' + rLocalhost.error)));
    if (r127.ok && !rLocalhost.ok) {
      lines.push('=> Похоже на резолвинг "localhost" в IPv6 (::1) вместо 127.0.0.1 — нужен фикс с принудительным 127.0.0.1.');
    } else if (!r127.ok && !rLocalhost.ok) {
      lines.push('=> Ни 127.0.0.1, ни localhost не отвечают напрямую по WebSocket даже с правильно сформированным токеном — похоже, что-то перехватывает или блокирует именно WebSocket-рукопожатие на этой машине (антивирус/файрвол с проверкой трафика), при том что обычный TCP/HTTP на этот же порт работает.');
    } else if (r127.ok && rLocalhost.ok) {
      lines.push('=> WebSocket-подключение само по себе работает! Значит проблема не в сети/антивирусе, а где-то дальше — в логике самого приложения (Neutralino.init() или обработке ответов).');
    }
  } else {
    lines.push('WebSocket-проба пропущена: NL_PORT не задан');
  }

  // Штатный клиент Neutralino (Neutralino.app.getConfig и т.п.) — держим для сравнения с
  // собственным мостом ниже: если штатный виснет, а свой мост работает, это подтверждает,
  // что дело в баге тайминга самой библиотеки при старте, а не в системе.
  if (window.Neutralino && Neutralino.app && typeof Neutralino.app.getConfig === 'function') {
    const t0 = Date.now();
    try {
      await withHardTimeout(Neutralino.app.getConfig(), 5000, 'таймаут 5с');
      lines.push('Neutralino.app.getConfig() [штатный клиент]: OK за ' + (Date.now() - t0) + 'мс');
    } catch (e) {
      lines.push('Neutralino.app.getConfig() [штатный клиент]: ОШИБКА за ' + (Date.now() - t0) + 'мс — ' + e.message);
    }
  } else {
    lines.push('Neutralino.app.getConfig [штатный клиент]: недоступен (нет desktop-обёртки)');
  }

  // Собственный мост (nlCall) — тот же протокол, но с реальным (пере)подключением вместо
  // одноразового WebSocket'а штатной библиотеки. Именно он теперь используется во всём
  // приложении вместо Neutralino.os.execCommand()/Neutralino.app.getConfig().
  if (window.Neutralino) {
    const t2 = Date.now();
    try {
      await nlCall('app.getConfig', {}, 6000);
      lines.push('nlCall("app.getConfig") [свой мост]: OK за ' + (Date.now() - t2) + 'мс');
    } catch (e) {
      lines.push('nlCall("app.getConfig") [свой мост]: ОШИБКА за ' + (Date.now() - t2) + 'мс — ' + e.message);
    }
    const t3 = Date.now();
    try {
      const r = await nlCall('os.execCommand', { command: 'cmd.exe /C echo ping', background: false }, 6000);
      lines.push('nlCall("os.execCommand", echo) [свой мост]: OK за ' + (Date.now() - t3) + 'мс, exitCode=' + (r && r.exitCode) + ', вывод=' + JSON.stringify(r && r.stdOut));
      lines.push('=> Свой мост работает — значит запуск процессов (curl.exe для обхода CORS) теперь должен работать. Если "Подключить" всё ещё не работает — дело уже не в native-мосте.');
    } catch (e) {
      lines.push('nlCall("os.execCommand", echo) [свой мост]: ОШИБКА за ' + (Date.now() - t3) + 'мс — ' + e.message);
      lines.push('=> Даже свой мост не смог выполнить команду — вот тут уже похоже на реальную блокировку запуска процессов антивирусом/EDR, а не на баг тайминга.');
    }
  } else {
    lines.push('nlCall [свой мост]: недоступен (нет desktop-обёртки)');
  }

  out.textContent = lines.join('\n');
  if (btn) btn.disabled = false;
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================

document.querySelectorAll('.nav-item').forEach(function (item) {
  item.addEventListener('click', function (e) {
    e.preventDefault();
    if (this.dataset.action === 'download-app') { downloadDesktopApp(); return; }
    switchPage(this.dataset.page);
  });
});

document.getElementById('collapseBtn').addEventListener('click', function () {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', sidebarCollapsed);
  document.querySelector('#collapseBtn i').className = sidebarCollapsed ? 'ri-arrow-right-s-line' : 'ri-arrow-left-s-line';
});

document.getElementById('themeToggle').addEventListener('click', function () {
  darkTheme = !darkTheme;
  document.getElementById('themeSwitch').classList.toggle('active', darkTheme);
  if (!darkTheme) {
    document.documentElement.style.setProperty('--bg-primary', '#F4F5F7');
    document.documentElement.style.setProperty('--bg-secondary', '#FFFFFF');
    document.documentElement.style.setProperty('--bg-card', '#FFFFFF');
    document.documentElement.style.setProperty('--bg-hover', '#EEF0F3');
    document.documentElement.style.setProperty('--border-color', '#E3E6EA');
    document.documentElement.style.setProperty('--text-primary', '#111');
    document.documentElement.style.setProperty('--text-secondary', '#555');
    document.documentElement.style.setProperty('--text-muted', '#888');
  } else {
    document.documentElement.style.setProperty('--bg-primary', '#0B0E11');
    document.documentElement.style.setProperty('--bg-secondary', '#11161C');
    document.documentElement.style.setProperty('--bg-card', '#1A2028');
    document.documentElement.style.setProperty('--bg-hover', '#252B33');
    document.documentElement.style.setProperty('--border-color', '#2B3139');
    document.documentElement.style.setProperty('--text-primary', '#EAECEF');
    document.documentElement.style.setProperty('--text-secondary', '#848E9C');
    document.documentElement.style.setProperty('--text-muted', '#5E6673');
  }
  if (currentCoin) loadExchangeChart(currentCoin.symbol, currentTF);
});

document.getElementById('langToggle').addEventListener('click', function () {
  const span = this.querySelector('span');
  span.textContent = span.textContent === 'RU' ? 'EN' : 'RU';
});

document.getElementById('resetFilters').addEventListener('click', function () {
  document.getElementById('profileSelect').value = 'balanced';
  applyProfile('balanced');
});

document.getElementById('applyFilters').addEventListener('click', function () {
  renderTable();
  const filteredCount = getFilteredCoins().length;
  const vis = Math.min(filteredCount, maxPairs);
  let text = 'Прошли фильтр: ' + filteredCount + ' из ' + allCoins.length + ' пар MEXC.';
  if (filteredCount > vis) {
    text += ' В таблице показаны первые ' + vis + ' (лимит "Максимум пар в таблице" в Настройках) — увеличьте лимит, чтобы видеть остальные.';
  }
  showModal('Фильтры', text);
});

document.getElementById('refreshData').addEventListener('click', function () {
  // Принудительно переподключаем WebSocket
  if (ws) {
    try { ws.close(); } catch(e) {}
    ws = null;
  }
  connectWs();
  showModal('Обновление', 'Переподключение к WebSocket MEXC...');
});

['filterVol24', 'filterVol5', 'filterVol5s', 'filterVol30s', 'filterChg', 'filterPriceFrom', 'filterPriceTo',
  'filterVol24Op', 'filterVol5Op', 'filterVol5sOp', 'filterVol30sOp', 'filterChgOp'].forEach(function (id) {
  document.getElementById(id).addEventListener('input', function () {
    if (document.getElementById('liveFilters').checked) renderTable();
  });
  document.getElementById(id).addEventListener('change', function () {
    if (document.getElementById('liveFilters').checked) renderTable();
  });
});

document.getElementById('saveSettings').addEventListener('click', function () {
  updateIntervalMs = parseInt(document.getElementById('updateInterval').value, 10) * 1000;
  maxPairs = parseInt(document.getElementById('maxPairs').value, 10) || 400;
  restartAnalyticsInterval();
  renderTable();
  showModal('Настройки', 'Сохранено. Цены и объёмы обновляются в реальном времени через WebSocket, интервал ниже применяется к аналитике и оповещениям.');
});

document.getElementById('clearData').addEventListener('click', function () {
  allCoins.forEach(function (c) { c.fav = false; });
  updateFavoritesPage();
  renderTable();
});

document.getElementById('viewList').addEventListener('click', function () {
  viewMode = 'list';
  this.classList.add('active');
  document.getElementById('viewGrid').classList.remove('active');
  document.getElementById('screenerContent').classList.remove('grid-mode');
});

document.getElementById('viewGrid').addEventListener('click', function () {
  viewMode = 'grid';
  this.classList.add('active');
  document.getElementById('viewList').classList.remove('active');
  document.getElementById('screenerContent').classList.add('grid-mode');
});

document.getElementById('profileSelect').addEventListener('change', function () {
  applyProfile(this.value);
});

document.querySelectorAll('.profile-strategy-card[data-profile]').forEach(function (card) {
  card.addEventListener('click', function () {
    const name = this.dataset.profile;
    document.getElementById('profileSelect').value = name;
    applyProfile(name);
    switchPage('screener');
  });
});

document.querySelectorAll('.profile-nav-pill[data-scroll-to]').forEach(function (pill) {
  pill.addEventListener('click', function () {
    const target = document.getElementById(this.dataset.scrollTo);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

document.querySelectorAll('.tf-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tf-btn').forEach(function (b) { b.classList.remove('active'); });
    this.classList.add('active');
    currentTF = this.dataset.tf;
    if (currentCoin) loadExchangeChart(currentCoin.symbol, currentTF);
  });
});

document.getElementById('toggleOwnChartBtn').addEventListener('click', function () {
  if (!currentCoin) return;
  const symbol = currentCoin.symbol;
  const nowOwn = ownChartModeMemory[symbol] === 'own';
  rememberChartMode(symbol, nowOwn ? 'tv' : 'own');
  loadExchangeChart(symbol, currentTF);
});

document.querySelectorAll('#coinTable th[data-sort]').forEach(function (th) {
  th.addEventListener('click', function () { sortCoins(this.dataset.sort); });
});

const copyForVatagaBtnEl = document.getElementById('copyForVatagaBtn');
if (copyForVatagaBtnEl) {
  copyForVatagaBtnEl.addEventListener('click', function () {
    if (currentCoin) copySymbolForVataga(currentCoin.symbol);
  });
}

document.querySelectorAll('.ochart-tool[data-tool]').forEach(function (btn) {
  btn.addEventListener('click', function () { setOwnChartTool(btn.getAttribute('data-tool')); });
});
const ochartClearBtnEl = document.getElementById('ochartClear');
if (ochartClearBtnEl) {
  ochartClearBtnEl.addEventListener('click', function () {
    if (!currentCoin) return;
    ownChartDrawings = [];
    saveOwnChartDrawings(currentCoin.raw, ownChartDrawings);
    if (ownChartCandles) drawCandleChart(document.getElementById('ownCandleChart'), ownChartCandles);
    showAppToast('Все построения на графике очищены');
  });
}
const ochartResetViewBtnEl = document.getElementById('ochartResetView');
if (ochartResetViewBtnEl) {
  ochartResetViewBtnEl.addEventListener('click', function () {
    ownChartView = { offset: 0, visibleCount: 140 };
    if (ownChartCandles) drawCandleChart(document.getElementById('ownCandleChart'), ownChartCandles);
  });
}
document.querySelectorAll('.ochart-tool[data-charttype]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    ownChartType = btn.getAttribute('data-charttype');
    document.querySelectorAll('.ochart-tool[data-charttype]').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    if (ownChartCandles) drawCandleChart(document.getElementById('ownCandleChart'), ownChartCandles);
  });
});
const ochartMaToggleEl = document.getElementById('ochartMaToggle');
if (ochartMaToggleEl) {
  ochartMaToggleEl.addEventListener('click', function () {
    ownChartShowMA = !ownChartShowMA;
    ochartMaToggleEl.classList.toggle('active', ownChartShowMA);
    if (ownChartCandles) drawCandleChart(document.getElementById('ownCandleChart'), ownChartCandles);
  });
}
const ochartLiveBtnEl = document.getElementById('ochartLiveBtn');
if (ochartLiveBtnEl) {
  ochartLiveBtnEl.addEventListener('click', function () {
    ownChartView.offset = 0;
    if (ownChartCandles) drawCandleChart(document.getElementById('ownCandleChart'), ownChartCandles);
  });
}
updateOchartHint();

// Canvas-графики (донат баланса, PnL, свой канделстик) сами не перерисовываются при ресайзе окна —
// CSS меняет их видимый размер, но растровое содержимое остаётся прежним, пока кто-то явно не
// перерисует. Один общий debounced-обработчик на весь window.resize.
let resizeRedrawTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(resizeRedrawTimer);
  resizeRedrawTimer = setTimeout(function () {
    const finresPageEl = document.getElementById('page-finres');
    const finresActive = finresPageEl && finresPageEl.classList.contains('active');
    if (lastBalanceState && finresActive) {
      updateFinresHeroPeriodView();
      if (finresTab === 'assets') {
        const donutCanvas = document.getElementById('finresAssetsDonut');
        if (donutCanvas && lastBalanceState.donutSegments) drawDonutChart(donutCanvas, lastBalanceState.donutSegments);
      }
    }
    if (ownChartCandles) {
      const ownCanvas = document.getElementById('ownCandleChart');
      if (ownCanvas) drawCandleChart(ownCanvas, ownChartCandles);
    }
    if (journalChartState && document.getElementById('journalModal').classList.contains('active')) {
      drawJournalChart(document.getElementById('journalChartCanvas'), journalChartState.candles);
    }
  }, 180);
});

// Открывает модалку "Журнал сделок" для одной монеты из баланса: тянет реальную историю сделок
// (подписанный /api/v3/myTrades) + свечи под неё и рисует BUY/SELL точки прямо на графике.
// Список закрытых ПОЗИЦИЙ (а не отдельных BUY/SELL-филлов) справа от графика — по образцу
// tradermake.money: клик по строке выбирает эту позицию (journalChartState.selectedPairIndex),
// график перерисовывается и центрируется на ней (см. centerJournalViewOnPair). Вынесено отдельно от
// openJournalForAsset, чтобы им же пользовался "живой" автообновляющий тик (startJournalLiveRefresh).
function renderJournalTradesList(pairs) {
  const listEl = document.getElementById('journalTradesList');
  if (!listEl) return;
  if (!pairs || !pairs.length) {
    listEl.innerHTML = '<div class="finres-empty" style="padding:20px"><i class="ri-inbox-line"></i>Пока нет ни одной закрытой позиции — только открытые входы без выхода здесь не показываются.</div>';
    return;
  }
  const selIndex = journalChartState ? journalChartState.selectedPairIndex : -1;
  listEl.innerHTML = pairs.map(function (p, idx) { return { p: p, idx: idx }; }).slice().reverse().map(function (item, i) {
    const p = item.p, realIndex = item.idx;
    const win = p.pnl >= 0;
    const cls = win ? 'buy' : 'sell';
    const d = new Date(p.exitTime);
    const timeStr = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return '<div class="journal-trade-row ' + cls + (realIndex === selIndex ? ' active' : '') + '" data-pair-index="' + realIndex + '" style="--row-i:' + Math.min(i, 20) + '">' +
      '<div><span class="journal-trade-side ' + cls + '"><i class="ri-arrow-' + (win ? 'up' : 'down') + '-line"></i>' + fmtPrice(p.entryPrice) + ' → ' + fmtPrice(p.exitPrice) + '</span>' +
      '<div class="journal-trade-time">' + timeStr + '</div></div>' +
      '<div style="text-align:right"><div class="' + cls + '">' + (win ? '+' : '') + p.pnlPct.toFixed(2) + '%</div><div class="journal-trade-time">' + fmtUsd(Math.abs(p.pnl)) + '</div></div>' +
      '</div>';
  }).join('');
}

// Клик по строке в списке — выбрать эту позицию для отображения на графике. Вешается один раз на
// статичный контейнер #journalTradesList (idempotent) — сами строки внутри пересоздаются при каждом
// рендере (renderJournalTradesList), навешивать заново незачем.
let journalTradesListWired = false;
function wireJournalTradesListClick() {
  if (journalTradesListWired) return;
  journalTradesListWired = true;
  const listEl = document.getElementById('journalTradesList');
  if (!listEl) return;
  listEl.addEventListener('click', function (e) {
    const row = e.target.closest('.journal-trade-row[data-pair-index]');
    if (!row || !journalChartState) return;
    const idx = parseInt(row.dataset.pairIndex, 10);
    const pair = journalChartState.pairs[idx];
    if (!pair) return;
    journalChartState.selectedPairIndex = idx;
    journalChartState.view = centerJournalViewOnPair(journalChartState.candles, pair);
    const canvas = document.getElementById('journalChartCanvas');
    if (canvas) drawJournalChart(canvas, journalChartState.candles);
    renderJournalTradesList(journalChartState.pairs);
  });
}

// Строит окно зума/пана так, чтобы выбранная позиция (вход→выход) была видна целиком с разумным
// запасом по бокам — а не "покажем всю историю и потеряемся в тысяче свечей" и не "покажем впритык
// без контекста". pad — примерно 80% от длительности самой позиции с каждой стороны, но не меньше
// 10 свечей — для очень короткой скальп-сделки (вход/выход на одной-двух соседних свечах) иначе
// получилось бы окно из 2-3 свечей, нечитаемо.
function centerJournalViewOnPair(candles, pair) {
  if (!candles || !candles.length || !pair) return null;
  const n = candles.length;
  const intervalMs = n > 1 ? (candles[1].t - candles[0].t) : 60000;
  let entryIdx = Math.floor((pair.entryTime - candles[0].t) / intervalMs);
  let exitIdx = Math.floor((pair.exitTime - candles[0].t) / intervalMs);
  entryIdx = Math.max(0, Math.min(n - 1, entryIdx));
  exitIdx = Math.max(0, Math.min(n - 1, exitIdx));
  const lo = Math.min(entryIdx, exitIdx), hi = Math.max(entryIdx, exitIdx);
  const pad = Math.max(10, Math.round((hi - lo) * 0.8));
  const startIdx = Math.max(0, lo - pad);
  const endIdx = Math.min(n, hi + pad + 1);
  const visibleCount = Math.max(6, Math.min(n, endIdx - startIdx));
  const offset = Math.max(0, n - endIdx);
  return { visibleCount: visibleCount, offset: offset };
}

// Кнопки таймфрейма в шапке модалки журнала — по фидбегу "сделай таймфрейм": до этого график сам
// подбирал ОДИН таймфрейм под диапазон истории (pickJournalTf) без возможности переключить руками.
// '1' здесь и далее — те же короткие коды, что уже использует основной график приложения (см.
// mexcKlineInterval/currentTF) — 1м/5м/15м/1ч/4ч/1д. "1s" в списке нет: у MEXC REST klines нет
// секундного таймфрейма вообще, показывать кнопку, которая ничего не может отдать, было бы нечестно.
const JOURNAL_TF_OPTIONS = [
  { key: '1', label: '1м' }, { key: '5', label: '5м' }, { key: '15', label: '15м' },
  { key: '60', label: '1ч' }, { key: '240', label: '4ч' }, { key: 'D', label: '1д' }
];
function renderJournalTfPills() {
  const el = document.getElementById('journalTfPills');
  if (!el || !journalChartState) return;
  el.innerHTML = JOURNAL_TF_OPTIONS.map(function (o) {
    return '<button type="button" class="journal-tf-pill' + (o.key === journalChartState.tf ? ' active' : '') + '" data-tf="' + o.key + '">' + o.label + '</button>';
  }).join('');
}
let journalTfPillsWired = false;
function wireJournalTfPills() {
  if (journalTfPillsWired) return;
  journalTfPillsWired = true;
  const el = document.getElementById('journalTfPills');
  if (!el) return;
  el.addEventListener('click', async function (e) {
    const btn = e.target.closest('.journal-tf-pill[data-tf]');
    if (!btn || !journalChartState) return;
    const tf = btn.dataset.tf;
    if (tf === journalChartState.tf) return;
    const prevTf = journalChartState.tf;
    journalChartState.tf = tf; // выставляем сразу — кнопка не должна "залипать" на старом ТФ, пока грузится
    renderJournalTfPills();
    try {
      const candles = await fetchKlines(journalChartState.raw, tf, 1000);
      if (!candles.length || !journalChartState) return;
      journalChartState.candles = candles;
      const selPair = journalChartState.pairs[journalChartState.selectedPairIndex];
      journalChartState.view = selPair ? centerJournalViewOnPair(candles, selPair) : null;
      const canvas = document.getElementById('journalChartCanvas');
      if (canvas) drawJournalChart(canvas, candles);
    } catch (err) {
      journalChartState.tf = prevTf; // откатываем выбор — новый ТФ реально не загрузился
      renderJournalTfPills();
      logW('Journal', 'не удалось переключить таймфрейм на ' + tf + ': ' + err.message);
    }
  });
}

// "График должен быть живой и двигаться" — периодически (не через WS, REST klines/myTrades того же
// пути, что и первая загрузка) подтягивает свежие свечи и сделки, пока модалка открыта, и
// перерисовывает график/список. Если пользователь смотрел на ПОСЛЕДНЮЮ позицию (обычный случай —
// только что открыл журнал) и появилась новая закрытая сделка, выбор переезжает на неё — то самое
// "живое" ощущение, ради которого вообще затевалось автообновление. Если же выбрана какая-то
// СТАРАЯ позиция (пользователь сам кликнул по ней в списке) — выбор остаётся на месте, чтобы не
// вырывать её из-под курса, пока разбираешься именно в ней.
let journalRefreshTimer = null;
function startJournalLiveRefresh(asset, raw) {
  stopJournalLiveRefresh();
  journalRefreshTimer = setInterval(async function () {
    const overlay = document.getElementById('journalModal');
    if (!overlay || !overlay.classList.contains('active') || !journalChartState) { stopJournalLiveRefresh(); return; }
    try {
      const trades = await fetchMyTrades(raw, 500);
      if (!trades.length) return;
      // Если пользователь сам выбрал таймфрейм кнопкой в шапке (journalTfPills) — уважаем его выбор
      // и на "живых" тиках тоже, а не тихо подменяем автоподобранным на каждое обновление.
      const backMs = Date.now() - trades[0].time;
      const tf = journalChartState.tf || pickJournalTf(backMs);
      const candles = await fetchKlines(raw, tf, 1000);
      if (!candles.length || !journalChartState) return;
      const pairs = computeTradePairsForChart(trades);
      const wasOnLatest = journalChartState.pairs && journalChartState.selectedPairIndex === journalChartState.pairs.length - 1;
      journalChartState.candles = candles;
      journalChartState.trades = trades;
      journalChartState.pairs = pairs;
      if (wasOnLatest || journalChartState.selectedPairIndex >= pairs.length) {
        journalChartState.selectedPairIndex = pairs.length - 1;
        journalChartState.view = pairs.length ? centerJournalViewOnPair(candles, pairs[pairs.length - 1]) : null;
      }
      const canvas = document.getElementById('journalChartCanvas');
      if (canvas) drawJournalChart(canvas, candles);
      renderJournalTradesList(pairs);
    } catch (e) {
      // Тихо пропускаем — уже показанные график/список остаются на месте, следующий тик попробует
      // снова; не хотим перекрывать рабочую модалку баннером ошибки из-за одного неудачного тика.
      logD('Journal', asset + ': живое обновление не удалось (' + e.message + '), пробуем на следующем тике');
    }
  }, 8000);
}
function stopJournalLiveRefresh() {
  if (journalRefreshTimer) { clearInterval(journalRefreshTimer); journalRefreshTimer = null; }
}

async function openJournalForAsset(asset, raw) {
  const overlay = document.getElementById('journalModal');
  const titleEl = document.getElementById('journalModalTitle');
  const emptyEl = document.getElementById('journalChartEmpty');
  const listEl = document.getElementById('journalTradesList');
  const canvas = document.getElementById('journalChartCanvas');
  const tfPillsEl = document.getElementById('journalTfPills');
  if (!overlay || !canvas) return;

  journalChartState = null;
  stopJournalLiveRefresh();
  overlay.classList.add('active');
  titleEl.innerHTML = '<i class="ri-file-list-3-line"></i> ' + asset + '/USDT — журнал сделок';
  listEl.innerHTML = '';
  if (tfPillsEl) tfPillsEl.innerHTML = '';
  const ctx2d = canvas.getContext('2d');
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  emptyEl.style.display = 'flex';
  emptyEl.innerHTML = '<i class="ri-loader-4-line spin-icon"></i> Загрузка истории сделок...';

  try {
    const trades = await fetchMyTrades(raw, 500);
    if (!trades.length) {
      emptyEl.innerHTML = '<i class="ri-inbox-line"></i> Сделок по ' + asset + '/USDT не найдено в истории, которую отдаёт API MEXC.';
      return;
    }
    const pairs = computeTradePairsForChart(trades);
    if (!pairs.length) {
      emptyEl.innerHTML = '<i class="ri-inbox-line"></i> По ' + asset + '/USDT есть только открытая позиция без выхода — здесь показываются закрытые сделки.';
      return;
    }
    emptyEl.innerHTML = '<i class="ri-loader-4-line spin-icon"></i> Загрузка графика...';
    const backMs = Date.now() - trades[0].time;
    const tf = pickJournalTf(backMs);
    const candles = await fetchKlines(raw, tf, 1000);
    if (!candles.length) {
      emptyEl.innerHTML = '<i class="ri-error-warning-line"></i> Не удалось загрузить свечи для графика.';
      return;
    }
    emptyEl.style.display = 'none';
    const selectedPairIndex = pairs.length - 1; // по умолчанию — самая свежая закрытая сделка
    journalChartState = {
      asset: asset, raw: raw, tf: tf, candles: candles, trades: trades, pairs: pairs,
      selectedPairIndex: selectedPairIndex, view: centerJournalViewOnPair(candles, pairs[selectedPairIndex])
    };
    wireJournalChartInteractions(canvas);
    wireJournalTradesListClick();
    wireJournalTfPills();
    drawJournalChart(canvas, candles);
    renderJournalTradesList(pairs);
    renderJournalTfPills();
    startJournalLiveRefresh(asset, raw);
  } catch (e) {
    emptyEl.style.display = 'flex';
    emptyEl.innerHTML = '<i class="ri-error-warning-line"></i> ' + (e.message || 'Ошибка загрузки сделок');
  }
}

function closeJournalModal() {
  document.getElementById('journalModal').classList.remove('active');
  stopJournalLiveRefresh();
  journalChartState = null;
}
document.getElementById('journalModalClose').addEventListener('click', closeJournalModal);
document.getElementById('journalModal').addEventListener('click', function (e) {
  if (e.target === this) closeJournalModal();
});
document.getElementById('finresContent').addEventListener('click', function (e) {
  const chip = e.target.closest('.journal-chip');
  if (!chip) return;
  openJournalForAsset(chip.dataset.asset, chip.dataset.raw);
});

document.getElementById('addFav').addEventListener('click', function () {
  if (!currentCoin) return;
  currentCoin.fav = !currentCoin.fav;
  updateFavButton();
  renderTable();
  updateFavoritesPage();
});

document.getElementById('searchInput').addEventListener('input', function (e) {
  searchQuery = e.target.value.trim();
  renderTable();
});

document.getElementById('settingsBtn').addEventListener('click', function () { switchPage('settings'); });

document.getElementById('modalBtn').addEventListener('click', function () {
  document.getElementById('modal').classList.remove('active');
});

document.getElementById('modal').addEventListener('click', function (e) {
  if (e.target === this) this.classList.remove('active');
});

function updateClock() {
  const t = new Date().toTimeString().slice(0, 8);
  document.getElementById('clock').textContent = t;
  document.getElementById('serverTime').textContent = t;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor(elapsed % 3600 / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  document.getElementById('metricUptime').textContent = h + ':' + m + ':' + s;
  // Если отметка "Обновлено ЧЧ:ММ:СС" в Финрезе не двигалась дольше 20с (при норме ~3с) — подсвечиваем
  // её оранжевым: явный визуальный сигнал "автообновление где-то застряло", а не молчаливо старые цифры.
  if (accountConnected && finresLastUpdatedAt) {
    const staleEl = document.getElementById('finresLastUpdated');
    if (staleEl) staleEl.classList.toggle('stale', (Date.now() - finresLastUpdatedAt) > 20000);
  }
}

// Обновление аналитики и оповещений с периодом из настроек ("Автообновление", по умолчанию 10с)
function restartAnalyticsInterval() {
  if (updateIntervalId) clearInterval(updateIntervalId);
  updateIntervalId = setInterval(function () {
    updateAnalytics();
    updateAlerts();
  }, updateIntervalMs);
}

// Аккаунт MEXC: кнопки подключения, показ/скрытие секрета, автоподключение при сохранённых ключах
document.getElementById('acctConnectBtn').addEventListener('click', function () { connectMexcAccount(false); });
document.getElementById('acctDiagBtn').addEventListener('click', runDiagnostics);
document.getElementById('acctDisconnectBtn').addEventListener('click', disconnectMexcAccount);
document.getElementById('acctGoFinresBtn').addEventListener('click', function () { switchPage('finres'); });
if (!window.Neutralino) {
  const note = document.getElementById('acctWebOnlyNote');
  if (note) note.style.display = 'flex';
}
document.getElementById('acctToggleEye').addEventListener('click', function () {
  const input = document.getElementById('acctApiSecret');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  this.className = showing ? 'ri-eye-line acct-toggle-eye' : 'ri-eye-off-line acct-toggle-eye';
});
// Именованная функция (не разовый try-блок) — её же повторно вызывает hydrateFromNativeStorageIfNeeded
// ниже, если ключи не нашлись локально при первом старте, но нашлись в резервном Neutralino.storage.
function restoreSavedApiKeyAndConnect() {
  try {
    const savedKey = localStorage.getItem('mexc_api_key');
    const savedSecret = localStorage.getItem('mexc_api_secret');
    if (savedKey && savedSecret && !accountConnected) {
      document.getElementById('acctApiKey').value = savedKey;
      document.getElementById('acctApiSecret').value = savedSecret;
      connectMexcAccount(true);
      return true;
    }
  } catch (e) { /* localStorage недоступен (например, приватный режим) — просто не автоподключаемся */ }
  return false;
}
restoreSavedApiKeyAndConnect();

// Восстановление из резервного Neutralino.storage (только desktop-обёртка) — см. комментарий у
// persistSet/nlStorageGet выше. Срабатывает только если localStorage-профиль сейчас пуст по
// конкретному ключу; если данные уже есть локально, вообще не трогает сеть/native-мост. Намеренно
// НЕ блокирует старт приложения (fire-and-forget, вызывается уже после connectWs() ниже) — если
// native-мост не готов/недоступен, приложение просто продолжает работать как обычно, без "теневой"
// копии, точно как до этой функции.
const NATIVE_STORAGE_HYDRATE_KEYS = [
  'mexc_api_key', 'mexc_api_secret', ACCOUNT_KEY_FINGERPRINT_KEY,
  BALANCE_HISTORY_KEY, KNOWN_SYMBOLS_KEY,
  CHART_MODE_KEY, OWN_CHART_DRAWINGS_KEY, PATTERN_HISTORY_KEY, DETECTOR_ENABLED_KEY, 'mexc_hide_dust'
];
async function hydrateFromNativeStorageIfNeeded() {
  if (!window.Neutralino) return; // веб-версия: один и тот же origin/профиль браузера, восстанавливать нечего
  let hydratedApiKey = false;
  let hydratedAccountState = false;
  for (let i = 0; i < NATIVE_STORAGE_HYDRATE_KEYS.length; i++) {
    const key = NATIVE_STORAGE_HYDRATE_KEYS[i];
    let local;
    try { local = localStorage.getItem(key); } catch (e) { local = null; }
    if (local) continue; // уже есть локально — резервная копия не нужна
    const remote = await nlStorageGet(key);
    if (remote == null) continue; // и в резервном хранилище пусто — действительно восстанавливать нечего
    try { localStorage.setItem(key, remote); } catch (e) { continue; }
    if (key === 'mexc_api_key' || key === 'mexc_api_secret') hydratedApiKey = true;
    if (key === BALANCE_HISTORY_KEY || key === KNOWN_SYMBOLS_KEY) hydratedAccountState = true;
    if (key === KNOWN_SYMBOLS_KEY) loadKnownSymbols(); // перечитать в уже загруженный в память объект
  }
  if (!hydratedApiKey && !hydratedAccountState) return;
  logI('Storage', 'локальный профиль браузера был пуст — восстановлены данные из резервного хранилища Neutralino (переживает пересборку .exe)');
  if (hydratedApiKey) {
    restoreSavedApiKeyAndConnect();
  } else if (hydratedAccountState && finresTab) {
    renderFinresTab();
    renderFinresHero();
  }
}
// Небольшая задержка перед первой попыткой — тот же самый задокументированный у nlCall баг тайминга
// старта (внутренний WS-сервер Neutralino может быть ещё не полностью поднят в первые секунды).
setTimeout(function () {
  hydrateFromNativeStorageIfNeeded().catch(function (e) {
    logW('Storage', 'восстановление из резервного хранилища не удалось: ' + e.message);
  });
}, 3000);

// Запуск
applyProfile('balanced');
if (!ProtoWrapper) {
  // protobufjs не загрузился (нет сети/заблокирован CDN) — без него бинарные данные MEXC не разобрать.
  setStatus('off', 'Ошибка: не загрузился protobufjs (CDN)');
  showModal('Ошибка загрузки', 'Не удалось загрузить библиотеку protobufjs с CDN (cdn.jsdelivr.net). ' +
    'MEXC отдаёт рыночные данные в формате Protobuf, поэтому без этой библиотеки скринер не сможет ' +
    'разобрать поток и таблица останется пустой. Проверьте подключение к интернету и перезагрузите страницу.');
} else {
  connectWs();
}
updateClock();
restartAnalyticsInterval();

// Обновление часов
setInterval(updateClock, 1000);

// Диагностика Tier 2 (watchlist) из консоли разработчика, пока для этого нет отдельной панели в UI
// (этап 7 плана) — window.__tier2Health.watchlistSize / .tradesIngested и т.д., а также
// window.__tier2Watchlist() для списка монет прямо сейчас в глубоком анализе.
window.__tier2Health = tier2Health;
window.__tier2Watchlist = function () { return Array.from(watchlist.keys()); };
window.__tier2TradesFor = function (symbol) { return tier2Trades.get(symbol) || []; };
window.__tier2DepthFor = function (symbol) { return tier2Depth.get(symbol) || []; };
window.__patternEvents = function () { return activePatternEvents.map(function (ev) { return Object.assign({ explanation: explainPatternEvent(ev) }, ev); }); };
window.__patternHistory = function () { return patternHistory; };
window.__sweepPatternOutcomesNow = sweepPatternOutcomes;
// Только для ручной проверки UI страницы "Паттерны" без ожидания реальных срабатываний детекторов
// (например, в песочнице разработки, где живая лента сделок недоступна) — впрыскивает синтетическое
// событие прямо в витрину. НЕ вызывается production-кодом.
window.__injectFakePatternEvent = function (partial) {
  const ev = Object.assign({
    symbol: 'TEST/USDT', detectorKey: 'repeatSize', direction: 'LONG',
    confidencePct: 78, repeatCount: 12, sizeRangeUsd: [190, 210], volumeUsd: 2400,
    detectedAt: Date.now(), factors: {}
  }, partial || {});
  activePatternEvents = [ev].concat(activePatternEvents);
  updatePatternsPage();
  return ev;
};

window.__tableHoverFreeze = function () { return tableHoverFreezeSymbol; };

// Диагностика "Финрез не показывает историю сделок" из консоли разработчика — без этого хука
// внутреннее состояние (knownSymbols, lastBalanceState и т.д.) недоступно снаружи, т.к. весь app.js
// выполняется в одном top-level IIFE. Показывает: какие именно монеты сейчас в балансе, что именно
// "запомнено" как когда-либо торговавшееся (knownSymbols — переживает продажу в ноль, но НЕ появляется
// само по себе, если монету никогда не искали вручную на вкладке "Сделки" и её сейчас нет в балансе),
// и, самое главное, какой РЕАЛЬНЫЙ ответ MEXC получен по каждому запрошенному символу — сколько
// сделок и была ли ошибка (например "Invalid symbol" — валюта на споте под таким тикером не торгуется).
window.__finresDebug = async function () {
  const data = await finresLoadRealizedCore();
  const raw = lastRawBalances || [];
  const zeroBalanceAssets = raw.filter(function (b) { return !(parseFloat(b.free) > 0 || parseFloat(b.locked) > 0); }).map(function (b) { return b.asset; });
  return {
    priced: (lastBalanceState && lastBalanceState.priced || []).map(function (r) { return { asset: r.asset, usdtValue: r.usdtValue }; }),
    knownSymbols: knownSymbols,
    totalRealizedTrades: data.trades.length,
    tradesPerSymbol: Object.keys(data.bySymbol).reduce(function (acc, k) { acc[k] = data.bySymbol[k].length; return acc; }, {}),
    error: data.error,
    // Если MEXC вообще присылает в /api/v3/account строки с нулевым балансом (не только текущий
    // ненулевой остаток) — это способ автоматически обнаружить ВСЕ когда-либо торговавшиеся монеты
    // без ручного поиска. Пусто/мало строк здесь = MEXC не даёт такой список, придётся оставаться
    // на текущей схеме (баланс + вручную найденное). Много строк (сотни-тысячи) = вероятно фиксированный
    // список ВСЕХ активов биржи, а не только "тронутых" этим аккаунтом — тоже бесполезно напрямую.
    rawBalancesTotal: raw.length,
    zeroBalanceAssetsCount: zeroBalanceAssets.length,
    zeroBalanceAssetsSample: zeroBalanceAssets.slice(0, 30)
  };
};

// Ручная проверка резервного хранилища (см. persistSet/nlStorageGet/hydrateFromNativeStorageIfNeeded
// выше) из консоли разработчика desktop-приложения, не дожидаясь реальной пересборки .exe:
// await __nativeStorageSelfTest() — пишет тестовое значение через native-мост, тут же читает его
// обратно и сравнивает. Возвращает {ok:true} либо {ok:false, error}. В веб-версии (нет window.Neutralino)
// сразу возвращает {ok:false, error:'нет desktop-обёртки'} — это ожидаемо, не баг.
window.__nativeStorageSelfTest = async function () {
  if (!window.Neutralino) return { ok: false, error: 'нет desktop-обёртки (window.Neutralino отсутствует) — это ожидаемо в браузере' };
  const probeKey = '__mexc_storage_selftest';
  const probeVal = 'ok-' + Date.now();
  try {
    await nlCall('storage.setData', { key: probeKey, data: probeVal }, 8000);
    const readBack = await nlCall('storage.getData', { key: probeKey }, 8000);
    await nlCall('storage.setData', { key: probeKey, data: '' }, 8000); // подчищаем за собой
    if (readBack !== probeVal) return { ok: false, error: 'записали "' + probeVal + '", прочитали обратно "' + readBack + '"' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// Только для ручной проверки дизайна страницы «Финрез» без реального подключённого аккаунта (нет
// смысла просить настоящий API-ключ ради вёрстки) — подставляет правдоподобные тестовые баланс и
// историю сделок (по РЕАЛЬНЫМ живым ценам монет, которые уже есть в coinMap) и переключает на
// страницу «Финрез». НЕ вызывается production-кодом, ничего не сохраняет между сессиями.
window.__fakeFinresLogin = function () {
  __designTestMode = true;
  accountConnected = true;
  setAccountStatus('connected');

  const assets = [
    { asset: 'BTC', qty: 0.15 }, { asset: 'ETH', qty: 2.4 }, { asset: 'SOL', qty: 18 },
    { asset: 'XRP', qty: 500 }, { asset: 'DOGE', qty: 12000 }, { asset: 'USDT', qty: 850 }
  ];
  renderAccountBalances(assets.map(function (a) { return { asset: a.asset, free: String(a.qty), locked: '0' }; }));

  if (lastBalanceState) {
    const now = Date.now();
    const hist = [];
    let v = lastBalanceState.total * 0.82;
    for (let i = 30; i >= 1; i--) {
      v *= (1 + (Math.random() - 0.45) * 0.03);
      hist.push({ t: now - i * 24 * 3600 * 1000, v: Math.max(v, 100), a: {} });
    }
    hist.push({ t: now, v: lastBalanceState.total, a: {} });
    lastBalanceState.hist = hist;
  }

  const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
  const trades = [];
  const now2 = Date.now();
  for (let i = 0; i < 140; i++) {
    const daysAgo = Math.floor(Math.random() * 60);
    const t = now2 - daysAgo * 24 * 3600 * 1000 - Math.floor(Math.random() * 24 * 3600 * 1000);
    const asset = symbols[Math.floor(Math.random() * symbols.length)];
    const win = Math.random() > 0.42;
    const cost = 50 + Math.random() * 950;
    const pnl = win ? cost * (0.02 + Math.random() * 0.15) : -cost * (0.01 + Math.random() * 0.10);
    trades.push({ time: t, asset: asset, pnl: pnl, price: 1, qty: 1, cost: cost });
  }
  trades.sort(function (a, b) { return a.time - b.time; });
  const openPositions = [
    { asset: 'ETH', qty: 0.8, avgCost: 2200, currentPrice: mexcUsdtPrice('ETH') || 2380, costBasis: 1760, value: 1904, unrealizedPnl: 144, unrealizedPct: 8.18 },
    { asset: 'SOL', qty: 10, avgCost: 105, currentPrice: mexcUsdtPrice('SOL') || 98, costBasis: 1050, value: 980, unrealizedPnl: -70, unrealizedPct: -6.67 }
  ];
  finresRealized = { trades: trades, bySymbol: {}, openPositions: openPositions, loadedAt: Date.now(), loading: false, error: null };

  switchPage('finres');
  console.log('[fake] Финрез: total=' + (lastBalanceState ? lastBalanceState.total.toFixed(2) : '?') + ', trades=' + trades.length);
};

// Только для ручной проверки дизайна модалки "журнал сделок" (openJournalForAsset тянет реальные
// klines+myTrades с биржи — не годится для оценки вёрстки без настоящего ключа): открывает модалку
// с синтетическими свечами и сделками, минуя сеть целиком. НЕ вызывается production-кодом.
window.__testJournalChart = function () {
  const overlay = document.getElementById('journalModal');
  const titleEl = document.getElementById('journalModalTitle');
  const emptyEl = document.getElementById('journalChartEmpty');
  const canvas = document.getElementById('journalChartCanvas');
  overlay.classList.add('active');
  titleEl.innerHTML = '<i class="ri-file-list-3-line"></i> TEST/USDT — журнал сделок';
  emptyEl.style.display = 'none';
  let price = 0.043;
  const candles = [];
  const t0 = Date.now() - 300 * 5 * 60000;
  for (let i = 0; i < 300; i++) {
    const o = price;
    price *= 1 + (Math.random() - 0.5) * 0.03;
    const c = price;
    const h = Math.max(o, c) * (1 + Math.random() * 0.01);
    const l = Math.min(o, c) * (1 - Math.random() * 0.01);
    candles.push({ t: t0 + i * 5 * 60000, o: o, h: h, l: l, c: c, v: 1000 + Math.random() * 9000 });
  }
  // Несколько отдельных закрытых позиций (вход→выход), в т.ч. одна с плотным доливом на активном
  // скальпинге (candles[250]-[251], несколько BUY/SELL подряд буквально по одинаковой округлённой
  // цене — та самая ситуация с реального BONER/USDT из репорта) — проверяет, что computeTradePairsForChart
  // честно сводит их в одну позицию по средней цене, а не путается.
  const trades = [
    { time: candles[80].t, buy: true, price: candles[80].c, qty: 100 },
    { time: candles[95].t, buy: false, price: candles[95].c, qty: 100 },
    { time: candles[150].t, buy: true, price: candles[150].c, qty: 200 },
    { time: candles[210].t, buy: false, price: candles[210].c, qty: 200 },
    { time: candles[250].t, buy: true, price: candles[250].c, qty: 50 },
    { time: candles[250].t + 10000, buy: true, price: candles[250].c, qty: 60 },
    { time: candles[250].t + 20000, buy: true, price: candles[250].c, qty: 40 },
    { time: candles[251].t, buy: false, price: candles[251].c, qty: 50 },
    { time: candles[251].t + 10000, buy: false, price: candles[251].c, qty: 30 },
    { time: candles[251].t + 20000, buy: false, price: candles[251].c, qty: 30 },
    { time: candles[251].t + 30000, buy: false, price: candles[251].c, qty: 20 },
    { time: candles[280].t, buy: true, price: candles[280].c, qty: 40 },
    { time: candles[290].t, buy: false, price: candles[290].c, qty: 40 }
  ];
  const pairs = computeTradePairsForChart(trades);
  const selectedPairIndex = pairs.length - 1;
  journalChartState = {
    asset: 'TEST', raw: 'TESTUSDT', tf: '5', candles: candles, trades: trades, pairs: pairs,
    selectedPairIndex: selectedPairIndex, view: centerJournalViewOnPair(candles, pairs[selectedPairIndex])
  };
  wireJournalChartInteractions(canvas);
  wireJournalTradesListClick();
  wireJournalTfPills();
  drawJournalChart(canvas, candles);
  renderJournalTradesList(pairs);
  renderJournalTfPills();
};

console.log('MEXC Screener запущен (MEXC Spot WS v3, protobuf)');

})();
