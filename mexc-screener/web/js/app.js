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

// ============================================
// Автообновление desktop-приложения (кнопка "Проверить обновления" на странице «Настройки»).
// window.NL_APPVERSION — глобал, который сама Neutralino-подсистема инжектит в страницу ДО загрузки
// этого скрипта (независимо от того, используется ли штатный Neutralino.init() — см. заметки про
// собственный WS-мост ниже по файлу); в обычной веб-версии (без desktop-обёртки) его нет, тогда
// берём запасную строку — держите её в СИНХРОНЕ с "version" в desktop/neutralino.config.json при
// каждом релизе, иначе версия в интерфейсе разойдётся с реальной.
const APP_VERSION = (typeof window.NL_APPVERSION === 'string' && window.NL_APPVERSION) || '1.7.1';
// ЗАПОЛНИТЕ после создания GitHub-репозитория и первого релиза (см. docs/updates.md) — до этого
// кнопка "Проверить обновления" будет честно показывать понятную ошибку, а не тихо молчать или
// стучаться в несуществующий адрес.
const UPDATE_REPO_OWNER = 'arteomsuharev-hash';
const UPDATE_REPO_NAME = 'mexc-screener';
const UPDATE_REPO_CONFIGURED = UPDATE_REPO_OWNER !== 'YOUR_GITHUB_USERNAME' && UPDATE_REPO_NAME !== 'YOUR_REPO_NAME';
const UPDATE_API_URL = 'https://api.github.com/repos/' + UPDATE_REPO_OWNER + '/' + UPDATE_REPO_NAME + '/releases/latest';

// ============================================
// Локализация (RU/EN) — переключатель "RU"/"EN" в подвале сайдбара (langToggle).
// Русский — язык исходного кода (все строковые литералы в HTML/JS написаны на нём), поэтому здесь
// только словарь EN-переводов по ключу — точному русскому тексту (или, для многострочных абзацев,
// стабильному ключу из data-i18n-key — сравнивать textContent длинных абзацев на равенство ненадёжно
// из-за пробелов/переносов строк в самой разметке). t() возвращает перевод, если язык = en и он
// есть в словаре, иначе — исходный текст без изменений (безопасный fallback, а не пустая строка).
const I18N_LANG_KEY = 'mexc_lang';
let currentLang = 'ru';
try { currentLang = localStorage.getItem(I18N_LANG_KEY) === 'en' ? 'en' : 'ru'; } catch (e) {}

function t(text) {
  if (currentLang !== 'en' || !text) return text;
  return I18N_EN[text] || text;
}

// Многострочные абзацы (data-i18n-key) хранят готовый HTML (с <strong> и т.п. — те же теги, что и в
// исходной разметке), а не голый текст — применяются через innerHTML, не textContent.
const I18N_EN_BLOCKS = {
  'patterns-watchlist-note':
    '<strong>About deep analysis.</strong> Unlike "Profiles" (a ticker-based heuristic across the ' +
    'whole market at once), pattern detectors work on real trades and the order book of specific ' +
    'coins — but that means a separate WS connection PER COIN, and thousands of them can\'t ' +
    'physically be open at once. So deep analysis only runs on a bounded, constantly-updated ' +
    'watchlist (by default up to the 20 most active coins right now + the open coin/favorites) — not ' +
    'the whole market. Coins outside the watchlist won\'t appear here, no matter how interesting they ' +
    'look on the "Screener" tab.',
  'patterns-validation-note':
    'Honest overfitting protection (there\'s no historical tick/order-book archive to backtest against — ' +
    'see README): compares a detector\'s win rate on "old" (closed more than 24h ago) vs. "fresh" ' +
    '(closed more recently) signals, counting only outcomes that have ALREADY RESOLVED (≥2 minutes ' +
    'since detection). A noticeable drop is a reason not to trust that detector blindly right now.',
  'profiles-strategy-note':
    '<strong>About the strategies.</strong> The screener has no order-book-depth subscription across every ' +
    'market pair at once — that\'s architecturally impossible for thousands of pairs simultaneously ' +
    '(MEXC caps ~30 streams per WebSocket connection). So "Algorithms" and "Inefficiencies" are heuristics ' +
    'on tick data (price, 24h volume, turnover volume/speed, and volatility over the last 5–60s), not a ' +
    'precise read of real limit-order walls. "Size" is the exception for coins in the deep-analysis ' +
    'watchlist (see "Patterns", typically the top ~20 most active coins right now + the open coin/favorites): ' +
    'for those, the signal is built on the REAL order book — looking for a large standing order (a "wall") ' +
    'noticeably bigger than nearby levels, close to the current price, that price has been approaching for ' +
    'several snapshots in a row. For coins outside the watchlist, "Size" still runs on the tick-based ' +
    'approximation (a lull, then a sharp volume spike) — honestly a less precise signal. When the "Size" ' +
    'strategy is active and a coin\'s chart is open, a "Density" panel appears above the chart — for ' +
    'watchlist coins that\'s the real wall level, for the rest it\'s the approximate tick-based zone. Before ' +
    'entering a trade, check that pair\'s real order book manually — the "Open in terminal" button by the ' +
    'chart links to the real MEXC terminal with the full order book.',
  'listings-honesty-note':
    '<strong>How this works.</strong> Binance Futures publishes new contracts in advance with a "pending" ' +
    'status and an exact start time — those get an honest countdown below. Neither MEXC Spot nor Binance ' +
    'Spot exposes any such field — a pair there simply appears in the tradable list with no warning, so the ' +
    'only honest approach is to catch the MOMENT it appears (this page checks both exchanges every 45 ' +
    'seconds), not promise a made-up countdown.',
  'acct-security-note':
    '<strong>How this works and what matters.</strong> The screener has no server of its own — the keys you ' +
    'enter are stored only in this browser/app (localStorage) and go straight to the MEXC API, signed ' +
    'right here on your device, never through any third-party service. This means: 1) create a separate ' +
    'API key in MEXC with Read-only permissions, without Withdraw and ideally without Trade — the ' +
    'screener never requests those; 2) anyone with access to this browser/computer could potentially see ' +
    'the saved key — don\'t use it on shared/public devices. Signing in via API does NOT log you into ' +
    'mexc.com — the "Open in terminal" button by the chart just opens that pair\'s page in a new tab; if ' +
    'you\'re separately logged into mexc.com in this same browser, it\'ll open in your own terminal.',
  'acct-weblonly-note':
    'You\'re using the web version: some exchanges, including MEXC, may not allow the browser to call ' +
    'their private API directly (a CORS policy on the exchange\'s side) — the connection would then fail ' +
    'with a network error. In the desktop app this same request bypasses the browser and isn\'t subject ' +
    'to that restriction.',
  'acct-finres-note-text':
    'Once a key is connected, your portfolio, P&amp;L, calendar, risk and a trade journal with entry/exit ' +
    'points show up there.',
  'acct-other-exchanges-note':
    'Connect an exchange — its coins will show up in the screener table (the "All/M/B/O" switcher at the ' +
    'top). Keys are stored only in this browser/app, same as MEXC\'s.'
};

function applyStaticI18n() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n-key]').forEach(function (el) {
    const key = el.getAttribute('data-i18n-key');
    if (!el.dataset.i18nSrcHtml) el.dataset.i18nSrcHtml = el.innerHTML;
    el.innerHTML = (currentLang === 'en' && I18N_EN_BLOCKS[key]) ? I18N_EN_BLOCKS[key] : el.dataset.i18nSrcHtml;
  });
  document.querySelectorAll('[data-i18n]:not([data-i18n-key])').forEach(function (el) {
    // Пробелы нормализуем (несколько пробелов/переносов строк из отступов разметки -> один пробел) —
    // иначе многострочный текст в HTML (с отступами) не совпадёт по ключу со словарной строкой,
    // набранной в JS одной строкой без переносов.
    if (!el.dataset.i18nSrc) el.dataset.i18nSrc = el.textContent.trim().replace(/\s+/g, ' ');
    el.textContent = t(el.dataset.i18nSrc);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
    if (!el.dataset.i18nTitleSrc) el.dataset.i18nTitleSrc = el.getAttribute('title') || '';
    el.setAttribute('title', t(el.dataset.i18nTitleSrc));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
    if (!el.dataset.i18nPhSrc) el.dataset.i18nPhSrc = el.getAttribute('placeholder') || '';
    el.setAttribute('placeholder', t(el.dataset.i18nPhSrc));
  });
  document.querySelectorAll('[data-i18n-label]').forEach(function (el) {
    if (!el.dataset.i18nLabelSrc) el.dataset.i18nLabelSrc = el.getAttribute('label') || '';
    el.setAttribute('label', t(el.dataset.i18nLabelSrc));
  });
  // data-i18n-prefix="Исходный текст: " — переводит только ВЕДУЩИЙ текстовый узел элемента, не
  // трогая дочерние элементы (например "Сервер: <span id=...>12:34:56</span>" — вложенный span с
  // живым значением остаётся нетронутым, меняется только текст "Сервер: " перед ним).
  document.querySelectorAll('[data-i18n-prefix]').forEach(function (el) {
    const src = el.getAttribute('data-i18n-prefix');
    const firstNode = el.firstChild;
    if (firstNode && firstNode.nodeType === Node.TEXT_NODE) firstNode.nodeValue = t(src);
  });
}

const I18N_EN = {
  // --- Сайдбар ---
  'Платформа': 'Platform', 'Скринер': 'Screener', 'Избранное': 'Favorites', 'Оповещения': 'Alerts',
  'Аналитика': 'Analytics', 'Аккаунт': 'Account', 'Настройки аккаунта': 'Account settings',
  'Не подключено': 'Not connected', 'Финрез': 'Finance', 'Система': 'System', 'Паттерны': 'Patterns',
  'Профили': 'Profiles', 'Настройки': 'Settings', 'Нет связи': 'No connection', 'Тёмная тема': 'Dark theme',
  'Свернуть меню': 'Collapse menu',
  // --- Топбар ---
  'ПОДКЛЮЧЕНИЕ...': 'CONNECTING...', 'Пары USDT': 'USDT pairs', 'Показано': 'Shown', 'Сделок': 'Trades',
  'Время работы': 'Uptime',
  // --- Фильтры ---
  'Объём 24ч': '24h Volume', 'Объём 5с': '5s Volume', 'Волат. 5с %': '5s Volat. %', 'Волат. 30с %': '30s Volat. %',
  'Изм. 24ч %': '24h Chg %', 'Цена': 'Price', 'любой': 'any', 'любая': 'any', 'любое': 'any', 'от': 'from', 'до': 'to',
  'Живые': 'Live', 'Сбросить': 'Reset', 'Применить': 'Apply', 'Обновить': 'Refresh',
  // --- Профиль/стратегия select ---
  'Профиль: CUSTOM': 'Profile: CUSTOM', 'Профиль: BALANCED': 'Profile: BALANCED',
  'Профиль: AGGRESSIVE': 'Profile: AGGRESSIVE', 'Профиль: CONSERVATIVE': 'Profile: CONSERVATIVE',
  'Профиль: MOVERS': 'Profile: MOVERS', 'Стратегия: АЛГОРИТМЫ': 'Strategy: ALGORITHMS',
  'Стратегия: НЕЭФФЕКТИВНОСТИ': 'Strategy: INEFFICIENCIES', 'Стратегия: САЙЗ': 'Strategy: SIZE',
  'Стандарт': 'Standard', 'Стратегии': 'Strategies',
  'Таблица': 'Table', 'Сетка': 'Grid', 'Поиск: BTC, PEPE...': 'Search: BTC, PEPE...',
  'Загрузка рынка MEXC...': 'Loading MEXC market...',
  // --- Таблица ---
  'Монета': 'Coin', 'Изм. 24ч': '24h Chg', 'Волат. 5с': '5s Volat.', 'Волат. 30с': '30s Volat.',
  'Волат. 60с': '60s Volat.', 'Сигнал': 'Signal',
  // --- Инфо-панель монеты ---
  'Мои открытые ордера': 'My open orders',
  'Все': 'All', 'Все биржи': 'All exchanges', 'Спот': 'Spot', 'Фьючерсы': 'Futures', 'выбрать рынок': 'choose market',
  'Нет пар с движением ≥': 'No pairs moved ≥', 'за 24ч.': 'over 24h.',
  'Рост': 'Gainers', 'Падение': 'Losers', 'Порог': 'Threshold',
  // --- Листинги (боковая вкладка «Листинги» — новые пары на MEXC/Binance) ---
  'Листинги': 'Listings',
  'Как это работает.': 'How this works.',
  'У Binance Futures новые контракты заранее видны в публичном API со статусом «ожидает торгов» и точным временем старта — по ним ниже честный обратный отсчёт. У MEXC Spot и Binance Spot такого поля в принципе нет ни у одной биржи — там пара просто появляется в списке торгуемых без предупреждения, и единственный честный способ — заметить её МОМЕНТ появления (страница проверяет обе биржи каждые 45 секунд), а не обещать выдуманный отсчёт.':
    'Binance Futures publishes new contracts in advance with a "pending" status and an exact start time — those get an honest countdown below. Neither MEXC Spot nor Binance Spot exposes any such field — a pair there simply appears in the tradable list with no warning, so the only honest approach is to catch the MOMENT it appears (this page checks both exchanges every 45 seconds), not promise a made-up countdown.',
  'Пока новых листингов не найдено — страница проверяет MEXC и Binance каждые 45с.': 'No new listings found yet — this page checks MEXC and Binance every 45s.',
  'до листинга': 'until listing', 'запаздывает — ещё не запущен': 'running late — not live yet',
  'листинг обнаружен': 'listing detected', 'назад': 'ago',
  'Скопировать название монеты': 'Copy coin name', 'Скопировано': 'Copied',
  // --- Таймфреймы ---
  '1м': '1m', '5м': '5m', '15м': '15m', '30м': '30m', '1ч': '1h', '4ч': '4h', '1д': '1D',
  // --- График ---
  'Открыть на бирже': 'Open on exchange',
  'Скопировать тикер для вставки в поиск Vataga.terminal': 'Copy ticker to paste into Vataga.terminal search',
  'Переключить между TradingView и своим графиком (по своим данным MEXC)': 'Switch between TradingView and the built-in chart (own MEXC data)',
  'Свой график': 'Built-in chart', 'Плотность': 'Density', 'эвристика по тикам, не данные стакана': 'tick-based heuristic, not order-book data',
  'Выберите монету для графика MEXC': 'Select a coin for the MEXC chart',
  'Свечи': 'Candles', 'Линия': 'Line', 'Область': 'Area', 'Индикаторы': 'Indicators',
  'Показать/скрыть': 'Show/hide', 'Объём': 'Volume',
  'Колесо мыши — масштаб, зажать и тащить — панорама': 'Mouse wheel — zoom, click and drag — pan',
  'Настройки графика (индикаторы)': 'Chart settings (indicators)', 'Сохранить скриншот графика': 'Save chart screenshot',
  'Полноэкранный режим': 'Fullscreen', 'Очистить все построения': 'Clear all drawings', 'Сбросить масштаб': 'Reset zoom',
  'Курсор / панорама (зажмите и тащите)': 'Cursor / pan (click and drag)', 'Уровень (горизонтальная линия)': 'Level (horizontal line)',
  'Отрезок (трендовая линия между двумя точками)': 'Segment (trendline between two points)',
  'Луч (бесконечен в одну сторону)': 'Ray (infinite in one direction)',
  'Прямая (бесконечна в обе стороны)': 'Line (infinite both directions)', 'Линейка (замер цены/времени)': 'Ruler (measure price/time)',
  'К живым данным': 'Jump to live',
  // --- Правая панель ---
  'Стакан': 'Order book', 'Стакан недоступен — монета не в списке глубокого анализа (см. «Паттерны»)': 'Order book unavailable — coin isn\'t in the deep-analysis watchlist (see "Patterns")',
  'Последние сделки': 'Recent trades', 'из 100': 'of 100', 'Ожидание данных': 'Waiting for data',
  'Добавить в избранное': 'Add to favorites',
  // --- Избранное/Оповещения/Аналитика ---
  'Избранные монеты': 'Favorite coins', 'Оповещения по движению 24ч': '24h move alerts',
  'Топ рост 24ч': 'Top 24h gainers', 'Топ падение 24ч': 'Top 24h losers', 'Лидер по объёму': 'Volume leader',
  'Волатильность 60с': '60s volatility',
  // --- Паттерны ---
  'Наполняется...': 'Filling...', 'Детекторы': 'Detectors',
  '(отключённые не считаются и не расходуют бюджет вычислений)': '(disabled ones don\'t count and don\'t spend compute budget)',
  'Последние события (предупреждения/ошибки)': 'Recent events (warnings/errors)', 'Обнаруженные паттерны': 'Detected patterns',
  'Валидация детекторов': 'Detector validation', 'Детектор': 'Detector', 'Винрейт (старые)': 'Win rate (old)',
  'Винрейт (свежие)': 'Win rate (fresh)', 'Статус': 'Status',
  // --- Профили ---
  'Профиль в панели скринера сразу меняет набор фильтров (или включает готовую стратегию отбора) и сортировку таблицы. Нажмите карточку ниже, чтобы применить профиль и перейти в скринер — то же самое делает выпадающий список «Профиль» над таблицей. Активный профиль подсвечен синим.':
    'A profile in the screener panel instantly swaps the filter set (or turns on a ready-made selection strategy) and the table sort order. Click a card below to apply the profile and jump to the screener — the "Profile" dropdown above the table does the same thing. The active profile is highlighted in blue.',
  'Стратегии отбора': 'Selection strategies', '1. Стандарт': '1. Standard', 'АКТИВЕН': 'ACTIVE',
  'Базовый профиль: объём 24ч от 100K USDT, без жёстких ограничений по волатильности.': 'Base profile: 24h volume from 100K USDT, no hard volatility limits.',
  'Только крупные, ликвидные пары — объём 24ч от 5M USDT.': 'Large, liquid pairs only — 24h volume from 5M USDT.',
  'Мелкая ликвидность (от 20K USDT) с заметной волатильностью за 5с — больше шума, больше кандидатов.': 'Thin liquidity (from 20K USDT) with noticeable 5s volatility — more noise, more candidates.',
  'Пары с сильным движением за 24ч (от +5%) при объёме от 50K USDT.': 'Pairs with a strong 24h move (from +5%) at volume from 50K USDT.',
  'Стратегии отбора (адаптивные пороги под текущий рынок)': 'Selection strategies (thresholds adapt to the current market)',
  '2. Алгоритмы': '2. Algorithms',
  'Заметный непрерывный оборот при сдержанном движении цены («много сделок — мало хода») — похоже на работу маркет-мейкера или бота, а не на органическую торговлю людьми.':
    'Noticeable continuous turnover with restrained price movement ("many trades, little move") — looks like a market-maker/bot rather than organic human trading.',
  '3. Неэффективности': '3. Inefficiencies',
  'Резкий сдвиг цены за последние 5с на средней/тонкой ликвидности — вероятный локальный перекос цены, интересный для быстрой отработки.':
    'A sharp price move over the last 5s on medium/thin liquidity — a likely local price dislocation, interesting for a quick play.',
  '4. Сайз': '4. Size',
  'Для монет из watchlist глубокого анализа (Tier 2) — реальная стоящая стена в стакане, к которой приближается цена. Для остальных — прокси по тикам: объём за 5с в разы выше обычного темпа суток + цена уже пошла.':
    'For coins in the deep-analysis watchlist (Tier 2) — a real standing wall in the order book that price is approaching. For the rest — a tick-based proxy: 5s volume many times above the usual daily pace + price already moving.',
  // --- Настройки ---
  'Отображение': 'Display', 'Обновление аналитики и оповещений (сек)': 'Analytics & alerts refresh (sec)',
  '5 сек': '5 sec', '10 сек': '10 sec', '30 сек': '30 sec', '60 сек': '60 sec',
  'Максимум пар в таблице': 'Max pairs in table', 'Порог оповещения |изм. 24ч| (%)': 'Alert threshold |24h chg| (%)',
  'Управление': 'Controls', 'Сохранить настройки': 'Save settings', 'Сохранить': 'Save',
  'Очистить избранное': 'Clear favorites', 'Очистить': 'Clear', 'Обновления': 'Updates', 'Текущая версия': 'Current version',
  'Проверьте, вышла ли новая версия': 'Check whether a new version is out', 'Проверить обновления': 'Check for updates',
  'Скачать и установить': 'Download & install',
  // --- Настройки аккаунта ---
  'Подключение по API-ключу': 'API key connection', 'Статус': 'Status', 'Подключить': 'Connect',
  'Отключить': 'Disconnect', 'Диагностика': 'Diagnostics', 'Проверить подключение': 'Test connection',
  'Баланс и аналитика — на странице «Финрез»': 'Balance & analytics are on the "Finance" page',
  'Открыть Финрез': 'Open Finance',
  'График и стакан для': 'Chart and order book for',
  'пока не подключены — доступна только цена в таблице.': 'aren\'t connected yet — only the price in the table is available.',
  'Лента сделок пока доступна только для MEXC.': 'The trade feed is only available for MEXC for now.',
  // --- Финрез ---
  'Обзор': 'Overview', 'Сделки': 'Trades', 'Риски': 'Risk', 'Активы': 'Assets',
  // --- Bottom bar ---
  'Сервер: ': 'Server: ', 'Обновлено: ': 'Updated: ', 'Источник: ': 'Source: ', 'Поток: ожидание': 'Stream: waiting',
  // --- Journal modal ---
  'Журнал сделок': 'Trade journal', 'Отдалить': 'Zoom out', 'Приблизить': 'Zoom in',
  'Колесо мыши — масштаб, зажать и тащить — панорама, тащить за шкалу цены/времени — растяжение':
    'Mouse wheel — zoom, click and drag — pan, drag the price/time axis — stretch',
  'Объём (VOLG)': 'Volume (VOLG)', 'Точки входа/выхода': 'Entry/exit points',
  // --- Финрез: пустые состояния / загрузка (динамические строки, обёрнуты t() в местах вывода) ---
  'Подключите API-ключ на странице «Настройки аккаунта», чтобы увидеть финансовый результат.':
    'Connect an API key on the "Account settings" page to see your financial results.',
  'Подключите API-ключ': 'Connect an API key for',
  'на странице «Настройки аккаунта», чтобы увидеть финансовый результат.': 'on the "Account settings" page to see your financial results.',
  'Загрузка баланса...': 'Loading balance...',
  'Загрузка истории сделок по монетам из баланса...': 'Loading trade history for balance coins...',
  'Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.':
    'No balance data — open the "Account settings" tab and wait for the connection.',
  'Загрузка истории сделок...': 'Loading trade history...',
  'Реализованных сделок пока нет — как только появятся закрытые позиции, здесь появится статистика по сериям и Profit Factor.':
    'No realized trades yet — once closed positions appear, streak stats and Profit Factor will show up here.',
  'Открытых позиций без учтённой продажи не найдено в загруженной истории сделок.':
    'No open positions without a matching sale were found in the loaded trade history.',
  'Пока нет ни одной закрытой позиции — только открытые входы без выхода здесь не показываются.':
    'No closed positions yet — open entries without an exit aren\'t shown here.',
  'активных': 'active',
  'Watchlist ещё наполняется — паттерны появятся, когда накопится история сделок по отслеживаемым монетам.':
    'The watchlist is still filling up — patterns will appear once there\'s enough trade history for the tracked coins.',
  'Пока не найдено ни одного паттерна с достаточной уверенностью — это нормально, показываем только то, что реально выглядит неслучайным, а не любой шум.':
    'No pattern with enough confidence found yet — that\'s normal, we only show what genuinely looks non-random, not just any noise.',
  'Пока недостаточно закрытых сигналов (нужно дождаться истечения окна +2 минуты после детекции) — таблица наполнится по мере работы.':
    'Not enough closed signals yet (need to wait out the +2 minute window after detection) — the table will fill in as it runs.',
  'Не удалось загрузить часть истории сделок: ': 'Failed to load part of the trade history: ',
  'Реализованных сделок пока нет. Как только по какой-то монете из баланса появится закрытая (проданная) позиция — здесь появится статистика.':
    'No realized trades yet. Once a closed (sold) position appears for a coin in your balance, statistics will show up here.',
  'Реализованных сделок пока нет — статистика появится после первой закрытой позиции.':
    'No realized trades yet — statistics will appear after the first closed position.',
  'Реализованных сделок пока нет ни по одной известной монете. Если нужная монета уже полностью продана — найдите её через поиск выше, чтобы добавить в журнал.':
    'No realized trades yet for any known coin. If a coin you need has already been fully sold, find it via the search above to add it to the journal.',
  // --- Стратегии (STRATEGY_DEFS.label/.short — используются в strategyHintText на скринере) ---
  'Алгоритмы': 'Algorithms', 'Неэффективности': 'Inefficiencies', 'Сайз': 'Size',
  'Равномерный оборот на всех окнах при сдержанном движении цены — признак маркет-мейкера/бота.':
    'Steady turnover across all windows with restrained price movement — a sign of a market-maker/bot.',
  'Резкое движение цены БЕЗ подтверждающего объёма — расхождение цены и оборота.':
    'A sharp price move WITHOUT confirming volume — a divergence between price and turnover.',
  'Watchlist-монеты: реальная стена в стакане рядом с ценой. Остальные: затишье, затем резкий всплеск объёма + цена пошла и не откатилась мгновенно.':
    'Watchlist coins: a real order book wall near price. Others: a lull, then a sharp volume spike + price moved and didn\'t instantly retrace.',
  // --- Детекторы паттернов (DETECTOR_DEFS.label) ---
  'Идентичные размеры сделок': 'Identical trade sizes', 'Идентичные интервалы': 'Identical intervals',
  'Всплеск без продолжения': 'Burst with no follow-through', 'Цикличность': 'Cyclicity',
  'Повторяющаяся последовательность': 'Repeating sequence', 'Лесенка': 'Ladder', 'Ёршик': 'Sawtooth',
  'Дисбаланс стакана': 'Order book imbalance', 'Поглощение плотности': 'Density absorption',
  'Возможная фейковая ликвидность': 'Possible fake liquidity', 'Истощение импульса': 'Momentum exhaustion',
  'Повторная реакция на зону': 'Repeated zone reaction',
  // --- Периоды (FINRES_PERIODS/BALANCE_PERIODS.label — пилюли периодов в Финрезе) ---
  '1Д': '1D', '1Н': '1W', '1М': '1M', 'Всё': 'All', '7Д': '7D', '30Д': '30D', '90Д': '90D',
  'День': 'Day', 'Неделя': 'Week', 'Месяц': 'Month', 'с начала наблюдения': 'since tracking began',
  // --- Финрез: карточки статистики Обзора, лог паттернов, валидация ---
  'Общий PnL': 'Total PnL', 'Прибыль': 'Profit', 'Убытки': 'Loss', 'Винрейт': 'Win rate',
  'сделок': 'trades', 'сделок, винрейт': 'trades, win rate', 'нет сделок': 'no trades', 'за': 'for',
  'Заработано по монетам за': 'Earned by coin for', 'просадка ≥20 п.п.': 'drop ≥20 pts', 'стабильно': 'stable',
  'с назад': 'ago',
  // --- Паттерны: статус watchlist + плитки диагностики ---
  'Глубокий анализ:': 'Deep analysis:', 'монет': 'coins', 'подключается': 'connecting',
  'соединений:': 'connections:', 'сделок обработано:': 'trades ingested:', 'обновлений стакана:': 'order-book updates:',
  'Основной поток': 'Main stream', 'МОЛЧИТ/ОБРЫВ': 'SILENT/DROPPED', 'Watchlist': 'Watchlist',
  'WS-соединений (Tier 2)': 'WS connections (Tier 2)', 'Подключений всего': 'Total connections',
  'Сделок обработано': 'Trades ingested', 'Обновлений стакана': 'Order-book updates',
  'Активных паттернов': 'Active patterns', 'В истории': 'In history', 'В cooldown': 'In cooldown',
  // --- Финрез: hero-панель портфеля ---
  'Экспорт': 'Export', 'Общая стоимость портфеля': 'Total portfolio value',
  'Обновить данные Финреза сейчас, не дожидаясь автообновления': 'Refresh Finance data now, without waiting for auto-refresh',
  'Копим историю для графика — загляните сюда попозже': 'Building up history for the chart — check back later',
  'Обновлено': 'Updated',
  // --- Финрез: Сделки (журнал позиций) ---
  'Поток:': 'Stream:', 'мелких скрыто': 'small hidden', 'монет учтено': 'coins counted', 'Из текущего баланса': 'From current balance',
  'Сейчас в балансе нет монет с известной USDT-парой — найдите нужную через поиск выше.':
    'No coins with a known USDT pair in the balance right now — find the one you need via the search above.',
  'Найти любую монету (в т.ч. полностью закрытые позиции)...': 'Find any coin (incl. fully closed positions)...',
  'График входа/выхода по монете': 'Entry/exit chart by coin',
  'Выберите монету — покажем сделки и точки входа/выхода на графике': 'Select a coin — we\'ll show trades and entry/exit points on the chart',
  'Поиск по монете...': 'Search by coin...',
  'сделка': 'trade', 'сделки': 'trades',
  'Дата': 'Date', 'Время': 'Time', 'Монета': 'Coin', 'Цена входа': 'Entry price', 'Цена выхода': 'Exit price',
  'Результат': 'Result', 'Показать ещё': 'Show more',
  // --- Финрез: Риски ---
  'Риски': 'Risk', 'Концентрация портфеля': 'Portfolio concentration', 'Крупнейший актив': 'Largest asset',
  'портфеля': 'of portfolio', 'нет открытых позиций': 'no open positions',
  'Топ-3 концентрация': 'Top-3 concentration', 'доля трёх крупнейших НЕ-стейблкоинов': 'share of the three largest non-stablecoins',
  'В кэше (USDT/USDC…)': 'In cash (USDT/USDC…)', 'вне рынка': 'off the market',
  'Активов в портфеле': 'Assets in portfolio', 'учтено в общей стоимости': 'counted in total value',
  'Высокая концентрация:': 'High concentration:', 'занимает': 'makes up',
  'портфеля — просадка по этой монете сильно повлияет на весь баланс.': 'of the portfolio — a drawdown in this coin will strongly affect the whole balance.',
  'Показатели по сделкам': 'Trade metrics', 'Лучший день': 'Best day', 'по реализованному PnL': 'by realized PnL',
  'Худший день': 'Worst day', 'Серии подряд': 'Streaks', 'макс. побед / макс. убытков': 'max wins / max losses',
  'Просадка эквити': 'Equity drawdown', 'от пика P&L': 'from the P&L peak', 'ещё не выходили в плюс': 'hasn\'t gone positive yet',
  'Открытые позиции': 'Open positions', 'Открытых позиций': 'Open positions', 'без учтённой продажи в истории': 'without a matching sale in history',
  'Нереализованный PnL': 'Unrealized PnL', 'от вложенного': 'of invested amount', 'Самая рискованная': 'Riskiest',
  'Концентрация по активам (топ-10)': 'Concentration by asset (top 10)', 'Нет ценообразованных активов.': 'No priced assets.',
  // --- Финрез: Активы ---
  'Общий баланс': 'Total balance', 'активов': 'assets', 'Доступно': 'Available', 'от портфеля': 'of portfolio',
  'В ордерах': 'In orders', 'нет активных ордеров': 'no active orders', 'Изменение за 24ч': '24h change',
  'копим историю': 'building up history', 'в ордерах:': 'in orders:',
  'Без USDT-пары в скринере (не учтено в общей стоимости):': 'No USDT pair in the screener (not counted in total value):',
  'Показать мелкие остатки (&lt;$1):': 'Show small balances (&lt;$1):', 'на': 'totaling',
  'Скрыть мелкие остатки (&lt;$1) — как на самой бирже': 'Hide small balances (&lt;$1) — like on the exchange itself',
  'Распределение портфеля': 'Portfolio distribution', 'Всего': 'Total', 'Список активов': 'Asset list',
  // --- Финрез: P&L (карточки, таблица по периодам, календарь) ---
  'Средний PnL': 'Average PnL', 'на сделку': 'per trade',
  'PnL по периодам': 'PnL by period', 'Период': 'Period', 'Изменение %': 'Change %',
  'Не удалось обновить часть истории сделок (': 'Failed to refresh part of the trade history (',
  ') — показаны последние загруженные данные': ') — showing the last loaded data', 'от': 'from',
  'Календарь P&L': 'P&L calendar', 'Прибыльный день': 'Profitable day', 'Убыточный день': 'Losing day',
  'Нет данных': 'No data', 'За месяц:': 'This month:', 'дней со сделками:': 'days with trades:',
  'Пока нет реализованных сделок за этот месяц.': 'No realized trades this month yet.'
};

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
// 'ALL' | 'MEXC' | 'BINANCE' | 'OKX' — переключатель "какие биржи показывать" в тулбаре скринера
// (см. renderExchangeSwitch/exchangeSwitch), учитывается в coinPassesFilters().
let activeExchangeFilter = 'ALL';
// 'mexc' | 'binance' — какую биржу сейчас показывает страница "Финрез" (см. switchFinresExchange
// далеко ниже, рядом с остальным Финрез-кодом). Объявлено здесь, СИЛЬНО раньше остального Финрез-кода
// — loadKnownSymbols() (см. её вызов сразу после объявления) читает эту переменную уже на самом
// первом проходе скрипта; будь finresActiveExchange объявлена позже (let/const), это была бы ошибка
// обращения к переменной до инициализации (temporal dead zone), а не просто "неопределённое значение".
let finresActiveExchange = 'mexc';
let sortField = 'vol24';
let sortAsc = false;
let viewMode = 'list';
// Пока курсор наведён на строку таблицы/карточку сетки — держим ПОРЯДОК монет неизменным (значения
// в ячейках по-прежнему обновляются живьём), чтобы монета, которую пользователь разглядывает, не
// "уезжала" из-под курсора от постоянной пересортировки по объёму/цене. См. applySortOnly() и
// делегированные mouseover/mouseout на #tableBody/#gridView в конце файла.
let tableHoverFreezeSymbol = null;
// Пока идёт заморозка (см. выше) — снимок ТОЧНОГО списка видимых монет (символы, тот же порядок,
// та же длина), сделанный в момент начала наведения. Одной заморозки порядка внутри allCoins
// недостаточно: если под курсором активен фильтр/стратегия на "живых" полях (объём, изменение и
// т.п.), сама принадлежность монеты текущему видимому срезу может измениться на лету — тогда
// строки всё равно "прыгают" (появляются/пропадают/сдвигаются), просто по другой причине, чем
// пересортировка. Пока заморожено — состав и порядок видимых строк не меняются вообще, обновляются
// только значения в ячейках (см. renderTable()). Сбрасывается в null, как только курсор уходит.
let frozenVisibleSymbols = null;
// Пагинация таблицы (редизайн 2026-09, по образцу макета) — режет уже отфильтрованный/капнутый
// maxPairs список на страницы по TABLE_PAGE_SIZE, вместо одного длинного скролла. Намеренно НЕ
// сбрасывается на 1 автоматически при каждом тике живых данных (иначе пользователя постоянно
// сбрасывало бы на первую страницу) — renderTable() просто клампит номер страницы в допустимый
// диапазон, если текущий список стал короче.
const TABLE_PAGE_SIZE = 50;
let tablePage = 1;
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
// Таблетки быстрых фильтров над таблицей (редизайн 2026-09) — отдельный, дополнительный фильтр
// (см. algoCategoryPillMatches), работает как AND поверх активного профиля/стратегии, а не вместо
// него. 'all' — без доп.фильтра, 'algo' — есть хоть один активный Tier-2 бейдж (см. algoBadgesCellHtml),
// остальные — конкретные группы detectorKey.
let activeAlgoPill = 'all';
const ALGO_PILL_DETECTOR_KEYS = {
  pump_dump: ['pumpReversal', 'dumpReversal', 'twap'],
  volume: ['volumeAnomaly', 'liquidityWithdrawal'],
  density: ['densityBreak', 'densityAbsorption', 'densityAbsorptionBreakout', 'standingWall', 'absorption', 'fakeLiquidity', 'possibleHiddenAbsorption'],
  reversal: ['liquiditySweep', 'failedBreakout', 'pumpReversal', 'dumpReversal'],
  cycle: ['cycle', 'cyclicalPattern', 'timeBasedImpulse']
};
// Честно смотрит на activePatternEvents (тот же живой Tier-2 срез, что и у algoBadgesCellHtml) —
// не выдумывает совпадение для монет вне watchlist.
function algoCategoryPillMatches(symbol) {
  if (activeAlgoPill === 'all') return true;
  const keys = ALGO_PILL_DETECTOR_KEYS[activeAlgoPill];
  for (let i = 0; i < activePatternEvents.length; i++) {
    const ev = activePatternEvents[i];
    if (ev.symbol !== symbol) continue;
    if (activeAlgoPill === 'algo') return true;
    if (keys && keys.indexOf(ev.detectorKey) !== -1) return true;
  }
  return false;
}
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
// Ручное растяжение/сжатие осей перетаскиванием — как в TradingView (тянуть за правую шкалу цены
// вверх/вниз или за нижнюю шкалу времени влево/вправо), в дополнение к колесу мыши/панораме.
let ownChartPriceScaleMult = 1;  // 1 = автоподбор диапазона цены по видимым свечам; >1 растянуто, <1 сжато
let ownChartPriceScaleDrag = null; // { startY, startMult } — активное перетаскивание шкалы цены
let ownChartTimeScaleDrag = null;  // { startX, startVisible, centerIdx } — активное перетаскивание шкалы времени
let ownChartLoadedRaw = null;    // raw-символ, для которого сейчас загружены view/drawings
let ownChartLoadedTF = null;     // ТФ, для которого подобран текущий ownChartView (сбрасываем зум при смене ТФ)
let ownChartType = 'candles';    // 'candles' | 'line' | 'area'
let ownChartShowMA = false;      // скользящие средние MA(7)/MA(25) поверх цены
let ownChartShowVolume = true;   // панель объёма снизу — переключается из панели "Индикаторы" (глазок)
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

// Монеты с других бирж (см. upsertExternalCoin) держат бирж-префикс ПРЯМО в c.symbol ("BINANCE:BTC/USDT"),
// а не в отдельном поле — так все существующие места, которые используют c.symbol как ключ
// identity (coinMap.get/data-symbol/избранное/паттерны), автоматически остаются рабочими и
// коллизий с "голыми" символами MEXC (например тем же "BTC/USDT") быть не может, без переделки
// каждого из этих мест по отдельности. Эта функция — только для ОТОБРАЖЕНИЯ: превращает такой
// символ в маленький цветной бейдж биржи + читаемую пару, вместо сырой строки с двоеточием.
// "BINANCEFUT" (см. upsertExternalCoin/EXCHANGE_CONNECTORS.binance.exchangeTags) красится ТЕМ ЖЕ
// жёлтым, что и обычный Binance (exch-tag-binance, суффикс FUT снят только у класса цвета) — это та
// же биржа, просто другой рынок — но подписывается отдельно "FUT", не "BIN", чтобы не перепутать со спотом.
const EXCHANGE_BADGE_TEXT = { BINANCE: 'BIN', BINANCEFUT: 'FUT', OKX: 'OKX' };

// Подпись под названием монеты в инфо-панели справа ("MEXC Spot"/"Binance Futures"/...) — раньше
// была жёстко "MEXC Spot" всегда, даже для монет с других бирж/рынков (см. updateInfoPanel).
const EXCHANGE_SUB_LABEL = { MEXC: 'MEXC Spot', BINANCE: 'Binance Spot', BINANCEFUT: 'Binance Futures', OKX: 'OKX Spot' };
function exchangeSubLabel(c) {
  return EXCHANGE_SUB_LABEL[c.exchange || 'MEXC'] || (c.exchange + ' Spot');
}

function coinDisplayLabel(c) {
  if (!c.exchange || c.exchange === 'MEXC') return c.symbol;
  const pair = c.baseAsset + '/USDT';
  const colorCls = c.exchange.replace(/FUT$/, '').toLowerCase();
  const text = EXCHANGE_BADGE_TEXT[c.exchange] || c.exchange.slice(0, 3);
  return '<span class="exch-tag exch-tag-' + colorCls + '">' + text + '</span>' + pair;
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
    short: 'Watchlist-монеты: сработал один из 16 микроструктурных алгоритмов (стр. «Паттерны»). Остальные: равномерный оборот при сдержанном движении цены.',
    desc: 'Для монет из watchlist глубокого анализа (Tier 2, см. стр. «Паттерны») сигнал строится на 16 ' +
      'микроструктурных алгоритмах, посчитанных по РЕАЛЬНЫМ сделкам и стакану (Density Break, Density ' +
      'Absorption, Liquidity Sweep, Impulse-Pullback-Continuation, Price/Volume Inefficiency, Density-' +
      'Absorption-Breakout, Pump/Dump Reversal, Compression Break, Failed Breakout, Volume Anomaly, Liquidity ' +
      'Withdrawal, Possible Hidden Absorption, Cross-Exchange Divergence, Cyclical Pattern, Time-Based ' +
      'Impulse) — если хотя бы один сейчас активен на монете, это и есть матч (подробности — в объяснении ' +
      'конкретной монеты и на стр. «Паттерны»). Для остальных пар (нет подписки на стакан/сделки — физический лимит MEXC на потоки ' +
      'соединения) используется прежняя тиковая эвристика: ищем пары с ликвидностью не хуже среднерыночной ' +
      '(объём 24ч выше нижних ~35% пар), у которых цена почти не отклоняется сразу на всех трёх окнах — 5с, 30с ' +
      'и 60с, и скорость оборота между этими окнами РАВНОМЕРНАЯ (боты/маркет-мейкеры обычно дробят активность ' +
      'на ровные по времени куски, органические человеческие всплески — куда более неравномерно) — сочетание ' +
      '«стабильный оборот, мало движения, ровный темп» типично для маркет-мейкеров и арбитражных ботов.',
    match: function (c, s) {
      // Watchlist-монеты (Tier 2): реальный сигнал одного из 10 приоритетных алгоритмов — тот же
      // принцип блендинга Tier1/Tier2, что уже применяется в density.match() ниже для стены в стакане.
      const algoEvent = bestActiveAlgoEventFor(c.symbol);
      c.__algoEvent = algoEvent;
      if (algoEvent) return true;
      return c.vol24 >= s.vol24Liquid && c.vol5 > 0 && c.vol30s <= s.vol30sCalm && c.vol60s <= s.vol60sCalm &&
        c.vol5s <= s.vol30sCalm * 1.5 && (c.rateCV == null || c.rateCV <= s.steadyCV);
    },
    score: function (c, s) {
      // Реальный Tier-2 сигнал всегда ранжируется выше тиковой эвристики — тот же принцип, что и у density.score().
      if (c.__algoEvent) return 1000 + c.__algoEvent.confidencePct;
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
    label: 'Сайз',
    badge: 'SIZE',
    short: 'Watchlist-монеты: реальная стена в стакане рядом с ценой. Остальные: затишье, затем резкий всплеск объёма + цена пошла и не откатилась мгновенно.',
    desc: 'Для монет из watchlist глубокого анализа (Tier 2, см. стр. «Паттерны» — обычно топ-20 самых ' +
      'активных монет прямо сейчас + открытая монета/избранное) сигнал строится на РЕАЛЬНОМ стакане: ищем ' +
      'уровень цены, где стоит заявка заметно (в разы) крупнее соседних — настоящая "стена" — недалеко от ' +
      'текущей цены, к которой цена устойчиво приближается несколько снимков подряд (см. ' +
      'MexcCore.detectStandingWall). Для остальных пар подписки на стакан нет (физический лимит MEXC на ' +
      'потоки соединения — тысячи пар одновременно не потянуть), поэтому там по-прежнему приближение по ' +
      'модели объёмного профиля: ЗАТИШЬЕ (цена почти не двигалась 30-60с назад) с последующим РЕЗКИМ ' +
      'всплеском объёма именно в последние 5с (burst-ratio, верхние ~15% ЛИКВИДНОГО рынка, адаптивно — ' +
      'мёртвые пары с объёмом ниже 20K USDT в выдачу не попадают), плюс подтверждение: направление последних ' +
      '~2с должно совпадать с направлением всего 5с-всплеска, иначе это, скорее, фитиль, а не устойчивый пробой.',
    match: function (c, s) {
      const wall = detectStandingWall(c.symbol); // null для не-watchlist монет (нет подписки на стакан) — см. её же комментарий
      c.__wallEvent = wall;
      if (wall) return true;
      const burst = burstRatio(c);
      const wasCalm = c.preMove == null || c.preMove <= s.vol30sCalm * 1.4;
      return c.vol24 >= STRATEGY_MIN_LIQUID_VOL24 && burst >= s.burstSpike && c.vol5s >= Math.max(0.02, s.vol30sCalm * 0.5) && wasCalm && !c.reverting;
    },
    score: function (c) {
      // Реальный сигнал по стакану всегда ранжируется выше тикового приближения — он честнее и это
      // ощутимо более редкий, специфичный сигнал (не столько "монет прошли фильтр", сколько "монет,
      // где реально стоит стена рядом с ценой").
      if (c.__wallEvent) return 1000 + c.__wallEvent.confidencePct;
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

// Монеты с других бирж несут биржу прямо в символе ("BINANCE:CREAM/USDT", см. upsertExternalCoin/
// coinDisplayLabel) — раньше tvSymbol() слепо приклеивала "MEXC:" ко ВСЕМУ, что ей передали, и для
// такой монеты получалось "MEXC:BINANCE:CREAMUSDT" (TradingView честно отвечал "этого инструмента
// не существует" — инструмента с таким именем действительно нет). Теперь читаем префикс биржи из
// самого символа, если он есть, и используем ЕГО — TradingView знает Binance/OKX как отдельные
// источники данных под собственными префиксами, так что график реально тянется с нужной биржи.
function tvSymbol(sym) {
  const s = String(sym || '');
  const m = s.match(/^([A-Z]+):(.+)$/);
  if (m) {
    // "BINANCEFUT" — не настоящий биржевой префикс TradingView (см. exchangeTags у
    // EXCHANGE_CONNECTORS.binance) — это по-прежнему обычная "BINANCE", просто её бессрочный
    // (perpetual) фьючерс, а TradingView различает их суффиксом ".P" у СИМВОЛА, не отдельным префиксом биржи.
    if (m[1] === 'BINANCEFUT') return 'BINANCE:' + rawSymbol(m[2]) + '.P';
    return m[1] + ':' + rawSymbol(m[2]);
  }
  return 'MEXC:' + rawSymbol(s);
}

// URL реальной торговой страницы (терминала) MEXC для пары, напр. "BTC/USDT" -> mexc.com/exchange/BTC_USDT
function mexcTerminalUrl(sym) {
  return 'https://www.mexc.com/exchange/' + encodeURIComponent(rawSymbol(sym).replace(/USDT$/, '_USDT'));
}

// Биржа, закодированная в начале символа ("BINANCE:CREAM/USDT" -> "BINANCE"), см. upsertExternalCoin/
// tvSymbol выше. "MEXC" по умолчанию — её собственные символы префикса не несут ("BTC/USDT").
function exchangeOfSymbol(sym) {
  const m = String(sym || '').match(/^([A-Z]+):/);
  return m ? m[1] : 'MEXC';
}

// То же самое, что и mexcTerminalUrl, но для любой из подключённых бирж — своя ссылка на реальный
// торговый терминал этой пары на ЕЁ СОБСТВЕННОМ сайте, а не всегда на mexc.com.
function exchangeTerminalUrl(symbol) {
  const exch = exchangeOfSymbol(symbol);
  if (exch === 'MEXC') return mexcTerminalUrl(symbol);
  const base = String(symbol).replace(/^[A-Z]+:/, '').replace('/USDT', '');
  if (exch === 'BINANCE') return 'https://www.binance.com/en/trade/' + encodeURIComponent(base) + '_USDT';
  if (exch === 'BINANCEFUT') return 'https://www.binance.com/en/futures/' + encodeURIComponent(base) + 'USDT';
  if (exch === 'OKX') return 'https://www.okx.com/trade-spot/' + encodeURIComponent(base.toLowerCase()) + '-usdt';
  if (exch === 'BITGET') return 'https://www.bitget.com/spot/' + encodeURIComponent(base) + 'USDT';
  return mexcTerminalUrl(symbol);
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

// ============================================
// Автообновление desktop-приложения — страница «Настройки» → «Обновления».
// Источник правды о версиях — GitHub Releases конкретного репозитория (UPDATE_REPO_OWNER/NAME
// выше по файлу): "Проверить обновления" читает /releases/latest (публичный GET, без токена и
// авторизации), "Скачать и установить" тянет .zip-ассет релиза (тот же архив, что публикует
// desktop/build.sh — отдельно паковать что-то специальное для автообновления не нужно), распаковывает
// его штатным PowerShell (Expand-Archive — есть в любой Windows 10/11 из коробки, дополнительных
// зависимостей не требует) и подменяет запущенный .exe классическим для Windows приёмом
// "переименовать текущий exe (это разрешено, даже пока он выполняется) → поставить новый на его
// место → перезапустить" через маленький bat-помощник, отвязанный от процесса приложения.
//
// ВАЖНО (честно, а не мелким шрифтом): сама подмена запущенного .exe — самая рискованная часть
// этого механизма, и я не могу её протестировать из песочницы разработки (здесь нет реального
// Windows-процесса, который можно было бы понаблюдать вживую). Приём стандартный и хорошо известный,
// но перед тем как раздавать обновление другим людям — обязательно прогоните полный цикл
// (проверка → скачивание → установка → перезапуск) сами на реальной машине хотя бы один раз.
// Старый .exe при этом не удаляется, а переименовывается в MEXC-Screener.exe.bak — так что даже
// при сбое у пользователя остаётся рабочая копия рядом.

let pendingUpdateInfo = null; // { version, notes, zipUrl, htmlUrl } — результат последней успешной проверки

function compareVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const pb = String(b || '0').replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchGithubLatestRelease() {
  let bodyText = null;
  try {
    const res = await fetchWithTimeout(UPDATE_API_URL, { method: 'GET', headers: { 'Accept': 'application/vnd.github+json' } }, 12000);
    if (!res.ok) throw new Error('GitHub ответил ' + res.status + (res.status === 404 ? ' (репозиторий/релиз не найден)' : ''));
    bodyText = await res.text();
  } catch (browserErr) {
    let native = null;
    try {
      native = await nativeCurlGet(UPDATE_API_URL, null);
    } catch (nativeErr) {
      throw new Error('Браузер не смог загрузить данные (' + browserErr.message + '), запасной путь через curl.exe тоже не сработал: ' + nativeErr.message);
    }
    if (!native) throw browserErr;
    bodyText = native.body;
  }
  let data;
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error('GitHub вернул не-JSON ответ'); }
  if (!data || !data.tag_name) throw new Error((data && data.message) || 'В ответе GitHub нет tag_name — возможно, у репозитория ещё нет ни одного релиза');
  return data;
}

async function checkForAppUpdate() {
  const statusEl = document.getElementById('updateStatusLabel');
  const btnEl = document.getElementById('checkUpdateBtn');
  const rowEl = document.getElementById('updateAvailableRow');
  if (rowEl) rowEl.style.display = 'none';
  pendingUpdateInfo = null;
  if (!UPDATE_REPO_CONFIGURED) {
    if (statusEl) statusEl.textContent = 'Адрес репозитория обновлений ещё не настроен (см. комментарий в app.js: UPDATE_REPO_OWNER/UPDATE_REPO_NAME)';
    return;
  }
  if (statusEl) statusEl.textContent = 'Проверяю...';
  if (btnEl) btnEl.disabled = true;
  try {
    const release = await fetchGithubLatestRelease();
    const latestVersion = String(release.tag_name).replace(/^v/i, '');
    const zipAsset = (release.assets || []).find(function (a) { return /\.zip$/i.test(a.name); });
    if (compareVersions(latestVersion, APP_VERSION) > 0) {
      if (!zipAsset) {
        if (statusEl) statusEl.textContent = 'Найдена версия ' + latestVersion + ', но в релизе нет .zip-файла для автоустановки';
      } else {
        pendingUpdateInfo = { version: latestVersion, notes: release.body || '', zipUrl: zipAsset.browser_download_url, htmlUrl: release.html_url };
        if (statusEl) statusEl.textContent = 'Текущая версия: ' + APP_VERSION;
        const labelEl = document.getElementById('updateAvailableLabel');
        if (labelEl) labelEl.textContent = 'Доступна версия ' + latestVersion + (release.body ? ' — ' + String(release.body).split('\n')[0].slice(0, 80) : '');
        if (rowEl) rowEl.style.display = '';
      }
    } else {
      if (statusEl) statusEl.textContent = 'У вас последняя версия (' + APP_VERSION + ')';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Не удалось проверить: ' + e.message;
    logW('Update', 'проверка обновлений не удалась: ' + e.message);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

// Скачивает файл через curl.exe НАПРЯМУЮ на диск (-o), а не через stdout — бинарные данные (exe/zip)
// через захват стандартного вывода (как это делает nativeCurlGet для текстовых ответов MEXC) были бы
// повреждены при прохождении через WS-мост как JS-строка. -f — считать HTTP-ошибки (404 и т.п.)
// падением, а не "успешно скачали страницу с текстом ошибки вместо файла".
// --retry 3 --retry-delay 2 --retry-all-errors — сама загрузка (GitHub отдаёт zip-ассет через редирект
// на CDN objects.githubusercontent.com) время от времени рвётся посреди передачи одноразовым сбросом
// соединения ("curl: (35) Recv failure: Connection was reset" — реальная ошибка, увиденная пользователем
// на его сети/антивирусе). Без --retry-all-errors обычный --retry curl повторяет только часть кодов
// ошибок и не гарантированно захватывает именно этот случай — теперь одноразовый обрыв решается сам,
// без участия пользователя, и только настоящая, повторяющаяся проблема сети доходит до него как ошибка.
async function nativeCurlDownloadToFile(url, destPath) {
  await execCommandSelfTest();
  const cmd = 'curl.exe -f -L -s -S --max-time 180 --retry 3 --retry-delay 2 --retry-all-errors -o "' +
    stripQuotes(destPath) + '" "' + stripQuotes(url) + '"';
  let result;
  try {
    result = await nlCall('os.execCommand', { command: cmd, background: false }, 190000);
  } catch (bridgeErr) {
    // Тот же диагноз, что и в nativeCurlGet выше: мост не ответил вообще — значит запуск процессов
    // сломался ПОСЕРЕДИНЕ сессии, после того как execCommandSelfTest() выше уже прошёл и закэшировался.
    if (!/не ответил/.test(bridgeErr.message)) throw bridgeErr;
    throw new Error(markNativeExecBroken(bridgeErr.message));
  }
  if (!result || result.exitCode !== 0) {
    throw new Error('curl.exe: ' + ((result && (result.stdErr || result.stdOut)) || ('код завершения ' + (result && result.exitCode))));
  }
}

// Выполняет короткую cmd-команду и возвращает её stdout как текст (для проверок вроде "существует
// ли файл" — быстрее и надёжнее, чем гадать по побочным эффектам).
async function nativeCmdOutput(cmd, timeoutMs) {
  const result = await nlCall('os.execCommand', { command: cmd, background: false }, timeoutMs || 15000);
  return (result && result.stdOut) || '';
}

async function downloadAndApplyUpdate() {
  if (!pendingUpdateInfo) return;
  if (!window.Neutralino) {
    showModal('Скачивание вручную',
      'Автоматическая установка работает только в desktop-приложении. Откройте страницу релиза и ' +
      'скачайте архив вручную:\n\n' + (pendingUpdateInfo.htmlUrl || pendingUpdateInfo.zipUrl));
    return;
  }
  const statusEl = document.getElementById('updateStatusLabel');
  const btnEl = document.getElementById('downloadUpdateBtn');
  if (btnEl) btnEl.disabled = true;
  function setStatus(text) { if (statusEl) statusEl.textContent = text; }
  try {
    const nlPath = window.NL_PATH;
    if (!nlPath) throw new Error('Не удалось определить папку приложения (NL_PATH не задан native-подсистемой)');
    const exeName = 'MEXC-Screener.exe';
    const zipPath = nlPath + '\\_update.zip';
    const extractedDir = nlPath + '\\_update_extracted';
    const applyBatPath = nlPath + '\\_apply_update.bat';

    setStatus('Скачиваю обновление...');
    await nativeCurlDownloadToFile(pendingUpdateInfo.zipUrl, zipPath);

    setStatus('Распаковываю...');
    await nlCall('os.execCommand', {
      command: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath \'' +
        zipPath.replace(/'/g, "''") + '\' -DestinationPath \'' + extractedDir.replace(/'/g, "''") + '\' -Force"',
      background: false
    }, 60000);

    const foundOut = await nativeCmdOutput('if exist "' + extractedDir + '\\' + exeName + '" (echo FOUND) else (echo MISSING)');
    if (foundOut.indexOf('FOUND') === -1) {
      throw new Error('В скачанном архиве не нашёлся ' + exeName + ' — установка отменена, текущая версия не тронута');
    }

    // Bat-помощник переживёт закрытие приложения (запускается отдельным отвязанным процессом):
    // ждёт, пока файл exe освободится (переименование запущенного .exe — стандартно разрешённая на
    // Windows операция, но занимает какое-то время после закрытия процесса), делает бэкап .bak,
    // ставит новую версию на место, перезапускает и подчищает за собой временные файлы.
    const batContent = [
      '@echo off',
      'setlocal',
      'cd /d "' + nlPath + '"',
      'set /a N=0',
      ':waitloop',
      'set /a N+=1',
      'ren "' + exeName + '" "' + exeName + '.lockcheck" >nul 2>&1',
      'if exist "' + exeName + '" (',
      '  if %N% GEQ 20 goto fail',
      '  timeout /t 1 /nobreak >nul',
      '  goto waitloop',
      ')',
      'del /f /q "' + exeName + '.bak" >nul 2>&1',
      'ren "' + exeName + '.lockcheck" "' + exeName + '.bak" >nul 2>&1',
      'copy /y "_update_extracted\\' + exeName + '" "' + exeName + '" >nul',
      'if not exist "' + exeName + '" goto fail',
      'rmdir /s /q "_update_extracted" >nul 2>&1',
      'del /f /q "_update.zip" >nul 2>&1',
      'start "" "' + exeName + '"',
      'goto cleanup',
      ':fail',
      '  if exist "' + exeName + '.lockcheck" ren "' + exeName + '.lockcheck" "' + exeName + '" >nul 2>&1',
      '  echo Автообновление не удалось — запущена прежняя версия, ничего не потеряно. > "_update_error.txt"',
      '  start "" "' + exeName + '"',
      ':cleanup',
      'del /f /q "%~f0"'
    ].join('\r\n');
    await nlCall('filesystem.writeFile', { path: applyBatPath, data: batContent }, 10000);

    setStatus('Устанавливаю и перезапускаю...');
    // /MIN + detached cmd-обёртка: помощник должен пережить закрытие текущего приложения ниже.
    nlCall('os.execCommand', { command: 'cmd.exe /C start "" /MIN "' + applyBatPath + '"', background: true }, 5000).catch(function () {});
    setTimeout(function () {
      nlCall('app.exit', {}, 5000).catch(function () {
        showModal('Обновление готово', 'Закройте приложение вручную — новая версия запустится автоматически.');
      });
    }, 800);
  } catch (e) {
    logW('Update', 'установка обновления не удалась: ' + e.message);
    setStatus('Ошибка установки: ' + e.message);
    if (btnEl) btnEl.disabled = false;
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

// Окно ринг-буфера — 5 минут (было 70с): тот же буфер теперь ещё и источник для range5m (честный
// диапазон max-min цены за 5 минут, см. rangePctFromSnaps) — по образцу метрики "range5m" у
// oculusdei.pro (см. их публичный /api/graph/v1/candidates, поле range5_pct), но посчитанной
// самостоятельно на своих тиковых данных, не скопированной. 5 минут при коалессинге тиков в ~900мс
// — до ~333 точек на монету, на ~1600+ монет рынка это по-прежнему лёгкие {t,p,q}-объекты, не
// заметно по памяти.
const SNAP_WINDOW_MS = 300000;
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
  const cut = now - SNAP_WINDOW_MS;
  while (arr.length && arr[0].t < cut) arr.shift();
}

// Диапазон (max-min)/min*100 за последние windowMs — честный "range5m", а не приближение по двум
// точкам (в отличие от vol5s/vol30s/vol60s выше, которые берут только цену НА границе окна, range
// нужно сканировать ВЕСЬ отрезок буфера, иначе пропустим пик/провал внутри окна).
function rangePctFromSnaps(symbol, windowMs) {
  const arr = snapshots.get(symbol);
  if (!arr || !arr.length) return 0;
  const cutoff = Date.now() - windowMs;
  let min = Infinity, max = -Infinity;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t < cutoff) break;
    if (arr[i].p < min) min = arr[i].p;
    if (arr[i].p > max) max = arr[i].p;
  }
  if (min === Infinity || min <= 0) return 0;
  return (max - min) / min * 100;
}

// NATR ("нормализованный ATR") за bucketCount минутных отрезков — честный tick-based аналог: делим
// тиковый буфер на bucketCount корзин по bucketMs (по умолчанию 5×1мин), считаем диапазон
// (max-min) ВНУТРИ каждой корзины отдельно (это и есть "истинный размах" за минуту, ближе к смыслу
// ATR, чем общий range5m — который может занизиться, если цена внутри окна ходила туда-сюда и
// вернулась к тому же уровню), затем усредняем по корзинам и нормализуем на текущую цену. Не
// настоящий ATR по свечным open/close (candle-based ATR по всему рынку разом нам не по карману —
// пришлось бы тянуть live-свечи на 1600+ пар одновременно), но такая же честная, посчитанная на
// собственных тиковых данных метрика, а не выдуманное число.
function natrPctFromSnaps(symbol, price, bucketMs, bucketCount) {
  const arr = snapshots.get(symbol);
  if (!arr || !arr.length || !price) return 0;
  const now = Date.now();
  const windowMs = bucketMs * bucketCount;
  const mins = new Array(bucketCount).fill(Infinity);
  const maxs = new Array(bucketCount).fill(-Infinity);
  for (let i = arr.length - 1; i >= 0; i--) {
    const age = now - arr[i].t;
    if (age > windowMs) break;
    const idx = Math.min(bucketCount - 1, Math.floor(age / bucketMs));
    if (arr[i].p < mins[idx]) mins[idx] = arr[i].p;
    if (arr[i].p > maxs[idx]) maxs[idx] = arr[i].p;
  }
  let sum = 0, count = 0;
  for (let b = 0; b < bucketCount; b++) {
    if (maxs[b] > -Infinity) { sum += (maxs[b] - mins[b]); count++; }
  }
  if (!count) return 0;
  return (sum / count) / price * 100;
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
  const range5m = rangePctFromSnaps(symbol, SNAP_WINDOW_MS);
  const natr5 = natrPctFromSnaps(symbol, price, 60000, 5);
  return { vol5: vol5, vol30: vol30, vol60: vol60, vol5s: vol5s, vol30s: vol30s, vol60s: vol60s, range5m: range5m, natr5: natr5, preMove: preMove, rateCV: rateCV, zoneLow: zoneLow, zoneHigh: zoneHigh, reverting: reverting };
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
    range5m: m.range5m,
    natr5: m.natr5,
    preMove: m.preMove,
    rateCV: m.rateCV,
    zoneLow: m.zoneLow,
    zoneHigh: m.zoneHigh,
    reverting: m.reverting,
    fav: prev ? prev.fav : false,
    color: getCoinColor(display),
    exchange: 'MEXC'
  };
  coin.signal = getSignal(coin);
  coin.__wlScore = computeWatchlistCandidateScore(coin);
  // OI5m/Dvol5m — честно только у watchlist-монет (реальный стакан/поток сделок), см. oi5mForSymbol/
  // dvol5mForSymbol. Дешёвая проверка членства на КАЖДЫЙ тик всего рынка (~1600 монет), а не сам
  // расчёт — он и так уже дешёвый внутри, но незачем звать его для 1600 монет без стакана.
  if (isTier2Watchlisted(display)) {
    coin.tpm = tpmForSymbol(display);
    coin.oi5m = oi5mForSymbol(display);
    coin.dvol5m = dvol5mForSymbol(display);
  }
  coinMap.set(display, coin);
  return coin;
}

// Тикеры с других подключённых бирж (Binance/OKX) — см. EXCHANGE_CONNECTORS/exchangeConnections
// и pollExternalTickers ниже. НАМЕРЕННО отдельная, более простая функция, а не переиспользование
// upsertCoin(): та тянет за собой тиковую историю (pushSnap/metricsFromSnaps) для вычисления
// 5с/30с/60с волатильности/скорости оборота — метрики, честные только на живом WebSocket-потоке
// сделок в реальном времени. Здесь же периодический REST-снимок раз в несколько секунд — считать
// по нему "5-секундную волатильность" значило бы выдавать шум за сигнал. Поэтому у монет с других
// бирж эти поля честно пустые/нулевые, а сигналы стратегий (Алгоритмы/Неэффективности/Пробой
// плотностей) на них просто не работают — см. coinPassesFilters(), которая на активной стратегии
// такие монеты из списка исключает, а не показывает им бессмысленный бейдж.
//
// c.symbol здесь ("BINANCE:BTC/USDT") — НЕ то же самое, что видит пользователь (см.
// coinDisplayLabel) — подробности почему именно так см. в её комментарии.
//
// Мультибиржевой Tier 2 (2026-09, расширено на OKX): для бирж из TIER2_EXTERNAL_EXCHANGES ниже
// (сейчас — спот Binance и OKX) заводится РЕАЛЬНЫЙ watchlist глубокого анализа — свои WS-подписки
// на сделки/стакан этой биржи (см. блоки "TIER 2 — BINANCE"/"TIER 2 — OKX" ниже), не просто цена по
// REST. __wlScore здесь — только дешёвая Tier-1 оценка "стоит ли вообще открывать WS-подписку"
// (честный объём 24ч с биржи, тот же принцип, что у MEXC в computeWatchlistCandidateScore, но без
// тиковых метрик — тем взяться неоткуда до того, как WS уже открыт). Для бирж вне этого набора
// (BINANCEFUT и т.д.) — по-прежнему 0, такие пары навсегда остаются тикером без глубокого анализа,
// честно.
const TIER2_EXTERNAL_EXCHANGES = new Set(['BINANCE', 'OKX', 'BITGET']);
function computeExternalWatchlistCandidateScore(vol24) {
  return (Number.isFinite(vol24) && vol24 >= STRATEGY_MIN_LIQUID_VOL24) ? vol24 : -1;
}
function upsertExternalCoin(rawSymbol, price, change24, vol24, high, low, exchange) {
  if (!isUsdtSpot(rawSymbol)) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  const base = rawSymbol.replace(/USDT$/, '');
  const pair = base + '/USDT';
  const key = exchange + ':' + pair;
  const prev = coinMap.get(key);
  const coin = {
    symbol: key,
    raw: rawSymbol,
    baseAsset: base,
    price: price,
    change24: Number.isFinite(change24) ? change24 : 0,
    vol24: Number.isFinite(vol24) ? vol24 : 0,
    high: Number.isFinite(high) ? high : price,
    low: Number.isFinite(low) ? low : price,
    vol5: 0, vol30: 0, vol60: 0, vol5s: 0, vol30s: 0, vol60s: 0,
    preMove: null, rateCV: null, zoneLow: null, zoneHigh: null, reverting: false,
    fav: prev ? prev.fav : false,
    color: getCoinColor(pair),
    exchange: exchange,
    signal: 'WAIT', // нет тикового потока по ЭТОЙ (Tier-1) цене -> нет тиковых сигналов, см. комментарий выше
    __wlScore: TIER2_EXTERNAL_EXCHANGES.has(exchange) ? computeExternalWatchlistCandidateScore(vol24) : 0
  };
  // TPM/OI5m/Dvol5m (сортировки "Графиков", см. коммит про них у MEXC) — честно те же поля и здесь,
  // если эта монета реально в Tier-2 watchlist СВОЕЙ биржи (Binance/OKX): реальный стакан/поток
  // сделок для них уже есть (tier2TradesForSymbol/tier2DepthForSymbol сами знают про префикс
  // "BINANCE:"/"OKX:"), просто раньше этот periodic REST-апдейтер их не считал вообще.
  if (isTier2Watchlisted(key)) {
    coin.tpm = tpmForSymbol(key);
    coin.oi5m = oi5mForSymbol(key);
    coin.dvol5m = dvol5mForSymbol(key);
  }
  coinMap.set(key, coin);
  return coin;
}

// Убирает из coinMap все монеты конкретной внешней биржи (вызывается при disconnectExchange) —
// иначе отключённая биржа продолжала бы висеть в таблице замороженным снимком последних цен.
function removeExternalCoinsForExchange(exchange) {
  let removed = 0;
  coinMap.forEach(function (c, key) {
    if (c.exchange === exchange) { coinMap.delete(key); removed++; }
  });
  return removed;
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
  if (!algoCategoryPillMatches(c.symbol)) return false;
  if (activeExchangeFilter !== 'ALL' && (c.exchange || 'MEXC') !== activeExchangeFilter) return false;
  const q = searchQuery.toLowerCase();
  if (q && c.symbol.toLowerCase().indexOf(q) === -1 && c.baseAsset.toLowerCase().indexOf(q) === -1) return false;
  if (activeStrategy && STRATEGY_DEFS[activeStrategy]) {
    // Неэффективности/Пробой плотностей — тиковые эвристики (см. upsertExternalCoin) на живом
    // WS-потоке MEXC; у монет с других бирж (периодический REST-снимок) для них честно нет данных,
    // показывать им бейдж сигнала было бы враньём — исключаем их из списка, а не подсовываем
    // нулевой/шумовой score. ИСКЛЮЧЕНИЕ — "algo": для бирж из TIER2_EXTERNAL_EXCHANGES (сейчас
    // Binance) там теперь реальный Tier-2 watchlist (см. binanceWatchlist/BINANCE_DETECTOR_FNS) —
    // bestActiveAlgoEventFor() честно вернёт null и match() корректно провалится сама по себе для
    // монет вне реального watchlist (тиковые поля у внешних монет по-прежнему зануляются), поэтому
    // здесь не нужно поддерживать отдельный список "каким биржам можно verить" руками.
    if (c.exchange && c.exchange !== 'MEXC' && activeStrategy !== 'algo') return false;
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

// Бейджи алгоритмов прямо в строке таблицы (редизайн 2026-09, по образцу пользовательского
// макета) — переиспользует уже посчитанный activePatternEvents (тот же живой срез Tier-2, что
// приводит в действие мост Tier1<->Tier2 и стр. «Паттерны»), НЕ отдельный проход детекторов.
// Честно показывает бейджи только для монет, что реально в Tier-2 watchlist (MEXC ИЛИ Binance,
// activePatternEvents уже несёт биржу прямо в ev.symbol) — для остальных строк тире, а не
// выдуманные значки только чтобы визуально "заполнить" колонку.
const ALGO_BADGES_MAX_PER_ROW = 3;
function algoBadgesCellHtml(symbol) {
  const evs = [];
  for (let i = 0; i < activePatternEvents.length && evs.length < ALGO_BADGES_MAX_PER_ROW; i++) {
    if (activePatternEvents[i].symbol === symbol) evs.push(activePatternEvents[i]);
  }
  if (!evs.length) return '<span class="algo-badges-empty">—</span>';
  return '<div class="algo-badges">' + evs.map(function (ev) {
    const def = DETECTOR_DEFS[ev.detectorKey];
    const dirCls = ev.direction === 'LONG' ? 'up' : ev.direction === 'SHORT' ? 'down' : 'neutral';
    // Цвет самого бейджа — по СЕМЕЙСТВУ детектора (category), не по сигналу (по образцу макета,
    // где у BRK/CYCL/IMP/VOL и т.п. всегда свой цвет вне зависимости от long/short) — так рядок
    // алгоритмов остаётся различимым с первого взгляда даже когда все сигналы совпадают.
    // Направление даёт маленькая цветная точка внутри бейджа, а не перекраска всего бейджа.
    const catCls = 'cat-' + ((def && def.category) || 'inefficiency').replace(/[^a-z-]/g, '');
    let text;
    try { text = explainPatternEvent(ev).replace(/"/g, '&quot;'); } catch (e) { text = ''; }
    return '<span class="algo-badge ' + catCls + '" title="' + text + '"><i class="badge-dot ' + dirCls + '"></i>' + ((def && def.badge) || ev.detectorKey) + '</span>';
  }).join('') + '</div>';
}

// "Рейтинг" в таблице (редизайн 2026-09, по образцу макета) — переиспользует УЖЕ существующий
// activityScore() (тот же 0-100 "насколько активна монета прямо сейчас" по объёму/движению/
// коротким волатильностям, что и у круглого индикатора в карточке выбранной монеты) и УЖЕ
// собираемый snapshots (тикеровый ринг-буфер за последние ~70с, который и так ведётся для
// vol5/vol30/vol60 у ВСЕГО рынка, см. pushSnap/metricsFromSnaps) — не заводит отдельного тяжёлого
// состояния и не рисует canvas на каждую строку (~400 одновременно видимых), только лёгкий inline
// SVG polyline из уже готовых точек.
function sparklineSvg(symbol, chg) {
  const snaps = snapshots.get(symbol);
  if (!snaps || snaps.length < 2) return '';
  const prices = snaps.map(function (s) { return s.p; });
  const min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
  const w = 56, h = 20, range = (max - min) || 1;
  const step = w / Math.max(1, prices.length - 1);
  const points = prices.map(function (p, i) { return (i * step).toFixed(1) + ',' + (h - ((p - min) / range) * h).toFixed(1); }).join(' ');
  const color = chg >= 0 ? 'var(--green)' : 'var(--red)';
  return '<svg class="row-sparkline" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<polyline points="' + points + '" fill="none" style="stroke:' + color + '" stroke-width="1.5"/></svg>';
}
function ratingCellHtml(c) {
  const score = activityScore(c);
  const chg = c.change24 || 0;
  return '<div class="rating-cell"><span class="rating-pct ' + (chg >= 0 ? 'up' : 'down') + '">' + score + '%</span>' + sparklineSvg(c.symbol, chg) + '</div>';
}

// "Активные алгоритмы" в правой панели выбранной монеты (редизайн 2026-09, по образцу макета) —
// тот же живой срез activePatternEvents, что и бейджи в таблице (algoBadgesCellHtml), просто в
// виде списка название/сигнал/score для ОДНОЙ выбранной монеты. Честно пусто для монет вне
// Tier-2 watchlist — как и бейджи в таблице, ничего не выдумывает.
const ACTIVE_ALGOS_PANEL_MAX = 4;
function activeAlgosPanelHtml(symbol) {
  const evs = [];
  for (let i = 0; i < activePatternEvents.length && evs.length < ACTIVE_ALGOS_PANEL_MAX; i++) {
    if (activePatternEvents[i].symbol === symbol) evs.push(activePatternEvents[i]);
  }
  if (!evs.length) return '<div class="active-algos-empty">Нет активных алгоритмов сейчас</div>';
  return evs.map(function (ev) {
    const def = DETECTOR_DEFS[ev.detectorKey];
    const dirCls = ev.direction === 'LONG' ? 'up' : ev.direction === 'SHORT' ? 'down' : 'neutral';
    const dirText = ev.direction === 'LONG' ? 'LONG' : ev.direction === 'SHORT' ? 'SHORT' : 'NEUTRAL';
    return '<div class="active-algo-row"><span class="active-algo-dot ' + dirCls + '"></span>' +
      '<span class="active-algo-name">' + ((def && def.label) || ev.detectorKey) + '</span>' +
      '<span class="active-algo-signal ' + dirCls + '">' + dirText + '</span>' +
      '<span class="active-algo-score">' + Math.round(ev.confidencePct) + '%</span></div>';
  }).join('');
}

function isTier2Watchlisted(symbol) {
  if (symbol.indexOf('OKX:') === 0) return okxWatchlist.has(symbol);
  if (symbol.indexOf('BITGET:') === 0) return bitgetWatchlist.has(symbol);
  if (symbol.indexOf('BINANCE:') === 0) return binanceWatchlist.has(symbol);
  return watchlist.has(symbol);
}
function standingWallForSymbol(symbol) {
  if (symbol.indexOf('OKX:') === 0) return detectStandingWallOkx(symbol);
  if (symbol.indexOf('BITGET:') === 0) return detectStandingWallBitget(symbol);
  if (symbol.indexOf('BINANCE:') === 0) return detectStandingWallBinance(symbol);
  return detectStandingWall(symbol);
}

// TPM ("сделок в минуту", по образцу oculusdei.pro) — считаем РЕАЛЬНЫЕ сделки за последние 60с из
// того же буфера, что и Tier-2 детекторы (tier2Trades/binanceTier2Trades). Честно только для
// watchlist-монет (~20-25 шт, «Паттерны») — у MEXC поток по ВСЕМУ рынку (miniTicker) не содержит
// счётчика сделок вообще, посчитать TPM на все 1600+ пар одновременно физически нечем (см. коммит
// про Range5m/NATR5m), выдумывать приближение вместо реальных сделок не стали.
function tpmForSymbol(symbol) {
  const trades = tier2TradesForSymbol(symbol);
  if (!trades || !trades.length) return 0;
  const cutoff = Date.now() - 60000;
  let count = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].t < cutoff) break;
    count++;
  }
  return count;
}

// OI 5м ("Order Imbalance", по мотивам сортировки oculusdei.pro, см. коммит про Range5m/NATR5m/TPM)
// — дисбаланс объёма стакана бид/аск, усреднённый по снимкам стакана за последние 5 минут, в
// процентах: +100% — весь видимый объём на покупку, -100% — весь на продажу. Это НЕ open interest
// (спот, открытого интереса в принципе нет) — честно только у watchlist-монет, тот же tier2Depth,
// что у depthWallsForSymbol выше.
function oi5mForSymbol(symbol) {
  const depth = tier2DepthForSymbol(symbol);
  if (!depth || !depth.length) return 0;
  const cutoff = Date.now() - SNAP_WINDOW_MS;
  let sum = 0, count = 0;
  for (let i = depth.length - 1; i >= 0; i--) {
    const snap = depth[i];
    if (snap.t < cutoff) break;
    const total = snap.bidVol + snap.askVol;
    if (total > 0) { sum += (snap.bidVol - snap.askVol) / total; count++; }
  }
  return count ? (sum / count) * 100 : 0;
}

// Dvol 5м ("Delta Volume") — чистая дельта покупки/продажи по РЕАЛЬНЫМ сделкам за последние 5 минут,
// в процентах от общего объёма за то же окно (+100% — все сделки на покупку, -100% — все на продажу).
// Честно только у watchlist-монет — тот же tier2Trades, что у tpmForSymbol/deltaSeriesForSymbol.
// DTPL с того же сайта сознательно НЕ добавляем — непонятная формула, по открытому API не
// восстанавливается, а выдумывать что-то под чужое название не стали (см. обсуждение в этой сессии).
function dvol5mForSymbol(symbol) {
  const trades = tier2TradesForSymbol(symbol);
  if (!trades || !trades.length) return 0;
  const cutoff = Date.now() - SNAP_WINDOW_MS;
  let buy = 0, sell = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const tr = trades[i];
    if (tr.t < cutoff) break;
    if (tr.side === 'sell') sell += tr.qty; else buy += tr.qty;
  }
  const total = buy + sell;
  return total > 0 ? ((buy - sell) / total) * 100 : 0;
}

// "Краткая статистика" в правой панели — только реальные, уже посчитанные где-то ещё числа
// (никаких новых тяжёлых вычислений на каждый рендер): объём/изменение уже на объекте монеты,
// волатильность 60с — то же metricsFromSnaps, что раньше было отдельной колонкой таблицы.
// «Плотность»/«Ликвидность» — честные текстовые категории по реальным сигналам (стена в стакане
// Tier-2 / объём 24ч), не выдуманные проценты и не «точный» анализ там, где данных физически нет.
function miniStatsListHtml(c) {
  const inWatchlist = isTier2Watchlisted(c.symbol);
  const wall = inWatchlist ? standingWallForSymbol(c.symbol) : null;
  const density = wall ? 'HIGH' : (inWatchlist ? 'LOW' : '—');
  const vol24 = c.vol24 || 0;
  const liquidity = vol24 >= 5000000 ? 'HIGH' : vol24 >= 500000 ? 'MED' : 'LOW';
  const chg = c.change24 || 0;
  const tpm = inWatchlist ? tpmForSymbol(c.symbol) : null;
  const rows = [
    ['Объём 24ч', fmtNum(vol24), ''],
    ['Изм. 24ч', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', chg >= 0 ? 'up' : 'down'],
    ['Волатильность', (c.vol60s || 0).toFixed(2) + '%', ''],
    ['Сделок/мин', tpm === null ? '—' : String(tpm), ''],
    ['Плотность', density, ''],
    ['Ликвидность', liquidity, '']
  ];
  return rows.map(function (r) {
    return '<div class="mini-stat-row"><span class="mini-stat-label">' + r[0] + '</span>' +
      '<span class="mini-stat-value' + (r[2] ? ' ' + r[2] : '') + '">' + r[1] + '</span></div>';
  }).join('');
}

// Пагинация таблицы (редизайн 2026-09, по образцу макета «Найдено: N ‹ 1 2 3 … 28 ›») — компактно
// показывает первую/последнюю страницу и окрестность текущей, с многоточием между разрывами,
// вместо полного списка из потенциально сотен страниц.
function pageNumbersToShow(current, total) {
  const pages = new Set([1, total]);
  for (let p = current - 1; p <= current + 1; p++) { if (p >= 1 && p <= total) pages.add(p); }
  return Array.from(pages).sort(function (a, b) { return a - b; });
}
function renderTablePagination(totalCount, totalPages) {
  const el = document.getElementById('tablePagination');
  if (!el) return;
  if (totalCount <= TABLE_PAGE_SIZE) { el.innerHTML = ''; return; }
  const nums = pageNumbersToShow(tablePage, totalPages);
  let numsHtml = '';
  let prevShown = 0;
  nums.forEach(function (p) {
    if (prevShown && p - prevShown > 1) numsHtml += '<span class="page-ellipsis">…</span>';
    numsHtml += '<button type="button" class="page-num' + (p === tablePage ? ' active' : '') + '" data-page="' + p + '">' + p + '</button>';
    prevShown = p;
  });
  el.innerHTML = '<span class="page-found">Найдено: ' + totalCount + '</span>' +
    '<button type="button" class="page-nav" data-page-nav="prev"' + (tablePage <= 1 ? ' disabled' : '') + '><i class="ri-arrow-left-s-line"></i></button>' +
    numsHtml +
    '<button type="button" class="page-nav" data-page-nav="next"' + (tablePage >= totalPages ? ' disabled' : '') + '><i class="ri-arrow-right-s-line"></i></button>';
}
(function wireTablePagination() {
  const el = document.getElementById('tablePagination');
  if (!el) return;
  el.addEventListener('click', function (e) {
    const numBtn = e.target.closest('[data-page]');
    const navBtn = e.target.closest('[data-page-nav]');
    if (numBtn) {
      tablePage = parseInt(numBtn.dataset.page, 10) || 1;
      renderTable();
    } else if (navBtn && !navBtn.disabled) {
      tablePage += navBtn.dataset.pageNav === 'prev' ? -1 : 1;
      renderTable();
    }
  });
})();

function renderTable() {
  const tbody = document.getElementById('tableBody');
  const grid = document.getElementById('gridView');
  const filtered = getFilteredCoins();
  let visible;
  if (tableHoverFreezeSymbol) {
    // Курсор на строке — фиксируем ТОЧНЫЙ состав и порядок видимых строк на момент начала наведения
    // (см. объявление frozenVisibleSymbols), а не только относительный порядок внутри allCoins.
    // Иначе монета, переставшая на тик проходить фильтр (объём/изменение и т.п. живые поля), пропадала
    // бы из списка прямо под курсором, и все строки ниже неё всё равно "прыгали" бы вверх.
    if (!frozenVisibleSymbols) frozenVisibleSymbols = filtered.slice(0, maxPairs).map(function (c) { return c.symbol; });
    visible = frozenVisibleSymbols.map(function (sym) { return coinMap.get(sym); }).filter(Boolean);
  } else {
    frozenVisibleSymbols = null;
    visible = filtered.slice(0, maxPairs);
  }
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
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="ri-database-2-line"></i>Нет данных MEXC. Ожидание WebSocket...</td></tr>';
    grid.innerHTML = '';
    renderTablePagination(0, 0);
    return;
  }
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="ri-filter-off-line"></i>Нет пар по текущим фильтрам. Сбросьте фильтры или подождите накопления 5с-метрик.</td></tr>';
    grid.innerHTML = '';
    renderTablePagination(0, 0);
    return;
  }

  // Пагинация (см. TABLE_PAGE_SIZE выше) — режем УЖЕ отфильтрованный/капнутый maxPairs список
  // visible на страницы, а не рендерим всё одним длинным скроллом. Клампим номер страницы вместо
  // сброса на 1, чтобы живые тики (объём/цена меняются, но состав почти тот же) не сбрасывали
  // пользователя с текущей страницы.
  const totalPages = Math.max(1, Math.ceil(visible.length / TABLE_PAGE_SIZE));
  if (tablePage > totalPages) tablePage = totalPages;
  if (tablePage < 1) tablePage = 1;
  const pageStart = (tablePage - 1) * TABLE_PAGE_SIZE;
  const pageVisible = visible.slice(pageStart, pageStart + TABLE_PAGE_SIZE);
  renderTablePagination(visible.length, totalPages);

  const stratDef = activeStrategy ? STRATEGY_DEFS[activeStrategy] : null;
  tbody.innerHTML = pageVisible.map(function (c, iOnPage) {
    const i = pageStart + iOnPage;
    const chg = c.change24 || 0;
    const sel = currentCoin && c.symbol === currentCoin.symbol;
    const sig = (c.signal || 'WAIT').toLowerCase();
    const signalCell = stratDef
      ? '<span class="signal-badge signal-strategy" title="' + stratDef.short.replace(/"/g, '&quot;') + '"><span class="dot dot-strategy"></span>' + stratDef.badge + ' ' + (c.__score || 0).toFixed(1) + '</span>'
      : '<span class="signal-badge signal-' + sig + '"><span class="dot dot-' + sig + '"></span>' + c.signal + '</span>';
    const rowAnim = isFirstFill ? ' row-enter" style="animation-delay:' + Math.min(i, 24) * 12 + 'ms' : '';
    const rankCls = i === 0 ? ' rank-one' : '';
    return '<tr data-symbol="' + c.symbol + '" class="' + (sel ? 'selected' : '') + rankCls + rowAnim + '">' +
      '<td><i class="ri-star-line star ' + (c.fav ? 'active' : '') + '" data-symbol="' + c.symbol + '"></i></td>' +
      '<td>' + (i + 1) + '</td>' +
      '<td><div class="coin-cell"><div class="coin-icon" style="background:' + c.color + '">' + c.baseAsset.charAt(0) + '</div><span>' + coinDisplayLabel(c) + '</span></div></td>' +
      '<td class="cell-price">' + fmtPrice(c.price) + '</td>' +
      '<td class="' + (chg >= 0 ? 'price-up' : 'price-down') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</td>' +
      '<td>' + fmtNum(c.vol24) + '</td>' +
      '<td>' + algoBadgesCellHtml(c.symbol) + '</td>' +
      '<td>' + signalCell + '</td>' +
      '<td>' + ratingCellHtml(c) + '</td></tr>';
  }).join('');

  grid.innerHTML = pageVisible.map(function (c) {
    const chg = c.change24 || 0;
    const sel = currentCoin && c.symbol === currentCoin.symbol;
    return '<div class="grid-card ' + (sel ? 'selected' : '') + '" data-symbol="' + c.symbol + '">' +
      '<div class="grid-card-top"><div class="coin-icon" style="background:' + c.color + '">' + c.baseAsset.charAt(0) + '</div><strong>' + coinDisplayLabel(c) + '</strong></div>' +
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
(function wireAlgoPillRow() {
  const row = document.getElementById('algoPillRow');
  if (!row) return;
  row.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-algo-pill]');
    if (!btn) return;
    activeAlgoPill = btn.dataset.algoPill;
    row.querySelectorAll('.algo-pill').forEach(function (p) { p.classList.toggle('active', p === btn); });
    renderTable();
  });
})();

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
  // Лента сделок/стакан тянутся с MEXC WS (см. loadTrades/subscribeDeals) — для монет с других
  // подключённых бирж (см. upsertExternalCoin) такого потока пока нет, честно показываем это вместо
  // попытки запросить несуществующие/чужие данные. График — отдельная история: TradingView сам знает
  // Binance/OKX как источники данных (см. tvSymbol), поэтому он загружается для любой биржи как обычно.
  if (coin.exchange && coin.exchange !== 'MEXC') {
    showExternalCoinTradesNotice(coin);
  } else {
    loadTrades(coin.raw);
  }
  if (forceChart || chartSymbol !== coin.symbol) {
    loadExchangeChart(coin.symbol, currentTF);
  }
}

function showExternalCoinTradesNotice(coin) {
  const list = document.getElementById('tradesList');
  if (!list) return;
  list.innerHTML = '<div class="trades-empty"><i class="ri-information-line"></i><span>' +
    t('Лента сделок пока доступна только для MEXC.') + '</span></div>';
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
  const exch = exchangeOfSymbol(symbol);

  const mexcLink = document.getElementById('openOnMexcLink');
  if (mexcLink) {
    mexcLink.href = exchangeTerminalUrl(symbol);
    mexcLink.style.display = 'inline-flex';
  }
  // "Скопировать для Vataga.terminal" и "Свой график" (см. ниже) — оба завязаны на MEXC-специфику
  // (символ для стороннего терминала заточен под MEXC; "свой график" тянет /api/v3/klines с MEXC REST,
  // которого для пары, которой у MEXC может вообще не быть, естественно нет) — скрываем для других бирж.
  const copyBtn = document.getElementById('copyForVatagaBtn');
  if (copyBtn) copyBtn.style.display = exch === 'MEXC' ? 'inline-flex' : 'none';
  const toggleBtn = document.getElementById('toggleOwnChartBtn');
  if (toggleBtn) toggleBtn.style.display = exch === 'MEXC' ? 'inline-flex' : 'none';
  updateToggleChartBtnLabel();

  if (exch === 'MEXC' && ownChartModeMemory[symbol] === 'own') {
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
// OKX использует свои обозначения интервала ("1H"/"1D" с большой буквы для часа/дня, не "1h"/"1d")
// и отдельный REST-эндпоинт (/api/v5/market/candles), см. fetchKlines ниже.
function okxKlineBar(tf) {
  const map = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1H', '240': '4H', 'D': '1D' };
  return map[tf] || '5m';
}
// "BTCUSDT" (наш внутренний raw, без разделителя) -> "BTC-USDT" (instId OKX, всегда через дефис).
function okxInstIdForRaw(raw) {
  return String(raw || '').replace(/USDT$/, '-USDT');
}
// Bitget использует свои строковые обозначения интервала ("1min"/"1h"/"1day", не "1m"/"1h"/"1d").
// Символ у Bitget — без разделителя ("BTCUSDT"), как у MEXC/Binance, конвертации не нужно.
function bitgetKlineGranularity(tf) {
  const map = { '1': '1min', '5': '5min', '15': '15min', '30': '30min', '60': '1h', '240': '4h', 'D': '1day' };
  return map[tf] || '5min';
}

// exchangeId — необязательный, тот же смысл, что и у fetchMyTrades: не задан (или 'mexc') — поведение
// как раньше (MEXC_REST); Binance — тот же путь, но на её собственный REST (тот же /api/v3/klines и
// тот же формат ответа — массив [openTime,open,high,low,close,volume,...], MEXC его 1:1 клонирует).
// OKX — свой путь целиком (другой эндпоинт, другой конверт ответа, другой порядок свечей — см. ветку
// ниже), но результат приводится к тому же {t,o,h,l,c,v}, так что вызывающему коду (drawMiniCandleChart,
// graphsCandles и т.д.) разница между биржами не видна.
async function fetchKlines(raw, tf, limit, exchangeId) {
  const isOkx = exchangeId === 'okx';
  const isBitget = exchangeId === 'bitget';
  const base = (!exchangeId || exchangeId === 'mexc') ? MEXC_REST : EXCHANGE_CONNECTORS[exchangeId].baseUrl;
  const url = isOkx
    ? base + '/api/v5/market/candles?instId=' + encodeURIComponent(okxInstIdForRaw(raw)) + '&bar=' + okxKlineBar(tf) + '&limit=' + (limit || 200)
    : isBitget
    ? base + '/api/v2/spot/market/candles?symbol=' + encodeURIComponent(raw) + '&granularity=' + bitgetKlineGranularity(tf) + '&limit=' + (limit || 200)
    : base + '/api/v3/klines?symbol=' + encodeURIComponent(raw) + '&interval=' + mexcKlineInterval(tf) + '&limit=' + (limit || 200);
  let bodyText = null;
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, 10000);
    if (!res.ok) throw new Error('Биржа ответила ' + res.status);
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
  try { data = JSON.parse(bodyText); } catch (e) { throw new Error('Некорректный ответ биржи'); }
  if (isOkx) {
    // OKX оборачивает массив в {code,msg,data} и отдаёт свечи от НОВОЙ к СТАРОЙ (в отличие от
    // MEXC/Binance, где уже по возрастанию времени) — разворачиваем, чтобы дальше по коду не
    // пришлось знать про разницу между биржами. Позиционный формат полей внутри строки тот же
    // [ts,o,h,l,c,vol,...], что и у MEXC/Binance.
    if (!data || !Array.isArray(data.data)) throw new Error((data && data.msg) ? data.msg : 'Некорректный ответ OKX');
    return data.data.slice().reverse().map(function (k) {
      return { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) };
    }).filter(function (k) { return Number.isFinite(k.o) && Number.isFinite(k.c) && Number.isFinite(k.h) && Number.isFinite(k.l); });
  }
  if (isBitget) {
    // Bitget тоже оборачивает массив в {code,msg,data}, но, в отличие от OKX, позиционный формат
    // [ts,o,h,l,c,baseVol,...] отдаётся УЖЕ по возрастанию времени (как у MEXC/Binance) — разворот
    // не нужен. Это подтверждено официальным примером ответа в документации Bitget V2, но НЕ
    // проверено на живых данных (нет реального аккаунта под рукой) — если свечи вдруг окажутся
    // задом наперёд, разворот включается тем же приёмом, что и у OKX (.slice().reverse()) в одну строку.
    if (!data || !Array.isArray(data.data)) throw new Error((data && data.msg) ? data.msg : 'Некорректный ответ Bitget');
    return data.data.map(function (k) {
      return { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) };
    }).filter(function (k) { return Number.isFinite(k.o) && Number.isFinite(k.c) && Number.isFinite(k.h) && Number.isFinite(k.l); });
  }
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
    ownChartPriceScaleMult = 1;
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
  const volumeH = ownChartShowVolume ? Math.round(plotHTotal * 0.16) : 0;
  const paneGap = ownChartShowVolume ? 6 : 0;
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
  if (ownChartPriceScaleMult !== 1) {
    const priceCenter = (min + max) / 2, priceHalf = (max - min) / 2 * ownChartPriceScaleMult;
    min = priceCenter - priceHalf; max = priceCenter + priceHalf;
  }

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

  // --- объём (панель снизу, если включена в панели "Индикаторы") ---
  const bodyW = Math.max(1, Math.min(9, slot * 0.62));
  if (ownChartShowVolume) {
    slice.forEach(function (k, i) {
      const x = i * slot + slot / 2;
      const up = k.c >= k.o;
      ctx.fillStyle = up ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)';
      const vy = volYOf(k.v);
      ctx.fillRect(x - bodyW / 2, vy, bodyW, (volTop + volumeH) - vy);
    });
  }

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

// Честный "грузится" вместо молчаливого чёрного экрана, пока для карточки ещё не пришли свечи
// (см. её же вызов в redrawGraphsGrid) — небольшая крутящаяся дуга + подпись. Дуга просто берёт угол
// из текущего времени (без requestAnimationFrame — перерисовывается вместе с остальной сеткой раз в
// GRAPHS_REDRAW_MS, этого достаточно, чтобы было видно, что экран живой, а не завис).
function drawGraphsLoadingPlaceholder(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 220, h = canvas.clientHeight || 120;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2 - 6, r = Math.min(14, Math.max(8, Math.round(Math.min(w, h) * 0.12)));
  const angle = (Date.now() / 500) % (Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#c98fa0'; // тот же акцент, что --accent в CSS — canvas не резолвит var() для цвета надёжно
  ctx.beginPath(); ctx.arc(cx, cy, r, angle, angle + Math.PI * 0.6); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.3)';
  ctx.font = '10px var(--font-mono, monospace)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t('Загрузка…'), cx, cy + r + 16);
}

// Упрощённый рендерер для сетки мини-графиков (стр. «Графики», по мотивам разбора GodsEye,
// 2026-09) — сознательно НЕ переиспользует drawCandleChart напрямую: тот завязан на глобальное
// состояние одного-единственного "своего" графика (зум/пан ownChartView, инструменты построений,
// MA-тумблер и т.д.), которое не должно шариться между N одновременно открытыми мини-карточками.
// Здесь — всегда весь переданный набор свечей, без зума/пана/построений, плюс пунктирная линия
// последней цены с бейджем (как в существующем drawCandleChart и как у GodsEye на скриншоте).
function drawMiniCandleChart(canvas, candles, opts) {
  opts = opts || {};
  if (!canvas || !candles || candles.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 220, h = canvas.clientHeight || 120;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padRight = 42, padTop = 4, padBottom = 2;
  const plotW = w - padRight;
  const showVolume = opts.showVolume !== false;
  const hasDelta = !!(opts.deltaSeries && opts.deltaSeries.length);
  const showTimeAxis = opts.timeAxis !== false;
  const volumeH = showVolume ? Math.round(h * 0.15) : 0;
  const deltaH = hasDelta ? Math.round(h * 0.16) : 0;
  const timeAxisH = showTimeAxis ? 11 : 0;
  const plotH = h - padTop - padBottom - volumeH - deltaH - timeAxisH;
  const volTop = padTop + plotH;
  const deltaTop = volTop + volumeH;

  // offsetFromEnd/maxCandles — окно просмотра для зума/панорамы конкретной карточки (см.
  // graphsChartView в wireGraphsGridClick): offset=0 значит "последние maxCandles свечей" (как
  // раньше), offset>0 сдвигает окно назад по истории — сам массив candles не режется/не мутирует,
  // только то, какой его отрезок сейчас рисуем.
  const maxCandles = Math.max(8, opts.maxCandles || 96);
  const offsetFromEnd = Math.max(0, Math.min(candles.length - 2, opts.offsetFromEnd || 0));
  const sliceEnd = candles.length - offsetFromEnd;
  const sliceStart = Math.max(0, sliceEnd - maxCandles);
  const slice = candles.slice(sliceStart, sliceEnd);
  const n = slice.length;
  if (n < 2) return;

  let min = Math.min.apply(null, slice.map(function (k) { return k.l; }));
  let max = Math.max.apply(null, slice.map(function (k) { return k.h; }));
  if (min === max) { min -= 1; max += 1; }
  const pricePad = (max - min) * 0.08;
  min -= pricePad; max += pricePad;

  let maxVol = Math.max.apply(null, slice.map(function (k) { return k.v; }));
  if (!Number.isFinite(maxVol) || maxVol <= 0) maxVol = 1;

  const slot = plotW / n;
  const bodyW = Math.max(1, Math.min(6, slot * 0.6));
  function yOf(v) { return padTop + plotH - ((v - min) / (max - min)) * plotH; }
  function volYOf(vv) { return volTop + volumeH - (vv / maxVol) * volumeH; }

  // Водяной знак — крупный тикер бледным фоном за свечами (reference-дизайн по мотивам GodsEye) —
  // рисуем ПЕРВЫМ, чтобы сетка/свечи/стены легли поверх и остались читаемыми.
  if (opts.watermark) {
    const fontSize = Math.max(18, Math.min(40, Math.round(plotH * 0.5)));
    ctx.save();
    ctx.font = '700 ' + fontSize + 'px var(--font-display, sans-serif)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    ctx.fillText(opts.watermark, plotW / 2, padTop + plotH / 2);
    ctx.restore();
  }

  ctx.font = '9px var(--font-mono, monospace)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  [max - pricePad, (min + max) / 2, min + pricePad].forEach(function (v) {
    const y = yOf(v);
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fillText(fmtPrice(v), plotW + 4, y);
  });

  if (showVolume) {
    slice.forEach(function (k, i) {
      const x = i * slot + slot / 2;
      const up = k.c >= k.o;
      ctx.fillStyle = up ? 'rgba(38,166,154,.4)' : 'rgba(239,83,80,.4)';
      const vy = volYOf(k.v);
      ctx.fillRect(x - bodyW / 2, vy, bodyW, (volTop + volumeH) - vy);
    });
  }

  slice.forEach(function (k, i) {
    const x = i * slot + slot / 2;
    const up = k.c >= k.o;
    const color = up ? OCHART_UP : OCHART_DOWN;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yOf(k.h)); ctx.lineTo(x, yOf(k.l)); ctx.stroke();
    const yo = yOf(k.o), yc = yOf(k.c);
    const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
  });

  // Плашки уровней стакана (см. depthWallsForSymbol) — поверх свечей, прижаты к правому краю
  // области цены, только те уровни, что попадают в видимый ценовой диапазон текущего окна.
  if (opts.depthWalls && opts.depthWalls.length) {
    const chipW = Math.min(38, Math.max(24, plotW * 0.22)), chipH = 11;
    opts.depthWalls.forEach(function (wall) {
      if (wall.price < min || wall.price > max) return;
      const y = Math.max(padTop + chipH / 2, Math.min(padTop + plotH - chipH / 2, yOf(wall.price)));
      const bid = wall.side === 'bid';
      ctx.fillStyle = bid ? 'rgba(38,166,154,.28)' : 'rgba(239,83,80,.28)';
      ctx.fillRect(plotW - chipW - 2, y - chipH / 2, chipW, chipH);
      ctx.fillStyle = bid ? '#8fe6d6' : '#ffb3ae';
      ctx.font = '8px var(--font-mono, monospace)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtWallSize(wall.notional), plotW - 4, y);
    });
    ctx.textAlign = 'left';
  }

  // Пунктирная линия последней цены + бейдж на оси — тот же приём, что в drawCandleChart.
  const last = slice[n - 1];
  const lastColor = last.c >= last.o ? OCHART_UP : OCHART_DOWN;
  const ly = yOf(last.c);
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = lastColor + '8c';
  ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = lastColor;
  ctx.fillRect(plotW + 1, ly - 7, padRight - 2, 14);
  ctx.fillStyle = '#0b0e14';
  ctx.font = 'bold 9px var(--font-mono, monospace)';
  ctx.fillText(fmtPrice(last.c), plotW + 4, ly);

  // Панель дельты (покупки-продажи по бакетам, см. deltaSeriesForSymbol) — честно только у
  // watchlist-монет, реальные данные потока сделок. Гистограмма от нулевой линии по центру полосы.
  if (hasDelta) {
    const series = opts.deltaSeries;
    let maxAbs = 0;
    series.forEach(function (d) { maxAbs = Math.max(maxAbs, Math.abs(d.delta)); });
    if (maxAbs <= 0) maxAbs = 1;
    const zeroY = deltaTop + deltaH / 2;
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(plotW, zeroY); ctx.stroke();
    series.forEach(function (d, i) {
      const x = i * slot + slot / 2;
      const half = (Math.abs(d.delta) / maxAbs) * (deltaH / 2 - 1);
      ctx.fillStyle = d.delta >= 0 ? 'rgba(38,166,154,.55)' : 'rgba(239,83,80,.55)';
      if (d.delta >= 0) ctx.fillRect(x - bodyW / 2, zeroY - half, bodyW, half);
      else ctx.fillRect(x - bodyW / 2, zeroY, bodyW, half);
    });
    ctx.fillStyle = 'rgba(255,255,255,.3)';
    ctx.font = '8px var(--font-mono, monospace)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('Дельта'), 2, deltaTop + 6);
  }

  // Ось времени внизу — 3 метки (начало/середина/конец видимого окна), формат ЧЧ:ММ, тот же приём
  // форматирования, что и в остальном приложении (см. историю сделок/журнал).
  if (showTimeAxis) {
    const axisY = h - padBottom - timeAxisH / 2;
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.font = '8px var(--font-mono, monospace)';
    ctx.textBaseline = 'middle';
    function hm(ts) {
      const d = new Date(ts);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    ctx.textAlign = 'left';
    ctx.fillText(hm(slice[0].t), 2, axisY);
    ctx.textAlign = 'center';
    ctx.fillText(hm(slice[Math.floor(n / 2)].t), plotW / 2, axisY);
    ctx.textAlign = 'right';
    ctx.fillText(hm(slice[n - 1].t), plotW - 2, axisY);
    ctx.textAlign = 'left';
  }

  // Маркеры алгоритмов (стр. «Паттерны», см. graphsMarkersForSymbol) поверх свечей — необязательные.
  // Экранные координаты каждого нарисованного маркера складываем на сам canvas (__markerHits) —
  // так наведение мыши (см. wireGraphsGridClick/mousemove) может показать полное объяснение через
  // native title, не пересчитывая координаты заново и не храня отдельный параллельный реестр.
  canvas.__markerHits = (opts.markers && opts.markers.length) ? drawMiniChartMarkers(ctx, opts.markers, slice, slot, yOf, plotW) : [];
}

// Рисует найденные алгоритмами события (см. graphsMarkersForSymbol) прямо поверх свечей мини-графика
// — стрелка вверх/вниз (LONG/SHORT) или точка (BOTH, не направленный сигнал), с коротким бейджем
// детектора под/над стрелкой. По мотивам разбора GodsEye (там сигналы боты/TWAP/плотности рисуются
// прямо на свечах, а не только отдельными карточками) — но сознательно без их сложной системы
// избежания наложений (chart-signal-markers.js): при типичном числе маркеров на мини-графике (0-3)
// это не нужно, а усложнять код ради гипотетического случая — лишнее.
function drawMiniChartMarkers(ctx, markers, slice, slot, yOf, plotW) {
  const t0 = slice[0].t, t1 = slice[slice.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const hits = []; // {x,y,ev} — для наведения мыши (см. drawMiniCandleChart/wireGraphsGridClick)
  markers.forEach(function (m) {
    if (m.time < t0 || m.time > t1) return; // маркер старше видимого окна графика — не рисуем за его пределами
    const idx = Math.round(((m.time - t0) / span) * (slice.length - 1));
    const x = Math.max(0, Math.min(plotW, idx * slot + slot / 2));
    const y = yOf(m.price);
    const up = m.direction === 'LONG', down = m.direction === 'SHORT';
    const color = up ? OCHART_UP : down ? OCHART_DOWN : '#8fcaff';
    const away = up ? -1 : 1;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    if (up || down) {
      ctx.moveTo(x, y + away * 10);
      ctx.lineTo(x - 4, y + away * 4);
      ctx.lineTo(x + 4, y + away * 4);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = '8px var(--font-mono, monospace)';
    ctx.textAlign = 'center';
    ctx.fillText(m.label, x, y + away * (up || down ? 16 : 12));
    ctx.restore();
    if (m.ev) hits.push({ x: x, y: y, ev: m.ev });
  });
  ctx.textAlign = 'left'; // сброс — остальной рендер canvas рассчитывает на left по умолчанию
  return hits;
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
    // Перетаскивание шкалы цены (справа от графика) / шкалы времени (снизу) — работает независимо
    // от выбранного инструмента рисования, как в TradingView, а не только в режиме "курсор".
    if (x > chart.plotW) {
      ownChartPriceScaleDrag = { startY: y, startMult: ownChartPriceScaleMult };
      return;
    }
    if (y > chart.volTop + chart.volumeH) {
      const n = ownChartCandles.length;
      const centerIdx = n - ownChartView.offset - ownChartView.visibleCount / 2;
      ownChartTimeScaleDrag = { startX: x, startVisible: ownChartView.visibleCount, centerIdx: centerIdx };
      return;
    }
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
    if (ownChartPriceScaleDrag) {
      const dy = y - ownChartPriceScaleDrag.startY;
      const factor = Math.exp(dy * 0.006); // тащим вниз — растягиваем (зум минус), вверх — сжимаем (зум плюс)
      ownChartPriceScaleMult = Math.max(0.15, Math.min(8, ownChartPriceScaleDrag.startMult * factor));
      redraw();
      return;
    }
    if (ownChartTimeScaleDrag) {
      const dx = x - ownChartTimeScaleDrag.startX;
      const factor = Math.exp(-dx * 0.006); // тащим вправо — сжимаем временную ось (зум ближе)
      const n = ownChartCandles.length;
      let newVisible = Math.round(ownChartTimeScaleDrag.startVisible * factor);
      newVisible = Math.max(20, Math.min(n, newVisible));
      const maxOffset = Math.max(0, n - newVisible);
      let newOffset = n - newVisible - (ownChartTimeScaleDrag.centerIdx - newVisible / 2);
      ownChartView.visibleCount = newVisible;
      ownChartView.offset = Math.max(0, Math.min(maxOffset, newOffset));
      redraw();
      return;
    }
    if (!ownChartPanDrag && !ownChartRulerDrag) {
      canvas.style.cursor = x > chart.plotW ? 'ns-resize' : (y > chart.volTop + chart.volumeH ? 'ew-resize' : '');
    }
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
    ownChartPriceScaleDrag = null;
    ownChartTimeScaleDrag = null;
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
  document.getElementById('infoCoinName').innerHTML = coinDisplayLabel(c);
  document.getElementById('infoCoinSub').textContent = exchangeSubLabel(c);
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
    // Шкала активности — не финансовая семантика (не рост/падение цены), а общий "насколько
    // горячая монета прямо сейчас" индикатор, поэтому верхний ярус красится в фирменный акцент
    // (магента), а не в зелёный — иначе на фоне остального розово-лавандового UI зелёный кружок
    // читался бы как чужеродный обрывок старой темы.
    statusEl.innerHTML = '<i class="ri-fire-line"></i> Высокая активность';
    statusEl.style.color = 'var(--accent)';
    gaugeFill.setAttribute('stroke', 'var(--accent)');
    gaugeFill.style.color = 'var(--accent)';
    if (algoPanel) algoPanel.style.setProperty('--gauge-glow', 'var(--neon-glow-soft)');
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
  const algosListEl = document.getElementById('activeAlgosList');
  if (algosListEl) algosListEl.innerHTML = activeAlgosPanelHtml(c.symbol);
  const statsListEl = document.getElementById('miniStatsList');
  if (statsListEl) statsListEl.innerHTML = miniStatsListHtml(c);
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

// Последнее реальное состояние MEXC WS-соединения — храним отдельно от того, что сейчас РИСУЕТСЯ
// на бейдже, потому что бейдж дополнительно перекрашивается под переключатель бирж (см.
// applyConnectionBadge/activeExchangeFilter) без нового события соединения.
let lastConnStatusMode = 'off';
let lastConnStatusText = '';

function setStatus(mode, text) {
  lastConnStatusMode = mode;
  lastConnStatusText = text;
  applyConnectionBadge();
}

// Красит и подписывает верхний статус-бейдж под текущий выбор в переключателе бирж (activeExchangeFilter,
// см. exchangeSwitch) — синяя MEXC, жёлтая светящаяся Binance, светлая OKX. Реальные проблемы связи
// (warn/off) всегда перекрывают бренд-цвет — статус соединения важнее того, какая биржа сейчас выбрана
// для просмотра. Вызывается и из setStatus() (новое событие соединения), и из клика по переключателю
// бирж (сама связь не менялась, но подпись/цвет бейджа должны обновиться немедленно).
function applyConnectionBadge() {
  const badge = document.getElementById('connectionStatus');
  if (!badge) return;
  const mode = lastConnStatusMode;
  let text = lastConnStatusText;
  let cls = 'status-badge';
  if (mode === 'warn') {
    cls += ' warn';
  } else if (mode === 'off') {
    cls += ' off';
  } else {
    const exch = activeExchangeFilter === 'ALL' ? 'MEXC' : activeExchangeFilter;
    // "BINANCEFUT" красится так же, как обычный Binance (та же биржа, другой рынок) — снимаем
    // суффикс только для класса цвета, не для отображаемого текста (см. EXCHANGE_SWITCH_TITLES).
    cls += ' exch-' + exch.replace(/FUT$/, '').toLowerCase();
    if (activeExchangeFilter !== 'ALL') text = (EXCHANGE_SWITCH_TITLES[exch] || exch).toUpperCase() + ' LIVE';
  }
  badge.className = cls;
  document.getElementById('statusText').textContent = text;
  const pill = document.getElementById('sidebarConn');
  pill.className = 'conn-pill ' + (mode === 'ok' ? 'ok' : mode === 'warn' ? 'warn' : 'err');
  document.getElementById('sidebarConnText').textContent = text;
  const ds = document.getElementById('dataStatus');
  ds.textContent = t('Поток:') + ' ' + text;
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
// Небольшое персистентное состояние между вызовами для двух алгоритмов ("Алгоритмы rebuild",
// 2026-09), которым честно нужна память дальше одного окна снимков — см. комментарий у
// MexcCore.detectDensityAbsorptionBreakout/detectFailedBreakout в core-utils.js. Сбрасывается при
// выходе монеты из watchlist (см. unsubscribeWatchlistSymbol).
const densityAbsorptionBreakoutState = new Map(); // symbol -> state
const failedBreakoutState = new Map();            // symbol -> state
// То же — для алгоритмов #14/#15 (rebuild "Алгоритмы" 11-16, 2026-09).
const possibleHiddenAbsorptionState = new Map();  // symbol -> state
const crossExchangeDivergenceState = new Map();   // symbol -> {[exchangeId]: state}
const cyclicalTimeWindowState = new Map();        // symbol -> {bucketKey, windowStartAt, windowStartPrice} — текущее незакрытое окно #16
const twapState = new Map();                      // symbol -> state (см. MexcCore.detectTwap, #17)
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
  densityAbsorptionBreakoutState.delete(symbol);
  failedBreakoutState.delete(symbol);
  possibleHiddenAbsorptionState.delete(symbol);
  crossExchangeDivergenceState.delete(symbol);
  cyclicalTimeWindowState.delete(symbol);
  twapState.delete(symbol);
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
// TIER 2 — BINANCE (мультибиржевой Tier 2, 2026-09). Тот же смысл, что у watchlist выше, но для
// споте Binance — свой отдельный, полностью самостоятельный набор Map'ов и WS-подключений, а НЕ
// переиспользование tier2Trades/watchlist/... (те намеренно остаются MEXC-only, трогать их —
// лишний риск сломать уже проверенный, годами обкатанный пайплайн). Пары ключа — тот же формат,
// что уже использует upsertExternalCoin ("BINANCE:BTC/USDT"), так что coinMap/allCoins/fetchKlines
// работают с этими символами без изменений.
//
// ЧЕСТНЫЙ ПРЕДОХРАНИТЕЛЬ: Binance-монеты вообще появляются в coinMap только когда пользователь сам
// подключил биржу (см. TIER2_EXTERNAL_EXCHANGES/upsertExternalCoin выше и connectExchange) — без
// подключённого аккаунта этот блок просто не находит кандидатов и ничего не подключает, а не
// выдаёт фиктивные данные.
//
// Отличие протокола от MEXC: у Binance один "комбинированный" WS на symbol покрывает И сделки, И
// стакан разом (никакого protobuf — обычный JSON), поэтому здесь ОДИН сокет на монету вместо двух.
// depth<N>@100ms — тоже ОГРАНИЧЕННЫЙ (top-20) снимок каждые ~100мс, ровно тот же "снимок, не диф"
// принцип, что и у канала стакана MEXC — никакой инкрементальной версии/resync не требуется.
// ============================================================================
const BINANCE_WS_STREAM = 'wss://stream.binance.com:9443/stream';
const BINANCE_WATCHLIST_SIZE = 15;         // скромнее MEXC — новая, менее обкатанная ветка
const BINANCE_WATCHLIST_HARD_CAP = 20;
const BINANCE_WATCHLIST_EVICT_MARGIN = 8;
const BINANCE_WATCHLIST_ADD_STREAK = 2;
const BINANCE_WATCHLIST_EVICT_STREAK = 3;
const BINANCE_WATCHLIST_EVAL_INTERVAL_MS = 20000;
const BINANCE_WATCHLIST_MAX_RECONNECT_FAILS = 10;
const BINANCE_WATCHLIST_COOLDOWN_MS = 5 * 60 * 1000;
const BINANCE_TIER2_TRADES_CAP = 2000;
const BINANCE_TIER2_DEPTH_CAP = 600;
const BINANCE_WATCHLIST_RECONNECT_DELAY_MS = 3000;
const BINANCE_WATCHLIST_SUBSCRIBE_STAGGER_MS = 2000;

const binanceTier2Trades = new Map();  // "BINANCE:BTC/USDT" -> ring buffer, тот же формат {t,price,qty,side}, что и tier2Trades
const binanceTier2Depth = new Map();   // "BINANCE:BTC/USDT" -> ring buffer, тот же формат {t,bids,asks,bestBid,bestAsk,bidVol,askVol}, что и tier2Depth
const binanceWatchlist = new Map();    // symbol -> {addedAt, ws, failStreak, blocked}
const binanceWatchlistPending = new Set();
const binanceWatchlistSubscribeQueue = [];
let binanceWatchlistSubscribeQueueTimer = null;
const binanceWatchlistCandidateStreaks = new Map();
const binanceWatchlistEvictStreaks = new Map();
const binanceWatchlistCooldowns = new Map();
// Состояние алгоритмов #6/#10/#14/#15/#17 для Binance — те же 5 карт, что и у MEXC, но отдельные (не
// шарим состояние между биржами: одна и та же базовая монета на разных биржах — разный стакан/поток).
const binanceDensityAbsorptionBreakoutState = new Map();
const binanceFailedBreakoutState = new Map();
const binancePossibleHiddenAbsorptionState = new Map();
const binanceCrossExchangeDivergenceState = new Map();
const binanceTwapState = new Map();
const binanceTier2Health = { watchlistSize: 0, connectionAttempts: 0, tradesIngested: 0, depthPushesIngested: 0, cooldownDrops: 0 };

function binanceWatchlistInCooldown(symbol) {
  const until = binanceWatchlistCooldowns.get(symbol);
  if (until == null) return false;
  if (Date.now() >= until) { binanceWatchlistCooldowns.delete(symbol); return false; }
  return true;
}

function binanceWatchlistHandleConnFail(symbol, kind) {
  logW('Watchlist', 'Binance ' + symbol + ': ' + kind + ' — ' + BINANCE_WATCHLIST_MAX_RECONNECT_FAILS + ' неудачных попыток подряд, уходит в cooldown');
  binanceWatchlistCooldowns.set(symbol, Date.now() + BINANCE_WATCHLIST_COOLDOWN_MS);
  binanceTier2Health.cooldownDrops++;
  unsubscribeBinanceWatchlistSymbol(symbol);
}

// Один комбинированный сокет на монету: <lower>@trade (сделки) + <lower>@depth20@100ms (топ-20
// стакана, снимок целиком на каждое сообщение — не диф). m===true у сделки означает "покупатель —
// мейкер", т.е. агрессором (тейкером) была ПРОДАЖА — см. документацию Binance WS trade stream.
function openBinanceWatchlistWs(symbol, lower, entry) {
  binanceTier2Health.connectionAttempts++;
  let sock;
  try {
    sock = new WebSocket(BINANCE_WS_STREAM + '?streams=' + lower + '@trade/' + lower + '@depth20@100ms');
  } catch (e) { binanceWatchlistHandleConnFail(symbol, 'не удалось создать сокет'); return; }
  entry.ws = sock;
  sock.onopen = function () { entry.failStreak = 0; };
  sock.onmessage = function (ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    const stream = String(msg.stream || ''), data = msg.data;
    if (!data) return;
    if (stream.indexOf('@trade') !== -1) {
      pushRing(binanceTier2Trades, symbol, {
        t: Number(data.T) || Date.now(), price: num(data.p), qty: num(data.q), side: data.m ? 'sell' : 'buy'
      }, BINANCE_TIER2_TRADES_CAP);
      binanceTier2Health.tradesIngested++;
    } else if (stream.indexOf('@depth') !== -1) {
      const bids = (data.bids || []).map(function (x) { return { p: num(x[0]), q: num(x[1]) }; });
      const asks = (data.asks || []).map(function (x) { return { p: num(x[0]), q: num(x[1]) }; });
      const bidVol = bids.reduce(function (a, x) { return a + x.p * x.q; }, 0);
      const askVol = asks.reduce(function (a, x) { return a + x.p * x.q; }, 0);
      pushRing(binanceTier2Depth, symbol, {
        t: Date.now(), bids: bids, asks: asks,
        bestBid: bids.length ? bids[0].p : null, bestAsk: asks.length ? asks[0].p : null,
        bidVol: bidVol, askVol: askVol
      }, BINANCE_TIER2_DEPTH_CAP);
      binanceTier2Health.depthPushesIngested++;
    }
  };
  sock.onerror = function () {};
  sock.onclose = function () {
    if (entry.ws !== sock) return;
    entry.ws = null;
    if (!binanceWatchlist.has(symbol)) return;
    entry.failStreak = (entry.failStreak || 0) + 1;
    if (entry.failStreak >= BINANCE_WATCHLIST_MAX_RECONNECT_FAILS) {
      binanceWatchlistHandleConnFail(symbol, 'соединение');
    } else {
      setTimeout(function () { if (binanceWatchlist.has(symbol)) openBinanceWatchlistWs(symbol, lower, entry); }, BINANCE_WATCHLIST_RECONNECT_DELAY_MS);
    }
  };
}

function subscribeBinanceWatchlistSymbol(symbol, raw) {
  if (binanceWatchlist.has(symbol) || binanceWatchlistPending.has(symbol)) return;
  binanceWatchlistPending.add(symbol);
  binanceWatchlistSubscribeQueue.push({ symbol: symbol, raw: raw });
  drainBinanceWatchlistSubscribeQueue();
}
function drainBinanceWatchlistSubscribeQueue() {
  if (binanceWatchlistSubscribeQueueTimer) return;
  const next = binanceWatchlistSubscribeQueue.shift();
  if (!next) return;
  binanceWatchlistPending.delete(next.symbol);
  subscribeBinanceWatchlistSymbolNow(next.symbol, next.raw);
  binanceWatchlistSubscribeQueueTimer = setTimeout(function () {
    binanceWatchlistSubscribeQueueTimer = null;
    drainBinanceWatchlistSubscribeQueue();
  }, BINANCE_WATCHLIST_SUBSCRIBE_STAGGER_MS);
}
function subscribeBinanceWatchlistSymbolNow(symbol, raw) {
  if (binanceWatchlist.has(symbol)) return;
  const entry = { addedAt: Date.now(), ws: null, failStreak: 0 };
  binanceWatchlist.set(symbol, entry);
  logI('Watchlist', 'Binance ' + symbol + ' добавлена в глубокий анализ (' + raw + ')');
  openBinanceWatchlistWs(symbol, raw.toLowerCase(), entry);
}
function unsubscribeBinanceWatchlistSymbol(symbol) {
  binanceWatchlistPending.delete(symbol);
  for (let i = binanceWatchlistSubscribeQueue.length - 1; i >= 0; i--) {
    if (binanceWatchlistSubscribeQueue[i].symbol === symbol) binanceWatchlistSubscribeQueue.splice(i, 1);
  }
  const entry = binanceWatchlist.get(symbol);
  if (!entry) return;
  try { if (entry.ws) { entry.ws.onclose = null; entry.ws.close(); } } catch (e) {}
  binanceWatchlist.delete(symbol);
  binanceWatchlistEvictStreaks.delete(symbol);
  binanceDensityAbsorptionBreakoutState.delete(symbol);
  binanceFailedBreakoutState.delete(symbol);
  binancePossibleHiddenAbsorptionState.delete(symbol);
  binanceCrossExchangeDivergenceState.delete(symbol);
  binanceTwapState.delete(symbol);
  logI('Watchlist', 'Binance ' + symbol + ' исключена из глубокого анализа');
}

// Форсированные символы для Binance — та же идея, что tier2ForcedSymbols(), но избранное/открытая
// монета учитываются, только если они САМИ Binance-монеты (иначе форсировали бы подписку на монету,
// для которой у нас даже нет Binance-цены).
function binanceTier2ForcedSymbols() {
  const forced = new Set();
  if (currentCoin && currentCoin.exchange === 'BINANCE') forced.add(currentCoin.symbol);
  allCoins.forEach(function (c) { if (c.fav && c.exchange === 'BINANCE') forced.add(c.symbol); });
  return forced;
}

function evaluateBinanceWatchlist() {
  const ranked = allCoins
    .filter(function (c) { return c.exchange === 'BINANCE' && c.__wlScore >= 0 && !binanceWatchlistInCooldown(c.symbol); })
    .slice()
    .sort(function (a, b) { return b.__wlScore - a.__wlScore; })
    .map(function (c) { return c.symbol; });

  const forced = binanceTier2ForcedSymbols();
  const currentMembers = new Set(binanceWatchlist.keys());
  binanceWatchlistPending.forEach(function (s) { currentMembers.add(s); });

  const transitions = MexcCore.computeWatchlistTransitions({
    rankedSymbols: ranked,
    currentMembers: currentMembers,
    candidateStreaks: binanceWatchlistCandidateStreaks,
    evictStreaks: binanceWatchlistEvictStreaks,
    size: BINANCE_WATCHLIST_SIZE,
    evictMargin: BINANCE_WATCHLIST_EVICT_MARGIN,
    addStreakNeeded: BINANCE_WATCHLIST_ADD_STREAK,
    evictStreakNeeded: BINANCE_WATCHLIST_EVICT_STREAK,
    forced: forced,
    maxSize: BINANCE_WATCHLIST_HARD_CAP
  });

  transitions.toEvict.forEach(unsubscribeBinanceWatchlistSymbol);
  transitions.toAdd.forEach(function (symbol) {
    const coin = coinMap.get(symbol);
    if (coin) subscribeBinanceWatchlistSymbol(symbol, coin.raw);
  });
  binanceTier2Health.watchlistSize = binanceWatchlist.size;
}
setInterval(evaluateBinanceWatchlist, BINANCE_WATCHLIST_EVAL_INTERVAL_MS);
setTimeout(evaluateBinanceWatchlist, 5000);

// ============================================================================
// TIER 2 — OKX (мультибиржевой Tier 2, продолжение — тот же принцип, что у Binance выше: свои
// отдельные Map'ы/состояние, ключ "OKX:BTC/USDT", MEXC/Binance не трогаем). ЧЕСТНЫЙ ПРЕДОХРАНИТЕЛЬ
// тот же: OKX-монеты попадают в coinMap только когда пользователь сам подключил биржу (см.
// connectExchange) — без этого allCoins.filter(exchange==='OKX') просто пуст, и блок ничего не
// подключает.
//
// Протокол ОТЛИЧАЕТСЯ от Binance ещё сильнее, чем Binance от MEXC: у OKX нет отдельного сокета на
// монету — ОДИН публичный WS (wss://ws.okx.com:8443/ws/v5/public) на ВСЮ биржу разом, а какие именно
// инструменты слушать, сообщается op:"subscribe"/"unsubscribe" сообщениями поверх уже открытого
// соединения. Значит: (1) подписка/отписка — это не "открыть/закрыть сокет", а отправка сообщения
// в уже живой канал; (2) при обрыве и переподключении нужно заново переподписаться на ВСЕ текущие
// watchlist-монеты разом (сервер ничего не помнит про разорванное соединение); (3) OKX требует
// keepalive: если за 30с в канале не было вообще никакого сообщения (включая наши), сервер сам рвёт
// соединение — шлём литеральный текст "ping" каждые ~20с, сервер отвечает "pong" (не JSON, отдельная
// ветка в onmessage).
//
// Глубина стакана — books5 (топ-5 уровней, снимок целиком на каждое сообщение): у OKX это
// единственный snapshot-канал без необходимости поддерживать инкрементальный ресинк с чек-суммой
// (полный "books" — 400 уровней, но diff+seqId+checksum, ощутимо сложнее и не даёт принципиально
// лучших детекций на нашем горизонте). Честно меньше уровней, чем 20 у MEXC/Binance — это реальное
// ограничение канала, а не наша недоработка; стены здесь будут грубее, но настоящие.
// ============================================================================
const OKX_WS_PUBLIC = 'wss://ws.okx.com:8443/ws/v5/public';
const OKX_WATCHLIST_SIZE = 15;
const OKX_WATCHLIST_HARD_CAP = 20;
const OKX_WATCHLIST_EVICT_MARGIN = 8;
const OKX_WATCHLIST_ADD_STREAK = 2;
const OKX_WATCHLIST_EVICT_STREAK = 3;
const OKX_WATCHLIST_EVAL_INTERVAL_MS = 20000;
const OKX_WATCHLIST_COOLDOWN_MS = 5 * 60 * 1000;
const OKX_TIER2_TRADES_CAP = 2000;
const OKX_TIER2_DEPTH_CAP = 600;
const OKX_WS_RECONNECT_DELAY_MS = 3000;
const OKX_WS_PING_INTERVAL_MS = 20000;

const okxTier2Trades = new Map();  // "OKX:BTC/USDT" -> ring buffer {t,price,qty,side}, тот же формат что tier2Trades
const okxTier2Depth = new Map();   // "OKX:BTC/USDT" -> ring buffer {t,bids,asks,bestBid,bestAsk,bidVol,askVol}
const okxWatchlist = new Map();    // symbol -> {addedAt, instId}
const okxWatchlistCandidateStreaks = new Map();
const okxWatchlistEvictStreaks = new Map();
const okxWatchlistCooldowns = new Map();
const okxInstIdToSymbol = new Map(); // "BTC-USDT" -> "OKX:BTC/USDT", для быстрого разбора входящих сообщений
// Состояние алгоритмов #6/#10/#14/#15/#17 для OKX — те же 5 карт, что у MEXC/Binance, но отдельные.
const okxDensityAbsorptionBreakoutState = new Map();
const okxFailedBreakoutState = new Map();
const okxPossibleHiddenAbsorptionState = new Map();
const okxCrossExchangeDivergenceState = new Map();
const okxTwapState = new Map();
const okxTier2Health = { watchlistSize: 0, connectionAttempts: 0, tradesIngested: 0, depthPushesIngested: 0, cooldownDrops: 0 };

let okxWs = null;
let okxWsReady = false; // соединение открыто И мы уже отправили подписки на весь текущий watchlist
let okxWsReconnectTimer = null;
let okxPingTimer = null;

// "BTC/USDT" -> "BTC-USDT" (instId OKX всегда через дефис, наш внутренний raw/symbol — без него).
function okxInstIdFromPair(pair) {
  return pair.replace('/', '-');
}

function okxWatchlistInCooldown(symbol) {
  const until = okxWatchlistCooldowns.get(symbol);
  if (until == null) return false;
  if (Date.now() >= until) { okxWatchlistCooldowns.delete(symbol); return false; }
  return true;
}

function okxWsSend(obj) {
  if (!okxWs || okxWs.readyState !== WebSocket.OPEN) return;
  try { okxWs.send(JSON.stringify(obj)); } catch (e) {}
}

function okxSubscribeArgsFor(instId) {
  return [{ channel: 'trades', instId: instId }, { channel: 'books5', instId: instId }];
}

// Вынесена из sock.onmessage именованной функцией (не анонимным замыканием) — так её можно
// проверить напрямую (см. window.__okxHandleMessage), не поднимая настоящий WS-сокет.
function handleOkxWsMessage(raw) {
  if (raw === 'pong') return;
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || !msg.arg || !msg.data) return;
  const instId = msg.arg.instId;
  const symbol = okxInstIdToSymbol.get(instId);
  if (!symbol) return;
  if (msg.arg.channel === 'trades') {
    msg.data.forEach(function (tr) {
      pushRing(okxTier2Trades, symbol, {
        t: Number(tr.ts) || Date.now(), price: num(tr.px), qty: num(tr.sz), side: tr.side === 'sell' ? 'sell' : 'buy'
      }, OKX_TIER2_TRADES_CAP);
      okxTier2Health.tradesIngested++;
    });
  } else if (msg.arg.channel === 'books5') {
    const snap = msg.data[0];
    if (!snap) return;
    // OKX-уровень — [price, size, устаревшее поле "0", numOrders] — берём только price/size.
    const bids = (snap.bids || []).map(function (x) { return { p: num(x[0]), q: num(x[1]) }; });
    const asks = (snap.asks || []).map(function (x) { return { p: num(x[0]), q: num(x[1]) }; });
    const bidVol = bids.reduce(function (a, x) { return a + x.p * x.q; }, 0);
    const askVol = asks.reduce(function (a, x) { return a + x.p * x.q; }, 0);
    pushRing(okxTier2Depth, symbol, {
      t: Date.now(), bids: bids, asks: asks,
      bestBid: bids.length ? bids[0].p : null, bestAsk: asks.length ? asks[0].p : null,
      bidVol: bidVol, askVol: askVol
    }, OKX_TIER2_DEPTH_CAP);
    okxTier2Health.depthPushesIngested++;
  }
}

function ensureOkxWs() {
  if (okxWs && (okxWs.readyState === WebSocket.OPEN || okxWs.readyState === WebSocket.CONNECTING)) return;
  okxTier2Health.connectionAttempts++;
  let sock;
  try {
    sock = new WebSocket(OKX_WS_PUBLIC);
  } catch (e) {
    logW('Watchlist', 'OKX: не удалось создать сокет — ' + e.message);
    scheduleOkxReconnect();
    return;
  }
  okxWs = sock;
  okxWsReady = false;
  sock.onopen = function () {
    if (okxWs !== sock) return;
    clearTimeout(okxWsReconnectTimer);
    // Свежее соединение ничего не помнит про предыдущие подписки — переподписываемся на ВЕСЬ
    // текущий watchlist одним сообщением (OKX принимает несколько args в одном op:"subscribe").
    const args = [];
    okxWatchlist.forEach(function (entry) { args.push.apply(args, okxSubscribeArgsFor(entry.instId)); });
    if (args.length) okxWsSend({ op: 'subscribe', args: args });
    okxWsReady = true;
    clearInterval(okxPingTimer);
    okxPingTimer = setInterval(function () { if (okxWs === sock && sock.readyState === WebSocket.OPEN) sock.send('ping'); }, OKX_WS_PING_INTERVAL_MS);
  };
  sock.onmessage = function (ev) { handleOkxWsMessage(ev.data); };
  sock.onerror = function () {};
  sock.onclose = function () {
    if (okxWs !== sock) return;
    okxWs = null;
    okxWsReady = false;
    clearInterval(okxPingTimer);
    if (!okxWatchlist.size) return; // никого слушать — не переподключаемся впустую
    scheduleOkxReconnect();
  };
}
function scheduleOkxReconnect() {
  clearTimeout(okxWsReconnectTimer);
  okxWsReconnectTimer = setTimeout(function () { if (okxWatchlist.size) ensureOkxWs(); }, OKX_WS_RECONNECT_DELAY_MS);
}

function subscribeOkxWatchlistSymbol(symbol, raw) {
  if (okxWatchlist.has(symbol)) return;
  const base = symbol.replace('OKX:', '');
  const instId = okxInstIdFromPair(base);
  const entry = { addedAt: Date.now(), instId: instId };
  okxWatchlist.set(symbol, entry);
  okxInstIdToSymbol.set(instId, symbol);
  logI('Watchlist', 'OKX ' + symbol + ' добавлена в глубокий анализ (' + raw + ')');
  ensureOkxWs();
  if (okxWsReady) okxWsSend({ op: 'subscribe', args: okxSubscribeArgsFor(instId) });
  // иначе — ws ещё не открыт/не готов, onopen сам переподпишет на весь текущий watchlist
}
function unsubscribeOkxWatchlistSymbol(symbol) {
  const entry = okxWatchlist.get(symbol);
  if (!entry) return;
  if (okxWsReady) okxWsSend({ op: 'unsubscribe', args: okxSubscribeArgsFor(entry.instId) });
  okxInstIdToSymbol.delete(entry.instId);
  okxWatchlist.delete(symbol);
  okxWatchlistEvictStreaks.delete(symbol);
  okxDensityAbsorptionBreakoutState.delete(symbol);
  okxFailedBreakoutState.delete(symbol);
  okxPossibleHiddenAbsorptionState.delete(symbol);
  okxCrossExchangeDivergenceState.delete(symbol);
  okxTwapState.delete(symbol);
  logI('Watchlist', 'OKX ' + symbol + ' исключена из глубокого анализа');
  if (!okxWatchlist.size && okxWs) { try { okxWs.close(); } catch (e) {} } // никого не слушаем — держать канал открытым незачем
}

// Форсированные символы для OKX — та же идея, что и у Binance (currentCoin/избранное, только если
// это реально OKX-монета).
function okxTier2ForcedSymbols() {
  const forced = new Set();
  if (currentCoin && currentCoin.exchange === 'OKX') forced.add(currentCoin.symbol);
  allCoins.forEach(function (c) { if (c.fav && c.exchange === 'OKX') forced.add(c.symbol); });
  return forced;
}

function evaluateOkxWatchlist() {
  const ranked = allCoins
    .filter(function (c) { return c.exchange === 'OKX' && c.__wlScore >= 0 && !okxWatchlistInCooldown(c.symbol); })
    .slice()
    .sort(function (a, b) { return b.__wlScore - a.__wlScore; })
    .map(function (c) { return c.symbol; });

  const forced = okxTier2ForcedSymbols();
  const currentMembers = new Set(okxWatchlist.keys());

  const transitions = MexcCore.computeWatchlistTransitions({
    rankedSymbols: ranked,
    currentMembers: currentMembers,
    candidateStreaks: okxWatchlistCandidateStreaks,
    evictStreaks: okxWatchlistEvictStreaks,
    size: OKX_WATCHLIST_SIZE,
    evictMargin: OKX_WATCHLIST_EVICT_MARGIN,
    addStreakNeeded: OKX_WATCHLIST_ADD_STREAK,
    evictStreakNeeded: OKX_WATCHLIST_EVICT_STREAK,
    forced: forced,
    maxSize: OKX_WATCHLIST_HARD_CAP
  });

  transitions.toEvict.forEach(unsubscribeOkxWatchlistSymbol);
  transitions.toAdd.forEach(function (symbol) {
    const coin = coinMap.get(symbol);
    if (coin) subscribeOkxWatchlistSymbol(symbol, coin.raw);
  });
  okxTier2Health.watchlistSize = okxWatchlist.size;
}
setInterval(evaluateOkxWatchlist, OKX_WATCHLIST_EVAL_INTERVAL_MS);
setTimeout(evaluateOkxWatchlist, 5000);

// ============================================================================
// TIER 2 — BITGET (мультибиржевой Tier 2, продолжение). Архитектурно ближе к OKX, чем к Binance —
// у Bitget тоже НЕТ сокета на монету, один общий публичный WS (wss://ws.bitget.com/v2/ws/public) на
// всю биржу, подписка/отписка — op:"subscribe"/"unsubscribe" сообщения с {instType,channel,instId}
// поверх уже открытого канала. Keepalive иначе, чем у OKX: клиент шлёт литеральный "ping" раз в 30с,
// сервер отвечает "pong"; если сервер не получает "ping" 2 минуты — сам рвёт соединение (мягче, чем
// 30-секундный таймаут OKX, но шлём с тем же запасом ~25с, что и там).
//
// Глубина — books15 (топ-15 уровней, снимок целиком на каждое сообщение) — у Bitget шире, чем
// books5 у OKX (там только топ-5), ближе к 20 уровням MEXC/Binance. Формат уровня — [price, size]
// (пара, без доп. полей, в отличие от 4-элементных уровней OKX).
//
// Символ Bitget — БЕЗ разделителя ("BTCUSDT"), как у MEXC/Binance — конвертация instId не нужна,
// в отличие от OKX (там всегда через дефис).
// ============================================================================
const BITGET_WS_PUBLIC = 'wss://ws.bitget.com/v2/ws/public';
const BITGET_WATCHLIST_SIZE = 15;
const BITGET_WATCHLIST_HARD_CAP = 20;
const BITGET_WATCHLIST_EVICT_MARGIN = 8;
const BITGET_WATCHLIST_ADD_STREAK = 2;
const BITGET_WATCHLIST_EVICT_STREAK = 3;
const BITGET_WATCHLIST_EVAL_INTERVAL_MS = 20000;
const BITGET_WATCHLIST_COOLDOWN_MS = 5 * 60 * 1000;
const BITGET_TIER2_TRADES_CAP = 2000;
const BITGET_TIER2_DEPTH_CAP = 600;
const BITGET_WS_RECONNECT_DELAY_MS = 3000;
const BITGET_WS_PING_INTERVAL_MS = 25000;

const bitgetTier2Trades = new Map();  // "BITGET:BTC/USDT" -> ring buffer {t,price,qty,side}
const bitgetTier2Depth = new Map();   // "BITGET:BTC/USDT" -> ring buffer {t,bids,asks,bestBid,bestAsk,bidVol,askVol}
const bitgetWatchlist = new Map();    // symbol -> {addedAt, instId}
const bitgetWatchlistCandidateStreaks = new Map();
const bitgetWatchlistEvictStreaks = new Map();
const bitgetWatchlistCooldowns = new Map();
const bitgetInstIdToSymbol = new Map(); // "BTCUSDT" -> "BITGET:BTC/USDT"
const bitgetDensityAbsorptionBreakoutState = new Map();
const bitgetFailedBreakoutState = new Map();
const bitgetPossibleHiddenAbsorptionState = new Map();
const bitgetCrossExchangeDivergenceState = new Map();
const bitgetTwapState = new Map();
const bitgetTier2Health = { watchlistSize: 0, connectionAttempts: 0, tradesIngested: 0, depthPushesIngested: 0, cooldownDrops: 0 };

let bitgetWs = null;
let bitgetWsReady = false;
let bitgetWsReconnectTimer = null;
let bitgetPingTimer = null;

function bitgetWatchlistInCooldown(symbol) {
  const until = bitgetWatchlistCooldowns.get(symbol);
  if (until == null) return false;
  if (Date.now() >= until) { bitgetWatchlistCooldowns.delete(symbol); return false; }
  return true;
}

function bitgetWsSend(obj) {
  if (!bitgetWs || bitgetWs.readyState !== WebSocket.OPEN) return;
  try { bitgetWs.send(JSON.stringify(obj)); } catch (e) {}
}

function bitgetSubscribeArgsFor(instId) {
  return [{ instType: 'SPOT', channel: 'trade', instId: instId }, { instType: 'SPOT', channel: 'books15', instId: instId }];
}

// Вынесена именованной функцией — как и handleOkxWsMessage, проверяема напрямую (window.__bitgetHandleMessage).
function handleBitgetWsMessage(raw) {
  if (raw === 'pong') return;
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || !msg.arg || !msg.data) return;
  const instId = msg.arg.instId;
  const symbol = bitgetInstIdToSymbol.get(instId);
  if (!symbol) return;
  if (msg.arg.channel === 'trade') {
    msg.data.forEach(function (tr) {
      pushRing(bitgetTier2Trades, symbol, {
        t: Number(tr.ts) || Date.now(), price: num(tr.price), qty: num(tr.size), side: tr.side === 'sell' ? 'sell' : 'buy'
      }, BITGET_TIER2_TRADES_CAP);
      bitgetTier2Health.tradesIngested++;
    });
  } else if (msg.arg.channel === 'books15' || msg.arg.channel === 'books5') {
    const snap = msg.data[0];
    if (!snap) return;
    // Уровень Bitget — [price, size], без доп. полей (в отличие от 4-элементных уровней OKX).
    const bids = (snap.bids || []).map(function (x) { return { p: num(x[0]), q: num(x[1]) }; });
    const asks = (snap.asks || []).map(function (x) { return { p: num(x[0]), q: num(x[1]) }; });
    const bidVol = bids.reduce(function (a, x) { return a + x.p * x.q; }, 0);
    const askVol = asks.reduce(function (a, x) { return a + x.p * x.q; }, 0);
    pushRing(bitgetTier2Depth, symbol, {
      t: Date.now(), bids: bids, asks: asks,
      bestBid: bids.length ? bids[0].p : null, bestAsk: asks.length ? asks[0].p : null,
      bidVol: bidVol, askVol: askVol
    }, BITGET_TIER2_DEPTH_CAP);
    bitgetTier2Health.depthPushesIngested++;
  }
}

function ensureBitgetWs() {
  if (bitgetWs && (bitgetWs.readyState === WebSocket.OPEN || bitgetWs.readyState === WebSocket.CONNECTING)) return;
  bitgetTier2Health.connectionAttempts++;
  let sock;
  try {
    sock = new WebSocket(BITGET_WS_PUBLIC);
  } catch (e) {
    logW('Watchlist', 'Bitget: не удалось создать сокет — ' + e.message);
    scheduleBitgetReconnect();
    return;
  }
  bitgetWs = sock;
  bitgetWsReady = false;
  sock.onopen = function () {
    if (bitgetWs !== sock) return;
    clearTimeout(bitgetWsReconnectTimer);
    const args = [];
    bitgetWatchlist.forEach(function (entry) { args.push.apply(args, bitgetSubscribeArgsFor(entry.instId)); });
    if (args.length) bitgetWsSend({ op: 'subscribe', args: args });
    bitgetWsReady = true;
    clearInterval(bitgetPingTimer);
    bitgetPingTimer = setInterval(function () { if (bitgetWs === sock && sock.readyState === WebSocket.OPEN) sock.send('ping'); }, BITGET_WS_PING_INTERVAL_MS);
  };
  sock.onmessage = function (ev) { handleBitgetWsMessage(ev.data); };
  sock.onerror = function () {};
  sock.onclose = function () {
    if (bitgetWs !== sock) return;
    bitgetWs = null;
    bitgetWsReady = false;
    clearInterval(bitgetPingTimer);
    if (!bitgetWatchlist.size) return;
    scheduleBitgetReconnect();
  };
}
function scheduleBitgetReconnect() {
  clearTimeout(bitgetWsReconnectTimer);
  bitgetWsReconnectTimer = setTimeout(function () { if (bitgetWatchlist.size) ensureBitgetWs(); }, BITGET_WS_RECONNECT_DELAY_MS);
}

function subscribeBitgetWatchlistSymbol(symbol, raw) {
  if (bitgetWatchlist.has(symbol)) return;
  const instId = raw; // без разделителя, raw уже в нужном формате
  const entry = { addedAt: Date.now(), instId: instId };
  bitgetWatchlist.set(symbol, entry);
  bitgetInstIdToSymbol.set(instId, symbol);
  logI('Watchlist', 'Bitget ' + symbol + ' добавлена в глубокий анализ (' + raw + ')');
  ensureBitgetWs();
  if (bitgetWsReady) bitgetWsSend({ op: 'subscribe', args: bitgetSubscribeArgsFor(instId) });
}
function unsubscribeBitgetWatchlistSymbol(symbol) {
  const entry = bitgetWatchlist.get(symbol);
  if (!entry) return;
  if (bitgetWsReady) bitgetWsSend({ op: 'unsubscribe', args: bitgetSubscribeArgsFor(entry.instId) });
  bitgetInstIdToSymbol.delete(entry.instId);
  bitgetWatchlist.delete(symbol);
  bitgetWatchlistEvictStreaks.delete(symbol);
  bitgetDensityAbsorptionBreakoutState.delete(symbol);
  bitgetFailedBreakoutState.delete(symbol);
  bitgetPossibleHiddenAbsorptionState.delete(symbol);
  bitgetCrossExchangeDivergenceState.delete(symbol);
  bitgetTwapState.delete(symbol);
  logI('Watchlist', 'Bitget ' + symbol + ' исключена из глубокого анализа');
  if (!bitgetWatchlist.size && bitgetWs) { try { bitgetWs.close(); } catch (e) {} }
}

function bitgetTier2ForcedSymbols() {
  const forced = new Set();
  if (currentCoin && currentCoin.exchange === 'BITGET') forced.add(currentCoin.symbol);
  allCoins.forEach(function (c) { if (c.fav && c.exchange === 'BITGET') forced.add(c.symbol); });
  return forced;
}

function evaluateBitgetWatchlist() {
  const ranked = allCoins
    .filter(function (c) { return c.exchange === 'BITGET' && c.__wlScore >= 0 && !bitgetWatchlistInCooldown(c.symbol); })
    .slice()
    .sort(function (a, b) { return b.__wlScore - a.__wlScore; })
    .map(function (c) { return c.symbol; });

  const forced = bitgetTier2ForcedSymbols();
  const currentMembers = new Set(bitgetWatchlist.keys());

  const transitions = MexcCore.computeWatchlistTransitions({
    rankedSymbols: ranked,
    currentMembers: currentMembers,
    candidateStreaks: bitgetWatchlistCandidateStreaks,
    evictStreaks: bitgetWatchlistEvictStreaks,
    size: BITGET_WATCHLIST_SIZE,
    evictMargin: BITGET_WATCHLIST_EVICT_MARGIN,
    addStreakNeeded: BITGET_WATCHLIST_ADD_STREAK,
    evictStreakNeeded: BITGET_WATCHLIST_EVICT_STREAK,
    forced: forced,
    maxSize: BITGET_WATCHLIST_HARD_CAP
  });

  transitions.toEvict.forEach(unsubscribeBitgetWatchlistSymbol);
  transitions.toAdd.forEach(function (symbol) {
    const coin = coinMap.get(symbol);
    if (coin) subscribeBitgetWatchlistSymbol(symbol, coin.raw);
  });
  bitgetTier2Health.watchlistSize = bitgetWatchlist.size;
}
setInterval(evaluateBitgetWatchlist, BITGET_WATCHLIST_EVAL_INTERVAL_MS);
setTimeout(evaluateBitgetWatchlist, 5000);

// Единственные два места во всём детекторном движке, которым честно нужно прочитать буфер ПО ЛЮБОЙ
// поддерживаемой бирже, а не только MEXC (см. sweepCyclicalOutcomes/flushTimeWindowIfDue ниже) —
// не переписываем сами tier2Trades/tier2Depth (MEXC-only, трогать лишний раз рискованно), просто
// выбираем нужную Map по префиксу символа ("OKX:"/"BINANCE:"/"BITGET:" -> своя биржа, иначе MEXC).
function tier2TradesForSymbol(symbol) {
  if (symbol.indexOf('OKX:') === 0) return okxTier2Trades.get(symbol);
  if (symbol.indexOf('BITGET:') === 0) return bitgetTier2Trades.get(symbol);
  return symbol.indexOf('BINANCE:') === 0 ? binanceTier2Trades.get(symbol) : tier2Trades.get(symbol);
}
function tier2DepthForSymbol(symbol) {
  if (symbol.indexOf('OKX:') === 0) return okxTier2Depth.get(symbol);
  if (symbol.indexOf('BITGET:') === 0) return bitgetTier2Depth.get(symbol);
  return symbol.indexOf('BINANCE:') === 0 ? binanceTier2Depth.get(symbol) : tier2Depth.get(symbol);
}

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
// Единственный ВПЕРЁД смотрящий (не постфактум) детектор стакана — см. комментарий у
// MexcCore.detectStandingWall. Используется и здесь (Паттерны, Tier 2 UI), и напрямую из
// STRATEGY_DEFS.density.match() на скринере — для watchlist-монет "Сайз" теперь опирается на
// РЕАЛЬНЫЙ стакан вместо тиковой эвристики (см. её же комментарий).
function detectStandingWall(symbol) {
  // minWallRatio: 5 — пользовательский фидбэк: 3х над соседними уровнями ловило слишком мелкие
  // "стены" (на книге, где обычный уровень ~10K, 3х — это всего 30K, недостаточно для настоящего
  // пробоя). 5х (например 10K типичный уровень -> 50K+ стена) — заметно более строгий, честный
  // порог именно под "крупную плотность, которая пойдёт на пробой".
  const ev = MexcCore.detectStandingWall(tier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.standingWall.minRepeats, lookback: 20, minWallRatio: 5, maxDistancePct: 1.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}

// ------------------------------------------------------------------------------------------
// 10 приоритетных алгоритмов из ТЗ пользователя (rebuild "Алгоритмы", 2026-09) — обёртки над
// чистыми MexcCore.detectX(...) (core-utils.js, юнит-тесты — tests/verify_<algo>.js), тот же
// wrapper-паттерн, что и у detectStandingWall выше. Два детектора (densityAbsorptionBreakout,
// failedBreakout) честно нуждаются в состоянии между вызовами — {event, state} контракт, state
// хранится в densityAbsorptionBreakoutState/failedBreakoutState выше.
// ------------------------------------------------------------------------------------------
function detectDensityBreak(symbol) {
  const ev = MexcCore.detectDensityBreak(tier2Depth.get(symbol), tier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityBreak.minRepeats, lookback: 300, minWallRatio: 5, minShrinkRatio: 0.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorption(symbol) {
  const ev = MexcCore.detectDensityAbsorption(tier2Depth.get(symbol), tier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityAbsorption.minRepeats, lookback: 300, minWallRatio: 5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquiditySweep(symbol) {
  const ev = MexcCore.detectLiquiditySweep(tier2Trades.get(symbol), tier2Depth.get(symbol), { lookback: 200 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectImpulsePullbackContinuation(symbol) {
  const ev = MexcCore.detectImpulsePullbackContinuation(tier2Trades.get(symbol), { lookback: 300 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPriceVolumeInefficiency(symbol) {
  const ev = MexcCore.detectPriceVolumeInefficiency(tier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorptionBreakout(symbol) {
  const state = densityAbsorptionBreakoutState.get(symbol) || {};
  const result = MexcCore.detectDensityAbsorptionBreakout(tier2Depth.get(symbol), tier2Trades.get(symbol), {
    minWallRatio: 5, maxDistancePct: 1.0, minTestCount: DETECTOR_DEFS.densityAbsorptionBreakout.minRepeats
  }, state);
  densityAbsorptionBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPumpReversal(symbol) {
  const ev = MexcCore.detectPumpReversal(tier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDumpReversal(symbol) {
  const ev = MexcCore.detectDumpReversal(tier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCompressionBreak(symbol) {
  const ev = MexcCore.detectCompressionBreak(tier2Trades.get(symbol), tier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFailedBreakout(symbol) {
  const state = failedBreakoutState.get(symbol) || {};
  const result = MexcCore.detectFailedBreakout(tier2Trades.get(symbol), { lookback: 300 }, state);
  failedBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}

// ------------------------------------------------------------------------------------------
// Персистентная библиотека эпизодов для CYCLICAL_PATTERN (#12) и статистика временных бакетов
// для REPEATING_TIME_BASED_IMPULSE (#16) — тот же localStorage-идиом, что и patternHistory (см.
// ниже). Ключевой принцип "без look-ahead" держит не хранилище само по себе, а РАЗДЕЛЕНИЕ во
// времени между "записать эпизод/окно" (сразу) и "заполнить его исход" (строго позже, отдельным
// sweep) — см. sweepCyclicalOutcomes/flushTimeWindowIfDue ниже.
// ------------------------------------------------------------------------------------------
const CYCLICAL_LIBRARY_KEY = 'mexc_cyclical_library';
const CYCLICAL_OUTCOME_HORIZON_MS = 120000; // 2 минуты — тот же горизонт, что at2m у общей истории паттернов

let cyclicalLibrary = (function loadCyclicalLibrary() {
  try {
    const raw = localStorage.getItem(CYCLICAL_LIBRARY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
})();
function saveCyclicalLibrary() {
  try { persistSet(CYCLICAL_LIBRARY_KEY, JSON.stringify(cyclicalLibrary)); } catch (e) { /* переживём без сохранения между сессиями */ }
}
// Раз в 30с проверяет ещё не закрытые эпизоды (outcomeMovePct == null) и, если с их момента прошло
// достаточно времени, заполняет исход РЕАЛЬНО НАБЛЮДАВШЕЙСЯ с тех пор ценой (Tier2 буфер, если
// монета всё ещё в watchlist; иначе — текущая цена из coinMap, та же честная деградация, что и у
// sweepPatternOutcomes).
function sweepCyclicalOutcomes() {
  const now = Date.now();
  let changed = false;
  Object.keys(cyclicalLibrary).forEach(function (symbol) {
    (cyclicalLibrary[symbol] || []).forEach(function (ep) {
      if (ep.outcomeMovePct != null || !ep.priceAtEpisode) return;
      if (now - ep.t < CYCLICAL_OUTCOME_HORIZON_MS) return;
      const trades = tier2TradesForSymbol(symbol);
      let priceAfter = null;
      if (trades && trades.length) {
        const since = trades.filter(function (tr) { return tr.t >= ep.t; });
        if (since.length) priceAfter = since[since.length - 1].price;
      }
      if (priceAfter == null) {
        const coin = coinMap.get(symbol);
        if (coin && coin.price) priceAfter = coin.price;
      }
      if (priceAfter == null) return;
      ep.outcomeMovePct = (priceAfter - ep.priceAtEpisode) / ep.priceAtEpisode;
      changed = true;
    });
  });
  if (changed) saveCyclicalLibrary();
}
setInterval(sweepCyclicalOutcomes, 30000);

const TIME_BUCKET_STATS_KEY = 'mexc_time_bucket_stats';
const TIME_WINDOW_MS = 15 * 60 * 1000; // гранулярность бакета (не гипотеза о периоде — см. MexcCore.timeBucketKeyFromDate)

let timeBucketStats = (function loadTimeBucketStats() {
  try {
    const raw = localStorage.getItem(TIME_BUCKET_STATS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
})();
function saveTimeBucketStats() {
  try { persistSet(TIME_BUCKET_STATS_KEY, JSON.stringify(timeBucketStats)); } catch (e) { /* переживём без сохранения между сессиями */ }
}
// Закрывает текущее 15-минутное окно РЕАЛЬНОГО времени (если оно действительно завершилось) и
// записывает наблюдение в статистику соответствующего бакета; иначе просто заводит окно при первом
// вызове для этой монеты. Вызывается из detectTimeBasedImpulse на каждый цикл — дёшево, без своего
// отдельного таймера.
function flushTimeWindowIfDue(symbol, now, price) {
  const w = cyclicalTimeWindowState.get(symbol);
  const bucketKey = MexcCore.timeBucketKeyFromDate(new Date(now));
  if (!w) { cyclicalTimeWindowState.set(symbol, { bucketKey: bucketKey, windowStartAt: now, windowStartPrice: price }); return; }
  if (now - w.windowStartAt < TIME_WINDOW_MS) return; // окно ещё не завершилось
  const trades = tier2TradesForSymbol(symbol) || [];
  const windowTrades = trades.filter(function (tr) { return tr.t >= w.windowStartAt && tr.t < now; });
  const volumeUsd = windowTrades.reduce(function (a, tr) { return a + tr.price * tr.qty; }, 0);
  const movePct = w.windowStartPrice > 0 ? (price - w.windowStartPrice) / w.windowStartPrice : 0;
  timeBucketStats[symbol] = timeBucketStats[symbol] || {};
  timeBucketStats[symbol][w.bucketKey] = MexcCore.recordTimeBucketObservation(timeBucketStats[symbol][w.bucketKey], { volumeUsd: volumeUsd, movePct: movePct });
  saveTimeBucketStats();
  cyclicalTimeWindowState.set(symbol, { bucketKey: bucketKey, windowStartAt: now, windowStartPrice: price });
}
function symbolOverallMedianVolume(symbol) {
  const buckets = timeBucketStats[symbol];
  if (!buckets) return 0;
  const medians = Object.keys(buckets).map(function (k) { return buckets[k].medianVolume; }).filter(function (v) { return v != null; });
  return medians.length ? MexcCore.median(medians) : 0;
}

// ------------------------------------------------------------------------------------------
// Алгоритмы #11-16 из ТЗ пользователя (rebuild "Алгоритмы", 2026-09, часть 2) — тот же
// wrapper-паттерн, что и у #1-10 выше.
// ------------------------------------------------------------------------------------------
function detectVolumeAnomaly(symbol) {
  const ev = MexcCore.detectVolumeAnomaly(tier2Trades.get(symbol), tier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquidityWithdrawal(symbol) {
  const ev = MexcCore.detectLiquidityWithdrawal(tier2Depth.get(symbol), tier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.liquidityWithdrawal.minRepeats, lookback: 200
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleHiddenAbsorption(symbol) {
  const state = possibleHiddenAbsorptionState.get(symbol) || {};
  const result = MexcCore.detectPossibleHiddenAbsorption(tier2Depth.get(symbol), tier2Trades.get(symbol), {}, state);
  possibleHiddenAbsorptionState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// symbol — "BTC/USDT" (MEXC). Ищем ту же базовую монету на РЕАЛЬНО подключённых биржах (см.
// upsertExternalCoin — их ключ в coinMap "BINANCE:BTC/USDT", см. EXCHANGE_CONNECTORS/
// exchangeConnections) — только споты (фьючерсные теги исключены, спецификация #15 просит именно
// SPOT). Если ни одна биржа не подключена или на ней нет этой монеты — кандидатов нет, и алгоритм
// честно не сработает (см. её же комментарий в core-utils.js).
function crossExchangeCandidatesFor(symbol) {
  const base = symbol.split('/')[0];
  const candidates = [];
  Object.keys(EXCHANGE_CONNECTORS).forEach(function (id) {
    if (!exchangeConnections[id] || !exchangeConnections[id].connected) return;
    EXCHANGE_CONNECTORS[id].exchangeTags.filter(function (tag) { return !/FUT$/.test(tag); }).forEach(function (tag) {
      const coin = coinMap.get(tag + ':' + base + '/USDT');
      if (coin && coin.price > 0) candidates.push({ exchange: tag, price: coin.price });
    });
  });
  return candidates;
}
function detectCrossExchangeDivergence(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const candidates = crossExchangeCandidatesFor(symbol);
  if (!candidates.length) return null;
  const state = crossExchangeDivergenceState.get(symbol) || {};
  const result = MexcCore.detectCrossExchangeDivergence(coin.price, candidates, { now: Date.now() }, state);
  crossExchangeDivergenceState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCyclicalPattern(symbol) {
  const trades = tier2Trades.get(symbol);
  const library = cyclicalLibrary[symbol] || [];
  const result = MexcCore.detectCyclicalPattern(trades, library, {});
  if (result.library !== library) {
    // MexcCore.detectCyclicalPattern не знает про priceAtEpisode (не её забота) — проставляем его
    // здесь, на свежезалогированной записи (последней в массиве); он нужен sweepCyclicalOutcomes
    // для расчёта исхода.
    const added = result.library[result.library.length - 1];
    if (added && added.priceAtEpisode == null && trades && trades.length) added.priceAtEpisode = trades[trades.length - 1].price;
    cyclicalLibrary[symbol] = result.library;
    saveCyclicalLibrary();
  }
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectTimeBasedImpulse(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const now = Date.now();
  flushTimeWindowIfDue(symbol, now, coin.price);
  const bucketKey = MexcCore.timeBucketKeyFromDate(new Date(now));
  const stats = (timeBucketStats[symbol] || {})[bucketKey];
  const ev = MexcCore.detectTimeBasedImpulse(stats, symbolOverallMedianVolume(symbol), coin.price, {});
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}

// ------------------------------------------------------------------------------------------
// Алгоритмы #17-18 (TWAP-исполнение, возможный маркет-мейкер/спредер-бот) — по мотивам разбора
// стороннего скринера GodsEye (oculusdei.pro, 2026-09): у него это подаётся как "Bot Rn"/"TWAP"
// прямо на графике. У нас — тот же смысл, честными средствами на РЕАЛЬНЫХ публичных данных MEXC
// (никакого моста к чужим desktop-ботам и никакого "рейтинга" контрагента — см. isHeuristic/
// maxConfidence у possibleMarketMakerBot в core-utils.js).
// ------------------------------------------------------------------------------------------
function detectTwap(symbol) {
  const state = twapState.get(symbol) || {};
  const result = MexcCore.detectTwap(tier2Trades.get(symbol), {}, state);
  twapState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleMarketMakerBot(symbol) {
  const ev = MexcCore.detectPossibleMarketMakerBot(tier2Trades.get(symbol), tier2Depth.get(symbol), {});
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
  zoneReturn: { label: 'Повторная реакция на зону', badge: 'ZONE', category: 'repeat', minRepeats: 5, detect: detectZoneReturn },
  standingWall: { label: 'Стоящая стена в стакане', badge: 'WALL', category: 'depth', minRepeats: 10, detect: detectStandingWall },
  // 10 приоритетных алгоритмов из ТЗ пользователя (rebuild "Алгоритмы", 2026-09) — см. wrapper'ы выше.
  densityBreak: { label: 'Пробой плотности', badge: 'DBREAK', category: 'depth', minRepeats: 30, detect: detectDensityBreak },
  densityAbsorption: { label: 'Поглощение у плотности', badge: 'DABSORB', category: 'depth', minRepeats: 30, detect: detectDensityAbsorption },
  liquiditySweep: { label: 'Снятие ликвидности (sweep)', badge: 'SWEEP', category: 'inefficiency', minRepeats: 30, detect: detectLiquiditySweep },
  impulsePullbackContinuation: { label: 'Импульс → откат → продолжение', badge: 'IPC', category: 'sequence', minRepeats: 40, detect: detectImpulsePullbackContinuation },
  priceVolumeInefficiency: { label: 'Неэффективность цена/объём', badge: 'PVI', category: 'inefficiency', minRepeats: 40, detect: detectPriceVolumeInefficiency },
  densityAbsorptionBreakout: { label: 'Пробой после многократного поглощения', badge: 'DABX', category: 'depth', minRepeats: 3, detect: detectDensityAbsorptionBreakout },
  pumpReversal: { label: 'Разворот/продолжение пампа', badge: 'PUMPX', category: 'inefficiency', minRepeats: 40, detect: detectPumpReversal },
  dumpReversal: { label: 'Разворот/продолжение дампа', badge: 'DUMPX', category: 'inefficiency', minRepeats: 40, detect: detectDumpReversal },
  compressionBreak: { label: 'Сжатие → расширение волатильности', badge: 'COMPR', category: 'inefficiency', minRepeats: 60, detect: detectCompressionBreak },
  failedBreakout: { label: 'Ложный пробой диапазона', badge: 'FAILBRK', category: 'repeat', minRepeats: 40, detect: detectFailedBreakout },
  // Алгоритмы #11-16 из ТЗ пользователя (rebuild "Алгоритмы", 2026-09, часть 2).
  volumeAnomaly: { label: 'Аномалия объёма', badge: 'VOLX', category: 'inefficiency', minRepeats: 40, detect: detectVolumeAnomaly },
  liquidityWithdrawal: { label: 'Уход ликвидности', badge: 'LWITH', category: 'depth', minRepeats: 20, detect: detectLiquidityWithdrawal },
  possibleHiddenAbsorption: { label: 'Возможное скрытое поглощение', badge: 'HIDDEN?', category: 'heuristic-lowconf', minRepeats: 2, detect: detectPossibleHiddenAbsorption },
  crossExchangeDivergence: { label: 'Межбиржевое расхождение', badge: 'XDIV', category: 'inefficiency', minRepeats: 2, detect: detectCrossExchangeDivergence },
  cyclicalPattern: { label: 'Циклический паттерн', badge: 'CYCLIC', category: 'cycle', minRepeats: 5, detect: detectCyclicalPattern },
  timeBasedImpulse: { label: 'Временной паттерн активности', badge: 'TIME', category: 'cycle', minRepeats: 10, detect: detectTimeBasedImpulse },
  // Алгоритмы #17-18 (по мотивам разбора GodsEye, 2026-09) — см. wrapper'ы выше.
  twap: { label: 'TWAP-исполнение', badge: 'TWAP', category: 'sequence', minRepeats: 6, detect: detectTwap },
  possibleMarketMakerBot: { label: 'Возможный маркет-мейкер/спредер-бот', badge: 'MMBOT?', category: 'heuristic-lowconf', minRepeats: 30, detect: detectPossibleMarketMakerBot }
};

// ============================================================================
// BINANCE-версии всех детекторов выше — тот же контракт detect(symbol) -> event|null, только читают
// binanceTier2Trades/binanceTier2Depth и свои binance*State карты вместо MEXC-карт. НЕ добавлены в
// DETECTOR_DEFS (тот остаётся единым реестром label/badge/category — общим для обеих бирж), а
// собраны в отдельный реестр BINANCE_DETECTOR_FNS ниже с ТЕМИ ЖЕ ключами detectorKey — runPatternDetectors()
// выбирает нужный реестр функций по бирже символа, а не по отдельному DETECTOR_DEFS на биржу.
// Пороги/opts — намеренно один в один с MEXC-версией того же алгоритма (не изобретаем разные пороги
// без причины только потому, что биржа другая).
// ------------------------------------------------------------------------------------------
function detectRepeatedTradeSizesBinance(symbol) {
  const ev = MexcCore.detectRepeatedTradeSizes(binanceTier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatSize.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatedIntervalsBinance(symbol) {
  const ev = MexcCore.detectRepeatedIntervals(binanceTier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatInterval.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectBurstNoFollowThroughBinance(symbol) {
  const ev = MexcCore.detectBurstNoFollowThrough(binanceTier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.burstNoFollow.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCyclicityBinance(symbol) {
  const ev = MexcCore.detectCyclicity(binanceTier2Trades.get(symbol), {
    bucketMs: 2000, minRepeats: DETECTOR_DEFS.cycle.minRepeats, tolerance: PATTERN_CLUSTER_TOLERANCE, lookback: 2000
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatingSequenceBinance(symbol) {
  const ev = MexcCore.detectRepeatingSequence(binanceTier2Trades.get(symbol), {
    minLen: 3, maxLen: 6, minRepeats: DETECTOR_DEFS.sequence.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLadderBinance(symbol) {
  const ev = MexcCore.detectLadder(binanceTier2Trades.get(symbol), {
    tolerance: 0.3, minRepeats: DETECTOR_DEFS.ladder.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectErshikBinance(symbol) {
  const ev = MexcCore.detectErshik(binanceTier2Trades.get(symbol), {
    tolerance: 0.2, minRepeats: DETECTOR_DEFS.ershik.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectImbalanceBinance(symbol) {
  const ev = MexcCore.detectImbalance(binanceTier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.imbalance.minRepeats, minZ: 2.5, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectAbsorptionBinance(symbol) {
  const ev = MexcCore.detectAbsorption(binanceTier2Depth.get(symbol), binanceTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.absorption.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFakeLiquidityBinance(symbol) {
  const ev = MexcCore.detectFakeLiquidity(binanceTier2Depth.get(symbol), binanceTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.fakeLiquidity.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectExhaustionBinance(symbol) {
  const ev = MexcCore.detectExhaustion(binanceTier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.exhaustion.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectZoneReturnBinance(symbol) {
  const ev = MexcCore.detectZoneReturn(binanceTier2Trades.get(symbol), {
    tolerance: 0.005, minRepeats: DETECTOR_DEFS.zoneReturn.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectStandingWallBinance(symbol) {
  const ev = MexcCore.detectStandingWall(binanceTier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.standingWall.minRepeats, lookback: 20, minWallRatio: 5, maxDistancePct: 1.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityBreakBinance(symbol) {
  const ev = MexcCore.detectDensityBreak(binanceTier2Depth.get(symbol), binanceTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityBreak.minRepeats, lookback: 300, minWallRatio: 5, minShrinkRatio: 0.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorptionBinance(symbol) {
  const ev = MexcCore.detectDensityAbsorption(binanceTier2Depth.get(symbol), binanceTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityAbsorption.minRepeats, lookback: 300, minWallRatio: 5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquiditySweepBinance(symbol) {
  const ev = MexcCore.detectLiquiditySweep(binanceTier2Trades.get(symbol), binanceTier2Depth.get(symbol), { lookback: 200 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectImpulsePullbackContinuationBinance(symbol) {
  const ev = MexcCore.detectImpulsePullbackContinuation(binanceTier2Trades.get(symbol), { lookback: 300 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPriceVolumeInefficiencyBinance(symbol) {
  const ev = MexcCore.detectPriceVolumeInefficiency(binanceTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorptionBreakoutBinance(symbol) {
  const state = binanceDensityAbsorptionBreakoutState.get(symbol) || {};
  const result = MexcCore.detectDensityAbsorptionBreakout(binanceTier2Depth.get(symbol), binanceTier2Trades.get(symbol), {
    minWallRatio: 5, maxDistancePct: 1.0, minTestCount: DETECTOR_DEFS.densityAbsorptionBreakout.minRepeats
  }, state);
  binanceDensityAbsorptionBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPumpReversalBinance(symbol) {
  const ev = MexcCore.detectPumpReversal(binanceTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDumpReversalBinance(symbol) {
  const ev = MexcCore.detectDumpReversal(binanceTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCompressionBreakBinance(symbol) {
  const ev = MexcCore.detectCompressionBreak(binanceTier2Trades.get(symbol), binanceTier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFailedBreakoutBinance(symbol) {
  const state = binanceFailedBreakoutState.get(symbol) || {};
  const result = MexcCore.detectFailedBreakout(binanceTier2Trades.get(symbol), { lookback: 300 }, state);
  binanceFailedBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectVolumeAnomalyBinance(symbol) {
  const ev = MexcCore.detectVolumeAnomaly(binanceTier2Trades.get(symbol), binanceTier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquidityWithdrawalBinance(symbol) {
  const ev = MexcCore.detectLiquidityWithdrawal(binanceTier2Depth.get(symbol), binanceTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.liquidityWithdrawal.minRepeats, lookback: 200
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleHiddenAbsorptionBinance(symbol) {
  const state = binancePossibleHiddenAbsorptionState.get(symbol) || {};
  const result = MexcCore.detectPossibleHiddenAbsorption(binanceTier2Depth.get(symbol), binanceTier2Trades.get(symbol), {}, state);
  binancePossibleHiddenAbsorptionState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// base монеты из "BINANCE:BTC/USDT" -> "BTC" — сравниваем цену Binance с MEXC (всегда доступна) и
// любой ДРУГОЙ подключённой биржей (не с самим Binance).
function crossExchangeCandidatesForBinance(symbol) {
  const base = symbol.split(':').pop().split('/')[0];
  const candidates = [];
  const mexcCoin = coinMap.get(base + '/USDT');
  if (mexcCoin && mexcCoin.price > 0) candidates.push({ exchange: 'MEXC', price: mexcCoin.price });
  Object.keys(EXCHANGE_CONNECTORS).forEach(function (id) {
    if (id === 'binance') return;
    if (!exchangeConnections[id] || !exchangeConnections[id].connected) return;
    EXCHANGE_CONNECTORS[id].exchangeTags.filter(function (tag) { return !/FUT$/.test(tag); }).forEach(function (tag) {
      const coin = coinMap.get(tag + ':' + base + '/USDT');
      if (coin && coin.price > 0) candidates.push({ exchange: tag, price: coin.price });
    });
  });
  return candidates;
}
function detectCrossExchangeDivergenceBinance(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const candidates = crossExchangeCandidatesForBinance(symbol);
  if (!candidates.length) return null;
  const state = binanceCrossExchangeDivergenceState.get(symbol) || {};
  const result = MexcCore.detectCrossExchangeDivergence(coin.price, candidates, { now: Date.now() }, state);
  binanceCrossExchangeDivergenceState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// #12/#16 честно переиспользуют ОБЩИЕ cyclicalLibrary/timeBucketStats (обычные объекты, не Map,
// ключ — уже уникальный "BINANCE:BTC/USDT" строкой, коллизий с MEXC-символами нет) — и уже
// обобщённые выше flushTimeWindowIfDue/symbolOverallMedianVolume (см. tier2TradesForSymbol).
function detectCyclicalPatternBinance(symbol) {
  const trades = binanceTier2Trades.get(symbol);
  const library = cyclicalLibrary[symbol] || [];
  const result = MexcCore.detectCyclicalPattern(trades, library, {});
  if (result.library !== library) {
    const added = result.library[result.library.length - 1];
    if (added && added.priceAtEpisode == null && trades && trades.length) added.priceAtEpisode = trades[trades.length - 1].price;
    cyclicalLibrary[symbol] = result.library;
    saveCyclicalLibrary();
  }
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectTimeBasedImpulseBinance(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const now = Date.now();
  flushTimeWindowIfDue(symbol, now, coin.price);
  const bucketKey = MexcCore.timeBucketKeyFromDate(new Date(now));
  const stats = (timeBucketStats[symbol] || {})[bucketKey];
  const ev = MexcCore.detectTimeBasedImpulse(stats, symbolOverallMedianVolume(symbol), coin.price, {});
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectTwapBinance(symbol) {
  const state = binanceTwapState.get(symbol) || {};
  const result = MexcCore.detectTwap(binanceTier2Trades.get(symbol), {}, state);
  binanceTwapState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleMarketMakerBotBinance(symbol) {
  const ev = MexcCore.detectPossibleMarketMakerBot(binanceTier2Trades.get(symbol), binanceTier2Depth.get(symbol), {});
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}

// OKX-версии всех детекторов выше — тот же контракт detect(symbol) -> event|null, только читают
// okxTier2Trades/okxTier2Depth и свои okx*State карты (см. блок "TIER 2 — OKX" выше). Пороги/opts —
// намеренно один в один с MEXC/Binance-версией того же алгоритма.
// ------------------------------------------------------------------------------------------
function detectRepeatedTradeSizesOkx(symbol) {
  const ev = MexcCore.detectRepeatedTradeSizes(okxTier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatSize.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatedIntervalsOkx(symbol) {
  const ev = MexcCore.detectRepeatedIntervals(okxTier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatInterval.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectBurstNoFollowThroughOkx(symbol) {
  const ev = MexcCore.detectBurstNoFollowThrough(okxTier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.burstNoFollow.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCyclicityOkx(symbol) {
  const ev = MexcCore.detectCyclicity(okxTier2Trades.get(symbol), {
    bucketMs: 2000, minRepeats: DETECTOR_DEFS.cycle.minRepeats, tolerance: PATTERN_CLUSTER_TOLERANCE, lookback: 2000
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatingSequenceOkx(symbol) {
  const ev = MexcCore.detectRepeatingSequence(okxTier2Trades.get(symbol), {
    minLen: 3, maxLen: 6, minRepeats: DETECTOR_DEFS.sequence.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLadderOkx(symbol) {
  const ev = MexcCore.detectLadder(okxTier2Trades.get(symbol), {
    tolerance: 0.3, minRepeats: DETECTOR_DEFS.ladder.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectErshikOkx(symbol) {
  const ev = MexcCore.detectErshik(okxTier2Trades.get(symbol), {
    tolerance: 0.2, minRepeats: DETECTOR_DEFS.ershik.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectImbalanceOkx(symbol) {
  const ev = MexcCore.detectImbalance(okxTier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.imbalance.minRepeats, minZ: 2.5, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectAbsorptionOkx(symbol) {
  const ev = MexcCore.detectAbsorption(okxTier2Depth.get(symbol), okxTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.absorption.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFakeLiquidityOkx(symbol) {
  const ev = MexcCore.detectFakeLiquidity(okxTier2Depth.get(symbol), okxTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.fakeLiquidity.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectExhaustionOkx(symbol) {
  const ev = MexcCore.detectExhaustion(okxTier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.exhaustion.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectZoneReturnOkx(symbol) {
  const ev = MexcCore.detectZoneReturn(okxTier2Trades.get(symbol), {
    tolerance: 0.005, minRepeats: DETECTOR_DEFS.zoneReturn.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectStandingWallOkx(symbol) {
  const ev = MexcCore.detectStandingWall(okxTier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.standingWall.minRepeats, lookback: 20, minWallRatio: 5, maxDistancePct: 1.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityBreakOkx(symbol) {
  const ev = MexcCore.detectDensityBreak(okxTier2Depth.get(symbol), okxTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityBreak.minRepeats, lookback: 300, minWallRatio: 5, minShrinkRatio: 0.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorptionOkx(symbol) {
  const ev = MexcCore.detectDensityAbsorption(okxTier2Depth.get(symbol), okxTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityAbsorption.minRepeats, lookback: 300, minWallRatio: 5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquiditySweepOkx(symbol) {
  const ev = MexcCore.detectLiquiditySweep(okxTier2Trades.get(symbol), okxTier2Depth.get(symbol), { lookback: 200 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectImpulsePullbackContinuationOkx(symbol) {
  const ev = MexcCore.detectImpulsePullbackContinuation(okxTier2Trades.get(symbol), { lookback: 300 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPriceVolumeInefficiencyOkx(symbol) {
  const ev = MexcCore.detectPriceVolumeInefficiency(okxTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorptionBreakoutOkx(symbol) {
  const state = okxDensityAbsorptionBreakoutState.get(symbol) || {};
  const result = MexcCore.detectDensityAbsorptionBreakout(okxTier2Depth.get(symbol), okxTier2Trades.get(symbol), {
    minWallRatio: 5, maxDistancePct: 1.0, minTestCount: DETECTOR_DEFS.densityAbsorptionBreakout.minRepeats
  }, state);
  okxDensityAbsorptionBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPumpReversalOkx(symbol) {
  const ev = MexcCore.detectPumpReversal(okxTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDumpReversalOkx(symbol) {
  const ev = MexcCore.detectDumpReversal(okxTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCompressionBreakOkx(symbol) {
  const ev = MexcCore.detectCompressionBreak(okxTier2Trades.get(symbol), okxTier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFailedBreakoutOkx(symbol) {
  const state = okxFailedBreakoutState.get(symbol) || {};
  const result = MexcCore.detectFailedBreakout(okxTier2Trades.get(symbol), { lookback: 300 }, state);
  okxFailedBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectVolumeAnomalyOkx(symbol) {
  const ev = MexcCore.detectVolumeAnomaly(okxTier2Trades.get(symbol), okxTier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquidityWithdrawalOkx(symbol) {
  const ev = MexcCore.detectLiquidityWithdrawal(okxTier2Depth.get(symbol), okxTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.liquidityWithdrawal.minRepeats, lookback: 200
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleHiddenAbsorptionOkx(symbol) {
  const state = okxPossibleHiddenAbsorptionState.get(symbol) || {};
  const result = MexcCore.detectPossibleHiddenAbsorption(okxTier2Depth.get(symbol), okxTier2Trades.get(symbol), {}, state);
  okxPossibleHiddenAbsorptionState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// base монеты из "OKX:BTC/USDT" -> "BTC" — сравниваем цену Okx с MEXC (всегда доступна) и
// любой ДРУГОЙ подключённой биржей (не с самим Okx).
function crossExchangeCandidatesForOkx(symbol) {
  const base = symbol.split(':').pop().split('/')[0];
  const candidates = [];
  const mexcCoin = coinMap.get(base + '/USDT');
  if (mexcCoin && mexcCoin.price > 0) candidates.push({ exchange: 'MEXC', price: mexcCoin.price });
  Object.keys(EXCHANGE_CONNECTORS).forEach(function (id) {
    if (id === 'okx') return;
    if (!exchangeConnections[id] || !exchangeConnections[id].connected) return;
    EXCHANGE_CONNECTORS[id].exchangeTags.filter(function (tag) { return !/FUT$/.test(tag); }).forEach(function (tag) {
      const coin = coinMap.get(tag + ':' + base + '/USDT');
      if (coin && coin.price > 0) candidates.push({ exchange: tag, price: coin.price });
    });
  });
  return candidates;
}
function detectCrossExchangeDivergenceOkx(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const candidates = crossExchangeCandidatesForOkx(symbol);
  if (!candidates.length) return null;
  const state = okxCrossExchangeDivergenceState.get(symbol) || {};
  const result = MexcCore.detectCrossExchangeDivergence(coin.price, candidates, { now: Date.now() }, state);
  okxCrossExchangeDivergenceState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// #12/#16 честно переиспользуют ОБЩИЕ cyclicalLibrary/timeBucketStats (обычные объекты, не Map,
// ключ — уже уникальный "OKX:BTC/USDT" строкой, коллизий с MEXC-символами нет) — и уже
// обобщённые выше flushTimeWindowIfDue/symbolOverallMedianVolume (см. tier2TradesForSymbol).
function detectCyclicalPatternOkx(symbol) {
  const trades = okxTier2Trades.get(symbol);
  const library = cyclicalLibrary[symbol] || [];
  const result = MexcCore.detectCyclicalPattern(trades, library, {});
  if (result.library !== library) {
    const added = result.library[result.library.length - 1];
    if (added && added.priceAtEpisode == null && trades && trades.length) added.priceAtEpisode = trades[trades.length - 1].price;
    cyclicalLibrary[symbol] = result.library;
    saveCyclicalLibrary();
  }
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectTimeBasedImpulseOkx(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const now = Date.now();
  flushTimeWindowIfDue(symbol, now, coin.price);
  const bucketKey = MexcCore.timeBucketKeyFromDate(new Date(now));
  const stats = (timeBucketStats[symbol] || {})[bucketKey];
  const ev = MexcCore.detectTimeBasedImpulse(stats, symbolOverallMedianVolume(symbol), coin.price, {});
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectTwapOkx(symbol) {
  const state = okxTwapState.get(symbol) || {};
  const result = MexcCore.detectTwap(okxTier2Trades.get(symbol), {}, state);
  okxTwapState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleMarketMakerBotOkx(symbol) {
  const ev = MexcCore.detectPossibleMarketMakerBot(okxTier2Trades.get(symbol), okxTier2Depth.get(symbol), {});
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}

// Bitget-версии всех детекторов выше — тот же контракт detect(symbol) -> event|null, только читают
// bitgetTier2Trades/bitgetTier2Depth и свои bitget*State карты (см. блок "TIER 2 — BITGET" выше). Пороги/opts —
// намеренно один в один с MEXC/Binance/OKX-версией того же алгоритма.
// ------------------------------------------------------------------------------------------
function detectRepeatedTradeSizesBitget(symbol) {
  const ev = MexcCore.detectRepeatedTradeSizes(bitgetTier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatSize.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatedIntervalsBitget(symbol) {
  const ev = MexcCore.detectRepeatedIntervals(bitgetTier2Trades.get(symbol), {
    tolerance: PATTERN_CLUSTER_TOLERANCE, minRepeats: DETECTOR_DEFS.repeatInterval.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectBurstNoFollowThroughBitget(symbol) {
  const ev = MexcCore.detectBurstNoFollowThrough(bitgetTier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.burstNoFollow.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCyclicityBitget(symbol) {
  const ev = MexcCore.detectCyclicity(bitgetTier2Trades.get(symbol), {
    bucketMs: 2000, minRepeats: DETECTOR_DEFS.cycle.minRepeats, tolerance: PATTERN_CLUSTER_TOLERANCE, lookback: 2000
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectRepeatingSequenceBitget(symbol) {
  const ev = MexcCore.detectRepeatingSequence(bitgetTier2Trades.get(symbol), {
    minLen: 3, maxLen: 6, minRepeats: DETECTOR_DEFS.sequence.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLadderBitget(symbol) {
  const ev = MexcCore.detectLadder(bitgetTier2Trades.get(symbol), {
    tolerance: 0.3, minRepeats: DETECTOR_DEFS.ladder.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectErshikBitget(symbol) {
  const ev = MexcCore.detectErshik(bitgetTier2Trades.get(symbol), {
    tolerance: 0.2, minRepeats: DETECTOR_DEFS.ershik.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectImbalanceBitget(symbol) {
  const ev = MexcCore.detectImbalance(bitgetTier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.imbalance.minRepeats, minZ: 2.5, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectAbsorptionBitget(symbol) {
  const ev = MexcCore.detectAbsorption(bitgetTier2Depth.get(symbol), bitgetTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.absorption.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFakeLiquidityBitget(symbol) {
  const ev = MexcCore.detectFakeLiquidity(bitgetTier2Depth.get(symbol), bitgetTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.fakeLiquidity.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectExhaustionBitget(symbol) {
  const ev = MexcCore.detectExhaustion(bitgetTier2Trades.get(symbol), {
    bucketMs: PATTERN_BURST_BUCKET_MS, minRepeats: DETECTOR_DEFS.exhaustion.minRepeats, lookback: 300
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectZoneReturnBitget(symbol) {
  const ev = MexcCore.detectZoneReturn(bitgetTier2Trades.get(symbol), {
    tolerance: 0.005, minRepeats: DETECTOR_DEFS.zoneReturn.minRepeats, lookback: PATTERN_LOOKBACK_TRADES
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectStandingWallBitget(symbol) {
  const ev = MexcCore.detectStandingWall(bitgetTier2Depth.get(symbol), {
    minSnapshots: DETECTOR_DEFS.standingWall.minRepeats, lookback: 20, minWallRatio: 5, maxDistancePct: 1.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityBreakBitget(symbol) {
  const ev = MexcCore.detectDensityBreak(bitgetTier2Depth.get(symbol), bitgetTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityBreak.minRepeats, lookback: 300, minWallRatio: 5, minShrinkRatio: 0.5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorptionBitget(symbol) {
  const ev = MexcCore.detectDensityAbsorption(bitgetTier2Depth.get(symbol), bitgetTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.densityAbsorption.minRepeats, lookback: 300, minWallRatio: 5
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquiditySweepBitget(symbol) {
  const ev = MexcCore.detectLiquiditySweep(bitgetTier2Trades.get(symbol), bitgetTier2Depth.get(symbol), { lookback: 200 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectImpulsePullbackContinuationBitget(symbol) {
  const ev = MexcCore.detectImpulsePullbackContinuation(bitgetTier2Trades.get(symbol), { lookback: 300 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPriceVolumeInefficiencyBitget(symbol) {
  const ev = MexcCore.detectPriceVolumeInefficiency(bitgetTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDensityAbsorptionBreakoutBitget(symbol) {
  const state = bitgetDensityAbsorptionBreakoutState.get(symbol) || {};
  const result = MexcCore.detectDensityAbsorptionBreakout(bitgetTier2Depth.get(symbol), bitgetTier2Trades.get(symbol), {
    minWallRatio: 5, maxDistancePct: 1.0, minTestCount: DETECTOR_DEFS.densityAbsorptionBreakout.minRepeats
  }, state);
  bitgetDensityAbsorptionBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPumpReversalBitget(symbol) {
  const ev = MexcCore.detectPumpReversal(bitgetTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectDumpReversalBitget(symbol) {
  const ev = MexcCore.detectDumpReversal(bitgetTier2Trades.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectCompressionBreakBitget(symbol) {
  const ev = MexcCore.detectCompressionBreak(bitgetTier2Trades.get(symbol), bitgetTier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectFailedBreakoutBitget(symbol) {
  const state = bitgetFailedBreakoutState.get(symbol) || {};
  const result = MexcCore.detectFailedBreakout(bitgetTier2Trades.get(symbol), { lookback: 300 }, state);
  bitgetFailedBreakoutState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectVolumeAnomalyBitget(symbol) {
  const ev = MexcCore.detectVolumeAnomaly(bitgetTier2Trades.get(symbol), bitgetTier2Depth.get(symbol), { lookback: 400 });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectLiquidityWithdrawalBitget(symbol) {
  const ev = MexcCore.detectLiquidityWithdrawal(bitgetTier2Depth.get(symbol), bitgetTier2Trades.get(symbol), {
    minSnapshots: DETECTOR_DEFS.liquidityWithdrawal.minRepeats, lookback: 200
  });
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleHiddenAbsorptionBitget(symbol) {
  const state = bitgetPossibleHiddenAbsorptionState.get(symbol) || {};
  const result = MexcCore.detectPossibleHiddenAbsorption(bitgetTier2Depth.get(symbol), bitgetTier2Trades.get(symbol), {}, state);
  bitgetPossibleHiddenAbsorptionState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// base монеты из "BITGET:BTC/USDT" -> "BTC" — сравниваем цену Bitget с MEXC (всегда доступна) и
// любой ДРУГОЙ подключённой биржей (не с самим Bitget).
function crossExchangeCandidatesForBitget(symbol) {
  const base = symbol.split(':').pop().split('/')[0];
  const candidates = [];
  const mexcCoin = coinMap.get(base + '/USDT');
  if (mexcCoin && mexcCoin.price > 0) candidates.push({ exchange: 'MEXC', price: mexcCoin.price });
  Object.keys(EXCHANGE_CONNECTORS).forEach(function (id) {
    if (id === 'bitget') return;
    if (!exchangeConnections[id] || !exchangeConnections[id].connected) return;
    EXCHANGE_CONNECTORS[id].exchangeTags.filter(function (tag) { return !/FUT$/.test(tag); }).forEach(function (tag) {
      const coin = coinMap.get(tag + ':' + base + '/USDT');
      if (coin && coin.price > 0) candidates.push({ exchange: tag, price: coin.price });
    });
  });
  return candidates;
}
function detectCrossExchangeDivergenceBitget(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const candidates = crossExchangeCandidatesForBitget(symbol);
  if (!candidates.length) return null;
  const state = bitgetCrossExchangeDivergenceState.get(symbol) || {};
  const result = MexcCore.detectCrossExchangeDivergence(coin.price, candidates, { now: Date.now() }, state);
  bitgetCrossExchangeDivergenceState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
// #12/#16 честно переиспользуют ОБЩИЕ cyclicalLibrary/timeBucketStats (обычные объекты, не Map,
// ключ — уже уникальный "BITGET:BTC/USDT" строкой, коллизий с MEXC-символами нет) — и уже
// обобщённые выше flushTimeWindowIfDue/symbolOverallMedianVolume (см. tier2TradesForSymbol).
function detectCyclicalPatternBitget(symbol) {
  const trades = bitgetTier2Trades.get(symbol);
  const library = cyclicalLibrary[symbol] || [];
  const result = MexcCore.detectCyclicalPattern(trades, library, {});
  if (result.library !== library) {
    const added = result.library[result.library.length - 1];
    if (added && added.priceAtEpisode == null && trades && trades.length) added.priceAtEpisode = trades[trades.length - 1].price;
    cyclicalLibrary[symbol] = result.library;
    saveCyclicalLibrary();
  }
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectTimeBasedImpulseBitget(symbol) {
  const coin = coinMap.get(symbol);
  if (!coin || !(coin.price > 0)) return null;
  const now = Date.now();
  flushTimeWindowIfDue(symbol, now, coin.price);
  const bucketKey = MexcCore.timeBucketKeyFromDate(new Date(now));
  const stats = (timeBucketStats[symbol] || {})[bucketKey];
  const ev = MexcCore.detectTimeBasedImpulse(stats, symbolOverallMedianVolume(symbol), coin.price, {});
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectTwapBitget(symbol) {
  const state = bitgetTwapState.get(symbol) || {};
  const result = MexcCore.detectTwap(bitgetTier2Trades.get(symbol), {}, state);
  bitgetTwapState.set(symbol, result.state);
  const ev = result.event;
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
function detectPossibleMarketMakerBotBitget(symbol) {
  const ev = MexcCore.detectPossibleMarketMakerBot(bitgetTier2Trades.get(symbol), bitgetTier2Depth.get(symbol), {});
  if (ev) { ev.symbol = symbol; ev.detectedAt = Date.now(); }
  return ev;
}
const BITGET_DETECTOR_FNS = {
  repeatSize: detectRepeatedTradeSizesBitget, repeatInterval: detectRepeatedIntervalsBitget,
  burstNoFollow: detectBurstNoFollowThroughBitget, cycle: detectCyclicityBitget,
  sequence: detectRepeatingSequenceBitget, ladder: detectLadderBitget, ershik: detectErshikBitget,
  imbalance: detectImbalanceBitget, absorption: detectAbsorptionBitget, fakeLiquidity: detectFakeLiquidityBitget,
  exhaustion: detectExhaustionBitget, zoneReturn: detectZoneReturnBitget, standingWall: detectStandingWallBitget,
  densityBreak: detectDensityBreakBitget, densityAbsorption: detectDensityAbsorptionBitget,
  liquiditySweep: detectLiquiditySweepBitget, impulsePullbackContinuation: detectImpulsePullbackContinuationBitget,
  priceVolumeInefficiency: detectPriceVolumeInefficiencyBitget, densityAbsorptionBreakout: detectDensityAbsorptionBreakoutBitget,
  pumpReversal: detectPumpReversalBitget, dumpReversal: detectDumpReversalBitget,
  compressionBreak: detectCompressionBreakBitget, failedBreakout: detectFailedBreakoutBitget,
  volumeAnomaly: detectVolumeAnomalyBitget, liquidityWithdrawal: detectLiquidityWithdrawalBitget,
  possibleHiddenAbsorption: detectPossibleHiddenAbsorptionBitget, crossExchangeDivergence: detectCrossExchangeDivergenceBitget,
  cyclicalPattern: detectCyclicalPatternBitget, timeBasedImpulse: detectTimeBasedImpulseBitget,
  twap: detectTwapBitget, possibleMarketMakerBot: detectPossibleMarketMakerBotBitget
};
const OKX_DETECTOR_FNS = {
  repeatSize: detectRepeatedTradeSizesOkx, repeatInterval: detectRepeatedIntervalsOkx,
  burstNoFollow: detectBurstNoFollowThroughOkx, cycle: detectCyclicityOkx,
  sequence: detectRepeatingSequenceOkx, ladder: detectLadderOkx, ershik: detectErshikOkx,
  imbalance: detectImbalanceOkx, absorption: detectAbsorptionOkx, fakeLiquidity: detectFakeLiquidityOkx,
  exhaustion: detectExhaustionOkx, zoneReturn: detectZoneReturnOkx, standingWall: detectStandingWallOkx,
  densityBreak: detectDensityBreakOkx, densityAbsorption: detectDensityAbsorptionOkx,
  liquiditySweep: detectLiquiditySweepOkx, impulsePullbackContinuation: detectImpulsePullbackContinuationOkx,
  priceVolumeInefficiency: detectPriceVolumeInefficiencyOkx, densityAbsorptionBreakout: detectDensityAbsorptionBreakoutOkx,
  pumpReversal: detectPumpReversalOkx, dumpReversal: detectDumpReversalOkx,
  compressionBreak: detectCompressionBreakOkx, failedBreakout: detectFailedBreakoutOkx,
  volumeAnomaly: detectVolumeAnomalyOkx, liquidityWithdrawal: detectLiquidityWithdrawalOkx,
  possibleHiddenAbsorption: detectPossibleHiddenAbsorptionOkx, crossExchangeDivergence: detectCrossExchangeDivergenceOkx,
  cyclicalPattern: detectCyclicalPatternOkx, timeBasedImpulse: detectTimeBasedImpulseOkx,
  twap: detectTwapOkx, possibleMarketMakerBot: detectPossibleMarketMakerBotOkx
};

// Реестр detect-функций по бирже — ключи ТЕ ЖЕ, что в DETECTOR_DEFS (label/badge/category там общие
// для обеих бирж); runPatternDetectors() выбирает MEXC (DETECTOR_DEFS[key].detect) или это по тому,
// с какой биржи символ.
const BINANCE_DETECTOR_FNS = {
  repeatSize: detectRepeatedTradeSizesBinance, repeatInterval: detectRepeatedIntervalsBinance,
  burstNoFollow: detectBurstNoFollowThroughBinance, cycle: detectCyclicityBinance,
  sequence: detectRepeatingSequenceBinance, ladder: detectLadderBinance, ershik: detectErshikBinance,
  imbalance: detectImbalanceBinance, absorption: detectAbsorptionBinance, fakeLiquidity: detectFakeLiquidityBinance,
  exhaustion: detectExhaustionBinance, zoneReturn: detectZoneReturnBinance, standingWall: detectStandingWallBinance,
  densityBreak: detectDensityBreakBinance, densityAbsorption: detectDensityAbsorptionBinance,
  liquiditySweep: detectLiquiditySweepBinance, impulsePullbackContinuation: detectImpulsePullbackContinuationBinance,
  priceVolumeInefficiency: detectPriceVolumeInefficiencyBinance, densityAbsorptionBreakout: detectDensityAbsorptionBreakoutBinance,
  pumpReversal: detectPumpReversalBinance, dumpReversal: detectDumpReversalBinance,
  compressionBreak: detectCompressionBreakBinance, failedBreakout: detectFailedBreakoutBinance,
  volumeAnomaly: detectVolumeAnomalyBinance, liquidityWithdrawal: detectLiquidityWithdrawalBinance,
  possibleHiddenAbsorption: detectPossibleHiddenAbsorptionBinance, crossExchangeDivergence: detectCrossExchangeDivergenceBinance,
  cyclicalPattern: detectCyclicalPatternBinance, timeBasedImpulse: detectTimeBasedImpulseBinance,
  twap: detectTwapBinance, possibleMarketMakerBot: detectPossibleMarketMakerBotBinance
};
// Тот же интерфейс {key: detect(symbol)}, что и BINANCE_DETECTOR_FNS, но для MEXC — просто читает
// .detect с уже существующего DETECTOR_DEFS, чтобы runDetectorsForSymbolInto() не знала про разницу
// между "реестр с доп. полями" (MEXC) и "голый реестр функций" (Binance).
const DETECTOR_DEFS_AS_FNS = {};
Object.keys(DETECTOR_DEFS).forEach(function (key) { DETECTOR_DEFS_AS_FNS[key] = DETECTOR_DEFS[key].detect; });

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
  if (ev.detectorKey === 'standingWall') {
    return 'На ' + (ev.side === 'ask' ? 'продажу' : 'покупку') + ' у уровня ' + fmtPrice(ev.priceLevel) + ' стоит стена ' +
      'в ' + ev.wallRatio + '× больше типичного соседнего уровня (≈$' + ev.volumeUsd.toLocaleString('ru-RU') + '), в ' +
      ev.distancePct + '% от текущей цены — и цена к ней устойчиво приближается. Если стену пробьют, движение, скорее ' +
      'всего, продолжится в сторону пробоя (' + ev.direction + '). Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'densityBreak') {
    return 'Стена ' + (ev.side === 'ask' ? 'на продажу' : 'на покупку') + ' у ' + fmtPrice(ev.priceLevel) + ' усохла на ' +
      ev.shrinkPct + '%, из них ' + ev.eatenRatioPct + '% "съедено" реальными сделками (не просто снята) — цена уже прошла ' +
      'уровень и не откатывает. Объём подтверждения ≈$' + ev.volumeUsd.toLocaleString('ru-RU') + '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'densityAbsorption') {
    return 'У уровня ' + fmtPrice(ev.priceLevel) + ' идёт поглощение: агрессивный объём ≈$' + ev.volumeUsd.toLocaleString('ru-RU') +
      ' при слабом продвижении цены (absorption ratio ' + ev.absorptionRatio + '), от стены осталось ' + ev.remainingLiquidityRatioPct +
      '%. Текущее состояние: ' + ev.state + ' (это НЕ автоматический сигнал на вход). Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'liquiditySweep') {
    return 'Снятие ликвидности: экстремум ' + fmtPrice(ev.sweptLevel) + ' был пробит и тут же отыгран назад (reclaim ' +
      ev.reclaimPct + '% диапазона), встречный поток истощился на ' + ev.exhaustionRatioPct + '% — похоже на выбивание ' +
      'стопов/ликвидности, а не продолжение движения. Объём ≈$' + ev.volumeUsd.toLocaleString('ru-RU') + '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'impulsePullbackContinuation') {
    return 'Импульс ' + ev.impulseMovePct + '% → откат ' + ev.pullbackRatioPct + '% от импульса → продолжение в исходном ' +
      'направлении с возобновившимся потоком (объём фазы продолжения ≈$' + ev.volumeUsd.toLocaleString('ru-RU') + '). Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'priceVolumeInefficiency') {
    return 'Движение цены ' + ev.movePct + '% (z-score ' + ev.priceZ + ') не подтверждено пропорциональным объёмом ' +
      '(volume z-score ' + ev.volumeZ + ') — тип: ' + ev.inefficiencyType + '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'densityAbsorptionBreakout') {
    return 'Уровень ' + fmtPrice(ev.priceLevel) + ' протестирован ' + ev.testCount + ' раз за ' + ev.absorptionDurationS +
      'с, от заявки осталось ' + ev.remainingLiquidityRatioPct + '% — и на этот раз пробит с подтверждающим объёмом ≈$' +
      ev.volumeUsd.toLocaleString('ru-RU') + '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'pumpReversal') {
    return ev.pumpType === 'PUMP_REVERSAL'
      ? ('Памп ' + ev.movePct + '% (z-score ' + ev.moveZ + ') замедляется, покупательное давление падает — признаки истощения. Confidence ' + ev.confidencePct + '%.')
      : ('Памп ' + ev.movePct + '% (z-score ' + ev.moveZ + ') продолжается, поток покупок не ослабевает — признаков разворота нет, ' +
        'это PUMP_CONTINUATION, не сигнал на шорт. Confidence ' + ev.confidencePct + '% (потолок ' + ev.maxConfidence + '%).');
  }
  if (ev.detectorKey === 'dumpReversal') {
    return ev.dumpType === 'DUMP_REVERSAL'
      ? ('Дамп ' + ev.movePct + '% (z-score ' + ev.moveZ + ') замедляется, давление продавцов падает — признаки истощения. Confidence ' + ev.confidencePct + '%.')
      : ('Дамп ' + ev.movePct + '% (z-score ' + ev.moveZ + ') продолжается, поток продаж не ослабевает — признаков разворота нет, ' +
        'это DUMP_CONTINUATION, не сигнал на лонг. Confidence ' + ev.confidencePct + '% (потолок ' + ev.maxConfidence + '%).');
  }
  if (ev.detectorKey === 'compressionBreak') {
    return 'Волатильность была на ' + ev.volatilityPercentile + '-м перцентиле собственной истории монеты (сжатие), затем — ' +
      'расширение с volume z-score ' + ev.volumeZ + ' и пробоем диапазона сжатия. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'failedBreakout') {
    return 'Цена проколола диапазон за уровень ' + fmtPrice(ev.level) + ', но вернулась внутрь диапазона с подтверждающим ' +
      'встречным объёмом ≈$' + ev.reclaimVolumeUsd.toLocaleString('ru-RU') + ' — похоже на ложный пробой. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'volumeAnomaly') {
    const volTxt = ev.eventType === 'BULLISH_VOLUME_EVENT' ? 'подтверждён движением цены вверх — бычье событие'
      : ev.eventType === 'BEARISH_VOLUME_EVENT' ? 'подтверждён движением цены вниз — медвежье событие'
      : 'но цена почти не сдвинулась при сбалансированном потоке — похоже на поглощение объёма, не сигнал само по себе';
    return 'Необычный объём: z-score ' + ev.volumeZ + ', в ' + ev.relativeVolume + '× выше типичного для этой монеты (' +
      ev.tradeCount + ' сделок). Объём ' + volTxt + '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'liquidityWithdrawal') {
    return 'Резко исчезла видимая ликвидность на стороне ' + (ev.side === 'ask' ? 'продажи' : 'покупки') + ' (усохла на ' +
      ev.withdrawalRatioPct + '%), и ' + ev.reactionRatioPct + '% потока сделок с тех пор идёт в сторону возникшего вакуума — ' +
      'НЕ утверждается спуфинг, только сам факт ухода ликвидности. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'possibleHiddenAbsorption') {
    return '⚠ ЭВРИСТИКА (не подтверждённый факт): уровень ' + fmtPrice(ev.priceLevel) + ' выдержал ' + ev.replenishments +
      ' цикла просадки/восстановления видимого объёма за ' + ev.durationS + 'с, при этом исполненный объём через него в ' +
      ev.executedOverVisibleRatio + '× превышает видимую глубину, а цена так и не пробила уровень — похоже на скрытую крупную ' +
      'заявку, но по публичному стакану MEXC подтвердить это напрямую нельзя. Confidence ' + ev.confidencePct + '% (потолок ' + ev.maxConfidence + '%).';
  }
  if (ev.detectorKey === 'crossExchangeDivergence') {
    return 'Цена на ' + ev.exchange + ' (' + fmtPrice(ev.extPrice) + ') устойчиво расходится с MEXC (' + fmtPrice(ev.mexcPrice) +
      ') уже ' + ev.persistedS + 'с: gross-спред ' + ev.grossSpreadPct + '%, net-спред после комиссий/проскальзывания ' +
      ev.netSpreadPct + '%. REST-опрос раз в несколько секунд — не тиковые данные другой биржи. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'cyclicalPattern') {
    return 'Текущая форма (импульс ' + ev.impulsePct + '% → пауза → движение) совпала с ' + ev.observedRepeats +
      ' прошлыми закрытыми эпизодами этой же монеты, из которых в ' + ev.winratePct + '% случаев движение продолжилось в ту же ' +
      'сторону (средний исход ' + ev.avgMovePct + '%, медианный ' + ev.medianMovePct + '%) — без использования будущих данных ' +
      'этих прошлых эпизодов. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'timeBasedImpulse') {
    return 'Эта монета статистически активизируется в этот временной интервал (UTC): по ' + ev.observations + ' реальным ' +
      'наблюдениям объём в ' + ev.volumeMultiplier + '× выше обычного для неё, и в ' + ev.biasPct + '% случаев движение было ' +
      'направленным в сторону ' + (ev.direction === 'LONG' ? 'роста' : 'падения') + '. Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'twap') {
    if (ev.eventType === 'TWAP_STOPPED') {
      return 'TWAP-подобная активность (' + (ev.direction === 'LONG' ? 'покупка' : 'продажа') + ') прекратилась — устойчивого ' +
        'потока одинаковых по размеру и интервалу сделок в эту сторону больше не наблюдается.';
    }
    return 'Похоже на TWAP-исполнение: ' + ev.repeatCount + ' сделок ' + (ev.direction === 'LONG' ? 'на покупку' : 'на продажу') +
      ' примерно одинакового размера (≈$' + ev.avgSizeUsd.toLocaleString('ru-RU') + ') с интервалом ~' + ev.avgIntervalS +
      'с между ними (≈$' + ev.rateUsdPer30s.toLocaleString('ru-RU') + ' за 30с). Confidence ' + ev.confidencePct + '%.';
  }
  if (ev.detectorKey === 'possibleMarketMakerBot') {
    return '⚠ ЭВРИСТИКА (не подтверждённый факт, личность контрагента по публичным данным не определить): ' +
      ev.tradeCount + ' сделок за минуту почти поровну на обе стороны (' + ev.buyRatioPct + '% на покупку), спокойная ' +
      'волатильность и узкий стабильный спред' + (ev.spreadBps != null ? ' (' + ev.spreadBps + ' bps)' : '') +
      ' — типичная сигнатура маркет-мейкера/спредер-бота. Confidence ' + ev.confidencePct + '% (потолок ' + ev.maxConfidence + '%).';
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

// Веса скоринга 10 новых алгоритмов (rebuild "Алгоритмы", 2026-09) — другой словарь факторов
// (context/trigger/flow/orderbook/volume/history), явно запрошенный пользователем, а не
// PATTERN_SCORE_WEIGHTS 13 исходных детекторов (repeatability/stability/...). Без этой развилки
// registerPatternEvent/подтверждение ниже применили бы к их factors чужие веса молча (NaN-риска
// нет — scorePatternEvent клампит отсутствующие ключи к 0, но score вышел бы неверным).
const NEW_ALGO_DETECTOR_KEYS = new Set([
  'densityBreak', 'densityAbsorption', 'liquiditySweep', 'impulsePullbackContinuation',
  'priceVolumeInefficiency', 'densityAbsorptionBreakout', 'pumpReversal', 'dumpReversal',
  'compressionBreak', 'failedBreakout',
  'volumeAnomaly', 'liquidityWithdrawal', 'possibleHiddenAbsorption', 'crossExchangeDivergence',
  'cyclicalPattern', 'timeBasedImpulse', 'twap', 'possibleMarketMakerBot'
]);
function patternWeightsFor(detectorKey) {
  return NEW_ALGO_DETECTOR_KEYS.has(detectorKey) ? MexcCore.ALGO_SCORE_WEIGHTS : undefined;
}

// DATA QUALITY (ТЗ) — протухшие данные (WS тихо завис) или аномальный снимок стакана (bid>=ask,
// спред за гранью разумного) не должны порождать сигнал вообще, ни у старых, ни у новых детекторов.
// Дешёвая, общая для всех детекторов проверка — считается один раз на монету за цикл, не 23 раза.
const PATTERN_MAX_DATA_AGE_MS = 15000;
const PATTERN_MAX_SPREAD_PCT = 5;
function symbolDataIsFresh(symbol, now) {
  const trades = tier2TradesForSymbol(symbol);
  const depth = tier2DepthForSymbol(symbol);
  const lastTradeAt = (trades && trades.length) ? trades[trades.length - 1].t : null;
  const lastDepth = (depth && depth.length) ? depth[depth.length - 1] : null;
  if (lastTradeAt == null && !lastDepth) return false; // вообще нет данных — не о чем детектить
  if (lastTradeAt != null && now - lastTradeAt > PATTERN_MAX_DATA_AGE_MS) return false;
  if (lastDepth) {
    if (now - lastDepth.t > PATTERN_MAX_DATA_AGE_MS) return false;
    if (!(lastDepth.bestBid > 0) || !(lastDepth.bestAsk > 0) || lastDepth.bestAsk <= lastDepth.bestBid) return false;
    const mid = (lastDepth.bestBid + lastDepth.bestAsk) / 2;
    if ((lastDepth.bestAsk - lastDepth.bestBid) / mid * 100 > PATTERN_MAX_SPREAD_PCT) return false;
  }
  return true;
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
  const weights = patternWeightsFor(ev.detectorKey);
  const historyFactorKey = weights ? 'history' : 'pastSuccess'; // новые алгоритмы называют этот фактор 'history' (ALGO_SCORE_WEIGHTS), а не 'pastSuccess'
  const pastSuccess = MexcCore.computePastSuccessRate(patternHistory, ev.detectorKey, {
    checkpointKey: 'at2m', successThresholdPct: PATTERN_SUCCESS_THRESHOLD_PCT
  });
  ev.factors[historyFactorKey] = pastSuccess ? pastSuccess.rate : 0;
  MexcCore.applyPatternScore(ev, weights);

  const id = ++patternHistorySeq;
  ev.historyId = id;
  patternHistory.push({
    id: id, symbol: ev.symbol, detectorKey: ev.detectorKey, detectedAt: now,
    direction: ev.direction, confidencePct: ev.confidencePct, scoreAtSignal: ev.scoreAtSignal,
    priceAtSignal: ev.priceAtSignal, repeatCount: ev.repeatCount, marketRegime: ev.marketRegime || null,
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

// Текущий срез активных паттернов (последний прогон) — используется мостом Tier2->Tier1
// (bestActiveAlgoEventFor) и диагностической панелью здоровья; постоянная история — отдельно, в
// patternHistory выше.
let activePatternEvents = [];

// Пользовательский фидбэк (2026-09): карточки на стр. «Паттерны» пересобирались из
// activePatternEvents КАЖДЫЙ цикл (2с) — как только детектор переставал совпадать хоть на один
// цикл (например, дисбаланс на секунду просел ниже порога), карточка мгновенно исчезала, даже если
// событие только что появилось и пользователь не успел его прочитать. patternFeed — отдельная,
// НАКАПЛИВАЮЩАЯСЯ витрина именно для этой страницы: новый symbol+detectorKey добавляется в начало
// и остаётся видимым, пока не "утихнет" на PATTERN_FEED_MAX_AGE_MS (не постфактум скрывается по
// live-статусу) — та же идея разделения "структурный ре-рендер vs лёгкий тик", что уже применена
// для флика на стр. «Листинги». Порядок элементов НЕ меняется на обновлении уже существующей
// записи (только её содержимое) — иначе список продолжал бы "прыгать" при каждом обновлении score.
const PATTERN_FEED_MAX_AGE_MS = 15 * 60 * 1000;
const PATTERN_FEED_MAX_ENTRIES = 60;
let patternFeed = [];
function updatePatternFeed(events, now) {
  events.forEach(function (ev) {
    const key = ev.symbol + '|' + ev.detectorKey;
    const existing = patternFeed.find(function (e) { return e.key === key; });
    if (existing) { existing.ev = ev; existing.lastSeenAt = now; }
    else patternFeed.unshift({ key: key, ev: ev, firstSeenAt: now, lastSeenAt: now });
  });
  patternFeed = patternFeed.filter(function (e) { return now - e.lastSeenAt <= PATTERN_FEED_MAX_AGE_MS; });
  if (patternFeed.length > PATTERN_FEED_MAX_ENTRIES) {
    // Обрезаем по избытку, но НИКОГДА не трогаем то, что совпало именно в этом цикле (lastSeenAt === now).
    const activeNow = patternFeed.filter(function (e) { return e.lastSeenAt === now; });
    const rest = patternFeed.filter(function (e) { return e.lastSeenAt !== now; })
      .sort(function (a, b) { return b.lastSeenAt - a.lastSeenAt; })
      .slice(0, Math.max(0, PATTERN_FEED_MAX_ENTRIES - activeNow.length));
    patternFeed = activeNow.concat(rest);
  }
}

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
      '<span class="chip-dot"></span>' + t(def.label) + '</span>';
  }).join('');
  row.querySelectorAll('.detector-chip[data-detector]').forEach(function (chip) {
    chip.addEventListener('click', function () { toggleDetectorEnabled(this.dataset.detector); });
  });
}

// Общее тело детекции на одну монету — переиспользуется и для MEXC (watchlist), и для Binance
// (binanceWatchlist) ниже; detectFnsByKey — DETECTOR_DEFS (там же и .detect) для MEXC или
// BINANCE_DETECTOR_FNS для Binance. Тот же DATA QUALITY gate и market regime tag для обеих бирж.
function runDetectorsForSymbolInto(symbol, detectFnsByKey, events, cycleNow) {
  if (!symbolDataIsFresh(symbol, cycleNow)) return;
  const trades = tier2TradesForSymbol(symbol);
  let regime = null;
  if (trades && trades.length >= 2) {
    const features = MexcCore.computeFeatures(trades, tier2DepthForSymbol(symbol), cycleNow);
    regime = MexcCore.classifyRegime(trades, features);
  }
  Object.keys(DETECTOR_DEFS).forEach(function (key) {
    if (disabledDetectorKeys.has(key)) return;
    const fn = detectFnsByKey[key];
    if (!fn) return; // например #12/#16 у Binance пока не подключены (см. отчёт) — при желании легко добавить
    let ev;
    try {
      ev = fn(symbol);
    } catch (e) {
      logE('Pattern', key + '/' + symbol + ': детектор упал с исключением — ' + e.message);
      return;
    }
    if (ev && ev.scoreAtSignal >= PATTERN_MIN_SCORE) {
      ev.marketRegime = regime;
      events.push(ev);
    }
  });
}

function runPatternDetectors() {
  const events = [];
  const cycleNow = Date.now();
  watchlist.forEach(function (entry, symbol) {
    runDetectorsForSymbolInto(symbol, DETECTOR_DEFS_AS_FNS, events, cycleNow);
  });
  binanceWatchlist.forEach(function (entry, symbol) {
    runDetectorsForSymbolInto(symbol, BINANCE_DETECTOR_FNS, events, cycleNow);
  });
  okxWatchlist.forEach(function (entry, symbol) {
    runDetectorsForSymbolInto(symbol, OKX_DETECTOR_FNS, events, cycleNow);
  });
  bitgetWatchlist.forEach(function (entry, symbol) {
    runDetectorsForSymbolInto(symbol, BITGET_DETECTOR_FNS, events, cycleNow);
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
      MexcCore.applyPatternScore(ev, patternWeightsFor(ev.detectorKey));
    }
  });

  const now = Date.now();
  events.forEach(function (ev) { registerPatternEvent(ev, now); });

  // Приоритет показа: 16 новых микроструктурных алгоритмов (NEW_ALGO_DETECTOR_KEYS) — ВСЕГДА
  // выше 13 старых детекторов, независимо от numeric score (явный пользовательский запрос);
  // внутри каждой из двух групп — по убыванию score, как и раньше.
  events.sort(function (a, b) {
    const an = NEW_ALGO_DETECTOR_KEYS.has(a.detectorKey) ? 1 : 0;
    const bn = NEW_ALGO_DETECTOR_KEYS.has(b.detectorKey) ? 1 : 0;
    if (an !== bn) return bn - an;
    return b.scoreAtSignal - a.scoreAtSignal;
  });
  activePatternEvents = events;
  updatePatternFeed(events, now);
  tier2Health.patternEventsActive = activePatternEvents.length;
  const badge = document.getElementById('navPatternBadge');
  if (badge) badge.textContent = activePatternEvents.length;
  updatePatternsPage();
}
setInterval(runPatternDetectors, PATTERN_DETECT_INTERVAL_MS);

// Мост Tier2 -> Tier1: наивысший по confidence СЕЙЧАС активный сигнал одного из 10 приоритетных
// микроструктурных алгоритмов (activePatternEvents уже отсортирован по scoreAtSignal убыв.) для
// данного символа — используется STRATEGY_DEFS.algo (фильтр «Стратегия: АЛГОРИТМЫ» на главном
// экране), тот же принцип блендинга Tier1/Tier2, что уже применяется в STRATEGY_DEFS.density для
// detectStandingWall. null для монет вне watchlist (для них там нет ни сделок, ни стакана) или
// если ни один из 10 алгоритмов сейчас не сработал.
function bestActiveAlgoEventFor(symbol) {
  for (let i = 0; i < activePatternEvents.length; i++) {
    const ev = activePatternEvents[i];
    if (ev.symbol === symbol && NEW_ALGO_DETECTOR_KEYS.has(ev.detectorKey)) return ev;
  }
  return null;
}

// ------------------------------------------------------------------
// UI страницы "Паттерны" — карточки найденных событий + сводка здоровья Tier 2 (watchlist,
// соединения, обработанные сделки/стакан). Переиспользует визуальный язык .profile-strategy-card
// (те же карточки, что у Профилей/Стратегий) и .finres-stat-card (те же плитки, что у Финреза) —
// сознательно, а не отдельный "язык дизайна" для этой страницы (см. план).
// ------------------------------------------------------------------
function watchlistStatusText() {
  const size = watchlist.size;
  const pending = watchlistPending.size;
  return t('Глубокий анализ:') + ' ' + size + '/' + WATCHLIST_SIZE + ' ' + t('монет') + (pending ? ' (+' + pending + ' ' + t('подключается') + ')' : '') +
    ' · ' + t('соединений:') + ' ' + (size * 2) + ' · ' + t('сделок обработано:') + ' ' + tier2Health.tradesIngested +
    ' · ' + t('обновлений стакана:') + ' ' + tier2Health.depthPushesIngested;
}

function patternStatCard(label, valueHtml, cls) {
  return '<div class="finres-stat-card"><div class="finres-stat-label">' + t(label) + '</div>' +
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
    '<span style="font-size:11px;color:var(--text-muted);">' + t(def.label) + ' · ' + ago + t('с назад') + '</span>' +
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
      patternStatCard('Основной поток', wsOk ? 'LIVE' : t('МОЛЧИТ/ОБРЫВ'), wsOk ? 'up' : 'down') +
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
  // Пользовательский фидбэк (2026-09): раньше здесь показывались только activePatternEvents
  // (мгновенный live-срез, ТЗ #8/#9 "5 действительно интересных ситуаций") — карточки исчезали,
  // стоило детектору перестать совпадать хоть на один цикл, читать не успевали. Теперь витрина —
  // patternFeed (копится, не пересобирается с нуля каждый цикл, см. её комментарий выше); порядок
  // уже "новое сверху" (unshift), доп. сортировка не нужна.
  const top = patternFeed.map(function (e) { return e.ev; });
  if (countEl) countEl.textContent = top.length + ' ' + t('за последние 15 мин');
  if (grid) {
    if (!top.length) {
      grid.innerHTML = '<div class="finres-empty" style="grid-column:1/-1;"><i class="ri-radar-2-line"></i>' +
        t(watchlist.size === 0
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
      t('Пока недостаточно закрытых сигналов (нужно дождаться истечения окна +2 минуты после детекции) — таблица наполнится по мере работы.') + '</td></tr>';
    return;
  }
  el.innerHTML = rows.map(function (r) {
    const refPct = r.split.reference.rate != null ? Math.round(r.split.reference.rate * 100) + '%' : '—';
    const recPct = r.split.recent.rate != null ? Math.round(r.split.recent.rate * 100) + '%' : '—';
    const recCls = r.split.degraded ? 'down' : (r.split.recent.rate != null && r.split.reference.rate != null && r.split.recent.rate >= r.split.reference.rate ? 'up' : '');
    return '<tr>' +
      '<td>' + t(r.label) + '</td>' +
      '<td>' + refPct + ' <span style="color:var(--text-muted);font-size:10px;">(n=' + r.split.reference.sampleSize + ')</span></td>' +
      '<td class="' + recCls + '">' + recPct + ' <span style="color:var(--text-muted);font-size:10px;">(n=' + r.split.recent.sampleSize + ')</span></td>' +
      '<td>' + (r.split.degraded ? '<span style="color:var(--orange);">⚠ ' + t('просадка ≥20 п.п.') + '</span>' : (r.split.reference.sampleSize >= PATTERN_VALIDATION_MIN_SAMPLE && r.split.recent.sampleSize >= PATTERN_VALIDATION_MIN_SAMPLE ? '<span style="color:var(--green);">' + t('стабильно') + '</span>' : '—')) + '</td>' +
      '</tr>';
  }).join('');
}

// ============================================================================
// Страница "Графики" — сетка живых мини-графиков свечей (по мотивам разбора стороннего скринера
// GodsEye, 2026-09: у него "Graph mode" 4x4 живых свечей вместо/рядом с таблицей). Свечи — тот же
// REST /api/v3/klines, что и у "своего" графика на вкладке монеты (fetchKlines), просто сразу на
// несколько символов; между REST-обновлениями последняя свеча "дышит" локально по уже живым тикам
// из coinMap (WS), без лишних сетевых запросов на каждый кадр. Пока только монеты MEXC (собственный
// REST) — как и весь остальной live-функционал приложения.
// ============================================================================
const GRAPHS_REFRESH_MS = 20000; // как часто перезапрашиваем историю свечей по REST
const GRAPHS_REDRAW_MS = 2000;   // как часто просто перерисовываем уже загруженное (живая цена)

// Компактное число для плашек стакана на мини-графике ("2K", "71K") — сознательно без десятичных
// (в отличие от fmtNum), чтобы плашка была короче на маленьком canvas.
function fmtWallSize(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return Math.round(n / 1e6) + 'M';
  if (a >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}

// Уровни стакана прямо на мини-графике (стр. «Графики», reference-дизайн по мотивам GodsEye) —
// честно ТОЛЬКО для watchlist-монет: реальный стакан (tier2Depth) есть только у ~20-25 монет
// «Паттернов», у остального рынка (miniTicker-поток) стакана нет вообще — см. тот же принцип, что
// уже применён для TPM (tpmForSymbol) и объяснён в коммите про Range5m/NATR5m. Берём по несколько
// самых весомых по нотионалу (price*qty) уровней с каждой стороны — не обязательно ближайшие к
// цене, а самые заметные "стены" (тот же сигнал, что ловит standingWallForSymbol, только сразу
// несколько сразу, а не один).
const GRAPHS_WALL_LEVELS = 4;
function depthWallsForSymbol(symbol) {
  if (!isTier2Watchlisted(symbol)) return [];
  const ring = tier2DepthForSymbol(symbol);
  const snap = ring && ring.length ? ring[ring.length - 1] : null;
  if (!snap) return [];
  function topLevels(levels, side) {
    return (levels || [])
      .map(function (l) { return { price: l.p, qty: l.q, notional: l.p * l.q, side: side }; })
      .filter(function (l) { return l.notional > 0; })
      .sort(function (a, b) { return b.notional - a.notional; })
      .slice(0, GRAPHS_WALL_LEVELS);
  }
  return topLevels(snap.bids, 'bid').concat(topLevels(snap.asks, 'ask'));
}

// Дельта (объём покупок - объём продаж) по тем же временным бакетам, что и видимые свечи — тоже
// честно только для watchlist (реальный поток сделок tier2Trades, см. комментарий выше). Один
// проход по буферу сделок (не N проходов на свечу) — бакет по индексу, а не вложенный фильтр.
function deltaSeriesForSymbol(symbol, slice) {
  if (!isTier2Watchlisted(symbol) || !slice || slice.length < 2) return [];
  const trades = tier2TradesForSymbol(symbol);
  if (!trades || !trades.length) return [];
  const t0 = slice[0].t;
  const bucketMs = Math.max(1000, slice[1].t - t0);
  const buckets = new Array(slice.length).fill(0);
  for (let i = 0; i < trades.length; i++) {
    const tr = trades[i];
    const idx = Math.floor((tr.t - t0) / bucketMs);
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx] += (tr.side === 'sell' ? -1 : 1) * tr.qty;
  }
  return slice.map(function (k, i) { return { t: k.t, delta: buckets[i] }; });
}
let graphsCandles = new Map();   // symbol -> candles[] (последний REST-снимок)
// Когда именно последний раз реально дошли до REST за этим символом (не когда карточка попала в
// топ) — на desktop-сборке КАЖДЫЙ такой запрос идёт через curl.exe (браузерный fetch к api.mexc.com
// почти всегда падает по CORS, см. fetchKlines/nativeCurlGet), а спавн процесса иногда придерживает
// антивирус на секунды-десятки секунд (см. развёрнутый комментарий у nativeCurlGet про
// execCommandSelfTest/bridgeTimeoutMs=22с). На сетке 5×5 это означает, что КАЖДЫЙ лишний повторный
// запрос за уже виденной монетой — не бесплатная мелочь, а реальная плата в секундах. Явно решаем,
// нужно ли перезапрашивать (см. graphsSymbolNeedsFetch), а не тянем заново любую монету, что просто
// сменила позицию в топе.
let graphsCandlesFetchedAt = new Map();
const GRAPHS_CANDLE_STALE_MS = 60000; // старше минуты — можно освежить, свежее — не трогаем лишний раз
function graphsSymbolNeedsFetch(symbol) {
  if (!graphsCandles.has(symbol)) return true;
  const fetchedAt = graphsCandlesFetchedAt.get(symbol) || 0;
  return (Date.now() - fetchedAt) > GRAPHS_CANDLE_STALE_MS;
}
// Индивидуальный зум/пан КАЖДОЙ карточки (колесо мыши / зажать-потащить на canvas, см.
// wireGraphsGridClick) — symbol -> {count, offset}, живёт отдельно от graphsCandles, поэтому
// переживает переперестройку сетки (смену фильтра/сортировки) и REST-обновление свечей той же
// монеты. Отсутствие записи = дефолт (последние 96 свечей, см. drawMiniCandleChart).
let graphsChartView = new Map();
const GRAPHS_MIN_ZOOM_CANDLES = 12;
const GRAPHS_MAX_ZOOM_CANDLES = 200; // столько же свечей и запрашиваем по REST (см. refreshGraphsCandles)
let graphsDrag = null; // {symbol, canvas, startX, startOffset, count} — активное перетаскивание графика (см. wireGraphsGridClick)
let graphsVisibleSymbols = [];
// Раньше "изменился ли состав сетки" определялось сравнением с предыдущим graphsVisibleSymbols,
// а места, которым нужно было ФОРСИРОВАТЬ перестройку (смена фильтра/пина), просто обнуляли его в
// []. Ломалось ровно на переходе "было что-то" -> "стало пусто" (например переключили биржу на ту,
// где нет ни одной монеты): новый список — [], обнулённый предыдущий — тоже [], "изменений" не
// видно, сетка молча остаётся со старыми карточками. Явный флаг вместо совпадения по значению.
let graphsForceRebuild = true;
let graphsRefreshInFlight = false;

// Закреплённые вручную монеты (стр. «Графики») — persist тем же localStorage-идиомом, что и
// избранное/отключённые детекторы. Всегда показываются, поверх авто-сортировки по метрике, и
// занимают часть слотов выбранного размера сетки (2×2..5×5).
const GRAPHS_PINNED_KEY = 'mexc_graphs_pinned';
let graphsPinned = (function loadGraphsPinned() {
  try {
    const raw = localStorage.getItem(GRAPHS_PINNED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
})();
function saveGraphsPinned() {
  try { persistSet(GRAPHS_PINNED_KEY, JSON.stringify(Array.from(graphsPinned))); } catch (e) { /* переживём без сохранения между сессиями */ }
}

function graphsGridSizeEl() { return document.getElementById('graphsGridSize'); }
function graphsSortMetricEl() { return document.getElementById('graphsSortMetric'); }
function graphsTimeframeEl() { return document.getElementById('graphsTimeframe'); }
function graphsExchangeFilterEl() { return document.getElementById('graphsExchangeFilter'); }
function graphsFavoritesOnlyEl() { return document.getElementById('graphsFavoritesOnly'); }

// Ранжирование — по уже посчитанным полям монеты (объём/изменение/всплеск/range5m), честно
// посчитанным по реальному тиковому потоку MEXC (см. metricsFromSnaps/rangePctFromSnaps).
// "Все биржи" здесь значит "все биржи с настоящим Tier-2" (MEXC + TIER2_EXTERNAL_EXCHANGES, сейчас
// Binance) — не вообще любая подключённая биржа, у остальных (BINANCEFUT/OKX) честно нет тикового
// потока для самого графика ("своя" история свечей у fetchKlines есть, но сортировка по
// vol5s/change24/range5m для них была бы на данных 4с-REST-поллинга, а не реального рынка) —
// range5m для не-MEXC монет просто undefined, сортировка трактует как 0 (см. Number(...)||0 ниже).
function computeGraphsVisibleSymbols() {
  const n = parseInt((graphsGridSizeEl() && graphsGridSizeEl().value) || '16', 10);
  const metric = (graphsSortMetricEl() && graphsSortMetricEl().value) || 'vol24';
  const exchangeFilter = (graphsExchangeFilterEl() && graphsExchangeFilterEl().value) || 'ALL';
  const favOnly = !!(graphsFavoritesOnlyEl() && graphsFavoritesOnlyEl().checked);

  function exchangeOk(c) {
    const ex = c.exchange || 'MEXC';
    if (exchangeFilter === 'ALL') return ex === 'MEXC' || TIER2_EXTERNAL_EXCHANGES.has(ex);
    return ex === exchangeFilter;
  }

  const pinned = Array.from(graphsPinned).filter(function (s) { return coinMap.has(s); });
  const pinnedSet = new Set(pinned);
  const candidates = allCoins.filter(function (c) { return !pinnedSet.has(c.symbol) && exchangeOk(c) && (!favOnly || c.fav); });
  const sorted = candidates.slice().sort(function (a, b) { return (Number(b[metric]) || 0) - (Number(a[metric]) || 0); });
  const autoSlots = Math.max(0, n - pinned.length);
  return pinned.concat(sorted.slice(0, autoSlots).map(function (c) { return c.symbol; }));
}

// exchangeId для fetchKlines — та же схема, что и в остальном приложении (undefined/'mexc' -> MEXC_REST,
// иначе EXCHANGE_CONNECTORS[id].baseUrl); ключ EXCHANGE_CONNECTORS ('binance') не совпадает с тегом
// монеты в coinMap ('BINANCE') — коротко сопоставляем.
function graphsExchangeIdFor(coin) {
  if (!coin || !coin.exchange || coin.exchange === 'MEXC') return 'mexc';
  if (coin.exchange === 'BINANCE') return 'binance';
  if (coin.exchange === 'OKX') return 'okx';
  if (coin.exchange === 'BITGET') return 'bitget';
  return null; // биржа без своего REST-клиента здесь (пока нет ни одной такой в TIER2_EXTERNAL_EXCHANGES)
}

// Раньше грузила свечи СТРОГО последовательно (один REST-запрос за раз, ждём ответа, только потом
// следующий) — на сетке 5×5 (25 монет) это 25 запросов подряд, и если хоть один подвисает у таймаута
// (fetchKlines — 10с, плюс на desktop ещё и резервный путь через curl.exe при неудаче браузерного
// fetch), все СЛЕДУЮЩИЕ по очереди символы просто ждут своей очереди — отсюда почти пустая сетка
// надолго с одной-двумя случайно повезшими карточками. Теперь — пул из GRAPHS_FETCH_CONCURRENCY
// "воркеров", разбирающих общую очередь параллельно: тот же принцип "один не загрузился — остальные
// не трогаем", но без искусственной сериализации там, где сеть это прекрасно позволяет.
const GRAPHS_FETCH_CONCURRENCY = 10;
async function refreshGraphsCandles(symbols) {
  if (graphsRefreshInFlight || !symbols || !symbols.length) return;
  graphsRefreshInFlight = true;
  const tf = (graphsTimeframeEl() && graphsTimeframeEl().value) || '1';
  try {
    let cursor = 0;
    async function worker() {
      while (cursor < symbols.length) {
        const symbol = symbols[cursor++];
        const page = document.getElementById('page-graphs');
        if (!page || !page.classList.contains('active')) return; // ушли со страницы — не тратим оставшиеся запросы впустую
        if (!graphsSymbolNeedsFetch(symbol)) continue; // уже есть свежий кэш — не тратим лишний curl.exe
        const coin = coinMap.get(symbol);
        if (!coin || !coin.raw) continue;
        const exchangeId = graphsExchangeIdFor(coin);
        if (!exchangeId) continue;
        try {
          const candles = await fetchKlines(coin.raw, tf, 200, exchangeId);
          if (candles && candles.length) {
            graphsCandles.set(symbol, candles);
            graphsCandlesFetchedAt.set(symbol, Date.now());
            redrawGraphsGrid(); // не ждём, пока догрузится вся пачка — эта карточка уже готова прямо сейчас
          }
        } catch (e) { /* один символ не загрузился — остальные не трогаем */ }
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(GRAPHS_FETCH_CONCURRENCY, symbols.length); i++) workers.push(worker());
    await Promise.all(workers);
  } finally {
    graphsRefreshInFlight = false;
  }
}

function graphsMiniCardHtml(symbol) {
  const coin = coinMap.get(symbol);
  const changeCls = coin && coin.change24 >= 0 ? 'up' : 'down';
  const pinned = graphsPinned.has(symbol);
  const rich = isTier2Watchlisted(symbol); // стены стакана + панель дельты доступны только этим монетам, см. depthWallsForSymbol
  const safeSymbol = symbol.replace(/"/g, '&quot;');
  const range5m = coin && Number.isFinite(coin.range5m) ? coin.range5m : null;
  // Карточка больше не открывает Скринер по клику на сам график — колесо мыши/зажать-потащить
  // на canvas теперь масштабируют/двигают ЭТОТ конкретный мини-график (см. graphsChartView,
  // wireGraphsGridClick), а не уводят со страницы. Полный переход в Скринер — отдельная кнопка
  // (mini-chart-open), копия тикера — тоже отдельная кнопка, обе в шапке карточки.
  return '<div class="mini-chart-card' + (pinned ? ' pinned' : '') + (rich ? ' rich' : '') + '" data-symbol="' + safeSymbol + '">' +
    '<div class="mini-chart-head">' +
      (pinned ? '<button class="mini-chart-unpin" data-unpin="' + safeSymbol + '" title="' + t('Открепить') + '">×</button>' : '') +
      '<span class="mini-chart-symbol">' + (coin ? coinDisplayLabel(coin) : symbol) + '</span>' +
      (range5m !== null ? '<span class="mini-chart-range" title="' + t('Диапазон цены за 5 минут') + '">Range 5м ' + range5m.toFixed(1) + '%</span>' : '') +
      '<span class="mini-chart-price ' + changeCls + '">' + (coin ? fmtPrice(coin.price) : '—') + '</span>' +
      '<span class="mini-chart-change ' + changeCls + '">' + (coin && coin.change24 != null ? (coin.change24 >= 0 ? '+' : '') + coin.change24.toFixed(2) + '%' : '') + '</span>' +
      '<button class="mini-chart-copy" data-copy="' + safeSymbol + '" title="' + t('Скопировать тикер') + '"><i class="ri-file-copy-line"></i></button>' +
      '<button class="mini-chart-open" data-open="' + safeSymbol + '" title="' + t('Открыть в Скринере') + '"><i class="ri-external-link-line"></i></button>' +
    '</div>' +
    '<canvas class="mini-chart-canvas" title="' + t('Колесо — масштаб, зажать и тащить — панорама, двойной клик — сбросить') + '"></canvas>' +
  '</div>';
}

// Маркеры алгоритмов прямо на мини-графике — переиспользует уже накопленный patternFeed (стр.
// «Паттерны», см. её же комментарий про накопление вместо мгновенного live-среза), а не отдельный
// проход детекторов: честно рисуем только для монет, что реально в Tier-2 watchlist (только там
// есть настоящие детекции по реальным сделкам/стакану) — для остальных пусто, а не выдумываем.
// Несёт ссылку на само событие (ev) — нужна для наведения (см. wireGraphsMarkerHover ниже).
const GRAPHS_MARKER_MAX_AGE_MS = 15 * 60 * 1000; // тот же горизонт актуальности, что у patternFeed
function graphsMarkersForSymbol(symbol) {
  const now = Date.now();
  const markers = [];
  patternFeed.forEach(function (entry) {
    const ev = entry.ev;
    if (!ev || ev.symbol !== symbol) return;
    if (now - entry.lastSeenAt > GRAPHS_MARKER_MAX_AGE_MS) return;
    if (!(ev.priceAtSignal > 0) || !entry.firstSeenAt) return;
    markers.push({
      time: entry.firstSeenAt, price: ev.priceAtSignal, direction: ev.direction,
      label: (DETECTOR_DEFS[ev.detectorKey] || {}).badge || ev.detectorKey, ev: ev
    });
  });
  return markers;
}

// Живые цифры в шапке карточки (цена/изменение/Range 5м) — раньше вшивались в HTML только при
// (пере)построении карточки (graphsMiniCardHtml), а карточка перестраивалась только при смене
// СОСТАВА видимых монет, поэтому между перестройками цифры в шапке молча стояли на месте. Теперь
// правим их прямо в DOM на каждой перерисовке (см. redrawGraphsGrid ниже) — дёшево (textContent/
// className на 3 узла), не трогает сам canvas/его кэш свечей.
function refreshGraphsCardHeader(card, symbol) {
  const coin = coinMap.get(symbol);
  if (!coin) return;
  const changeCls = coin.change24 >= 0 ? 'up' : 'down';
  const priceEl = card.querySelector('.mini-chart-price');
  if (priceEl) { priceEl.textContent = fmtPrice(coin.price); priceEl.className = 'mini-chart-price ' + changeCls; }
  const changeEl = card.querySelector('.mini-chart-change');
  if (changeEl) {
    changeEl.textContent = coin.change24 != null ? (coin.change24 >= 0 ? '+' : '') + coin.change24.toFixed(2) + '%' : '';
    changeEl.className = 'mini-chart-change ' + changeCls;
  }
  const rangeEl = card.querySelector('.mini-chart-range');
  if (rangeEl && Number.isFinite(coin.range5m)) rangeEl.textContent = 'Range 5м ' + coin.range5m.toFixed(1) + '%';
}

function redrawGraphsGrid() {
  const page = document.getElementById('page-graphs');
  if (!page || !page.classList.contains('active')) return;
  const grid = document.getElementById('graphsGrid');
  if (!grid) return;
  grid.querySelectorAll('.mini-chart-card').forEach(function (card) {
    const symbol = card.dataset.symbol;
    const candles = graphsCandles.get(symbol);
    const canvas = card.querySelector('.mini-chart-canvas');
    const coin = coinMap.get(symbol);
    refreshGraphsCardHeader(card, symbol);
    if (!candles || candles.length < 2) {
      // Свечи ещё не пришли (см. graphsSymbolNeedsFetch/refreshGraphsCandles) — честный "грузится",
      // а не молча чёрный экран: на desktop-сборке единичный REST-запрос может реально занять
      // секунды из-за curl.exe-моста (см. её же комментарий), непонятно ли это подвисло или правда
      // ещё грузится — пусть видно, что второе.
      if (canvas) drawGraphsLoadingPlaceholder(canvas);
      return;
    }
    // "Дышащая" последняя свеча — патчим close/high/low живой ценой из WS (coinMap), без нового
    // REST-запроса на каждый кадр; сам массив candles (кэш) не мутируем, чтобы следующий такой же
    // патч не накапливал ошибку поверх уже пропатченной копии.
    const patched = candles.slice();
    const lastIdx = patched.length - 1;
    if (coin && coin.price > 0) {
      const last = patched[lastIdx];
      patched[lastIdx] = Object.assign({}, last, {
        c: coin.price, h: Math.max(last.h, coin.price), l: Math.min(last.l, coin.price)
      });
    }
    const view = graphsChartView.get(symbol);
    const rich = isTier2Watchlisted(symbol);
    const watermark = (coin && coin.baseAsset) || rawSymbol(symbol).replace(/USDT$/, '');
    // Дельта считается по ТОМУ ЖЕ окну свечей, что реально сейчас на экране (зум/пан карточки, см.
    // graphsChartView) — та же формула среза, что drawMiniCandleChart применит к patched внутри себя,
    // иначе при панораме назад по истории бары дельты уедут от своих свечей.
    let deltaSeries = null;
    if (rich) {
      const maxCandles = Math.max(8, view ? view.count : 96);
      const offsetFromEnd = Math.max(0, Math.min(patched.length - 2, view ? view.offset : 0));
      const sliceEnd = patched.length - offsetFromEnd;
      const sliceStart = Math.max(0, sliceEnd - maxCandles);
      deltaSeries = deltaSeriesForSymbol(symbol, patched.slice(sliceStart, sliceEnd));
    }
    drawMiniCandleChart(canvas, patched, {
      markers: graphsMarkersForSymbol(symbol),
      maxCandles: view ? view.count : undefined,
      offsetFromEnd: view ? view.offset : 0,
      watermark: watermark,
      depthWalls: rich ? depthWallsForSymbol(symbol) : null,
      deltaSeries: deltaSeries
    });
  });
}

// Копирование тикера монеты (кнопка mini-chart-copy на карточке «Графики») — тот же паттерн
// clipboard-с-fallback'ом, что и copySymbolForVataga выше, просто нейтральный тост без упоминания
// конкретного терминала (тут это просто "скопировать тикер", а не подсказка для конкретного места).
function copyGraphsTicker(symbol) {
  const text = rawSymbol(symbol);
  const announce = function () { showAppToast(t('Тикер скопирован') + ': ' + text); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(announce).catch(function () { fallbackCopyText(text); announce(); });
  } else {
    fallbackCopyText(text);
    announce();
  }
}

(function wireGraphsGridClick() {
  const grid = document.getElementById('graphsGrid');
  if (!grid) return;

  // Клики по кнопкам в шапке карточки — открепить/скопировать/открыть в Скринере. Клик по самому
  // графику (canvas) больше никуда не уводит: там теперь зум/пан (колесо/зажать-потащить, ниже) и
  // двойной клик — сброс.
  grid.addEventListener('click', function (e) {
    const unpinBtn = e.target.closest('[data-unpin]');
    if (unpinBtn) {
      e.stopPropagation();
      graphsPinned.delete(unpinBtn.dataset.unpin);
      saveGraphsPinned();
      graphsForceRebuild = true;
      updateGraphsPage();
      return;
    }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) { e.stopPropagation(); copyGraphsTicker(copyBtn.dataset.copy); return; }
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { e.stopPropagation(); openCoinFromPattern(openBtn.dataset.open); return; }
  });

  // Наведение на маркер алгоритма — полное объяснение (explainPatternEvent) через нативный title,
  // без отдельного плавающего тултипа: canvas.__markerHits проставляется drawMiniCandleChart'ом
  // (см. её же комментарий) на каждую перерисовку. Во время перетаскивания (панорамы) не дёргаем —
  // ниже координаты маркеров всё равно сейчас же станут неактуальны от следующей перерисовки.
  const HOVER_RADIUS_PX = 8;
  grid.addEventListener('mousemove', function (e) {
    if (graphsDrag) return;
    const canvas = e.target.closest('.mini-chart-canvas');
    if (!canvas) return;
    const hits = canvas.__markerHits || [];
    if (!hits.length) { if (canvas.title) canvas.title = ''; return; }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let found = null, bestDist = HOVER_RADIUS_PX;
    hits.forEach(function (h) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= bestDist) { bestDist = d; found = h; }
    });
    const nextTitle = found ? explainPatternEvent(found.ev) : '';
    if (canvas.title !== nextTitle) canvas.title = nextTitle; // не дёргаем title на каждый мышемув без надобности
  });

  // Колесо мыши над конкретным мини-графиком — зум ЭТОЙ карточки (не всей страницы): вверх —
  // приблизить (меньше свечей видно), вниз — отдалить. preventDefault, чтобы страница саму не
  // скроллило заодно.
  grid.addEventListener('wheel', function (e) {
    const canvas = e.target.closest('.mini-chart-canvas');
    if (!canvas) return;
    const card = canvas.closest('.mini-chart-card[data-symbol]');
    if (!card) return;
    const symbol = card.dataset.symbol;
    const candles = graphsCandles.get(symbol);
    if (!candles || candles.length < 2) return;
    e.preventDefault();
    const view = graphsChartView.get(symbol) || { count: Math.min(96, candles.length), offset: 0 };
    const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    const maxCount = Math.min(candles.length, GRAPHS_MAX_ZOOM_CANDLES);
    const nextCount = Math.max(GRAPHS_MIN_ZOOM_CANDLES, Math.min(maxCount, Math.round(view.count * factor)));
    const maxOffset = Math.max(0, candles.length - nextCount);
    graphsChartView.set(symbol, { count: nextCount, offset: Math.max(0, Math.min(maxOffset, view.offset)) });
    redrawGraphsGrid();
  }, { passive: false });

  // Зажать и тащить — панорама (пан) той же карточки. Слушаем mousemove/mouseup на document, а не
  // на grid/canvas, чтобы перетаскивание не срывалось, если курсор на миг ушёл за пределы холста —
  // обычное поведение drag в любом графическом редакторе/чарте.
  grid.addEventListener('mousedown', function (e) {
    const canvas = e.target.closest('.mini-chart-canvas');
    if (!canvas) return;
    const card = canvas.closest('.mini-chart-card[data-symbol]');
    if (!card) return;
    const symbol = card.dataset.symbol;
    const candles = graphsCandles.get(symbol);
    if (!candles || candles.length < 2) return;
    const view = graphsChartView.get(symbol) || { count: Math.min(96, candles.length), offset: 0 };
    graphsDrag = { symbol: symbol, canvas: canvas, startX: e.clientX, startOffset: view.offset, count: view.count };
    canvas.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!graphsDrag) return;
    const candles = graphsCandles.get(graphsDrag.symbol);
    if (!candles || candles.length < 2) return;
    const dx = e.clientX - graphsDrag.startX;
    const pxPerCandle = (graphsDrag.canvas.clientWidth || 220) / graphsDrag.count;
    const deltaCandles = Math.round(dx / pxPerCandle);
    const maxOffset = Math.max(0, candles.length - graphsDrag.count);
    const nextOffset = Math.max(0, Math.min(maxOffset, graphsDrag.startOffset + deltaCandles));
    graphsChartView.set(graphsDrag.symbol, { count: graphsDrag.count, offset: nextOffset });
    redrawGraphsGrid();
  });
  document.addEventListener('mouseup', function () {
    if (!graphsDrag) return;
    if (graphsDrag.canvas) graphsDrag.canvas.classList.remove('dragging');
    graphsDrag = null;
  });

  // Двойной клик по графику — сброс зума/пана этой карточки к дефолту (последние 96 свечей).
  grid.addEventListener('dblclick', function (e) {
    const canvas = e.target.closest('.mini-chart-canvas');
    if (!canvas) return;
    const card = canvas.closest('.mini-chart-card[data-symbol]');
    if (!card) return;
    graphsChartView.delete(card.dataset.symbol);
    redrawGraphsGrid();
  });
})();

(function wireGraphsPinInput() {
  const input = document.getElementById('graphsPinInput');
  if (!input) return;
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) return;
    const qUpper = q.toUpperCase();
    let match = coinMap.get(qUpper + '/USDT') || null;
    if (!match) {
      match = allCoins.find(function (c) { return c.baseAsset.toUpperCase() === qUpper || c.symbol.toUpperCase() === qUpper; }) || null;
    }
    if (!match) { showAppToast(t('Монета не найдена') + ': ' + q); return; }
    graphsPinned.add(match.symbol);
    saveGraphsPinned();
    input.value = '';
    graphsForceRebuild = true;
    updateGraphsPage();
  });
})();

// Растягивает сетку на реальное число ВИДИМЫХ карточек (не на выбранный "2×2/3×3/..." в фильтре —
// тот только задаёт МАКСИМУМ монет, реальных карточек может быть меньше из-за фильтров/избранного),
// иначе при небольшом числе карточек они жмутся в угол (auto-fill считает колонки по ширине окна,
// а не по факту "мало карточек — потому покажи их покрупнее на всю высоту"). Квадратное разбиение —
// ближайшее к NxN под фактический count, столбцы всегда 1fr (тянутся по ширине), строки —
// minmax(130px, 1fr): есть место — растут и заполняют; тесно (много карточек на невысоком окне) —
// не сжимаются меньше читаемого предела, тогда включается прокрутка обёртки (см. её же CSS flex:1;
// overflow-y:auto в index.html).
function applyGraphsGridLayout(grid, count) {
  if (!count) { grid.style.gridTemplateColumns = ''; grid.style.gridTemplateRows = ''; return; }
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
  grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(130px, 1fr))';
}

function updateGraphsPage() {
  const page = document.getElementById('page-graphs');
  if (!page || !page.classList.contains('active')) return;
  const symbols = computeGraphsVisibleSymbols();
  const forced = graphsForceRebuild; // пин/анпин/смена фильтра — статичная разметка карточки тоже могла поменяться
  const prevSet = new Set(graphsVisibleSymbols);
  // СОСТАВ (какие монеты вообще видны), а не порядок — раньше сравнивали symbols.join(',') целиком,
  // и любая волатильная метрика (Всплеск 5с, Range 5м) меняет ПОРЯДОК почти на каждом тике даже без
  // единой новой монеты в топе. Это заставляло периодический пересчёт (см. setInterval ниже) сносить
  // ВСЮ сетку в grid.innerHTML = ... на каждый чих — canvas с уже загруженными свечами превращался
  // обратно в чёрный пустой экран, и на большой сетке (5×5 = 25 монет) REST не успевал перезагрузить
  // всё до следующего сноса — сетка выглядела вечно пустой. Теперь при чистой смене порядка карточки
  // просто переставляются (см. ниже), без разрушения canvas/повторной загрузки свечей.
  const membershipChanged = forced || symbols.length !== graphsVisibleSymbols.length ||
    symbols.some(function (s) { return !prevSet.has(s); });
  const orderChanged = symbols.join(',') !== graphsVisibleSymbols.join(',');
  graphsForceRebuild = false;
  graphsVisibleSymbols = symbols;
  const countEl = document.getElementById('graphsCount');
  if (countEl) countEl.textContent = symbols.length + ' ' + t('монет');
  const grid = document.getElementById('graphsGrid');
  if (grid && (membershipChanged || orderChanged)) {
    if (!symbols.length) {
      grid.innerHTML = '<div class="finres-empty" style="grid-column:1/-1;"><i class="ri-layout-grid-line"></i>' +
        t('Нет монет, подходящих под текущий выбор.') + '</div>';
    } else if (forced) {
      // Форсированная перестройка — меняется и статичная разметка карточки (кнопка "открепить" и
      // т.п.), не только состав, так что честно перестраиваем всё заново.
      grid.innerHTML = symbols.map(graphsMiniCardHtml).join('');
    } else {
      // Обычная периодическая ре-сортировка — переиспользуем DOM уже отрисованных карточек (не
      // сбрасываем их canvas и не роняем уже загруженные свечи), новые узлы создаём только для
      // монет, реально впервые вошедших в топ; выпавшие из топа узлы просто не переносим в новый
      // порядок (сборщик мусора заберёт).
      const existingCards = new Map();
      grid.querySelectorAll('.mini-chart-card[data-symbol]').forEach(function (card) {
        existingCards.set(card.dataset.symbol, card);
      });
      const frag = document.createDocumentFragment();
      symbols.forEach(function (symbol) {
        const card = existingCards.get(symbol);
        if (card) { frag.appendChild(card); }
        else {
          const wrap = document.createElement('div');
          wrap.innerHTML = graphsMiniCardHtml(symbol);
          frag.appendChild(wrap.firstElementChild);
        }
      });
      grid.innerHTML = '';
      grid.appendChild(frag);
    }
    applyGraphsGridLayout(grid, symbols.length);
  }
  // Список отдаём ВЕСЬ видимый набор — какие из них реально нуждаются в свежих свечах, решает сам
  // graphsSymbolNeedsFetch внутри refreshGraphsCandles (нет кэша ИЛИ кэш старше минуты), так что
  // лишний REST/curl.exe за уже свежей монетой не улетает просто потому что она поменяла позицию
  // в топе или карточка была форс-пересобрана.
  if (symbols.length) refreshGraphsCandles(symbols);
  redrawGraphsGrid();
}
setInterval(redrawGraphsGrid, GRAPHS_REDRAW_MS);
// Раньше здесь просто перезапрашивались свечи для УЖЕ имеющегося graphsVisibleSymbols — сам список
// (какие именно монеты сейчас в топе по выбранной метрике, например «Всплеск 5с») никогда не
// пересчитывался периодически, только при заходе на страницу / смене фильтра. На быстрой метрике
// вроде vol5s топ должен постоянно ротироваться — а у нас застывал на составе, что был на момент
// открытия страницы, и выглядело так, будто сетка "не обновляется". updateGraphsPage() сам
// пересчитывает computeGraphsVisibleSymbols() и перестраивает карточки, только если состав реально
// изменился (см. её же переменную changed) — так что для неизменившегося топа это дешёвый no-op.
setInterval(updateGraphsPage, GRAPHS_REFRESH_MS);
['graphsGridSize', 'graphsSortMetric', 'graphsTimeframe', 'graphsExchangeFilter', 'graphsFavoritesOnly'].forEach(function (id) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', function () { graphsForceRebuild = true; updateGraphsPage(); });
});

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
      '<div class="fav-symbol">' + coinDisplayLabel(c) + '</div>' +
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

// Общий "плоский" фильтр по бирже (Все/MEXC/Binance/.../OKX) — переиспользуется страницами
// "Аналитика" и "Оповещения" (см. вызовы ниже), которые раньше ранжировали/показывали allCoins
// целиком, вперемешку показывая монеты сразу всех подключённых бирж в одном списке — при нескольких
// подключённых биржах быстро превращалось в нечитаемую кашу из разноцветных бейджей.
// getActive/setActive — геттер/сеттер конкретной страницы (analyticsExchangeFilter/alertsExchangeFilter
// и т.п.), onChange — что перерисовать после смены фильтра. Кнопки — тот же exch-switch-btn, что и у
// переключателя бирж в тулбаре скринера, просто без выдвижной ленты спот/фьючерс (для второстепенных
// страниц с топ-листами эта тонкость не нужна — Binance-фьючерсы там просто отдельная кнопка "F").
function renderFlatExchFilter(containerId, getActive, setActive, onChange) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const connectedIds = Object.keys(EXCHANGE_CONNECTORS).filter(function (id) { return exchangeConnections[id] && exchangeConnections[id].connected; });
  if (!connectedIds.length) {
    box.style.display = 'none';
    if (getActive() !== 'ALL') setActive('ALL'); // нечего фильтровать — единственная биржа снова MEXC
    return;
  }
  box.style.display = 'flex';
  const tags = ['MEXC'].concat(connectedIds.reduce(function (acc, id) { return acc.concat(EXCHANGE_CONNECTORS[id].exchangeTags); }, []));
  const buttons = ['ALL'].concat(tags);
  const active = getActive();
  box.innerHTML = buttons.map(function (ex) {
    if (ex === 'ALL') {
      return '<div class="exch-switch-btn exch-switch-all' + (active === 'ALL' ? ' active' : '') + '" data-fexch="ALL">' + t('Все') + '</div>';
    }
    return '<div class="exch-switch-btn exch-switch-' + ex.toLowerCase() + (active === ex ? ' active' : '') +
      '" data-fexch="' + ex + '" title="' + (EXCHANGE_SWITCH_TITLES[ex] || ex) + '">' + EXCHANGE_SWITCH_LABELS[ex] + '</div>';
  }).join('');
  if (!box.dataset.wired) {
    box.dataset.wired = '1'; // слушатель на контейнере переживает переотрисовку innerHTML — вешаем один раз
    box.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-fexch]');
      if (!btn || getActive() === btn.dataset.fexch) return;
      setActive(btn.dataset.fexch);
      onChange();
    });
  }
}

// Какая биржа сейчас выбрана в фильтре страницы "Аналитика" (см. analyticsExchFilter) — по умолчанию
// "Все", как и раньше.
let analyticsExchangeFilter = 'ALL';
function renderAnalyticsExchFilter() {
  renderFlatExchFilter('analyticsExchFilter',
    function () { return analyticsExchangeFilter; },
    function (v) { analyticsExchangeFilter = v; },
    updateAnalytics);
}

function updateAnalytics() {
  renderAnalyticsExchFilter();
  // Полоска относительной "тяжести" значения внутри своей восьмёрки (не просто число — сразу видно,
  // насколько первое место оторвалось от остальных) + номер места + шаг анимации появления при каждой
  // смене списка (то же ощущение, что и у staggered-плиток в Финрезе).
  function list(arr, fmt, valueOf, barVar) {
    if (!arr.length) return '<div class="rank-row rank-row-empty">' + t('Нет данных') + '</div>';
    const maxVal = Math.max.apply(null, arr.map(function (c) { return Math.abs(valueOf(c)); })) || 1;
    return arr.map(function (c, i) {
      const pct = Math.min(100, Math.abs(valueOf(c)) / maxVal * 100);
      return '<div class="rank-row" style="animation-delay:' + (i * 28) + 'ms">' +
        '<span class="rank-num">' + (i + 1) + '</span>' +
        '<span class="rank-coin">' + coinDisplayLabel(c) + '</span>' +
        '<span class="rank-value">' + fmt(c) + '</span>' +
        '<span class="rank-bar-track"><span class="rank-bar-fill" style="width:' + pct.toFixed(1) + '%;background:var(' + barVar + ')"></span></span>' +
      '</div>';
    }).join('');
  }
  const copy = (analyticsExchangeFilter === 'ALL' ? allCoins : allCoins.filter(function (c) { return (c.exchange || 'MEXC') === analyticsExchangeFilter; })).slice();
  document.getElementById('topGainers').innerHTML = list(
    copy.slice().sort(function (a, b) { return b.change24 - a.change24; }).slice(0, 8),
    function (c) { return '<span class="price-up">+' + c.change24.toFixed(2) + '%</span>'; },
    function (c) { return c.change24; }, '--green');
  document.getElementById('topLosers').innerHTML = list(
    copy.slice().sort(function (a, b) { return a.change24 - b.change24; }).slice(0, 8),
    function (c) { return '<span class="price-down">' + c.change24.toFixed(2) + '%</span>'; },
    function (c) { return c.change24; }, '--red');
  document.getElementById('topVolume').innerHTML = list(
    copy.slice().sort(function (a, b) { return b.vol24 - a.vol24; }).slice(0, 8),
    function (c) { return fmtNum(c.vol24); },
    function (c) { return c.vol24; }, '--blue');
  document.getElementById('topVolat').innerHTML = list(
    copy.slice().sort(function (a, b) { return b.vol60s - a.vol60s; }).slice(0, 8),
    function (c) { return c.vol60s.toFixed(3) + '%'; },
    function (c) { return c.vol60s; }, '--orange');
}

// Какая биржа сейчас выбрана в фильтре страницы "Оповещения" (см. renderFlatExchFilter) — бейдж в
// сайдбаре при этом всегда честно считает ВСЕ оповещения по всем биржам сразу (это его роль —
// "сколько их вообще"), фильтр сужает только сам список ниже.
let alertsExchangeFilter = 'ALL';
function renderAlertsExchFilter() {
  renderFlatExchFilter('alertsExchFilter',
    function () { return alertsExchangeFilter; },
    function (v) { alertsExchangeFilter = v; },
    updateAlerts);
}

// Рост/Падение/Все — отдельный от биржевого фильтр направления движения: раньше растущие и падающие
// пары были свалены в один список, отсортированный только по силе движения, из-за чего его было
// неудобно сканировать глазами ("а где вообще падения?"). Своя маленькая пилюльная лента рядом с
// биржевым фильтром, тот же паттерн wireAlertsDirFilter/dataset.wired, что и у renderFlatExchFilter.
let alertsDirFilter = 'ALL'; // 'ALL' | 'UP' | 'DOWN'
const ALERTS_DIR_OPTIONS = [
  { id: 'ALL', label: 'Все', icon: '' },
  { id: 'UP', label: 'Рост', icon: 'ri-arrow-up-line' },
  { id: 'DOWN', label: 'Падение', icon: 'ri-arrow-down-line' }
];
function renderAlertsDirFilter() {
  const box = document.getElementById('alertsDirFilter');
  if (!box) return;
  box.innerHTML = ALERTS_DIR_OPTIONS.map(function (o) {
    return '<div class="alerts-dir-btn alerts-dir-' + o.id.toLowerCase() + (alertsDirFilter === o.id ? ' active' : '') + '" data-dir="' + o.id + '">' +
      (o.icon ? '<i class="' + o.icon + '"></i>' : '') + t(o.label) + '</div>';
  }).join('');
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-dir]');
      if (!btn || alertsDirFilter === btn.dataset.dir) return;
      alertsDirFilter = btn.dataset.dir;
      updateAlerts();
    });
  }
}

function updateAlerts() {
  renderAlertsExchFilter();
  renderAlertsDirFilter();
  const thr = num(document.getElementById('priceAlertThreshold').value) || 8;
  const allHits = allCoins.filter(function (c) { return Math.abs(c.change24) >= thr; });
  document.getElementById('navAlertBadge').textContent = allHits.length;
  let hits = alertsExchangeFilter === 'ALL' ? allHits : allHits.filter(function (c) { return (c.exchange || 'MEXC') === alertsExchangeFilter; });
  if (alertsDirFilter === 'UP') hits = hits.filter(function (c) { return c.change24 >= 0; });
  else if (alertsDirFilter === 'DOWN') hits = hits.filter(function (c) { return c.change24 < 0; });
  hits = hits.sort(function (a, b) { return Math.abs(b.change24) - Math.abs(a.change24); }).slice(0, 30);
  const countBadge = document.getElementById('alertsCountBadge');
  if (countBadge) countBadge.textContent = hits.length;
  const box = document.getElementById('alertsList');
  if (!hits.length) {
    box.innerHTML = '<div class="empty-state"><i class="ri-notification-off-line"></i>' + t('Нет пар с движением ≥') + ' ' + thr + '% ' + t('за 24ч.') + '</div>';
    return;
  }
  const maxAbs = Math.max.apply(null, hits.map(function (c) { return Math.abs(c.change24); })) || 1;
  box.innerHTML = hits.map(function (c, i) {
    const up = c.change24 >= 0;
    const barPct = Math.min(100, Math.abs(c.change24) / maxAbs * 100);
    return '<div class="alert-row" style="animation-delay:' + (i * 22) + 'ms" data-symbol="' + c.symbol + '">' +
      '<span class="alert-row-bar" style="height:' + barPct.toFixed(0) + '%;top:auto;bottom:0;background:var(' + (up ? '--green' : '--red') + ')"></span>' +
      '<span class="alert-row-num">' + (i + 1) + '</span>' +
      '<div class="coin-icon" style="background:' + c.color + '">' + c.baseAsset.charAt(0) + '</div>' +
      '<div class="alert-row-coin"><strong>' + coinDisplayLabel(c) + '</strong><span class="alert-row-price">' + fmtPrice(c.price) + '</span></div>' +
      '<span class="alert-row-change ' + (up ? 'price-up' : 'price-down') + '"><i class="ri-arrow-' + (up ? 'up' : 'down') + '-line"></i> ' + (up ? '+' : '') + c.change24.toFixed(2) + '%</span>' +
      '<i class="ri-arrow-right-s-line alert-row-chevron"></i></div>';
  }).join('');
  wireAlertRowClicks();
}

// Клик по строке — открыть эту монету в скринере, тот же паттерн, что у .fav-card в "Избранном".
// Делегированный слушатель на контейнере (переживает переотрисовку innerHTML) навешивается один раз.
function wireAlertRowClicks() {
  const box = document.getElementById('alertsList');
  if (!box || box.dataset.wired) return;
  box.dataset.wired = '1';
  box.addEventListener('click', function (e) {
    const row = e.target.closest('.alert-row');
    if (!row) return;
    selectCoin(row.dataset.symbol, true);
    switchPage('screener');
  });
}

// Порог оповещения теперь редактируется прямо на странице (стрелки +/- и само поле) — сразу
// перерисовывает список, не дожидаясь ближайшего тика автообновления аналитики/оповещений.
(function wireAlertsThreshold() {
  const input = document.getElementById('priceAlertThreshold');
  const minusBtn = document.getElementById('alertsThrMinus');
  const plusBtn = document.getElementById('alertsThrPlus');
  if (!input) return;
  function step(delta) {
    const cur = num(input.value) || 8;
    const next = Math.max(0.5, Math.round((cur + delta) * 10) / 10);
    input.value = next;
    updateAlerts();
  }
  if (minusBtn) minusBtn.addEventListener('click', function () { step(-0.5); });
  if (plusBtn) plusBtn.addEventListener('click', function () { step(0.5); });
  input.addEventListener('input', updateAlerts);
})();

function switchPage(pageId) {
  document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
  const target = document.getElementById('page-' + pageId);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(function (n) {
    n.classList.toggle('active', n.dataset.page === pageId);
  });
  if (pageId === 'graphs') updateGraphsPage();
  if (pageId === 'favorites') updateFavoritesPage();
  if (pageId === 'analytics') updateAnalytics();
  if (pageId === 'alerts') updateAlerts();
  if (pageId === 'listings') updateListingsPage();
  if (pageId === 'profiles') updateProfilesPage();
  if (pageId === 'patterns') { renderDetectorFilterRow(); updatePatternsPage(); }
  if (pageId === 'account') refreshAccountBalancesIfConnected();
  if (pageId === 'finres') {
    // Сразу красим хиро/вкладку из уже закешированного lastBalanceState (если он есть — например,
    // юзер уже был на этой странице раньше в сессии), не дожидаясь ответа сети — и параллельно
    // запрашиваем свежие данные.
    renderFinresExchangeTabs();
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
  document.getElementById('strategyHintText').textContent = t(def.label) + ': ' + t(def.short);
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
  const wall = detectStandingWall(c.symbol); // не-null только для watchlist-монет с реальной подпиской на стакан
  if (zoneText) {
    if (wall) {
      // Watchlist-монета с реальной стеной — показываем настоящий уровень стакана, а не тиковое приближение.
      zoneText.innerHTML = '<span class="lvl-tag">стена:</span>' + fmtPrice(wall.priceLevel) +
        ' (' + (wall.side === 'ask' ? 'ask' : 'bid') + ', ' + wall.wallRatio + '×)';
    } else if (c.zoneLow != null && c.zoneHigh != null) {
      // c.zoneHigh > c.zoneLow (строго) — НАЙДЕННЫЙ баг: у самой "идеальной" для этой стратегии
      // ситуации — совершенно плоской, спокойной досплесковой фазы (та же цена и 60с, и 30с назад,
      // ровно то, что текст ниже описывает как "движение было спокойным: 0.00%") — zoneLow и zoneHigh
      // ЧИСЛЕННО РАВНЫ (min/max одной и той же цены). Строгое ">" тогда ложно проваливалось в ветку
      // "копим данные…", хотя данные уже есть — просто зона выродилась в одну точку. Теперь такой
      // случай показывается как "≈цена" вместо противоречивого "копим данные" рядом с уже готовым
      // объяснением пробоя.
      zoneText.innerHTML = '<span class="lvl-tag">зона:</span>' +
        (c.zoneHigh > c.zoneLow ? fmtPrice(c.zoneLow) + '–' + fmtPrice(c.zoneHigh) : '≈' + fmtPrice(c.zoneLow));
    } else {
      zoneText.innerHTML = '<span class="lvl-tag">зона:</span>копим данные…';
    }
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
    // STRATEGY_DEFS.algo.match() (вызван строкой выше как matched) уже посчитал c.__algoEvent —
    // не пересчитываем bestActiveAlgoEventFor второй раз, просто читаем свежий результат.
    if (c.__algoEvent) {
      const def = DETECTOR_DEFS[c.__algoEvent.detectorKey];
      return 'Совпадает с профилем — активен реальный Tier-2 алгоритм «' + t(def.label) + '» (сделки/стакан, не тиковая эвристика). ' +
        explainPatternEvent(c.__algoEvent);
    }
    const cvText = c.rateCV != null ? (c.rateCV * 100).toFixed(0) + '%' : '—';
    return prefix + '(тиковая эвристика — монета вне watchlist глубокого анализа, либо ни один из 10 ' +
      'микроструктурных алгоритмов сейчас не активен). Скорость оборота почти не меняется между окнами ' +
      '5с/30с/60с (разброс ' + cvText + '), а цена держится в узком диапазоне: ' + pctText(c.vol5s) + ' за 5с, ' +
      pctText(c.vol30s) + ' за 30с, ' + pctText(c.vol60s) + ' за 60с. Сочетание "ровный темп сделок + минимум ' +
      'движения цены" типично для маркет-мейкера или арбитражного бота, а не для органической торговли людьми.';
  }
  if (key === 'ineff') {
    return prefix + 'Цена сдвинулась на ' + pctText(c.vol5s) + ' всего за 5 секунд, но объём при этом вырос лишь ' +
      'в ' + burst.toFixed(1) + '× от обычного темпа этой монеты — заметно меньше, чем бывает при реальном ' +
      'потоке заявок. Движение цены опережает подтверждающий его объём: похоже, что её сдвинула небольшая ' +
      'заявка на тонком участке книги ордеров, а не устойчивый спрос/предложение.';
  }
  if (key === 'density') {
    // STRATEGY_DEFS.density.match() (вызван строкой выше как matched) уже посчитал c.__wallEvent —
    // не пересчитываем detectStandingWall второй раз, просто читаем свежий результат.
    if (c.__wallEvent) {
      const w = c.__wallEvent;
      return 'Совпадает с профилем — реальная стена в стакане. На ' + (w.side === 'ask' ? 'продажу' : 'покупку') +
        ' у ' + fmtPrice(w.priceLevel) + ' стоит заявка в ' + w.wallRatio + '× больше типичного соседнего уровня ' +
        '(≈$' + w.volumeUsd.toLocaleString('ru-RU') + '), в ' + w.distancePct + '% от текущей цены — и цена к ней ' +
        'устойчиво приближается несколько снимков стакана подряд. Confidence ' + w.confidencePct + '%.';
    }
    const calmText = c.preMove != null ? pctText(c.preMove) : 'нет данных';
    const revertText = c.reverting
      ? ' Но в последние ~2с цена уже разворачивается против этого всплеска — больше похоже на фитиль/ложный ' +
        'прокол уровня, чем на устойчивый пробой, поэтому в выдачу она не попадёт.'
      : (matched ? ' Разворота против движения в последние ~2с не видно — похоже на устойчивый пробой.' : '');
    return prefix + '(тиковое приближение — монета вне watchlist глубокого анализа). Перед всплеском ' +
      '(60с→30с назад) движение было спокойным: ' + calmText + '. За последние 5с объём резко вырос — в ' +
      burst.toFixed(1) + '× от обычного дневного темпа этой монеты, и цена пошла на ' + pctText(c.vol5s) + '.' + revertText;
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

// Тот же HMAC-SHA256, что и hmacSha256Hex выше, но с base64-кодированием результата вместо hex —
// именно так подписывает запросы OKX (см. EXCHANGE_CONNECTORS.okx.sign ниже); MEXC/Binance используют hex.
async function hmacSha256Base64(secret, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  let binary = '';
  new Uint8Array(sigBuf).forEach(function (b) { binary += String.fromCharCode(b); });
  return btoa(binary);
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

// Кэш результата самопроверки на время жизни приложения: антивирус/EDR чаще всего задерживает
// только ПЕРВЫЙ запуск дочернего процесса ("cold-start" поведенческая проверка), последующие
// запуски того же бинарника обычно уже быстрые. Поэтому: (1) успех кэшируем НАВСЕГДА — не гоняем
// одну и ту же 5-10с проверку перед КАЖДЫМ запросом klines/myTrades; (2) неудачу кэшируем лишь на
// короткое окно (30с), чтобы серия быстрых подряд идущих запросов не каждый раз ждала полный
// таймаут — но и не залипала в "сломано" навсегда, если пользователь тем временем добавил
// исключение в антивирус, не перезапуская приложение.
let nativeExecOk = null; // null = ещё не проверяли, true = подтверждено рабочим, false = недавно упало
let nativeExecFailedAt = 0;
let nativeExecFailReason = '';
const NATIVE_EXEC_FAIL_COOLDOWN_MS = 30000;

// Общий текст диагноза + сброс кэша self-test'а — используется и самим execCommandSelfTest(), и
// ниже в nativeCurlGet/nativeCurlDownloadToFile для СЛУЧАЯ, который self-test с его кэшем "успех
// навсегда" не ловит: антивирус/EDR иногда разрешает самый первый дочерний процесс (self-test это
// проходит, результат кэшируется как "работает"), а потом, ПОСЕРЕДИНЕ сессии, начинает блокировать
// дальнейшие — поведенческая эскалация по накопленной активности, а не разовая проверка при старте.
// Без этой функции пользователь в такой момент видел голое "native-мост не ответил за N мс" вместо
// понятной инструкции. Помечаем кэш снова как "сломано", чтобы и следующий вызов сразу получил
// этот же понятный текст, не дожидаясь очередного полного таймаута.
function markNativeExecBroken(rawMessage) {
  nativeExecOk = false;
  nativeExecFailedAt = Date.now();
  nativeExecFailReason = 'Запуск процессов из приложения не работает на этой машине (' + rawMessage + '). ' +
    'Похоже, антивирус блокирует или задерживает дочерние процессы у MEXC-Screener.exe. Добавьте ' +
    'MEXC-Screener.exe в исключения антивируса (Защитник Windows: Параметры → Безопасность Windows → ' +
    'Защита от вирусов и угроз → Управление настройками → Добавление или удаление исключений) и попробуйте снова.';
  return nativeExecFailReason;
}

async function execCommandSelfTest() {
  if (nativeExecOk === true) return; // уже подтверждено рабочим в этой сессии — не проверяем повторно
  if (nativeExecOk === false && (Date.now() - nativeExecFailedAt) < NATIVE_EXEC_FAIL_COOLDOWN_MS) {
    throw new Error(nativeExecFailReason); // недавно падало — не ждём ещё раз полный таймаут, отвечаем сразу
  }
  try {
    // 10с, а не 5с: если антивирус делает поведенческую проверку самого первого дочернего процесса
    // (обычное дело для Windows Defender "cloud-delivered protection"), она может занять несколько
    // секунд сама по себе, даже когда процессы в итоге ЗАПУСКАЮТСЯ нормально — слишком короткий
    // таймаут здесь давал ложный "сломано" именно в этом случае.
    const ping = await nlCall('os.execCommand', { command: 'cmd.exe /C echo ping', background: false }, 10000);
    if (!ping || ping.exitCode !== 0) {
      throw new Error('запуск процессов вернул код ' + (ping && ping.exitCode));
    }
    nativeExecOk = true;
  } catch (pingErr) {
    throw new Error(markNativeExecBroken(pingErr.message));
  }
}

// Запасной путь для десктоп-приложения (Neutralino): выполняет HTTP-запрос через curl.exe (входит
// в Windows 10/11 по умолчанию) — это ОТДЕЛЬНЫЙ ОС-процесс, не запрос браузера, поэтому на него не
// распространяются ограничения CORS. curl.exe — обычный скомпилированный бинарник (в отличие от
// PowerShell с закодированным скриптом, который антивирусы чаще проверяют дольше как потенциально
// подозрительный). Используется автоматически, только если обычный fetch() не сработал.
// headers — план объект {имя: значение} (например {'X-MEXC-APIKEY': ключ} у MEXC, четыре
// OK-ACCESS-* заголовка у OKX — см. EXCHANGE_CONNECTORS) или null/falsy для публичных эндпоинтов
// без авторизации (klines и т.п., заголовок тогда просто не добавляется).
async function nativeCurlGet(url, headers, method) {
  if (!window.Neutralino) {
    return null; // нативный путь недоступен (не десктоп-приложение)
  }
  await execCommandSelfTest(); // бросит понятную ошибку, если процессы вообще не запускаются

  const header = headers
    ? Object.keys(headers).map(function (k) { return ' -H "' + stripQuotes(k) + ': ' + stripQuotes(headers[k]) + '"'; }).join('')
    : '';
  // -X нужен только для не-GET (например POST/PUT/DELETE /api/v3/userDataStream — см. listenKeyRequest
  // ниже); MEXC у этих эндпоинтов, как и у GET, ожидает подписанные параметры в query string, тело
  // запроса не нужно, поэтому просто меняем метод, а не добавляем -d.
  const methodFlag = (method && method !== 'GET') ? ' -X ' + method : '';
  const cmd = 'curl.exe -s -S --max-time 10' + methodFlag + header + ' "' + stripQuotes(url) + '"';
  // Таймаут МОСТА здесь должен быть заметно больше --max-time самого curl (10с) — тот же запас на
  // поведенческую проверку антивирусом ПЕРЕД стартом дочернего процесса, что и в execCommandSelfTest
  // выше (там на неё явно выделено 10с даже для мгновенного "echo"). Раньше здесь стояло 14000 —
  // при 10с у curl это давало всего ~4с запаса на саму проверку антивируса, WS-туда-обратно и разбор
  // ответа. На "прогретой" машине этого хватало почти всегда, но именно поэтому ошибка была
  // РЕДКОЙ, а не системной: иногда антивирус на конкретный запуск curl.exe (не на сам факт запуска
  // процессов вообще — тот execCommandSelfTest уже проверил и закэшировал успешным) тратит на пару
  // секунд больше обычного, и мост не успевает уложиться в 14с, хотя curl.exe в итоге отработал бы
  // нормально. 22с — тот же принцип, что и у self-test (до ~10с на антивирус) плюс полные 10с у
  // curl.exe плюс запас на сам WS-обмен.
  const bridgeTimeoutMs = 22000;
  let result;
  try {
    result = await nlCall('os.execCommand', { command: cmd, background: false }, bridgeTimeoutMs);
  } catch (bridgeErr) {
    // Мост не ответил вовремя — почти всегда одноразовая задержка старта ИМЕННО ЭТОГО запуска
    // curl.exe (см. выше), а не системная поломка моста (ту execCommandSelfTest() уже отсеял бы
    // ошибкой до этого места, ЕСЛИ бы она была видна с самого начала сессии). Один быстрый повтор
    // почти всегда решает проблему без участия пользователя.
    if (!/не ответил/.test(bridgeErr.message)) throw bridgeErr;
    try {
      result = await nlCall('os.execCommand', { command: cmd, background: false }, bridgeTimeoutMs);
    } catch (secondErr) {
      // Мост правда недоступен и на повторе — это тот же диагноз, что даёт execCommandSelfTest(),
      // просто он мог проявиться ПОЗЖЕ (антивирус разрешил самый первый пробный процесс, потом начал
      // блокировать) и потому не был пойман в начале сессии. Помечаем кэш сломанным на будущее и
      // отдаём то же понятное сообщение с инструкцией, а не голый таймаут моста.
      throw new Error(markNativeExecBroken(secondErr.message));
    }
  }
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
      native = await nativeCurlGet(url, { 'X-MEXC-APIKEY': mexcApiKey }, method);
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
  updateAcctTabStatus('mexc', state === 'connected');
}

// Кружок-индикатор и подсветка вкладки биржи на "Настройки аккаунта" (см. exch-tabs в index.html) —
// вызывается и из setAccountStatus (MEXC) выше, и из setExchangeStatus (Binance/OKX) ниже.
function updateAcctTabStatus(id, connected) {
  const tab = document.querySelector('.exch-tab[data-exch-tab="' + id + '"]');
  const dot = document.getElementById('acctTabDot' + id.charAt(0).toUpperCase() + id.slice(1));
  if (tab) tab.classList.toggle('connected', connected);
  if (dot) dot.textContent = connected ? t('Подключено') : t('Не подключено');
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

// coinMap-запись монеты для ТЕКУЩЕЙ активной биржи Финреза (finresActiveExchange) — "голый" ключ
// ("BTC/USDT") для MEXC, префиксованный ("BINANCE:BTC/USDT") для любой другой (см. upsertExternalCoin);
// EXCHANGE_CONNECTORS[id].exchangeTags[0] — спотовый тег, не фьючерсный (Финрез сейчас только про
// спотовый баланс/сделки, см. комментарий у switchFinresExchange).
// exchangeIdOverride — опционально: используется finresLoadRealizedCore, чтобы фоновая загрузка,
// начатая для одной биржи, не "поплыла" на другую биржу, если пользователь переключится в Финрезе
// прямо посреди неё (finresActiveExchange к этому моменту уже может указывать на другую биржу —
// см. комментарий у finresLoadRealized/applyFinresLoadResult). Без override — как и раньше, текущая
// активная биржа Финреза.
function financeCoinFor(asset, exchangeIdOverride) {
  const exchangeId = exchangeIdOverride || finresActiveExchange;
  if (exchangeId === 'mexc') return coinMap.get(asset + '/USDT');
  const connector = EXCHANGE_CONNECTORS[exchangeId];
  const spotTag = connector ? connector.exchangeTags[0] : exchangeId.toUpperCase();
  return coinMap.get(spotTag + ':' + asset + '/USDT');
}

// То же самое, что mexcUsdtPrice, но для ТЕКУЩЕЙ (или явно переданной, см. financeCoinFor) активной
// биржи Финреза — mexcUsdtPrice сам остаётся нетронутым, эта обёртка используется только в двух
// местах Финреза, которым реально нужна цена ЛЮБОЙ активной биржи — renderAccountBalances и
// finresLoadRealizedCore; по всем остальным вызовам (включая __fakeFinresLogin) mexcUsdtPrice
// продолжает означать ровно то же, что и раньше.
function financeUsdtPrice(asset, exchangeIdOverride) {
  const exchangeId = exchangeIdOverride || finresActiveExchange;
  if (exchangeId === 'mexc') return mexcUsdtPrice(asset);
  const c = financeCoinFor(asset, exchangeId);
  if (c && c.price) return c.price;
  if (STABLECOINS.hasOwnProperty(asset)) return STABLECOINS[asset];
  return null;
}

// MEXC хранит историю портфеля под старым ключом без изменений (не мигрируем существующих
// пользователей на новый формат); у любой другой биржи Финреза (сейчас — Binance) свой отдельный
// ключ, чтобы истории стоимости портфеля по разным биржам не перемешивались друг с другом.
function balanceHistoryKeyFor(exchangeId) {
  return exchangeId === 'mexc' ? BALANCE_HISTORY_KEY : exchangeId + '_balance_history';
}

function loadBalanceHistory() {
  try {
    const raw = localStorage.getItem(balanceHistoryKeyFor(finresActiveExchange));
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
  try { persistSet(balanceHistoryKeyFor(finresActiveExchange), JSON.stringify(hist)); } catch (e) {}
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
  return { abs: abs, pct: pct, period: fullPeriod ? t(period.label) : t('с начала наблюдения') };
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
// Раунд "сделай 1 в 1 как на референсе" (tradermake.money): панель инструментов рисования, глазки-
// индикаторы, зум-кнопки и растяжение осей — та же техника, что и у "своего графика" на главной
// странице скринера (см. ownChartTool/ownChartDrawings/wireOwnChartInteractions выше по файлу), но
// со своим, полностью изолированным состоянием (journalChart*), по тому же принципу, что и раньше —
// не трогаем уже рабочий главный график ради модалки журнала.
let journalChartTool = 'cursor';
let journalChartDrawings = [];
let journalChartPendingTrend = null;
let journalChartRulerDrag = null;
let journalPriceScaleMult = 1;   // ручное растяжение/сжатие оси цены (перетаскивание правой шкалы)
let journalPriceScaleDrag = null;
let journalTimeScaleDrag = null; // ручное растяжение/сжатие оси времени (перетаскивание нижней шкалы)
let journalShowVolume = true;    // переключается глазком в панели "Индикаторы"
let journalShowEntryExit = true; // переключается глазком в панели "Индикаторы"

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
  const volumeH = journalShowVolume ? Math.round(plotHTotal * 0.16) : 0;
  const paneGap = journalShowVolume ? 6 : 0;
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
  if (journalPriceScaleMult !== 1) {
    const priceCenter = (min + max) / 2, priceHalf = (max - min) / 2 * journalPriceScaleMult;
    min = priceCenter - priceHalf; max = priceCenter + priceHalf;
  }

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
    xOfTime: xOfTime, timeOfX: timeOfX, priceOfY: priceOfY, yOf: yOf, plotW: plotW, plotH: plotH,
    padLeft: padLeft, padTop: padTop, slot: slot, intervalMs: intervalMs, volTop: volTop, volumeH: volumeH,
    min: min, max: max
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

  // --- объём (панель снизу, если включена в панели "Индикаторы" — VOLG) ---
  if (journalShowVolume) {
    slice.forEach(function (c) {
      const x = xOfTime(c.t);
      const up = c.c >= c.o;
      ctx.fillStyle = up ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)';
      const vy = volYOf(c.v);
      ctx.fillRect(x - bodyW / 2, vy, bodyW, (volTop + volumeH) - vy);
    });
  }

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

  // --- построения пользователя: уровни/трендлинии/лучи/прямые (своё изолированное состояние
  // journalChartDrawings/journalChartTool — не трогаем ownChartDrawings главного графика) ---
  journalChartDrawings.forEach(function (dr) {
    if (dr.type === 'hline') {
      const y = yOf(dr.v);
      if (y < padTop - 20 || y > h - padBottom + 20) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,193,7,.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#131722';
      ctx.fillRect(padLeft + plotW + 1, y - 8, padRight - 2, 16);
      ctx.fillStyle = '#FFC107';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(dr.v), padLeft + plotW + 5, y);
    } else if (dr.type === 'trend' || dr.type === 'ray' || dr.type === 'xline') {
      const x1 = xOfTime(dr.p1.t), y1 = yOf(dr.p1.v);
      const x2 = xOfTime(dr.p2.t), y2 = yOf(dr.p2.v);
      const dx = x2 - x1, dy = y2 - y1;
      let seg = { x1: x1, y1: y1, x2: x2, y2: y2 };
      if (dr.type !== 'trend' && (dx !== 0 || dy !== 0)) {
        const clipped = clipRayToRect(x1, y1, dx, dy, padLeft, padLeft + plotW, padTop, padTop + plotH,
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
      ctx.fillStyle = 'rgba(30,128,255,.85)';
      [[x1, y1], [x2, y2]].forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  });

  if (journalChartPendingTrend && journalChartHover) {
    const x1 = xOfTime(journalChartPendingTrend.p1.t), y1 = yOf(journalChartPendingTrend.p1.v);
    ctx.save();
    ctx.strokeStyle = 'rgba(30,128,255,.5)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(journalChartHover.x, journalChartHover.y);
    ctx.stroke();
    ctx.restore();
  }

  if (journalChartRulerDrag) {
    const r = journalChartRulerDrag;
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
    const bx = Math.min(Math.max(r.x2, padLeft + tw / 2 + 6), padLeft + plotW - tw / 2 - 6);
    const by = r.y2 < padTop + 20 ? r.y2 + 18 : r.y2 - 14;
    ctx.fillStyle = up ? 'rgba(0,192,118,.92)' : 'rgba(248,73,96,.92)';
    ctx.fillRect(bx - tw / 2 - 6, by - 10, tw + 12, 20);
    ctx.fillStyle = '#0b0e14';
    ctx.textAlign = 'center';
    ctx.fillText(label, bx, by);
    ctx.textAlign = 'left';
  }

  // Раунд "1 в 1 как на tradermake.money": вместо маркера на КАЖДУЮ сделку (что на активном
  // скальпинге неизбежно упирается в кашу — сколько ни разводи и ни зумируй, у трейдера с полусотней
  // сделок в день их физически некуда деть на одном экране) — график показывает ОДНУ выбранную
  // позицию целиком: точку входа (зелёный шеврон ^) и точку выхода (красный крестик ×), с пунктирной
  // линией-уровнем на каждой цене и подписью результата в процентах — ровно тот же язык, что в
  // референсе. Какая позиция выбрана — journalChartState.selectedPairIndex, туда же ведёт клик по
  // строке в списке справа (см. renderJournalTradesList/wireJournalTradesListClick).
  const selPair = journalShowEntryExit && journalChartState && journalChartState.pairs && journalChartState.pairs[journalChartState.selectedPairIndex];
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

    // Точка выхода — красный шеврон ˅ (та же "галочка", что и у входа, просто зеркально вниз и
    // другим цветом — по фидбеку "нужны две галочки на вход и на выход, крестик не нужен").
    ctx.save();
    ctx.strokeStyle = '#F84960';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(exitX - 6, exitY - 6); ctx.lineTo(exitX, exitY); ctx.lineTo(exitX + 6, exitY - 6);
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
    if (ev.button !== 0) return;
    const chart = canvas.__journalChart;
    if (!chart) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    // Перетаскивание шкалы цены (справа) / шкалы времени (снизу) — работает независимо от
    // выбранного инструмента рисования, как у "своего графика" (см. wireOwnChartInteractions).
    if (x > chart.padLeft + chart.plotW) {
      journalPriceScaleDrag = { startY: y, startMult: journalPriceScaleMult };
      return;
    }
    if (y > chart.volTop + chart.volumeH) {
      const n = journalChartState ? journalChartState.candles.length : 0;
      const view = (journalChartState && journalChartState.view) || { visibleCount: n, offset: 0 };
      const centerIdx = n - view.offset - view.visibleCount / 2;
      journalTimeScaleDrag = { startX: x, startVisible: view.visibleCount, centerIdx: centerIdx };
      return;
    }
    if (journalChartTool === 'cursor') {
      journalPanDrag = { startX: x, startOffset: (journalChartState && journalChartState.view && journalChartState.view.offset) || 0 };
      canvas.classList.add('panning');
    } else if (journalChartTool === 'hline') {
      const v = chart.priceOfY(y);
      journalChartDrawings.push({ type: 'hline', v: v });
      journalChartTool = 'cursor';
      syncJournalToolButtons();
      redraw();
    } else if (journalChartTool === 'trend' || journalChartTool === 'ray' || journalChartTool === 'xline') {
      const t = chart.timeOfX(x), v = chart.priceOfY(y);
      if (!journalChartPendingTrend) {
        journalChartPendingTrend = { tool: journalChartTool, p1: { t: t, v: v } };
      } else {
        journalChartDrawings.push({ type: journalChartPendingTrend.tool, p1: journalChartPendingTrend.p1, p2: { t: t, v: v } });
        journalChartPendingTrend = null;
        journalChartTool = 'cursor';
        syncJournalToolButtons();
      }
      redraw();
    } else if (journalChartTool === 'ruler') {
      journalChartRulerDrag = { x1: x, y1: y, t1: chart.timeOfX(x), v1: chart.priceOfY(y), x2: x, y2: y, t2: chart.timeOfX(x), v2: chart.priceOfY(y) };
      redraw();
    }
  });

  window.addEventListener('mousemove', function (ev) {
    const chart = canvas.__journalChart;
    if (!chart || !journalChartState) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (journalPriceScaleDrag) {
      const dy = y - journalPriceScaleDrag.startY;
      const factor = Math.exp(dy * 0.006);
      journalPriceScaleMult = Math.max(0.15, Math.min(8, journalPriceScaleDrag.startMult * factor));
      redraw();
      return;
    }
    if (journalTimeScaleDrag) {
      const dx = x - journalTimeScaleDrag.startX;
      const factor = Math.exp(-dx * 0.006);
      const n = journalChartState.candles.length;
      let newVisible = Math.round(journalTimeScaleDrag.startVisible * factor);
      newVisible = Math.max(6, Math.min(n, newVisible));
      const maxOffset = Math.max(0, n - newVisible);
      let newOffset = n - newVisible - (journalTimeScaleDrag.centerIdx - newVisible / 2);
      journalChartState.view = { visibleCount: newVisible, offset: Math.max(0, Math.min(maxOffset, newOffset)) };
      redraw();
      return;
    }
    if (!journalPanDrag) {
      canvas.style.cursor = x > chart.padLeft + chart.plotW ? 'ns-resize' : (y > chart.volTop + chart.volumeH ? 'ew-resize' : '');
    }
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
    if (journalChartRulerDrag) {
      journalChartRulerDrag.x2 = x; journalChartRulerDrag.y2 = y;
      journalChartRulerDrag.t2 = chart.timeOfX(x); journalChartRulerDrag.v2 = chart.priceOfY(y);
      redraw();
      return;
    }
    // Курсор вне области построения (событие всё равно приходит через window, не только canvas) — гасим hover.
    if (x < chart.padLeft || x > chart.padLeft + chart.plotW || y < chart.padTop || y > chart.volTop + chart.volumeH) {
      if (journalChartHover) { journalChartHover = null; redraw(); }
      return;
    }
    journalChartHover = { x: x, y: y };
    redraw();
  });

  canvas.addEventListener('mouseleave', function () {
    if (!journalPanDrag && !journalChartRulerDrag && journalChartHover) { journalChartHover = null; redraw(); }
  });

  window.addEventListener('mouseup', function () {
    if (journalPanDrag) { journalPanDrag = null; canvas.classList.remove('panning'); }
    if (journalChartRulerDrag) { journalChartRulerDrag = null; redraw(); }
    journalPriceScaleDrag = null;
    journalTimeScaleDrag = null;
  });

  canvas.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    const chart = canvas.__journalChart;
    if (!chart || !journalChartDrawings.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const threshold = 8;
    let bestIdx = -1, bestDist = threshold;
    journalChartDrawings.forEach(function (dr, i) {
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
      journalChartDrawings.splice(bestIdx, 1);
      redraw();
      showAppToast('Построение удалено');
    }
  });
}

function syncJournalToolButtons() {
  document.querySelectorAll('#journalVToolbar .ochart-tool[data-jtool]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-jtool') === journalChartTool);
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
        '<span class="stat-tile-abs">' + agg.count + ' ' + t('сделок, винрейт') + ' ' + agg.winRate.toFixed(0) + '%</span>'
      : '<span class="stat-tile-abs muted">' + t('нет сделок') + '</span>';
    return '<div class="stat-tile ' + cls + '"><div class="stat-tile-label"><i class="' + icon + '"></i>' + t(d.label) + '</div>' +
      '<div class="stat-tile-value">' + valueHtml + '</div></div>';
  }).join('');
  const assetsTile = '<div class="stat-tile neutral"><div class="stat-tile-label"><i class="ri-coins-line"></i>' + t('Активы') + '</div>' +
    '<div class="stat-tile-value"><span class="stat-tile-pct">' + assetCount + '</span>' +
    '<span class="stat-tile-abs muted">' + (dustCount > 0 ? dustCount + ' ' + t('мелких скрыто') : t('монет учтено')) + '</span></div></div>';
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
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
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
    if (finresTab !== 'pnl' || data !== finresRealized) return; // не та вкладка ИЛИ пользователь уже переключил биржу Финреза
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
  label.textContent = (currentLang === 'en' ? EN_MONTHS[month] : RU_MONTHS[month]) + ' ' + year;

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
      ? (key + ': ' + (entry.abs >= 0 ? '+' : '-') + fmtUsd(Math.abs(entry.abs)).slice(1) + ' (' + entry.count + ' ' + t(entry.count === 1 ? 'сделка' : (entry.count < 5 ? 'сделки' : 'сделок')) + ')')
      : key;
    html += '<div class="' + cls + '" title="' + titleAttr + '">' +
      '<div class="' + innerCls + '" style="' + styleAttr + '"><span class="balcal-daynum">' + d + '</span>' + amountHtml + '</div></div>';
  }
  grid.classList.toggle('animate', animate);
  grid.innerHTML = html;

  summaryEl.innerHTML = monthDaysWithData
    ? t('За месяц:') + ' <span class="' + (monthDelta >= 0 ? 'up' : 'down') + '">' + (monthDelta >= 0 ? '+' : '-') + fmtUsd(Math.abs(monthDelta)).slice(1) + '</span> · ' + t('дней со сделками:') + ' ' + monthDaysWithData
    : t('Пока нет реализованных сделок за этот месяц.');
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

// Начало ТЕКУЩИХ календарных суток (00:00 по местному времени устройства) в мс — используется
// только для периода "1Д" в finresFilterByPeriod ниже. Раньше "1Д" считался скользящим окном
// (Date.now() - 24ч), из-за чего рано утром в него всё ещё попадала БОЛЬШАЯ часть ВЧЕРАШНИХ
// сделок — и вкладка "Обзор" выглядела так, будто показывает "вчера", хотя технически честно
// показывала "последние 24 часа". К тому же это расходилось с тем, как считает календарь P&L
// (тот группирует сделки строго по календарной дате, см. balCalDayKey/computeDailyRealizedPnlMap) —
// одно и то же слово "сегодня"/"1Д" в двух местах приложения означало бы разные наборы сделок.
function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

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
  if (!finresActiveExchangeConnected()) {
    const exchLabel = finresActiveExchange === 'mexc' ? 'MEXC' : (EXCHANGE_CONNECTORS[finresActiveExchange] || {}).label || finresActiveExchange;
    el.innerHTML = '<div class="finres-empty"><i class="ri-key-2-line"></i>' +
      t('Подключите API-ключ') + ' ' + exchLabel + ' ' + t('на странице «Настройки аккаунта», чтобы увидеть финансовый результат.') + '</div>';
    return;
  }
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-empty"><i class="ri-loader-4-line spin-icon"></i>' + t('Загрузка баланса...') + '</div>';
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
    el.innerHTML = '<div class="finres-empty"><i class="ri-loader-4-line spin-icon"></i>' + t('Загрузка истории сделок по монетам из баланса...') + '</div>';
  }
  finresLoadRealized(false).then(function (data) {
    // юзер уже переключился на другую вкладку ИЛИ (data !== finresRealized) на другую биржу Финреза —
    // без второй проверки медленно грузящаяся MEXC могла дозагрузиться уже после переключения на
    // Binance и перерисовать этот блок её собственными цифрами поверх Binance.
    if (finresTab !== 'overview' || data !== finresRealized) return;
    renderFinresOverviewContent(el, data, animate);
  });
  if (wasLoaded) renderFinresOverviewContent(el, finresRealized, animate);
}

function renderFinresOverviewContent(el, data, animate) {
  animate = animate !== false;
  if (!data.trades.length) {
    el.innerHTML =
      '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
      '<div class="finres-head"><h2>' + t('Обзор') + '</h2></div>' +
      '<div class="finres-empty"><i class="ri-inbox-line"></i>' +
      (data.error
        ? t('Не удалось загрузить часть истории сделок: ') + data.error
        : t('Реализованных сделок пока нет. Как только по какой-то монете из баланса появится закрытая (проданная) позиция — здесь появится статистика.')) +
      '</div></div>';
    return;
  }

  const filtered = finresFilterByPeriod(data.trades, finresPeriod);
  const agg = finresAggregate(filtered);

  const periodPillsHtml = Object.keys(FINRES_PERIODS).map(function (key) {
    return '<button type="button" class="finres-period-pill' + (key === finresPeriod ? ' active' : '') + '" data-finres-period="' + key + '">' + t(FINRES_PERIODS[key].label) + '</button>';
  }).join('');

  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + label + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }
  const pnlCls = agg.pnl >= 0 ? 'up' : 'down';
  const statsHtml =
    statCard(t('Общий PnL'), (agg.pnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(agg.pnl)).slice(1), pnlCls,
      agg.pct !== 0 ? (agg.pct >= 0 ? '+' : '') + agg.pct.toFixed(2) + '%' : null) +
    statCard(t('Прибыль'), '+' + fmtUsd(agg.profit).slice(1), 'up', agg.winCount + ' ' + t('сделок')) +
    statCard(t('Убытки'), (agg.loss <= 0 ? '-' : '') + fmtUsd(Math.abs(agg.loss)).slice(1), 'down', agg.lossCount + ' ' + t('сделок')) +
    statCard(t('Сделки'), String(agg.count), null, t('за') + ' ' + t(FINRES_PERIODS[finresPeriod].label).toLowerCase()) +
    statCard(t('Винрейт'), agg.winRate.toFixed(2) + '%', agg.winRate >= 50 ? 'up' : 'down', agg.winCount + '/' + agg.count);

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
    '<div class="finres-head"><h2>' + t('Обзор') + '</h2>' +
      '<div class="finres-head-right">' +
        '<div class="finres-period-pills">' + periodPillsHtml + '</div>' +
        '<button type="button" class="finres-export-btn" id="finresExportBtn"><i class="ri-download-2-line"></i> ' + t('Экспорт') + '</button>' +
      '</div>' +
    '</div>' +
    finresStaleErrorBannerHtml(data) +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '">' + statsHtml + '</div>' +
    '<div class="finres-chart-row' + (animate ? '' : ' no-anim') + '">' +
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
    if (animate) pnlWrap.classList.add('chart-draw-in');
  } else {
    pnlWrap.innerHTML = '<div class="balance-chart-empty">Недостаточно закрытых сделок за этот период для графика</div>';
  }
  const donutCanvas = document.getElementById('finresDonut');
  if (donutCanvas) {
    drawDonutChart(donutCanvas, donutSegments);
    if (animate) document.querySelector('.finres-donut-wrap').classList.add('donut-reveal-in');
  }

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
      '<td class="finres-period-name">' + t(r.label) + '</td>' +
      '<td class="' + pnlCls + '">' + (agg.pnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(agg.pnl)).slice(1) + '</td>' +
      '<td class="' + pnlCls + '">' + (agg.pct >= 0 ? '+' : '') + agg.pct.toFixed(2) + '%</td>' +
      '<td class="up">+' + fmtUsd(agg.profit).slice(1) + '</td>' +
      '<td class="down">' + (agg.loss <= 0 ? '-' : '') + fmtUsd(Math.abs(agg.loss)).slice(1) + '</td>' +
      '<td>' + agg.count + '</td>' +
      '<td>' + agg.winRate.toFixed(2) + '%</td>' +
      '</tr>';
  }).join('');
  return '<div class="finres-table-card"><div class="finres-table-title">' + t('PnL по периодам') + '</div>' +
    '<table class="finres-table"><thead><tr><th>' + t('Период') + '</th><th>PnL</th><th>' + t('Изменение %') + '</th><th>' + t('Прибыль') + '</th><th>' + t('Убытки') + '</th><th>' + t('Сделки') + '</th><th>' + t('Винрейт') + '</th></tr></thead>' +
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
    t('Не удалось обновить часть истории сделок (') + data.error + t(') — показаны последние загруженные данные') +
    (data.loadedAt ? ' ' + t('от') + ' ' + new Date(data.loadedAt).toTimeString().slice(0, 8) : '') + '.</div>';
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
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + t(label) + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + t(subHtml) + '</div>' : '') + '</div>';
  }
  if (!data || !data.trades.length) {
    return '<div class="finres-empty" style="grid-column:1/-1;padding:20px"><i class="ri-bar-chart-line"></i>' +
      (data && data.error ? t('Не удалось загрузить часть истории сделок: ') + data.error : t('Реализованных сделок пока нет — статистика появится после первой закрытой позиции.')) +
      '</div>';
  }
  const filtered = finresFilterByPeriod(data.trades, FINRES_PNL_PERIOD_MAP[finresPnlPeriod] || 'all');
  const agg = finresAggregate(filtered);
  const stats = computeFinresTradeStats(filtered);
  const pnlCls = agg.pnl >= 0 ? 'up' : 'down';
  const avgPnl = agg.count ? agg.pnl / agg.count : 0;
  const pf = !stats ? '—' : (stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2));
  return statCard('Общий PnL', (agg.pnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(agg.pnl)).slice(1), pnlCls, agg.count + ' ' + t('сделок')) +
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
    if (finresTab !== 'pnl' || data !== finresRealized) return; // не та вкладка ИЛИ уже другая биржа Финреза
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
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>' + t('Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.') + '</div></div>';
    return;
  }
  const periodPillsHtml = Object.keys(BALANCE_PERIODS).map(function (key) {
    return '<span class="balance-period-pill' + (key === finresPnlPeriod ? ' active' : '') + '" data-period="' + key + '">' + t(BALANCE_PERIODS[key].label) + '</span>';
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
        '<div class="balance-calendar-title"><i class="ri-calendar-2-line"></i> ' + t('Календарь P&L') + '</div>' +
        '<div class="balance-calendar-nav">' +
          '<button type="button" class="balance-calendar-navbtn" id="balCalPrev"><i class="ri-arrow-left-s-line"></i></button>' +
          '<span class="balance-calendar-month" id="balCalMonthLabel">—</span>' +
          '<button type="button" class="balance-calendar-navbtn" id="balCalNext"><i class="ri-arrow-right-s-line"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="balance-calendar-weekdays">' + (currentLang === 'en'
        ? '<span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span>'
        : '<span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span>') + '</div>' +
      '<div class="balance-calendar-grid" id="balCalGrid"></div>' +
      '<div class="balance-calendar-summary" id="balCalSummary"></div>' +
      '<div class="balance-calendar-legend">' +
        '<span class="balance-calendar-legend-item"><span class="balance-calendar-legend-dot up"></span>' + t('Прибыльный день') + '</span>' +
        '<span class="balance-calendar-legend-item"><span class="balance-calendar-legend-dot down"></span>' + t('Убыточный день') + '</span>' +
        '<span class="balance-calendar-legend-item"><span class="balance-calendar-legend-dot empty-dot"></span>' + t('Нет данных') + '</span>' +
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
    const c = financeCoinFor(r.asset);
    const raw = (c && c.raw) || assetToRawSymbol(r.asset);
    const color = getCoinColor(r.asset);
    return '<button type="button" class="journal-chip" data-asset="' + r.asset + '" data-raw="' + raw + '">' +
      '<span class="journal-chip-avatar" style="background:' + color + '">' + r.asset.slice(0, 3) + '</span>' + r.asset + '</button>';
  }).join('');
}

function renderFinresTradesTab(el, animate) {
  animate = animate !== false;
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>' + t('Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.') + '</div></div>';
    return;
  }
  const journalChipsHtml = buildJournalChipsHtml();
  el.innerHTML =
    '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
    '<div class="finres-head"><h2>' + t('Сделки') + '</h2></div>' +
    '<div class="balance-journal-card">' +
      '<div class="balance-journal-header">' +
        '<div class="balance-journal-title"><i class="ri-file-list-3-line"></i> ' + t('График входа/выхода по монете') + '</div>' +
        '<span class="balance-journal-hint">' + t('Выберите монету — покажем сделки и точки входа/выхода на графике') + '</span>' +
      '</div>' +
      '<div class="finres-coin-search">' +
        '<div class="finres-coin-search-box"><i class="ri-search-line"></i>' +
          '<input type="text" id="finresCoinSearchInput" autocomplete="off" placeholder="' + t('Найти любую монету (в т.ч. полностью закрытые позиции)...') + '">' +
        '</div>' +
        '<div class="finres-coin-search-results" id="finresCoinSearchResults"></div>' +
      '</div>' +
      '<div class="balance-journal-subtitle">' + t('Из текущего баланса') + '</div>' +
      '<div class="balance-journal-chips">' + (journalChipsHtml || '<span class="balance-journal-empty">' + t('Сейчас в балансе нет монет с известной USDT-парой — найдите нужную через поиск выше.') + '</span>') + '</div>' +
    '</div>' +
    '<div class="finres-table-card" id="finresTradesTableCard"><div class="finres-empty"><i class="ri-loader-4-line spin-icon"></i>' + t('Загрузка истории сделок...') + '</div></div>' +
    '</div>';

  wireFinresCoinSearch();

  finresTradesLimit = 25;
  const wasLoaded = finresRealized && !finresRealized.loading;
  finresLoadRealized(false).then(function (data) {
    if (finresTab !== 'trades' || data !== finresRealized) return; // не та вкладка ИЛИ уже другая биржа Финреза
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
  // coinMap хранит тикеры сразу всех подключённых бирж под разными ключами ("BTC/USDT" у MEXC,
  // "BINANCE:BTC/USDT" у Binance-спота, "BINANCEFUT:..." у её же фьючерсов — см. upsertExternalCoin) —
  // раньше здесь совпадал вообще любой ключ, кончающийся на "/USDT", то есть поиск монеты для
  // Финреза Binance мог бы предложить монету, которой на Binance вообще нет. Фильтруем строго по
  // ключам ТЕКУЩЕЙ активной биржи Финреза: у MEXC ключ без префикса, у остальных — с ним.
  const keyPrefix = finresActiveExchange === 'mexc' ? '' : (function () {
    const connector = EXCHANGE_CONNECTORS[finresActiveExchange];
    return (connector ? connector.exchangeTags[0] : finresActiveExchange.toUpperCase()) + ':';
  })();
  coinMap.forEach(function (c, key) {
    if (!c || !c.raw || key.slice(-5) !== '/USDT') return;
    if (finresActiveExchange === 'mexc' ? key.indexOf(':') !== -1 : key.indexOf(keyPrefix) !== 0) return;
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
      if (finresTab === 'trades' && data === finresRealized) renderFinresTradesTable(data);
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
        ? t('Не удалось загрузить часть истории сделок: ') + data.error
        : t('Реализованных сделок пока нет ни по одной известной монете. Если нужная монета уже полностью продана — найдите её через поиск выше, чтобы добавить в журнал.')) +
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
      '<div class="finres-search"><i class="ri-search-line"></i><input type="text" id="finresTradesSearchInput" placeholder="' + t('Поиск по монете...') + '" value="' + finresTradesSearch.replace(/"/g, '&quot;') + '"></div>' +
      '<span class="finres-trades-count">' + rows.length + ' ' + t(pluralSdelka(rows.length)) + '</span>' +
    '</div>' +
    '<div style="overflow-x:auto">' +
    '<table class="finres-table"><thead><tr>' +
      '<th class="sortable" data-sort="time">' + t('Дата') + sortIc('time') + '</th>' +
      '<th>' + t('Время') + '</th>' +
      '<th class="sortable" data-sort="asset">' + t('Монета') + sortIc('asset') + '</th>' +
      '<th>' + t('Цена входа') + '</th>' +
      '<th>' + t('Цена выхода') + '</th>' +
      '<th>' + t('Объём') + '</th>' +
      '<th class="sortable" data-sort="pnl">PnL' + sortIc('pnl') + '</th>' +
      '<th class="sortable" data-sort="pnlPct">PnL %' + sortIc('pnlPct') + '</th>' +
      '<th>' + t('Результат') + '</th>' +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
    '</div>' +
    (rows.length > shown.length ? '<button type="button" class="finres-load-more" id="finresTradesLoadMore">' + t('Показать ещё') + ' (' + (rows.length - shown.length) + ')</button>' : '');

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
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>' + t('Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.') + '</div></div>';
    return;
  }
  const priced = lastBalanceState.priced, total = lastBalanceState.total, donutSegments = lastBalanceState.donutSegments || [];
  const unpriced = lastBalanceState.unpriced || [], dust = lastBalanceState.dust || [], dustTotal = lastBalanceState.dustTotal || 0;

  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card"><div class="finres-stat-label">' + t(label) + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }
  const availableValue = priced.reduce(function (s, r) { return s + (r.free * (r.price || 0)); }, 0);
  const lockedValue = priced.reduce(function (s, r) { return s + (r.locked * (r.price || 0)); }, 0);
  const dayDelta = computeBalanceDelta(lastBalanceState.hist, total, 'day');
  const deltaCls = !dayDelta ? null : (dayDelta.abs > 0.005 ? 'up' : (dayDelta.abs < -0.005 ? 'down' : null));
  const summaryHtml =
    statCard('Общий баланс', fmtUsd(total), null, priced.length + ' ' + t('активов')) +
    statCard('Доступно', fmtUsd(availableValue), null, total > 0 ? (availableValue / total * 100).toFixed(1) + '% ' + t('от портфеля') : null) +
    statCard('В ордерах', fmtUsd(lockedValue), lockedValue > 0.01 ? null : 'muted', total > 0 && lockedValue > 0 ? (lockedValue / total * 100).toFixed(1) + '% ' + t('от портфеля') : t('нет активных ордеров')) +
    statCard('Изменение за 24ч', dayDelta ? (dayDelta.abs >= 0 ? '+' : '-') + fmtUsd(Math.abs(dayDelta.abs)).slice(1) : '—', deltaCls, dayDelta ? (dayDelta.abs >= 0 ? '+' : '') + dayDelta.pct.toFixed(2) + '%' : t('копим историю'));

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
      (r.locked > 0 ? '<div class="balance-asset-locked">' + t('в ордерах:') + ' ' + r.locked.toLocaleString('en', { maximumFractionDigits: 8 }) + '</div>' : '') +
      '</div></div>';
  }).join('');

  const unpricedHtml = unpriced.length
    ? '<div class="balance-unpriced-note"><i class="ri-information-line"></i> ' + t('Без USDT-пары в скринере (не учтено в общей стоимости):') + ' ' +
      unpriced.map(function (r) { return r.asset + ' ' + r.amount.toLocaleString('en', { maximumFractionDigits: 8 }); }).join(', ') + '</div>'
    : '';
  const dustToggleHtml = dust.length
    ? '<div class="balance-dust-toggle" id="finresDustToggle">' +
      (hideDustBalances
        ? '<i class="ri-eye-line"></i> ' + t('Показать мелкие остатки (&lt;$1):') + ' ' + dust.length + ' ' + t('активов') + ' ' + t('на') + ' ' + fmtUsd(dustTotal)
        : '<i class="ri-eye-off-line"></i> ' + t('Скрыть мелкие остатки (&lt;$1) — как на самой бирже')) +
      '</div>'
    : '';

  el.innerHTML =
    '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
    '<div class="finres-head"><h2>' + t('Активы') + '</h2></div>' +
    '<div class="finres-stats-grid">' + summaryHtml + '</div>' +
    '<div class="finres-chart-row">' +
      '<div class="finres-card">' +
        '<div class="finres-card-head"><span class="finres-card-title">' + t('Распределение портфеля') + '</span></div>' +
        '<div class="finres-donut-wrap"><canvas id="finresAssetsDonut"></canvas>' +
          '<div class="finres-donut-center"><div class="finres-donut-center-value small">' + fmtUsd(total) + '</div><div class="finres-donut-center-label">' + t('Всего') + '</div></div>' +
        '</div>' +
        '<div class="finres-donut-legend">' + (legendHtml || '<div class="balance-earnings-empty">' + t('Нет ценообразованных активов.') + '</div>') + '</div>' +
      '</div>' +
      '<div class="finres-card">' +
        '<div class="finres-card-head"><span class="finres-card-title">' + t('Список активов') + '</span></div>' +
        '<div class="balance-asset-list no-anim">' + (assetRowsHtml || '<div class="balance-earnings-empty">' + t('Нет ценообразованных активов.') + '</div>') + '</div>' +
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
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + t(label) + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + t(subHtml) + '</div>' : '') + '</div>';
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
    return '<div class="finres-empty" style="grid-column:1/-1;padding:24px"><i class="ri-bar-chart-line"></i>' + t('Реализованных сделок пока нет — как только появятся закрытые позиции, здесь появится статистика по сериям и Profit Factor.') + '</div>';
  }
  const pf = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
  const rr = stats.riskReward === Infinity ? '∞' : stats.riskReward.toFixed(2);
  const dd = computeFinresMaxDrawdownFromTrades(data.trades);
  return statCard('Лучший день', (stats.bestDay >= 0 ? '+' : '-') + fmtUsd(Math.abs(stats.bestDay)).slice(1), stats.bestDay >= 0 ? 'up' : 'down', 'по реализованному PnL') +
    statCard('Худший день', (stats.worstDay >= 0 ? '+' : '-') + fmtUsd(Math.abs(stats.worstDay)).slice(1), stats.worstDay >= 0 ? 'up' : 'down', 'по реализованному PnL') +
    statCard('Серии подряд', stats.maxWinStreak + ' / ' + stats.maxLossStreak, null, 'макс. побед / макс. убытков') +
    statCard('Profit Factor', pf, stats.profitFactor >= 1.5 ? 'up' : (stats.profitFactor < 1 ? 'down' : null), 'Risk/Reward ' + rr) +
    statCard('Просадка эквити', dd ? '-' + fmtUsd(Math.abs(dd.abs)).slice(1) : '$0.00', dd && dd.abs < -0.01 ? 'down' : 'muted', dd && dd.pct != null ? dd.pct.toFixed(2) + '% ' + t('от пика P&L') : t('ещё не выходили в плюс'));
}

// Раунд 12 ("доработать Риски"): третья строка — риск ОТКРЫТЫХ (ещё не проданных) позиций, которого
// раньше на вкладке не было вовсе (только реализованные закрытые сделки). Использует ту же
// finresLoadRealized(), т.к. openPositions считается там же по реальной истории /api/v3/myTrades.
function renderFinresOpenRiskHtml(data, loading) {
  function statCard(label, valueHtml, cls, subHtml) {
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + t(label) + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + t(subHtml) + '</div>' : '') + '</div>';
  }
  if (loading) {
    return statCard('Открытых позиций', '···', null, null) +
      statCard('Нереализованный PnL', '···', null, null) +
      statCard('Самая рискованная', '···', null, null);
  }
  const positions = (data && data.openPositions) || [];
  if (!positions.length) {
    return '<div class="finres-empty" style="grid-column:1/-1;padding:24px"><i class="ri-shield-check-line"></i>' + t('Открытых позиций без учтённой продажи не найдено в загруженной истории сделок.') + '</div>';
  }
  const totalUnrealized = positions.reduce(function (s, p) { return s + p.unrealizedPnl; }, 0);
  const totalCost = positions.reduce(function (s, p) { return s + p.costBasis; }, 0);
  const totalPct = totalCost > 1e-9 ? (totalUnrealized / totalCost * 100) : 0;
  const worst = positions[0]; // отсортировано по |unrealizedPnl| убыв. в finresLoadRealized
  return statCard('Открытых позиций', String(positions.length), null, 'без учтённой продажи в истории') +
    statCard('Нереализованный PnL', (totalUnrealized >= 0 ? '+' : '-') + fmtUsd(Math.abs(totalUnrealized)).slice(1), totalUnrealized >= 0 ? 'up' : 'down', (totalPct >= 0 ? '+' : '') + totalPct.toFixed(2) + '% ' + t('от вложенного')) +
    statCard('Самая рискованная', worst.asset, worst.unrealizedPnl >= 0 ? 'up' : 'down', (worst.unrealizedPnl >= 0 ? '+' : '-') + fmtUsd(Math.abs(worst.unrealizedPnl)).slice(1) + ' (' + (worst.unrealizedPct >= 0 ? '+' : '') + worst.unrealizedPct.toFixed(1) + '%)');
}

function renderFinresRiskTab(el, animate) {
  animate = animate !== false;
  if (!lastBalanceState) {
    el.innerHTML = '<div class="finres-tab-body finres-anim-in"><div class="finres-empty"><i class="ri-wallet-3-line"></i>' + t('Нет данных баланса — откройте вкладку "Настройки аккаунта" и дождитесь подключения.') + '</div></div>';
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
    return '<div class="finres-stat-card' + (cls ? ' ' + cls : '') + '"><div class="finres-stat-label">' + t(label) + '</div>' +
      '<div class="finres-stat-value' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</div>' +
      (subHtml ? '<div class="finres-stat-sub ' + (cls || 'muted') + '">' + subHtml + '</div>' : '') + '</div>';
  }

  const top1Cls = conc.top1Pct >= 50 ? 'down' : (conc.top1Pct >= 30 ? null : 'up');
  const statsHtml =
    statCard('Крупнейший актив', conc.top1 ? conc.top1.asset : '—', top1Cls, conc.top1 ? conc.top1Pct.toFixed(1) + '% ' + t('портфеля') : (priced.length ? t('нет открытых позиций') : null)) +
    statCard('Топ-3 концентрация', conc.top3Pct.toFixed(1) + '%', conc.top3Pct >= 70 ? 'down' : null, t('доля трёх крупнейших НЕ-стейблкоинов')) +
    statCard('В кэше (USDT/USDC…)', stablePct.toFixed(1) + '%', null, fmtUsd(stableValue) + ' ' + t('вне рынка')) +
    statCard('Активов в портфеле', String(priced.length), null, t('учтено в общей стоимости'));

  const warnHtml = conc.top1 && conc.top1Pct >= 50
    ? '<div class="finres-warn-banner"><i class="ri-alert-line"></i> ' + t('Высокая концентрация:') + ' ' + conc.top1.asset + ' ' + t('занимает') + ' ' + conc.top1Pct.toFixed(1) + '% ' + t('портфеля — просадка по этой монете сильно повлияет на весь баланс.') + '</div>'
    : '';

  const topRowsHtml = priced.slice(0, 10).map(function (r) {
    const pct = total > 0 ? (r.usdtValue / total * 100) : 0;
    const color = getCoinColor(r.asset);
    return '<div class="balance-asset-row">' +
      '<span class="balance-asset-avatar" style="background:' + color + '">' + r.asset.slice(0, 3) + '</span>' +
      '<div class="balance-asset-mid">' +
        '<div class="balance-asset-name-row"><span class="balance-asset-name">' + r.asset + '</span>' +
        '<span class="balance-asset-amount">' + pct.toFixed(1) + '% ' + t('портфеля') + '</span></div>' +
        '<div class="balance-asset-bar-track"><div class="balance-asset-bar-fill" style="width:' + Math.max(pct, 1.5) + '%;background:' + color + '"></div></div>' +
      '</div>' +
      '<div class="balance-asset-right"><div class="balance-asset-usdt">' + fmtUsd(r.usdtValue) + '</div></div>' +
      '</div>';
  }).join('');

  el.innerHTML =
    '<div class="finres-tab-body' + (animate ? ' finres-anim-in' : '') + '">' +
    '<div class="finres-head"><h2>' + t('Риски') + '</h2></div>' +
    '<div class="finres-card-title" style="margin-bottom:10px">' + t('Концентрация портфеля') + '</div>' +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '">' + statsHtml + '</div>' +
    warnHtml +
    '<div class="finres-card-title" style="margin:18px 0 10px">' + t('Показатели по сделкам') + '</div>' +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '" id="finresRiskTradeStats">' + renderFinresRiskTradeStatsHtml(null, true) + '</div>' +
    '<div class="finres-card-title" style="margin:18px 0 10px">' + t('Открытые позиции') + '</div>' +
    '<div class="finres-stats-grid' + (animate ? '' : ' no-anim') + '" id="finresOpenRiskStats">' + renderFinresOpenRiskHtml(null, true) + '</div>' +
    '<div class="finres-table-card" style="margin-top:18px"><div class="finres-table-title">' + t('Концентрация по активам (топ-10)') + '</div>' +
    '<div class="balance-asset-list no-anim">' + (topRowsHtml || '<div class="balance-earnings-empty">' + t('Нет ценообразованных активов.') + '</div>') + '</div></div>' +
    '</div>';

  finresLoadRealized(false).then(function (data) {
    if (finresTab !== 'risk' || data !== finresRealized) return; // не та вкладка ИЛИ уже другая биржа Финреза
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
let knownSymbols = {}; // { BTC: 'BTCUSDT', ... } — известные символы ТЕКУЩЕЙ активной биржи Финреза
// MEXC хранит список под старым ключом без изменений; у любой другой биржи Финреза — свой отдельный
// ключ (тот же принцип, что и у balanceHistoryKeyFor выше), иначе, например, известные Binance-символы
// подмешивались бы в MEXC-запросы /api/v3/myTrades и наоборот.
function knownSymbolsKeyFor(exchangeId) {
  return exchangeId === 'mexc' ? KNOWN_SYMBOLS_KEY : exchangeId + '_known_trade_symbols';
}
// Именованная (не анонимная IIFE), т.к. её нужно повторно вызвать из hydrateFromNativeStorageIfNeeded
// ниже — если локальный localStorage-профиль оказался пустым (см. её комментарий), но резервная копия
// нашлась в Neutralino.storage, нужно перечитать localStorage ещё раз уже ПОСЛЕ восстановления. Также
// вызывается из switchFinresExchange при первом переключении на биржу, для которой ещё нет снимка —
// тогда читает уже её собственный ключ (см. knownSymbolsKeyFor(finresActiveExchange)).
function loadKnownSymbols() {
  try {
    const key = knownSymbolsKeyFor(finresActiveExchange);
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    let hadStablecoin = false;
    if (Array.isArray(arr)) arr.forEach(function (e) {
      if (!e || !e.asset || !e.raw) return;
      // Стейблкоин сам против себя ("USDTUSDT" и т.п.) — не реальная спот-пара, биржа всегда ответит
      // "Invalid symbol". Раньше такие записи могли попасть сюда (до того как эта проверка появилась
      // и в rememberSymbol ниже, и в finresLoadRealizedCore для текущего баланса) и с тех пор молча
      // пережёвывались на каждое обновление Финреза — один гарантированно провальный запрос впустую.
      if (STABLECOINS.hasOwnProperty(e.asset)) { hadStablecoin = true; return; }
      knownSymbols[e.asset] = e.raw;
    });
    if (hadStablecoin) {
      const arr2 = Object.keys(knownSymbols).map(function (a) { return { asset: a, raw: knownSymbols[a] }; });
      persistSet(key, JSON.stringify(arr2));
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
    persistSet(knownSymbolsKeyFor(finresActiveExchange), JSON.stringify(arr));
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
      const price = financeUsdtPrice(b.asset);
      return { asset: b.asset, free: free, locked: locked, amount: amount, price: price, usdtValue: price != null ? price * amount : null };
    });
    const pricedAll = rows.filter(function (r) { return r.usdtValue != null; }).sort(function (a, b) { return b.usdtValue - a.usdtValue; });
    const unpriced = rows.filter(function (r) { return r.usdtValue == null; });
    // Запоминаем символ каждой монеты, у которой сейчас ненулевой баланс — на будущее, на случай если
    // её потом продадут в ноль (см. комментарий у KNOWN_SYMBOLS_KEY выше).
    pricedAll.forEach(function (r) {
      const c = financeCoinFor(r.asset);
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
  if (!finresActiveExchangeConnected() || !lastBalanceState) { el.innerHTML = ''; return; }

  // Уже была отрисована hero-карточка — значит, это авто-обновление, а не первый показ страницы:
  // плитки не должны заново проигрывать анимацию появления при каждом тике/переключении вкладок.
  const isRefresh = !!el.querySelector('.balance-hero');
  const total = lastBalanceState.total, hist = lastBalanceState.hist, priced = lastBalanceState.priced;

  const periodPillsHtml = Object.keys(BALANCE_PERIODS).map(function (key) {
    return '<span class="balance-period-pill' + (key === balancePeriod ? ' active' : '') + '" data-period="' + key + '">' + t(BALANCE_PERIODS[key].label) + '</span>';
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
          '<div class="balance-hero-label">' + t('Общая стоимость портфеля') + '</div>' +
          '<button type="button" class="finres-refresh-btn" id="finresRefreshBtn" title="' + t('Обновить данные Финреза сейчас, не дожидаясь автообновления') + '">' +
            '<i class="ri-refresh-line"></i><span>' + t('Обновить') + '</span>' +
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
    // data !== finresRealized значит эта загрузка стартовала для биржи, которая к моменту ответа уже
    // не активна в Финрезе (пользователь успел переключиться) — её результат сюда не подставляем.
    if (data !== finresRealized) return;
    const gridEl = document.querySelector('#finresHeroBar .balance-stats-grid');
    if (!gridEl || !finresActiveExchangeConnected() || !lastBalanceState) return;
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
    el.textContent = t('Обновлено') + ' ' + new Date(finresLastUpdatedAt).toTimeString().slice(0, 8);
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
      '<span class="delta-note">' + t('за') + ' ' + delta.period + '</span></div>'
    : '<div class="balance-hero-delta flat"><span class="delta-note">' + t('Копим историю для графика — загляните сюда попозже') + '</span></div>';
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
  if (!el || !finresActiveExchangeConnected() || !lastBalanceState) return;
  if (finresTab === 'overview') {
    renderFinresOverview(el, false);
  } else if (finresTab === 'pnl') {
    renderBalanceCalendar(false);
    renderFinresPnlEarnings();
    renderFinresPnlStats(false);
  } else if (finresTab === 'trades') {
    finresLoadRealized(false).then(function (data) {
      if (finresTab !== 'trades' || data !== finresRealized) return; // не та вкладка ИЛИ уже другая биржа Финреза
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
  return '<div class="balance-earnings-title">' + t('Заработано по монетам за') + ' ' + t(period.label) + '</div>' +
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
  if (!finresActiveExchangeConnected()) return;
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

// Реальная история исполненных сделок по конкретной паре — подписанный приватный эндпоинт (тот же
// путь fetch()→curl.exe, что и у mexcSignedRequest в целом). Ни MEXC, ни Binance не отдают единый
// список сделок по ВСЕМ парам сразу, поэтому журнал строится только по монетам из текущего баланса —
// по ним уже точно известен нужный symbol для запроса.
// exchangeId — необязательный: 'mexc' (или не задан, поведение как раньше — mexcSignedRequest)
// vs любая другая подключённая биржа (см. EXCHANGE_CONNECTORS) — тогда через exchangeSignedRequest,
// тот же ответ-формат {price,qty,time,isBuyer}, что и у MEXC (документированный Binance-клон).
async function fetchMyTrades(raw, limit, exchangeId) {
  const data = (!exchangeId || exchangeId === 'mexc')
    ? await mexcSignedRequest('/api/v3/myTrades', { symbol: raw, limit: limit || 500 })
    : await exchangeSignedRequest(exchangeId, '/api/v3/myTrades', { symbol: raw, limit: limit || 500 });
  if (!Array.isArray(data)) throw new Error((data && (data.msg || data.message)) || 'Некорректный ответ биржи');
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
//
// exchangeId/balanceState/knownSymbolsSnapshot передаются явно (а не читаются из finresActiveExchange/
// lastBalanceState/knownSymbols на лету) — НАЙДЕННЫЙ баг: эта функция асинхронная и делает десятки
// await между запросами по разным монетам, а переключение вкладки Финреза (switchFinresExchange)
// меняет finresActiveExchange/lastBalanceState/knownSymbols мгновенно и синхронно. Раньше более
// поздние итерации цикла ниже внезапно начинали слать запросы под уже ДРУГУЮ, только что выбранную
// биржу (finresActiveExchange в fetchMyTrades/financeUsdtPrice читался в момент каждой итерации, а не
// один раз в начале) — список монет при этом оставался от старой биржи. Явные параметры, захваченные
// один раз в finresLoadRealized() до старта, делают весь проход самодостаточным и невосприимчивым к
// переключению биржи посреди загрузки.
async function finresLoadRealizedCore(exchangeId, balanceState, knownSymbolsSnapshot) {
  // Символы для запроса — объединение ТЕКУЩЕГО баланса и всего, что когда-либо было "замечено"
  // (knownSymbols, см. выше): так полностью закрытая (проданная в ноль) позиция не выпадает из
  // статистики, если её видели в балансе раньше или искали вручную на вкладке "Сделки".
  const priced = (balanceState && balanceState.priced) || [];
  const targetMap = {};
  priced.forEach(function (r) {
    // Стейблкоины (USDT/USDC/FDUSD/...) в балансе не имеют осмысленной "истории сделок против USDT" —
    // конструировать для них raw-символ через assetToRawSymbol бессмысленно (на споте MEXC такой пары,
    // как правило, просто нет) и раньше приводило к лишнему запросу, падающему с "Invalid symbol".
    if (STABLECOINS.hasOwnProperty(r.asset)) return;
    const c = financeCoinFor(r.asset, exchangeId);
    targetMap[r.asset] = (c && c.raw) || assetToRawSymbol(r.asset);
  });
  Object.keys(knownSymbolsSnapshot).forEach(function (asset) { targetMap[asset] = knownSymbolsSnapshot[asset]; });
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
        const trades = await withRetry(function () { return fetchMyTrades(t.raw, 1000, exchangeId); }, 3, [1000, 3000, 8000], 'Finrez:' + t.asset, function (err) {
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
          const currentPrice = priceRow ? priceRow.price : financeUsdtPrice(t.asset, exchangeId);
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
// Теперь единственный признак "уже грузится" — сам промис (см. finresLoadPromises ниже), который
// гарантированно удаляется из карты в .finally() при ЛЮБОМ исходе (успех/ошибка/что угодно ещё),
// поэтому зависнуть навсегда он не может: следующий же вызов (даже без force) увидит, что слота для
// этой биржи нет, и запустит новую попытку.
// Ключ — id биржи, значение — Promise её текущей фоновой загрузки (или отсутствует, если сейчас
// ничего не грузится). Раньше был один общий finresLoadPromise на все биржи разом — из-за этого
// "идёт загрузка" одной биржи ошибочно считалось идущей загрузкой другой при переключении Финреза
// туда-обратно. Отдельный слот на каждую биржу устраняет и это, и не мешает им грузиться параллельно
// (например, фоновая MEXC ещё не успела ответить, пока уже открыт Binance).
let finresLoadPromises = {};

// Применяет результат уже завершённой загрузки: если её биржа (exchangeId) всё ещё активна в
// Финрезе — обновляет ЖИВОЙ finresRealized как раньше; если пользователь уже успел переключиться на
// другую биржу — кладёт результат в её снимок (finresSnapshots), откуда он подхватится сам при
// следующем переключении назад, вместо того чтобы перетереть данные биржи, которую видит пользователь
// ПРЯМО СЕЙЧАС (тот самый баг: медленно грузящаяся MEXC дозагружалась уже после переключения на
// Binance и перетирала его finresRealized своими цифрами).
function applyFinresLoadResult(exchangeId, result) {
  if (finresActiveExchange === exchangeId) {
    finresRealized = result;
  } else if (finresSnapshots[exchangeId]) {
    finresSnapshots[exchangeId].finresRealized = result;
  }
  return result;
}

async function finresLoadRealized(force) {
  if (__designTestMode) return finresRealized;
  const exchangeId = finresActiveExchange;
  if (finresLoadPromises[exchangeId]) return finresLoadPromises[exchangeId];
  if (!force && finresRealized && !finresRealized.loading && (Date.now() - finresRealized.loadedAt) < 60000) return finresRealized;
  // Пока грузим — не стираем уже показанные данные в пустоту (раньше именно так и делали), а просто
  // помечаем их как "обновляются": если экран уже что-то показывал, он и продолжит это показывать,
  // пока не придёт свежий ответ.
  finresRealized = Object.assign({ trades: [], bySymbol: {}, openPositions: [], loadedAt: 0, error: null }, finresRealized, { loading: true });
  // Баланс/известные символы захватываем ОДИН РАЗ здесь, до старта — см. комментарий у
  // finresLoadRealizedCore про то, почему им нельзя читать live-глобалы посреди асинхронного прохода.
  const balanceStateAtStart = lastBalanceState;
  const knownSymbolsAtStart = Object.assign({}, knownSymbols);
  const promise = finresLoadRealizedCore(exchangeId, balanceStateAtStart, knownSymbolsAtStart)
    .then(function (result) { return applyFinresLoadResult(exchangeId, result); })
    .catch(function (e) {
      // Не должно происходить (вся сетевая логика уже ловит свои ошибки по каждой монете отдельно
      // внутри цикла), но если что-то всё же бросит исключение выше — честно показываем это как
      // ошибку загрузки, а не оставляем интерфейс замороженным в состоянии "загрузка" навсегда.
      const msg = (e && e.message) || 'Неизвестная ошибка загрузки Финреза';
      logE('Finrez', 'finresLoadRealizedCore выбросил исключение целиком (неожиданно, все per-symbol ошибки должны ловиться внутри цикла): ' + msg);
      const base = (finresActiveExchange === exchangeId ? finresRealized : (finresSnapshots[exchangeId] && finresSnapshots[exchangeId].finresRealized)) ||
        { trades: [], bySymbol: {}, openPositions: [], loadedAt: 0 };
      return applyFinresLoadResult(exchangeId, Object.assign({}, base, { loading: false, error: msg }));
    })
    .finally(function () { delete finresLoadPromises[exchangeId]; });
  finresLoadPromises[exchangeId] = promise;
  return promise;
}

function finresFilterByPeriod(trades, periodKey) {
  const period = FINRES_PERIODS[periodKey] || FINRES_PERIODS['7d'];
  if (period.ms == null) return trades;
  // "1Д" — календарный день, см. комментарий у startOfTodayMs(); 7Д/30Д/90Д остаются скользящим
  // окном (там расхождение на доли дня не бросается в глаза так, как оно бросалось на "1Д").
  const cutoff = periodKey === '1d' ? startOfTodayMs() : (Date.now() - period.ms);
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
    // Если Финрез прямо сейчас показывает НЕ MEXC (пользователь подключил MEXC, глядя на Binance) —
    // не перетираем текущие живые lastBalanceState/... данными MEXC. Свежий баланс MEXC подтянется
    // сам, ленивым запросом, как только пользователь переключит Финрез на вкладку MEXC (см.
    // switchFinresExchange: !lastBalanceState там как раз и обнаружит, что для MEXC ещё нет снимка).
    if (finresActiveExchange === 'mexc') renderAccountBalances(data && data.balances);
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
  // Останавливаем 3с-таймер, только если ВООБЩЕ никакая биржа больше не подключена — если, скажем,
  // Binance всё ещё подключён, его Финрезу нужно продолжать тикать даже после отключения MEXC.
  if (!anyFinresExchangeConnected()) stopBalanceAutoRefresh();
  persistRemove('mexc_api_key');
  persistRemove('mexc_api_secret');
  document.getElementById('acctApiKey').value = '';
  document.getElementById('acctApiSecret').value = '';
  // Если Финрез прямо сейчас показывает MEXC — чистим живые данные и перерисовываем как раньше. Если
  // показывает другую биржу (Binance) — эти самые lastBalanceState/... принадлежат ЕЙ прямо сейчас,
  // трогать их нельзя; вместо этого чистим отдельно хранящийся снимок MEXC (finresSnapshots.mexc),
  // чтобы при следующем переключении обратно на MEXC он честно показался отключённым.
  if (finresActiveExchange === 'mexc') {
    lastBalanceState = null;
    lastRawBalances = null;
    lastRenderedBalanceTotal = null;
    // Баланс на "Настройки аккаунта" больше не рендерится — только на Финрезе; очищаем его, если
    // страница сейчас видна, чтобы не показывать устаревшие цифры отключённого аккаунта.
    const heroEl = document.getElementById('finresHeroBar');
    if (heroEl) heroEl.innerHTML = '';
    const finresPage = document.getElementById('page-finres');
    if (finresPage && finresPage.classList.contains('active')) renderFinresTab();
  } else {
    finresSnapshots.mexc = null;
  }
  setAccountStatus('disconnected');
  const block = document.getElementById('myOrdersBlock');
  if (block) block.style.display = 'none';
}

// ============================================================================================
// ДОПОЛНИТЕЛЬНЫЕ БИРЖИ (Binance, OKX) — Настройки аккаунта, "просто подключить".
//
// Это ПЕРВЫЙ шаг многобиржевого скринера: только подключение и проверка ключа, ровно как у MEXC
// выше, но полностью НЕЗАВИСИМО от mexcApiKey/mexcApiSecret/accountConnected и mexcSignedRequest —
// тот код (уже отлаженный, только что доработан по таймаутам native-моста) НЕ трогаем и НЕ
// переиспользуем как единый путь, чтобы ничего в рабочем MEXC-подключении не могло случайно
// сломаться. Экран/таблица скринера, Финрез и стратегии этих бирж пока не касаются — это
// сознательно следующий шаг, не этот.
//
// Подпись у каждой биржи своя:
//  - Binance: то же самое, что у MEXC (MEXC — документированный Binance-совместимый клон spot API)
//    — HMAC-SHA256 в hex поверх query-строки, ключ в заголовке X-MBX-APIKEY.
//  - OKX: другая схема — HMAC-SHA256 в base64 поверх строки timestamp+method+requestPath+body
//    (timestamp — ISO-8601 UTC с миллисекундами), четыре заголовка OK-ACCESS-*, включая пароль
//    (passphrase) — единственная из трёх бирж, где он обязателен.
const EXCHANGE_CONNECTORS = {
  binance: {
    label: 'Binance',
    baseUrl: 'https://api.binance.com',
    verifyPath: '/api/v3/account',
    needsPassphrase: false,
    sign: async function (conn, path, params) {
      const p = Object.assign({}, params, { timestamp: Date.now(), recvWindow: 10000 });
      const qs = Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
      const signature = await hmacSha256Hex(conn.apiSecret, qs);
      return { url: this.baseUrl + path + '?' + qs + '&signature=' + signature, headers: { 'X-MBX-APIKEY': conn.apiKey } };
    },
    // Binance/MEXC иногда отвечают HTTP 200, но телом {code, msg} с реальной ошибкой внутри —
    // тот же приём, что и в mexcSignedRequest выше.
    checkError: function (data) {
      if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.code === 'number' &&
          data.code !== 200 && typeof data.balances === 'undefined') {
        throw new Error(data.msg || ('Ошибка Binance (код ' + data.code + ')'));
      }
    },
    // Публичные (без ключа/подписи) снимки 24ч-тикеров одним запросом на КАЖДЫЙ рынок — см.
    // pollExternalTickers ниже. Формат полей у Binance ticker/24hr идентичен тому, что уже понимает
    // upsertCoin() для MEXC (не совпадение — MEXC spot API документированно клонирует Binance);
    // у фьючерсного fapi.binance.com — тот же формат один в один, просто другой хост.
    //
    // На Binance реальный объём в основном именно во фьючерсах (USDT-M perpetual), не в споте — без
    // отдельного фьючерсного фида таблица честно недооценивала бы, что там на самом деле происходит.
    // Помечаем такие монеты ОТДЕЛЬНЫМ псевдо-биржевым тегом "BINANCEFUT" (а не market-полем на "BINANCE") —
    // так они автоматически получают свой отдельный ключ в coinMap (не путаются со спотовым BTC/USDT
    // той же пары) и свою отдельную кнопку в переключателе бирж (см. renderExchangeSwitch), без
    // необходимости заводить второе, отдельное измерение фильтрации. tvSymbol/exchangeTerminalUrl/
    // coinDisplayLabel ниже знают про этот тег отдельно (у фьючерсов другой символ на TradingView
    // — с суффиксом ".P" — и другая ссылка на терминал).
    exchangeTags: ['BINANCE', 'BINANCEFUT'],
    feeds: [
      { exchangeTag: 'BINANCE', url: 'https://api.binance.com/api/v3/ticker/24hr' },
      { exchangeTag: 'BINANCEFUT', url: 'https://fapi.binance.com/fapi/v1/ticker/24hr' }
    ],
    parseTickers: function (body, exchangeTag) {
      const data = JSON.parse(body);
      if (!Array.isArray(data)) throw new Error('неожиданный формат ответа Binance');
      data.forEach(function (row) {
        upsertExternalCoin(row.symbol, num(row.lastPrice), num(row.priceChangePercent), num(row.quoteVolume), num(row.highPrice), num(row.lowPrice), exchangeTag);
      });
    }
  },
  okx: {
    label: 'OKX',
    baseUrl: 'https://www.okx.com',
    verifyPath: '/api/v5/account/balance',
    needsPassphrase: true,
    sign: async function (conn, path, params, method) {
      const qs = params && Object.keys(params).length
        ? '?' + Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&')
        : '';
      const requestPath = path + qs;
      const timestamp = new Date().toISOString(); // уже ровно нужный формат: YYYY-MM-DDTHH:mm:ss.sssZ
      const prehash = timestamp + (method || 'GET') + requestPath;
      const signature = await hmacSha256Base64(conn.apiSecret, prehash);
      return {
        url: this.baseUrl + requestPath,
        headers: {
          'OK-ACCESS-KEY': conn.apiKey,
          'OK-ACCESS-SIGN': signature,
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-PASSPHRASE': conn.passphrase
        }
      };
    },
    // OKX почти всегда отвечает HTTP 200 (даже на неверный ключ) — реальный успех/ошибка сидит
    // в теле: code "0" значит успех, любой другой код — ошибка с текстом в msg.
    checkError: function (data) {
      if (data && typeof data === 'object' && data.code !== undefined && String(data.code) !== '0') {
        throw new Error(data.msg || ('Ошибка OKX (код ' + data.code + ')'));
      }
    },
    // Публичный снимок ВСЕХ спот-тикеров одним запросом — см. pollExternalTickers ниже. У OKX нет
    // готового "изменения за 24ч в %" в ответе (в отличие от Binance/MEXC) — считаем сами из
    // last/open24h; instId у OKX через дефис ("BTC-USDT"), приводим к слитному виду для
    // upsertExternalCoin (тот же формат, что и raw-символ на MEXC/Binance).
    exchangeTags: ['OKX'],
    feeds: [{ exchangeTag: 'OKX', url: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT' }],
    parseTickers: function (body, exchangeTag) {
      const parsed = JSON.parse(body);
      const rows = parsed && parsed.data;
      if (!Array.isArray(rows)) throw new Error('неожиданный формат ответа OKX');
      rows.forEach(function (row) {
        const rawSymbol = String(row.instId || '').replace('-', '');
        const last = num(row.last);
        const open = num(row.open24h);
        const change24 = open > 0 ? (last - open) / open * 100 : 0;
        upsertExternalCoin(rawSymbol, last, change24, num(row.volCcy24h), num(row.high24h), num(row.low24h), exchangeTag);
      });
    }
  },
  bitget: {
    label: 'Bitget',
    baseUrl: 'https://api.bitget.com',
    verifyPath: '/api/v2/spot/account/assets',
    needsPassphrase: true,
    // Схема подписи 1-в-1 как у OKX (тот же timestamp+METHOD+requestPath(+query)+body -> HMAC-SHA256
    // -> base64), отличие только в именах заголовков (без префикса "OK-") и в формате timestamp —
    // у Bitget это просто миллисекунды эпохи строкой, а не ISO8601.
    sign: async function (conn, path, params, method) {
      const qs = params && Object.keys(params).length
        ? '?' + Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&')
        : '';
      const requestPath = path + qs;
      const timestamp = String(Date.now());
      const prehash = timestamp + (method || 'GET') + requestPath;
      const signature = await hmacSha256Base64(conn.apiSecret, prehash);
      return {
        url: this.baseUrl + requestPath,
        headers: {
          'ACCESS-KEY': conn.apiKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': conn.passphrase
        }
      };
    },
    // Как и OKX, Bitget почти всегда отвечает HTTP 200 — реальный успех/ошибка в теле: code "00000"
    // значит успех, любой другой код — ошибка с текстом в msg.
    checkError: function (data) {
      if (data && typeof data === 'object' && data.code !== undefined && String(data.code) !== '00000') {
        throw new Error(data.msg || ('Ошибка Bitget (код ' + data.code + ')'));
      }
    },
    // Публичный снимок ВСЕХ спот-тикеров одним запросом. change24h у Bitget — уже готовая ДОЛЯ
    // (0.0123 значит +1.23%), не сам процент — умножаем на 100, как и everywhere в этом файле для
    // подобных полей. Символ — без разделителя ("BTCUSDT"), как у MEXC/Binance, конвертация не нужна.
    exchangeTags: ['BITGET'],
    feeds: [{ exchangeTag: 'BITGET', url: 'https://api.bitget.com/api/v2/spot/market/tickers' }],
    parseTickers: function (body, exchangeTag) {
      const parsed = JSON.parse(body);
      const rows = parsed && parsed.data;
      if (!Array.isArray(rows)) throw new Error('неожиданный формат ответа Bitget');
      rows.forEach(function (row) {
        const rawSymbol = String(row.symbol || row.instId || '');
        upsertExternalCoin(rawSymbol, num(row.lastPr), num(row.change24h) * 100, num(row.quoteVolume), num(row.high24h), num(row.low24h), exchangeTag);
      });
    }
  }
};

// { binance: {apiKey, apiSecret, passphrase, connected}, okx: {...} } — независимо от mexcApiKey/
// accountConnected выше, см. комментарий у EXCHANGE_CONNECTORS.
let exchangeConnections = {};

// GET без подписи (публичные рыночные данные) с тем же fetch()->curl.exe запасным путём, что и у
// mexcSignedRequest/fetchKlines — публичные тикер-эндпоинты Binance/OKX на практике сами разрешают
// CORS из браузера (проверено), но обход всё равно оставлен для устойчивости в desktop-приложении
// (антивирус/сеть могут заблокировать САМ fetch, а не just CORS).
async function fetchPublicText(url) {
  try {
    const res = await fetchWithTimeout(url, {}, 10000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } catch (browserErr) {
    const native = await nativeCurlGet(url, null);
    if (!native) throw browserErr;
    return native.body;
  }
}

// ============================================================================
// ЛИСТИНГИ — боковая вкладка «Листинги» (см. #page-listings в index.html). Показывает новые
// торговые пары на MEXC и Binance. Два ЧЕСТНО разных механизма — у бирж просто нет единого способа
// заранее знать о листинге:
//
// 1) Binance Futures — единственное место, где реально можно посчитать обратный отсчёт: у ещё не
//    запущенных контрактов в /fapi/v1/exchangeInfo стоит status="PENDING_TRADING" и заполнено поле
//    onboardDate (эпоха мс, официально запланированное время старта торгов) — проверено вживую
//    прямым запросом к API перед тем, как писать этот код, поле реальное. onboardDate иногда
//    сдвигается (Binance может задержать запуск) — поэтому перепроверяем на каждом опросе, а не
//    один раз при первом обнаружении.
// 2) MEXC Spot и Binance Spot — такого поля нет вообще ни у одной из бирж: exchangeInfo отдаёт
//    только уже ТОРГУЮЩИЕСЯ пары. Единственный честный способ — периодически сверять список
//    торгуемых пар с сохранённым списком с прошлого опроса и ловить момент, когда там появляется
//    то, чего не было — то есть узнавать о листинге В МОМЕНТ (или в первые ~45с после), а не
//    заранее. Отсюда два разных вида карточек: "до листинга: 8м 12с" (только Binance Futures) и
//    "листинг обнаружен N назад" (MEXC/Binance spot).
// ============================================================================
const LISTING_POLL_MS = 45000;
const LISTING_SPOT_SOURCES = {
  MEXC: { url: 'https://api.mexc.com/api/v3/exchangeInfo', isTradable: function (s) { return String(s.status) === '1'; } },
  BINANCE: { url: 'https://api.binance.com/api/v3/exchangeInfo', isTradable: function (s) { return s.status === 'TRADING'; } }
};
const BINANCE_FUT_EXCHANGEINFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const LISTING_BADGE_TEXT = { MEXC: 'MEXC', BINANCE: 'BIN', BINANCEFUT: 'FUT', MEXCFUT: 'FUT' };
const LISTING_BASELINE_KEY = { MEXC: 'mexc_listing_baseline_mexc', BINANCE: 'mexc_listing_baseline_binance' };
const LISTING_EVENTS_KEY = 'mexc_listing_events';
const LISTING_EVENTS_MAX = 300;
const LISTING_EVENTS_MAX_AGE_MS = 14 * 24 * 3600 * 1000; // 14 дней — хватит полистать историю, не раздувая localStorage
const LISTING_FRESH_MS = 30 * 60 * 1000; // "новое" в бейдже сайдбара — обнаружено за последние 30 минут

let listingBaseline = { MEXC: null, BINANCE: null };          // null = ещё не инициализирован в этой сессии; иначе Set торгуемых пар
let listingBaselineSeeded = { MEXC: false, BINANCE: false };  // true = базовый список уже полон (либо загружен с диска, либо только что впервые построен) — дальше сравнение честное

let listingEvents = (function loadListingEvents() {
  try {
    const raw = localStorage.getItem(LISTING_EVENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
})();
let listingEventsSeq = listingEvents.reduce(function (m, e) { return Math.max(m, e.id || 0); }, 0);

function saveListingEvents() {
  const now = Date.now();
  listingEvents = listingEvents.filter(function (e) { return now - e.detectedAt < LISTING_EVENTS_MAX_AGE_MS; });
  if (listingEvents.length > LISTING_EVENTS_MAX) listingEvents = listingEvents.slice(-LISTING_EVENTS_MAX);
  try { persistSet(LISTING_EVENTS_KEY, JSON.stringify(listingEvents)); } catch (e) {}
}

function loadListingBaselineSet(exch) {
  try {
    const raw = localStorage.getItem(LISTING_BASELINE_KEY[exch]);
    if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return new Set(arr); }
  } catch (e) {}
  return null;
}
function saveListingBaselineSet(exch) {
  try { persistSet(LISTING_BASELINE_KEY[exch], JSON.stringify(Array.from(listingBaseline[exch]))); } catch (e) {}
}

function registerJustListed(exch, symbol) {
  const base = symbol.replace(/USDT$/, '');
  listingEvents.push({
    id: ++listingEventsSeq, exchange: exch, market: 'SPOT', symbol: symbol, baseAsset: base,
    kind: 'justListed', onboardDate: null, detectedAt: Date.now(), wentLiveAt: Date.now()
  });
  saveListingEvents();
}

// Проверяет список торгуемых пар одной биржи (MEXC или Binance spot) и ловит НОВЫЕ по сравнению с
// сохранённым базовым списком. Первый прогон (нет сохранённого списка на диске вообще) — НЕ считает
// ничего новым, просто фиксирует ВЕСЬ текущий рынок как точку отсчёта (иначе при первом же запуске
// приложения весь рынок — тысячи пар — выглядел бы как "листинг только что").
async function pollSpotListings(exch) {
  const src = LISTING_SPOT_SOURCES[exch];
  const body = await fetchPublicText(src.url);
  const data = JSON.parse(body);
  const current = new Set();
  (data.symbols || []).forEach(function (s) {
    if (s.quoteAsset !== 'USDT' || !src.isTradable(s)) return;
    current.add(s.symbol);
  });
  if (listingBaseline[exch] === null) {
    const saved = loadListingBaselineSet(exch);
    listingBaseline[exch] = saved || new Set();
    listingBaselineSeeded[exch] = !!saved;
  }
  const baseline = listingBaseline[exch];
  if (!listingBaselineSeeded[exch]) {
    current.forEach(function (s) { baseline.add(s); });
    listingBaselineSeeded[exch] = true;
    saveListingBaselineSet(exch);
    return;
  }
  let changed = false;
  current.forEach(function (s) {
    if (baseline.has(s)) return;
    baseline.add(s);
    changed = true;
    registerJustListed(exch, s);
  });
  if (changed) saveListingBaselineSet(exch);
}

// Binance Futures — единственная биржа/рынок из трёх, где есть настоящее время старта заранее (см.
// комментарий в начале секции). upcoming-события обновляются на КАЖДОМ опросе (не только при первом
// обнаружении) — onboardDate у биржи иногда сдвигается, счётчик должен оставаться честным.
async function pollBinanceFuturesListings() {
  const body = await fetchPublicText(BINANCE_FUT_EXCHANGEINFO_URL);
  const data = JSON.parse(body);
  const now = Date.now();
  (data.symbols || []).forEach(function (s) {
    if (s.quoteAsset !== 'USDT') return;
    const existingUpcoming = listingEvents.find(function (e) { return e.kind === 'upcoming' && e.exchange === 'BINANCEFUT' && e.symbol === s.symbol; });
    if (s.status === 'PENDING_TRADING' && s.onboardDate) {
      if (existingUpcoming) {
        existingUpcoming.onboardDate = s.onboardDate;
      } else {
        listingEvents.push({
          id: ++listingEventsSeq, exchange: 'BINANCEFUT', market: 'FUTURES', symbol: s.symbol, baseAsset: s.baseAsset,
          kind: 'upcoming', onboardDate: s.onboardDate, detectedAt: now, wentLiveAt: null
        });
      }
    } else if (s.status === 'TRADING' && existingUpcoming) {
      // Была в upcoming, теперь реально торгуется — переводим карточку в "уже залистилась".
      existingUpcoming.kind = 'justListed';
      existingUpcoming.wentLiveAt = now;
    }
  });
  saveListingEvents();
}

// MEXC Futures — у MEXC (в отличие от Binance) нет отдельного явного статуса вроде PENDING_TRADING,
// но у контракта в /contract/detail есть openingTime (эпоха мс, запланированное время открытия
// торгов) + showBeforeOpen/openingCountdownOption — та же механика, что и Binance-баннер "откроется
// через", проверено вживую прямым запросом к API. Раз явного статуса нет, честно опираемся ТОЛЬКО
// на openingTime: > now -> точно ещё не открыт (иначе openingTime уже был бы в прошлом по
// определению). Как только время прошло — считаем контракт запущенным (доверяем расписанию MEXC
// так же, как доверяем onboardDate у Binance) и переводим в "только что залистилась".
// RECENT_WINDOW ограничивает выборку: тысяча с лишним давно живущих контрактов (BTC/ETH и т.п.)
// тоже имеют openingTime, просто в далёком прошлом/эпохе 0 — интересны только контракты с
// openingTime в пределах последних 10 минут или в будущем.
const MEXC_FUT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const MEXC_FUT_RECENT_WINDOW_MS = 10 * 60 * 1000;
async function pollMexcFuturesListings() {
  const body = await fetchPublicText(MEXC_FUT_DETAIL_URL);
  const data = JSON.parse(body);
  const now = Date.now();
  (data.data || []).forEach(function (s) {
    if (s.quoteCoin !== 'USDT' || !s.openingTime || s.openingTime <= now - MEXC_FUT_RECENT_WINDOW_MS) return;
    const symbol = s.baseCoin + 'USDT';
    const existing = listingEvents.find(function (e) { return e.exchange === 'MEXCFUT' && e.symbol === symbol; });
    if (s.openingTime > now) {
      if (existing) { existing.onboardDate = s.openingTime; }
      else {
        listingEvents.push({
          id: ++listingEventsSeq, exchange: 'MEXCFUT', market: 'FUTURES', symbol: symbol, baseAsset: s.baseCoin,
          kind: 'upcoming', onboardDate: s.openingTime, detectedAt: now, wentLiveAt: null
        });
      }
    } else if (existing && existing.kind === 'upcoming') {
      existing.kind = 'justListed';
      existing.wentLiveAt = s.openingTime;
    } else if (!existing) {
      listingEvents.push({
        id: ++listingEventsSeq, exchange: 'MEXCFUT', market: 'FUTURES', symbol: symbol, baseAsset: s.baseCoin,
        kind: 'justListed', onboardDate: null, detectedAt: now, wentLiveAt: s.openingTime
      });
    }
  });
  saveListingEvents();
}

function updateListingsNavBadge() {
  const badge = document.getElementById('navListingBadge');
  if (!badge) return;
  const now = Date.now();
  const freshCount = listingEvents.filter(function (e) { return now - e.detectedAt < LISTING_FRESH_MS; }).length;
  badge.textContent = freshCount;
  badge.style.display = freshCount > 0 ? '' : 'none';
}

function renderListingsPageIfActive() {
  const page = document.getElementById('page-listings');
  if (page && page.classList.contains('active')) updateListingsPage();
  updateListingsNavBadge();
}

async function pollAllListings() {
  try { await pollSpotListings('MEXC'); } catch (e) { logW('Listings', 'MEXC: ' + e.message); }
  try { await pollSpotListings('BINANCE'); } catch (e) { logW('Listings', 'Binance Spot: ' + e.message); }
  try { await pollBinanceFuturesListings(); } catch (e) { logW('Listings', 'Binance Futures: ' + e.message); }
  try { await pollMexcFuturesListings(); } catch (e) { logW('Listings', 'MEXC Futures: ' + e.message); }
  renderListingsPageIfActive();
}
setInterval(pollAllListings, LISTING_POLL_MS);
pollAllListings(); // сразу при старте, не ждём первого интервала

function fmtCountdown(ms) {
  if (ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return (h > 0 ? h + 'ч ' : '') + m + 'м ' + sec + 'с';
}
function fmtAgoShort(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 'с';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'м';
  const h = Math.floor(m / 60);
  return h + 'ч';
}

// Фиксированный набор вкладок (не через renderFlatExchFilter — тот скрывает себя и сбрасывает
// фильтр, если нет ПОДКЛЮЧЁННОЙ по API-ключу биржи; листинги — публичные данные, не завязаны на
// подключение аккаунта, должны быть видны всегда). Свои label/title (не переиспользуем
// EXCHANGE_SWITCH_LABELS/TITLES — там нет MEXCFUT, и это отдельный, самодостаточный набор вкладок).
let listingsExchangeFilter = 'ALL'; // 'ALL' | 'MEXC' | 'MEXCFUT' | 'BINANCE' | 'BINANCEFUT'
const LISTINGS_FILTER_TABS = ['ALL', 'MEXC', 'MEXCFUT', 'BINANCE', 'BINANCEFUT'];
const LISTINGS_TAB_LABELS = { MEXC: 'M', MEXCFUT: 'MF', BINANCE: 'B', BINANCEFUT: 'BF' };
const LISTINGS_TAB_TITLES = { MEXC: 'MEXC Spot', MEXCFUT: 'MEXC Futures', BINANCE: 'Binance Spot', BINANCEFUT: 'Binance Futures' };
function renderListingsExchFilter() {
  const box = document.getElementById('listingsExchFilter');
  if (!box) return;
  box.innerHTML = LISTINGS_FILTER_TABS.map(function (ex) {
    if (ex === 'ALL') return '<div class="exch-switch-btn exch-switch-all' + (listingsExchangeFilter === 'ALL' ? ' active' : '') + '" data-fexch="ALL">' + t('Все') + '</div>';
    return '<div class="exch-switch-btn exch-switch-' + ex.replace(/FUT$/, '').toLowerCase() + (listingsExchangeFilter === ex ? ' active' : '') +
      '" data-fexch="' + ex + '" title="' + LISTINGS_TAB_TITLES[ex] + '">' + LISTINGS_TAB_LABELS[ex] + '</div>';
  }).join('');
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-fexch]');
      if (!btn || listingsExchangeFilter === btn.dataset.fexch) return;
      listingsExchangeFilter = btn.dataset.fexch;
      updateListingsPage();
    });
  }
}

// cls/statusHtml для одной карточки — вынесено отдельно от updateListingsPage(), чтобы 1-секундный
// тикер (tickListingsCountdowns ниже) мог пересчитать ТОЛЬКО текст отсчёта у уже существующих
// карточек, не перестраивая весь список — см. комментарий у tickListingsCountdowns о том, почему
// это принципиально важно (полная переотрисовка каждую секунду вызывала видимое "моргание").
function listingRowStatus(e, now) {
  if (e.kind === 'upcoming') {
    const msLeft = e.onboardDate - now;
    const countdown = fmtCountdown(msLeft);
    const cls = 'listing-row-upcoming' + (msLeft > 0 && msLeft <= 60000 ? ' listing-row-imminent' : msLeft > 0 && msLeft <= 300000 ? ' listing-row-soon' : '');
    const statusHtml = countdown
      ? '<span class="listing-row-countdown"><i class="ri-timer-flash-line"></i> ' + t('до листинга') + ': ' + countdown + '</span>'
      : '<span class="listing-row-countdown listing-row-overdue">' + t('запаздывает — ещё не запущен') + '</span>';
    return { cls: cls, statusHtml: statusHtml };
  }
  return {
    cls: 'listing-row-just',
    statusHtml: '<span class="listing-row-ago"><i class="ri-flashlight-line"></i> ' + t('листинг обнаружен') + ' ' + fmtAgoShort(now - e.detectedAt) + ' ' + t('назад') + '</span>'
  };
}

function updateListingsPage() {
  renderListingsExchFilter();
  const now = Date.now();
  let items = listingEvents.slice();
  if (listingsExchangeFilter !== 'ALL') items = items.filter(function (e) { return e.exchange === listingsExchangeFilter; });
  items.sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === 'upcoming' ? -1 : 1;
    if (a.kind === 'upcoming') return (a.onboardDate - now) - (b.onboardDate - now);
    return b.detectedAt - a.detectedAt;
  });
  items = items.slice(0, 100);
  const countBadge = document.getElementById('listingsCountBadge');
  if (countBadge) countBadge.textContent = items.length;
  const box = document.getElementById('listingsList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="empty-state"><i class="ri-rocket-2-line"></i>' + t('Пока новых листингов не найдено — страница проверяет MEXC и Binance каждые 45с.') + '</div>';
    return;
  }
  box.innerHTML = items.map(function (e, i) {
    const pair = e.baseAsset + '/USDT';
    const badgeText = LISTING_BADGE_TEXT[e.exchange] || e.exchange;
    const colorCls = e.exchange.replace(/FUT$/, '').toLowerCase();
    const st = listingRowStatus(e, now);
    return '<div class="listing-row ' + st.cls + '" data-id="' + e.id + '" style="animation-delay:' + (Math.min(i, 20) * 22) + 'ms">' +
      '<span class="exch-tag exch-tag-' + colorCls + '">' + badgeText + '</span>' +
      '<div class="listing-row-coin"><strong>' + pair + '</strong></div>' +
      st.statusHtml +
      '<button type="button" class="listing-row-copy" data-copy="' + e.baseAsset + '" title="' + t('Скопировать название монеты') + '"><i class="ri-file-copy-line"></i></button>' +
      '</div>';
  }).join('');
  wireListingRowCopy();
}

// Клик по кнопке-копирования — кладёт название монеты (базовый актив, например "GAIB") в буфер
// обмена, тот же паттерн copy+toast, что и у copySymbolForVataga выше. Делегированный слушатель на
// контейнере переживает переотрисовку innerHTML — вешаем один раз.
function copyListingSymbol(baseAsset) {
  const announce = function () { showAppToast(t('Скопировано') + ': ' + baseAsset); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(baseAsset).then(announce).catch(function () { fallbackCopyText(baseAsset); announce(); });
  } else {
    fallbackCopyText(baseAsset);
    announce();
  }
}
function wireListingRowCopy() {
  const box = document.getElementById('listingsList');
  if (!box || box.dataset.copyWired) return;
  box.dataset.copyWired = '1';
  box.addEventListener('click', function (e) {
    const btn = e.target.closest('.listing-row-copy');
    if (!btn) return;
    e.stopPropagation();
    copyListingSymbol(btn.dataset.copy);
  });
}

// Тикает раз в секунду, пока страница открыта — обратный отсчёт у upcoming-карточек живой, не
// дожидается следующего 45с-опроса биржи. НАЙДЕННЫЙ баг: раньше это вызывало полный
// updateListingsPage() каждую секунду — box.innerHTML полностью пересобирался, что для КАЖДОЙ
// карточки заново запускало её CSS entrance-анимацию (rankRowIn) — визуально выглядело как
// постоянное моргание всего списка. Теперь тикер точечно обновляет только текст отсчёта/классы
// эскалации (imminent/soon) у УЖЕ СУЩЕСТВУЮЩИХ узлов через data-id, не трогая сам список DOM-узлов
// — анимация, once отыгранная при вставке узла, повторно не запускается.
function tickListingsCountdowns() {
  const page = document.getElementById('page-listings');
  if (!page || !page.classList.contains('active')) return;
  const box = document.getElementById('listingsList');
  if (!box) return;
  const now = Date.now();
  const rows = box.querySelectorAll('.listing-row[data-id]');
  if (!rows.length) return;
  const byId = {};
  listingEvents.forEach(function (e) { byId[e.id] = e; });
  rows.forEach(function (row) {
    const e = byId[row.dataset.id];
    if (!e || e.kind !== 'upcoming') return; // justListed-карточки не тикают (их "N назад" меняется медленно — обновится на ближайшей полной перерисовке)
    const st = listingRowStatus(e, now);
    row.className = 'listing-row ' + st.cls; // без animation-delay/entrance-класса — тот уже был применён при вставке и не сбрасывается сменой ДРУГИХ классов на том же узле
    const countdownEl = row.querySelector('.listing-row-countdown');
    if (countdownEl) countdownEl.outerHTML = st.statusHtml;
  });
}
setInterval(tickListingsCountdowns, 1000);

let externalTickerTimers = {}; // id -> setInterval-хендл, см. start/stopExternalTickerPolling
const EXTERNAL_TICKER_POLL_MS = 4000;

async function pollExternalTickers(id) {
  const connector = EXCHANGE_CONNECTORS[id];
  // Каждый фид (спот, у Binance ещё и фьючерсы) опрашивается отдельно и независимо — сбой одного
  // (например, фьючерсный fapi.binance.com временно недоступен) не должен утопить обновление
  // остальных, уже успешно показанных монет этой биржи.
  for (let i = 0; i < connector.feeds.length; i++) {
    const feed = connector.feeds[i];
    try {
      const body = await fetchPublicText(feed.url);
      connector.parseTickers(body, feed.exchangeTag);
    } catch (e) {
      logW('Exchange', id + '/' + feed.exchangeTag + ': не удалось обновить тикеры — ' + e.message);
    }
  }
  rebuildList();
  renderTable();
}

// Запускается при успешном connectExchange(id) — публичные рыночные данные качаются периодическим
// REST-опросом (не WS, см. комментарий у upsertExternalCoin), пока эта биржа подключена.
function startExternalTickerPolling(id) {
  stopExternalTickerPollingTimer(id);
  pollExternalTickers(id); // сразу первый раз, не ждём первого интервала
  externalTickerTimers[id] = setInterval(function () { pollExternalTickers(id); }, EXTERNAL_TICKER_POLL_MS);
}

function stopExternalTickerPollingTimer(id) {
  if (externalTickerTimers[id]) { clearInterval(externalTickerTimers[id]); delete externalTickerTimers[id]; }
}

// Вызывается при disconnectExchange(id) — останавливает опрос И убирает уже показанные монеты этой
// биржи из таблицы (иначе они молча "зависли" бы последним известным снимком цены навсегда).
function stopExternalTickerPolling(id) {
  stopExternalTickerPollingTimer(id);
  EXCHANGE_CONNECTORS[id].exchangeTags.forEach(removeExternalCoinsForExchange);
  rebuildList();
  renderTable();
}

function setExchangeStatus(id, state, msg) {
  const badge = document.getElementById(id + 'StatusBadge');
  const text = document.getElementById(id + 'StatusText');
  if (!badge || !text) return;
  badge.classList.remove('off', 'warn');
  if (state === 'connected') {
    text.textContent = t('Подключено');
  } else if (state === 'connecting') {
    badge.classList.add('warn');
    text.textContent = msg || t('Подключение...');
  } else if (state === 'error') {
    badge.classList.add('off');
    text.textContent = t('Ошибка') + ': ' + (msg || t('не удалось подключиться'));
  } else {
    badge.classList.add('off');
    text.textContent = t('Не подключено');
  }
  updateAcctTabStatus(id, state === 'connected');
}

// Переключатель бирж в тулбаре скринера (#exchangeSwitch, см. index.html) — кружки с буквой вместо
// названия (см. .exch-switch-btn в styles.css: не тянем внешние бренд-ассеты логотипов, тот же
// визуальный язык, что и у coin-icon везде в этом приложении). MEXC всегда доступна (её тикеры идут
// по публичному WS независимо от того, подключен ли API-ключ аккаунта — см. accountConnected — это
// про баланс/сделки, не про рыночные данные); Binance/OKX появляются в переключателе, только когда
// реально подключены (см. connectExchange/disconnectExchange), иначе выбирать там нечего.
// "BINANCEFUT" — псевдо-биржа для фьючерсов Binance (см. exchangeTags/feeds у EXCHANGE_CONNECTORS.binance
// выше) — своя буква "F" и своё полное имя для подсказки, но цвет кнопки (см. styles.css) намеренно
// тот же жёлтый, что и у обычного Binance — это та же биржа, просто другой рынок.
const EXCHANGE_SWITCH_LABELS = { MEXC: 'M', BINANCE: 'B', BINANCEFUT: 'F', OKX: 'O', BITGET: 'G' };
const EXCHANGE_SWITCH_TITLES = { MEXC: 'MEXC', BINANCE: 'Binance Spot', BINANCEFUT: 'Binance Futures', OKX: 'OKX', BITGET: 'Bitget' };
const EXCHANGE_MARKET_LABEL = { BINANCE: 'Спот', BINANCEFUT: 'Фьючерсы' };

// Какая группа переключателя сейчас раскрыта (см. .exch-switch-submenu в styles.css) — только одна
// одновременно, id коннектора ('binance'/'okx') или null, если ни одна не раскрыта. У группы с
// ОДНИМ рынком (MEXC, пока и OKX) выдвигать нечего — клик по ней сразу фильтрует, без ленты.
let exchSwitchOpenGroup = null;

function renderExchangeSwitch() {
  const box = document.getElementById('exchangeSwitch');
  if (!box) return;
  const connectedIds = Object.keys(EXCHANGE_CONNECTORS).filter(function (id) { return exchangeConnections[id] && exchangeConnections[id].connected; });
  if (!connectedIds.length) {
    box.style.display = 'none';
    // Отключили единственную дополнительную биржу, пока фильтр стоял именно на ней — сбрасываем на
    // "Все", иначе таблица молча осталась бы пустой без видимого способа это исправить (переключатель
    // сам сейчас скрывается).
    if (activeExchangeFilter !== 'ALL' && activeExchangeFilter !== 'MEXC') {
      activeExchangeFilter = 'ALL';
      renderTable();
      applyConnectionBadge();
    }
    exchSwitchOpenGroup = null;
    return;
  }
  box.style.display = 'flex';

  // groupId — ключ EXCHANGE_CONNECTORS ('mexc'/'binance'/'okx') или "all"/"mexc" для встроенных
  // одиночных кнопок; tags — все рыночные теги этой группы (['BINANCE'] или ['BINANCE','BINANCEFUT']).
  function groupHtml(groupId, tags) {
    const mainTag = tags[0];
    const isMulti = tags.length > 1;
    if (!isMulti) {
      return '<div class="exch-switch-btn exch-switch-' + mainTag.toLowerCase() + (activeExchangeFilter === mainTag ? ' active' : '') +
        '" data-group="' + groupId + '" data-exchange="' + mainTag + '" title="' + (EXCHANGE_SWITCH_TITLES[mainTag] || mainTag) + '">' +
        EXCHANGE_SWITCH_LABELS[mainTag] + '</div>';
    }
    const groupActive = tags.indexOf(activeExchangeFilter) !== -1;
    const open = exchSwitchOpenGroup === groupId;
    return '<div class="exch-switch-group' + (open ? ' open' : '') + '">' +
      '<div class="exch-switch-btn exch-switch-' + mainTag.toLowerCase() + (groupActive ? ' group-active' : '') +
        '" data-group="' + groupId + '" title="' + (EXCHANGE_SWITCH_TITLES[mainTag] || mainTag) + ' — ' + t('выбрать рынок') + '">' +
        EXCHANGE_SWITCH_LABELS[mainTag] + '</div>' +
      '<div class="exch-switch-submenu">' + tags.map(function (tag) {
        return '<div class="exch-switch-subbtn' + (activeExchangeFilter === tag ? ' active' : '') + '" data-exchange="' + tag + '">' +
          t(EXCHANGE_MARKET_LABEL[tag] || tag) + '</div>';
      }).join('') + '</div>' +
    '</div>';
  }

  // "Все" не описана в EXCHANGE_SWITCH_LABELS/TITLES (не настоящая биржа) — собираем её кнопку вручную,
  // а не тянем через общий groupHtml(), чтобы не заводить фиктивные записи в тех картах ради одной кнопки.
  let html = '<div class="exch-switch-btn exch-switch-all' + (activeExchangeFilter === 'ALL' ? ' active' : '') +
    '" data-group="all" data-exchange="ALL" title="' + t('Все биржи') + '">' + t('Все') + '</div>';
  html += groupHtml('mexc', ['MEXC']);
  connectedIds.forEach(function (id) { html += groupHtml(id, EXCHANGE_CONNECTORS[id].exchangeTags); });
  box.innerHTML = html;
}

(function wireExchangeSwitchClick() {
  const box = document.getElementById('exchangeSwitch');
  if (!box) return;
  box.addEventListener('click', function (e) {
    const subBtn = e.target.closest('.exch-switch-subbtn[data-exchange]');
    if (subBtn) {
      activeExchangeFilter = subBtn.dataset.exchange;
      exchSwitchOpenGroup = null; // выбор сделан — задвигаем ленту обратно
      renderExchangeSwitch();
      renderTable();
      applyConnectionBadge();
      return;
    }
    const btn = e.target.closest('.exch-switch-btn[data-group]');
    if (!btn) return;
    const exch = btn.dataset.exchange; // задан только у однорыночных групп (см. groupHtml выше)
    if (exch) {
      if (activeExchangeFilter !== exch) {
        activeExchangeFilter = exch;
        renderTable();
        applyConnectionBadge();
      }
      exchSwitchOpenGroup = null;
    } else {
      // Мультирыночная группа (Binance) — сама по себе ничего не фильтрует, только
      // раскрывает/задвигает свою ленту "Спот/Фьючерсы"; выбор — за клик по ленте выше.
      const group = btn.dataset.group;
      exchSwitchOpenGroup = (exchSwitchOpenGroup === group) ? null : group;
    }
    renderExchangeSwitch();
  });
  // Клик мимо переключателя — задвигаем открытую ленту, тот же принцип, что у обычного dropdown.
  // ВАЖНО: composedPath(), а не box.contains(e.target) — тот же клик по кнопке группы ВЫШЕ уже успел
  // пересобрать box.innerHTML (открыв ленту), из-за чего e.target к этому моменту — уже отсоединённый
  // от DOM старый узел, и box.contains(e.target) ложно вернул бы false для клика ВНУТРИ переключателя,
  // тут же закрывая ленту, которую только что открыли. composedPath() фиксирует путь на момент
  // диспатча события, до какой-либо последующей замены DOM, поэтому не подвержен этой гонке.
  document.addEventListener('click', function (e) {
    if (exchSwitchOpenGroup && e.composedPath().indexOf(box) === -1) {
      exchSwitchOpenGroup = null;
      renderExchangeSwitch();
    }
  });
})();

// Обобщённый аналог mexcSignedRequest (см. её же комментарий) — тот же приём "сначала fetch() из
// браузера, при провале (CORS/сеть) — в обход через curl.exe", только параметризован коннектором
// конкретной биржи вместо жёстко зашитого MEXC.
async function exchangeSignedRequest(id, path, params, onProgress, method) {
  method = method || 'GET';
  const connector = EXCHANGE_CONNECTORS[id];
  const conn = exchangeConnections[id];
  let signed = await connector.sign(conn, path, params, method);
  let text = null;
  let httpOk = true;
  if (onProgress) onProgress('browser');
  try {
    const res = await fetchWithTimeout(signed.url, { method: method, headers: signed.headers }, 8000);
    text = await res.text();
    httpOk = res.ok;
    if (!httpOk) {
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* оставляем null */ }
      throw new Error((data && (data.msg || data.message)) || text || ('HTTP ' + res.status));
    }
  } catch (fetchErr) {
    if (!httpOk) throw fetchErr;
    const fetchReason = fetchErr && fetchErr.name === 'AbortError' ? 'таймаут 8с' : (fetchErr && fetchErr.message) || 'сеть/CORS';
    if (onProgress) onProgress('native');
    signed = await connector.sign(conn, path, params, method); // свежий timestamp/подпись перед native-попыткой
    let native = null;
    try {
      native = await nativeCurlGet(signed.url, signed.headers, method);
    } catch (nativeErr) {
      throw new Error('Браузер не смог достучаться до ' + connector.label + ' напрямую (' + fetchReason + '), и запасной способ через curl.exe тоже не сработал: ' + nativeErr.message);
    }
    if (!native) {
      throw new Error('Не удалось связаться с ' + connector.label + ' напрямую из браузера (' + fetchReason + '). Похоже, биржа блокирует такие запросы из браузера для этого источника. ' +
        'В desktop-приложении тот же запрос идёт в обход браузера и должен сработать.');
    }
    text = native.body;
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {
    throw new Error(connector.label + ' вернул нераспознаваемый ответ: ' + String(text).slice(0, 200));
  }
  if (connector.checkError) connector.checkError(data);
  return data;
}

async function connectExchange(id, silent) {
  const connector = EXCHANGE_CONNECTORS[id];
  const keyEl = document.getElementById(id + 'ApiKey');
  const secEl = document.getElementById(id + 'ApiSecret');
  const passEl = connector.needsPassphrase ? document.getElementById(id + 'ApiPassphrase') : null;
  const key = keyEl.value.trim();
  const secret = secEl.value.trim();
  const passphrase = passEl ? passEl.value.trim() : '';
  if (!key || !secret || (connector.needsPassphrase && !passphrase)) {
    if (!silent) showModal(connector.label, connector.needsPassphrase ? 'Введите API Key, Secret Key и Passphrase.' : 'Введите и API Key, и Secret Key.');
    return;
  }
  exchangeConnections[id] = { apiKey: key, apiSecret: secret, passphrase: passphrase, connected: false };
  setExchangeStatus(id, 'connecting');
  try {
    await exchangeSignedRequest(id, connector.verifyPath, {}, function (stage) {
      setExchangeStatus(id, 'connecting', stage === 'native'
        ? t('Браузер не ответил, пробуем в обход через curl.exe...')
        : t('Подключение через браузер...'));
    });
    exchangeConnections[id].connected = true;
    persistSet('exch_' + id + '_api_key', key);
    persistSet('exch_' + id + '_api_secret', secret);
    if (connector.needsPassphrase) persistSet('exch_' + id + '_api_passphrase', passphrase);
    setExchangeStatus(id, 'connected');
    startExternalTickerPolling(id);
    startBalanceAutoRefresh(); // тот же общий 3с-таймер, что и у MEXC — refreshAccountBalancesIfConnected сам решит, чью биржу обновлять (см. finresActiveExchange)
    renderExchangeSwitch();
    renderFinresExchangeTabs();
  } catch (e) {
    exchangeConnections[id].connected = false;
    setExchangeStatus(id, 'error', e.message);
    if (!silent) showModal('Не удалось подключить ' + connector.label, e.message);
  }
}

function disconnectExchange(id) {
  const connector = EXCHANGE_CONNECTORS[id];
  stopExternalTickerPolling(id);
  exchangeConnections[id] = { apiKey: '', apiSecret: '', passphrase: '', connected: false };
  persistRemove('exch_' + id + '_api_key');
  persistRemove('exch_' + id + '_api_secret');
  if (connector.needsPassphrase) persistRemove('exch_' + id + '_api_passphrase');
  document.getElementById(id + 'ApiKey').value = '';
  document.getElementById(id + 'ApiSecret').value = '';
  if (connector.needsPassphrase) document.getElementById(id + 'ApiPassphrase').value = '';
  setExchangeStatus(id, 'disconnected');
  if (!anyFinresExchangeConnected()) stopBalanceAutoRefresh();
  // Финрез прямо сейчас показывает именно эту биржу — она больше не подключена, чистим её живой снимок
  // (то же самое, что disconnectMexcAccount делает для MEXC) и перерисовываем как "не подключено".
  if (finresActiveExchange === id) {
    lastBalanceState = null;
    lastRawBalances = null;
    lastRenderedBalanceTotal = null;
    finresRealized = { trades: [], bySymbol: {}, openPositions: [], loadedAt: 0, loading: false, error: null };
    const heroEl = document.getElementById('finresHeroBar');
    if (heroEl) heroEl.innerHTML = '';
    const finresPage = document.getElementById('page-finres');
    if (finresPage && finresPage.classList.contains('active')) renderFinresTab();
  } else {
    finresSnapshots[id] = null;
  }
  renderExchangeSwitch();
  renderFinresExchangeTabs();
}

function restoreSavedExchangeAndConnect(id) {
  const connector = EXCHANGE_CONNECTORS[id];
  try {
    const savedKey = localStorage.getItem('exch_' + id + '_api_key');
    const savedSecret = localStorage.getItem('exch_' + id + '_api_secret');
    const savedPassphrase = connector.needsPassphrase ? localStorage.getItem('exch_' + id + '_api_passphrase') : '';
    if (savedKey && savedSecret && (!connector.needsPassphrase || savedPassphrase) && !(exchangeConnections[id] && exchangeConnections[id].connected)) {
      document.getElementById(id + 'ApiKey').value = savedKey;
      document.getElementById(id + 'ApiSecret').value = savedSecret;
      if (connector.needsPassphrase) document.getElementById(id + 'ApiPassphrase').value = savedPassphrase;
      connectExchange(id, true);
    }
  } catch (e) { /* localStorage недоступен — просто не автоподключаемся, как и у MEXC выше */ }
}

// Общий обработчик "глазка" показать/скрыть пароль — то же самое, что и у acctToggleEye для MEXC
// выше, только параметризован input'ом, чтобы не плодить одинаковые обработчики на каждое поле.
function wirePasswordToggleEye(eyeId, inputId) {
  const eye = document.getElementById(eyeId);
  const input = document.getElementById(inputId);
  if (!eye || !input) return;
  eye.addEventListener('click', function () {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    this.className = showing ? 'ri-eye-line acct-toggle-eye' : 'ri-eye-off-line acct-toggle-eye';
  });
}

Object.keys(EXCHANGE_CONNECTORS).forEach(function (id) {
  const connector = EXCHANGE_CONNECTORS[id];
  const connectBtn = document.getElementById(id + 'ConnectBtn');
  const disconnectBtn = document.getElementById(id + 'DisconnectBtn');
  if (connectBtn) connectBtn.addEventListener('click', function () { connectExchange(id, false); });
  if (disconnectBtn) disconnectBtn.addEventListener('click', function () { disconnectExchange(id); });
  wirePasswordToggleEye(id + 'ToggleEye', id + 'ApiSecret');
  if (connector.needsPassphrase) wirePasswordToggleEye(id + 'PassphraseToggleEye', id + 'ApiPassphrase');
  restoreSavedExchangeAndConnect(id);
});

// Только для __fakeFinresLogin (ручная проверка дизайна без реального API-ключа) — реальные сетевые
// попытки с пустым секретом просто сыпали бы ошибками HMAC и затирали тестовые данные. В обычной
// работе всегда false, ни на что не влияет.
let __designTestMode = false;

// "Подключена ли биржа, которую СЕЙЧАС показывает Финрез" — accountConnected для MEXC, тот же
// exchangeConnections[id].connected, что и в Настройках аккаунта, для любой другой (см.
// switchFinresExchange). Единая точка вместо прямых обращений к accountConnected во всех гейтах
// Финреза ниже — так каждый из них одинаково честно понимает, какая биржа сейчас активна.
function finresActiveExchangeConnected() {
  if (finresActiveExchange === 'mexc') return accountConnected;
  return !!(exchangeConnections[finresActiveExchange] && exchangeConnections[finresActiveExchange].connected);
}

// Есть ли ВООБЩЕ хоть одна подключённая биржа (не только активная в Финрезе сейчас) — используется
// только чтобы решить, можно ли останавливать общий 3с-таймер обновления баланса при отключении
// ОДНОЙ конкретной биржи (см. disconnectMexcAccount/disconnectExchange): если, скажем, Binance ещё
// подключён, таймеру рано останавливаться, даже если это MEXC только что отключили.
function anyFinresExchangeConnected() {
  if (accountConnected) return true;
  return Object.keys(exchangeConnections).some(function (id) { return exchangeConnections[id] && exchangeConnections[id].connected; });
}

// ============================================================================================
// ФИНРЕЗ ДЛЯ НЕСКОЛЬКИХ БИРЖ — переключатель сверху страницы (см. finresExchangeTabs в index.html).
//
// Раньше единственный набор глобалов (lastBalanceState/lastRawBalances/lastRenderedBalanceTotal/
// finresRealized/knownSymbols) подразумевал единственную биржу — MEXC, потому что сам Финрез был
// только про неё. НИ ОДНА из функций рендера/загрузки Финреза (renderFinresTab и все её вкладки,
// renderFinresHero, finresLoadRealized/Core, refreshAccountBalancesIfConnected и т.д.) не менялась —
// они по-прежнему читают/пишут ровно эти же имена переменных. Вместо этого при переключении между
// биржами Финреза эти глобалы просто МЕНЯЮТСЯ МЕСТАМИ со снимком неактивной биржи (снимок — обычный
// объект в finresSnapshots, не какая-то система геттеров/подписок). Именно поэтому весь дизайн/
// фильтры/анимации Финреза остаются ровно теми же, что и были — их код в буквальном смысле не видит
// разницы, чью биржу он сейчас рисует.
//
// Пока сознательно только спотовый баланс/сделки (тот же охват, что и у MEXC) — фьючерсный аккаунт
// Binance (/fapi/v2/account) технически совсем другой API (маржа, позиции, а не free/locked баланс)
// и заслуживает отдельного раунда, а не втискивания в существующие "баланс актива в USDT" виджеты.
let finresSnapshots = { mexc: null }; // {exchangeId: {lastBalanceState, lastRawBalances, lastRenderedBalanceTotal, finresRealized, knownSymbols} | null}

function snapshotFinresState() {
  return {
    lastBalanceState: lastBalanceState,
    lastRawBalances: lastRawBalances,
    lastRenderedBalanceTotal: lastRenderedBalanceTotal,
    finresRealized: finresRealized,
    knownSymbols: knownSymbols
  };
}
function applyFinresSnapshot(snap) {
  lastBalanceState = snap.lastBalanceState;
  lastRawBalances = snap.lastRawBalances;
  lastRenderedBalanceTotal = snap.lastRenderedBalanceTotal;
  finresRealized = snap.finresRealized;
  knownSymbols = snap.knownSymbols;
}

// Список бирж, у которых сейчас в принципе есть смысл показывать Финрез: MEXC — всегда (это базовая
// биржа приложения), плюс любая подключённая биржа из EXCHANGE_CONNECTORS. OKX подключить можно уже
// сегодня (см. Настройки аккаунта), но у нас пока нет её адаптера для Финреза (её REST не идентичен
// Binance/MEXC по форме ответов) — явно исключаем, чтобы не предлагать вкладку, которая тут же
// покажет "Не подключено" без реального пути её когда-либо подключить.
const FINRES_SUPPORTED_EXCHANGES = ['mexc', 'binance'];
const FINRES_EXCHANGE_LABEL = { mexc: 'MEXC', binance: 'Binance' };

function switchFinresExchange(id) {
  if (id === finresActiveExchange || FINRES_SUPPORTED_EXCHANGES.indexOf(id) === -1) return;
  finresSnapshots[finresActiveExchange] = snapshotFinresState();
  finresActiveExchange = id;
  let snap = finresSnapshots[id];
  if (!snap) {
    // Впервые за эту сессию открываем Финрез этой биржи — начинаем с чистого состояния и подтягиваем
    // её собственный список "известных символов" из localStorage (см. loadKnownSymbols выше — она
    // читает knownSymbolsKeyFor(finresActiveExchange), а finresActiveExchange уже указывает на id).
    knownSymbols = {};
    loadKnownSymbols();
    // finresRealized: та же "пустая, но валидная" форма, которую гарантирует настоящая загрузка
    // (см. finresLoadRealized ниже, Object.assign({trades:[], ...}, ...)) — НЕ голый null, иначе
    // finresLoadRealized(false) в __designTestMode мог бы на одно микротаск-тик вернуть null и уронить
    // renderFinresOverviewContent/renderFinresHero, которые читают data.trades без проверки на null
    // (в проде так не бывает — там до первого реального ответа finresRealized уже имеет эту форму).
    snap = {
      lastBalanceState: null, lastRawBalances: null, lastRenderedBalanceTotal: null,
      finresRealized: { trades: [], bySymbol: {}, openPositions: [], loadedAt: 0, loading: false, error: null },
      knownSymbols: knownSymbols
    };
    finresSnapshots[id] = snap;
  }
  applyFinresSnapshot(snap);
  // Больше не нужно сбрасывать flag "идёт загрузка" вручную — finresLoadPromises теперь per-биржевая
  // карта (см. её комментарий), у каждой биржи свой независимый слот, переключение само по себе на
  // них не влияет.
  // Очищаем DOM, чтобы следующий рендер посчитался "первой отрисовкой" и заново честно проиграл
  // анимации появления (renderFinresHero сама решает это по наличию .balance-hero в DOM, см.
  // комментарий у неё — а не по JS-флагу, поэтому очистки DOM достаточно, ничего больше сбрасывать не нужно).
  const heroEl = document.getElementById('finresHeroBar');
  if (heroEl) heroEl.innerHTML = '';
  const contentEl = document.getElementById('finresContent');
  if (contentEl) contentEl.innerHTML = '';
  renderFinresExchangeTabs();
  renderFinresHero();
  renderFinresTab();
  if (finresActiveExchangeConnected() && !lastBalanceState) {
    refreshAccountBalancesIfConnected().then(function () { return finresLoadRealized(true); }).then(function () {
      renderFinresHero();
      renderFinresTab();
    });
  }
}

function renderFinresExchangeTabs() {
  const box = document.getElementById('finresExchangeTabs');
  if (!box) return;
  // Показываем переключатель, только если реально есть между чем переключаться — MEXC один в один
  // как раньше (без лишней вкладки над Финрезом, если Binance никогда не подключали).
  const available = FINRES_SUPPORTED_EXCHANGES.filter(function (id) { return id === 'mexc' || (exchangeConnections[id] && exchangeConnections[id].connected); });
  if (available.length <= 1) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  box.innerHTML = available.map(function (id) {
    const connected = id === 'mexc' ? accountConnected : (exchangeConnections[id] && exchangeConnections[id].connected);
    return '<div class="exch-switch-btn exch-switch-' + id + (id === finresActiveExchange ? ' active' : '') +
      (connected ? ' connected' : '') + '" data-finres-exchange="' + id + '" title="' + FINRES_EXCHANGE_LABEL[id] + '">' +
      EXCHANGE_SWITCH_LABELS[id.toUpperCase()] + '</div>';
  }).join('');
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-finres-exchange]');
      if (btn) switchFinresExchange(btn.dataset.finresExchange);
    });
  }
}

let balanceRefreshInFlight = false;
let balanceRefreshFailStreak = 0;
function refreshAccountBalancesIfConnected() {
  if (__designTestMode) return Promise.resolve();
  if (!finresActiveExchangeConnected() || balanceRefreshInFlight) return Promise.resolve(); // не копим параллельные запросы, если предыдущий ещё не ответил
  balanceRefreshInFlight = true;
  const isMexc = finresActiveExchange === 'mexc';
  // return — чтобы вызывающий код (например, кнопка «Обновить» в Финрезе) мог дождаться реального
  // завершения запроса, а не только поставить его в очередь.
  const req = isMexc ? mexcSignedRequest('/api/v3/account', {}) : exchangeSignedRequest(finresActiveExchange, '/api/v3/account', {});
  return req.then(function (data) {
    balanceRefreshFailStreak = 0;
    renderAccountBalances(data && data.balances);
    // Раз соединение прямо сейчас реально работает — статус должен это отражать, даже если до этого
    // была временная ошибка (сеть моргнула, биржа на секунду не ответила и т.п.). Иначе бейдж "Ошибка"
    // мог бы навсегда зависнуть в интерфейсе даже после того, как всё восстановилось.
    // setAccountStatus — бейдж на "Настройки аккаунта", он есть только у MEXC (см. её же комментарий);
    // у Binance/OKX там свой независимый setExchangeStatus, который сам управляется из connectExchange
    // и не нуждается в подталкивании отсюда.
    if (isMexc) setAccountStatus('connected');
  }).catch(function (e) {
    balanceRefreshFailStreak++;
    // Не дёргаем статус в "Ошибка" на каждый одиночный сбой (короткий сетевой сбой раз в 3с —
    // это нормально и само пройдёт). Показываем ошибку только если не получилось несколько раз подряд.
    if (isMexc && balanceRefreshFailStreak >= 3) setAccountStatus('error', e.message);
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
  // coin.exchange !== 'MEXC' — эта монета с другой биржи (см. upsertExternalCoin), а запрос ниже
  // всегда идёт на MEXC-аккаунт; без этой проверки для монеты вроде BINANCE:BTC/USDT здесь
  // ошибочно показались бы MEXC-ордера по совпадающему по названию, но другому рынку символу.
  if (!accountConnected || !coin || (coin.exchange && coin.exchange !== 'MEXC')) { block.style.display = 'none'; return; }
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
  currentLang = currentLang === 'en' ? 'ru' : 'en';
  try { localStorage.setItem(I18N_LANG_KEY, currentLang); } catch (e) {}
  document.getElementById('langToggleLabel').textContent = currentLang === 'en' ? 'EN' : 'RU';
  applyStaticI18n();
  refreshAllDynamicContent();
});
// Дозаписывает перевод в уже отрисованный ДИНАМИЧЕСКИЙ контент (innerHTML=... из JS, не статичная
// разметка index.html — ту applyStaticI18n() выше уже покрывает) — большинство строк в нём обёрнуты
// в t() прямо в месте формирования, поэтому просто перерисовываем то, что уже видно на экране;
// каждая функция защищена try/catch — сбой в одной вкладке не должен мешать переводу остальных.
function refreshAllDynamicContent() {
  [
    function () { renderTable(); },
    function () { if (currentCoin) updateInfoPanel(); },
    function () { updateFavoritesPage(); },
    function () { updateAlerts(); },
    function () { updateAnalytics(); },
    function () { updatePatternsPage(); },
    function () { updateProfilesPage(); },
    function () {
      const finresPageEl = document.getElementById('page-finres');
      if (finresPageEl && finresPageEl.classList.contains('active')) renderFinresTab();
    }
  ].forEach(function (fn) { try { fn(); } catch (e) {} });
}

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

const appVersionLabelEl = document.getElementById('appVersionLabel');
if (appVersionLabelEl) appVersionLabelEl.textContent = APP_VERSION;
document.getElementById('checkUpdateBtn').addEventListener('click', checkForAppUpdate);
document.getElementById('downloadUpdateBtn').addEventListener('click', downloadAndApplyUpdate);

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
    ownChartPriceScaleMult = 1;
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
// Панель "Индикаторы" — переключаемые индикаторы с глазками (объём/MA), тот же принцип, что у
// TradingView-легенды индикаторов, вместо одной жёстко зашитой кнопки-таблетки MA.
const ochartIndicatorsBtnEl = document.getElementById('ochartIndicatorsBtn');
const ochartSettingsBtnEl = document.getElementById('ochartSettingsBtn');
const ochartIndicatorsPanelEl = document.getElementById('ochartIndicatorsPanel');
if (ochartIndicatorsPanelEl && (ochartIndicatorsBtnEl || ochartSettingsBtnEl)) {
  // Открывается и от "Индикаторы" (слева), и от шестерёнки "Настройки" (справа) — один и тот же
  // список глазков-переключателей, просто два разных входа, как у TradingView (там тоже indicators
  // и settings часто ведут к пересекающимся панелям). Позиционируем под тем триггером, который
  // реально кликнули (position:fixed), а не жёстко под одним из них.
  function toggleIndicatorsPanel(anchorEl) {
    const isOpenForThis = ochartIndicatorsPanelEl.classList.contains('show') && ochartIndicatorsPanelEl.__anchor === anchorEl;
    if (isOpenForThis) { ochartIndicatorsPanelEl.classList.remove('show'); return; }
    const r = anchorEl.getBoundingClientRect();
    ochartIndicatorsPanelEl.style.top = (r.bottom + 6) + 'px';
    const panelW = 168;
    ochartIndicatorsPanelEl.style.left = Math.max(6, Math.min(window.innerWidth - panelW - 6, r.left)) + 'px';
    ochartIndicatorsPanelEl.__anchor = anchorEl;
    ochartIndicatorsPanelEl.classList.add('show');
  }
  if (ochartIndicatorsBtnEl) {
    ochartIndicatorsBtnEl.addEventListener('click', function (e) { e.stopPropagation(); toggleIndicatorsPanel(ochartIndicatorsBtnEl); });
  }
  if (ochartSettingsBtnEl) {
    ochartSettingsBtnEl.addEventListener('click', function (e) { e.stopPropagation(); toggleIndicatorsPanel(ochartSettingsBtnEl); });
  }
  document.addEventListener('click', function (e) {
    if (!ochartIndicatorsPanelEl.classList.contains('show')) return;
    if (ochartIndicatorsPanelEl.contains(e.target) || e.target === ochartIndicatorsBtnEl || e.target === ochartSettingsBtnEl) return;
    ochartIndicatorsPanelEl.classList.remove('show');
  });
  function syncIndRow(row, on) {
    row.classList.toggle('ind-off', !on);
    const eyeBtn = row.querySelector('.ochart-ind-eye');
    const eyeIcon = eyeBtn.querySelector('i');
    eyeBtn.classList.toggle('active', on);
    eyeIcon.className = on ? 'ri-eye-line' : 'ri-eye-off-line';
  }
  ochartIndicatorsPanelEl.querySelectorAll('.ochart-ind-row').forEach(function (row) {
    row.addEventListener('click', function () {
      const ind = row.getAttribute('data-ind');
      if (ind === 'volume') { ownChartShowVolume = !ownChartShowVolume; syncIndRow(row, ownChartShowVolume); }
      else if (ind === 'ma') { ownChartShowMA = !ownChartShowMA; syncIndRow(row, ownChartShowMA); }
      if (ownChartCandles) drawCandleChart(document.getElementById('ownCandleChart'), ownChartCandles);
    });
  });
}
// Скриншот графика — экспорт текущего вида канваса в PNG (тот же Blob+ObjectURL+<a download>
// приём, что и у экспорта CSV в Финрез, просто для картинки).
const ochartScreenshotBtnEl = document.getElementById('ochartScreenshot');
if (ochartScreenshotBtnEl) {
  ochartScreenshotBtnEl.addEventListener('click', function () {
    const srcCanvas = document.getElementById('ownCandleChart');
    if (!srcCanvas || !ownChartCandles) { showAppToast('Нет данных для скриншота'); return; }
    const out = document.createElement('canvas');
    out.width = srcCanvas.width; out.height = srcCanvas.height;
    const octx = out.getContext('2d');
    octx.fillStyle = '#131722';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(srcCanvas, 0, 0);
    out.toBlob(function (blob) {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const sym = currentCoin ? currentCoin.symbol : 'chart';
      a.href = url;
      a.download = 'mexc-' + sym + '-' + Date.now() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      showAppToast('Скриншот графика сохранён');
    }, 'image/png');
  });
}
// Полноэкранный режим для "своего графика" — нативный Fullscreen API на весь контейнер
// (топбар + вертикальная панель инструментов + холст), не только на канвас.
const ochartFullscreenBtnEl = document.getElementById('ochartFullscreen');
if (ochartFullscreenBtnEl) {
  ochartFullscreenBtnEl.addEventListener('click', function () {
    const container = document.getElementById('ownChartContainer');
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(function () { showAppToast('Не удалось включить полноэкранный режим'); });
    } else {
      document.exitFullscreen().catch(function () {});
    }
  });
  document.addEventListener('fullscreenchange', function () {
    const container = document.getElementById('ownChartContainer');
    const isFs = document.fullscreenElement === container;
    ochartFullscreenBtnEl.classList.toggle('active', isFs);
    ochartFullscreenBtnEl.querySelector('i').className = isFs ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line';
    ochartFullscreenBtnEl.title = isFs ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим';
    setTimeout(function () {
      if (ownChartCandles) drawCandleChart(document.getElementById('ownCandleChart'), ownChartCandles);
    }, 60);
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
    listEl.innerHTML = '<div class="finres-empty" style="padding:20px"><i class="ri-inbox-line"></i>' + t('Пока нет ни одной закрытой позиции — только открытые входы без выхода здесь не показываются.') + '</div>';
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
    journalLastAutoCenterExitTime = pair.exitTime; // ручной выбор тоже "легализует" эту сделку как текущий центр
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
  // Пол растянут с 10 до 30 свечей по фидбеку "график открывается слишком приближенным" — у
  // активного скальпера вход/выход часто попадают в одну-две соседние свечи (hi-lo≈0), и с полом в
  // 10 видимое окно схлопывалось до ~21 свечи, визуально "впритык". 30 даёт ~61 свечу по умолчанию —
  // тот же порядок, что у "своего графика" на главной странице (140), просто под масштаб детального
  // разбора одной сделки, а не всей истории разом.
  const pad = Math.max(30, Math.round((hi - lo) * 0.8));
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
    return '<button type="button" class="journal-tf-pill' + (o.key === journalChartState.tf ? ' active' : '') + '" data-tf="' + o.key + '">' + t(o.label) + '</button>';
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
      const candles = await fetchKlines(journalChartState.raw, tf, 1000, finresActiveExchange);
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
// exitTime закрытой позиции, на которую последний раз автоцентрировали вид — используется ниже,
// чтобы отличить "появилась НОВАЯ сделка" (стоит центрировать) от "та же последняя сделка, просто
// обновились свечи" (центрировать НЕ надо — иначе ручной зум/панорама/растяжение осей пользователя
// откатывались бы на каждый тик обновления, даже если он просто отвёл мышь ничего не поменяв).
let journalLastAutoCenterExitTime = null;
function startJournalLiveRefresh(asset, raw) {
  stopJournalLiveRefresh();
  journalRefreshTimer = setInterval(async function () {
    const overlay = document.getElementById('journalModal');
    if (!overlay || !overlay.classList.contains('active') || !journalChartState) { stopJournalLiveRefresh(); return; }
    try {
      const trades = await fetchMyTrades(raw, 500, finresActiveExchange);
      if (!trades.length) return;
      // Если пользователь сам выбрал таймфрейм кнопкой в шапке (journalTfPills) — уважаем его выбор
      // и на "живых" тиках тоже, а не тихо подменяем автоподобранным на каждое обновление.
      const backMs = Date.now() - trades[0].time;
      const tf = journalChartState.tf || pickJournalTf(backMs);
      const candles = await fetchKlines(raw, tf, 1000, finresActiveExchange);
      if (!candles.length || !journalChartState) return;
      const pairs = computeTradePairsForChart(trades);
      const wasOnLatest = journalChartState.pairs && journalChartState.selectedPairIndex === journalChartState.pairs.length - 1;
      journalChartState.candles = candles;
      journalChartState.trades = trades;
      journalChartState.pairs = pairs;
      const newLatestPair = pairs.length ? pairs[pairs.length - 1] : null;
      const isGenuinelyNewTrade = newLatestPair && newLatestPair.exitTime !== journalLastAutoCenterExitTime;
      if (journalChartState.selectedPairIndex >= pairs.length) {
        // Прежний индекс больше не существует (список сузился) — единственный случай, когда
        // приходится пересинхронизировать выбор безусловно.
        journalChartState.selectedPairIndex = pairs.length - 1;
        journalChartState.view = newLatestPair ? centerJournalViewOnPair(candles, newLatestPair) : null;
        journalLastAutoCenterExitTime = newLatestPair && newLatestPair.exitTime;
      } else if (wasOnLatest && isGenuinelyNewTrade) {
        // Появилась НОВАЯ закрытая сделка, пока смотрели на последнюю — переезжаем на неё (то самое
        // "живое" ощущение). Если же сделка та же самая, что и на прошлом тике — НЕ трогаем view,
        // иначе любой ручной зум/панорама/растяжение осей откатывались бы каждые 8с сами по себе.
        journalChartState.selectedPairIndex = pairs.length - 1;
        journalChartState.view = centerJournalViewOnPair(candles, newLatestPair);
        journalLastAutoCenterExitTime = newLatestPair.exitTime;
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
    const trades = await fetchMyTrades(raw, 500, finresActiveExchange);
    if (!trades.length) {
      const exchLabel = finresActiveExchange === 'mexc' ? 'MEXC' : (EXCHANGE_CONNECTORS[finresActiveExchange] || {}).label || finresActiveExchange;
      emptyEl.innerHTML = '<i class="ri-inbox-line"></i> Сделок по ' + asset + '/USDT не найдено в истории, которую отдаёт API ' + exchLabel + '.';
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
    const candles = await fetchKlines(raw, tf, 1000, finresActiveExchange);
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
    journalLastAutoCenterExitTime = pairs[selectedPairIndex].exitTime;
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
  // Построения/зум-по-осям не привязаны к конкретной монете (в отличие от ownChartDrawings у
  // главного графика) — сбрасываем при закрытии, чтобы при следующем открытии журнала для ДРУГОЙ
  // сделки не остались линии/растяжение от предыдущей.
  journalChartTool = 'cursor';
  journalChartDrawings = [];
  journalChartPendingTrend = null;
  journalChartRulerDrag = null;
  journalPriceScaleMult = 1;
  journalLastAutoCenterExitTime = null;
}
document.getElementById('journalModalClose').addEventListener('click', closeJournalModal);
document.getElementById('journalModal').addEventListener('click', function (e) {
  if (e.target === this) closeJournalModal();
});

// Панель инструментов рисования слева (та же техника, что у "своего графика") — делегированный
// клик по кнопкам с data-jtool.
document.querySelectorAll('#journalVToolbar .ochart-tool[data-jtool]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    journalChartTool = btn.getAttribute('data-jtool');
    journalChartPendingTrend = null;
    syncJournalToolButtons();
  });
});

// Панель "Индикаторы" (глазки VOLG/Точки входа-выхода) — открывается и от "Индикаторы", и от
// шестерёнки "Настройки", тот же приём, что и у главного "своего графика" (position:fixed,
// позиционируется под реально кликнутой кнопкой).
(function wireJournalIndicatorsPanel() {
  const panelEl = document.getElementById('journalIndicatorsPanel');
  const btns = [document.getElementById('journalIndicatorsBtn'), document.getElementById('journalSettingsBtn')].filter(Boolean);
  if (!panelEl || !btns.length) return;
  function toggle(anchorEl) {
    const isOpenForThis = panelEl.classList.contains('show') && panelEl.__anchor === anchorEl;
    if (isOpenForThis) { panelEl.classList.remove('show'); return; }
    const r = anchorEl.getBoundingClientRect();
    panelEl.style.top = (r.bottom + 6) + 'px';
    const panelW = 190;
    panelEl.style.left = Math.max(6, Math.min(window.innerWidth - panelW - 6, r.left)) + 'px';
    panelEl.__anchor = anchorEl;
    panelEl.classList.add('show');
  }
  btns.forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(btn); });
  });
  document.addEventListener('click', function (e) {
    if (!panelEl.classList.contains('show')) return;
    if (panelEl.contains(e.target) || btns.indexOf(e.target) !== -1) return;
    panelEl.classList.remove('show');
  });
  function syncIndRow(row, on) {
    row.classList.toggle('ind-off', !on);
    const eyeBtn = row.querySelector('.ochart-ind-eye');
    eyeBtn.classList.toggle('active', on);
    eyeBtn.querySelector('i').className = on ? 'ri-eye-line' : 'ri-eye-off-line';
  }
  panelEl.querySelectorAll('.ochart-ind-row').forEach(function (row) {
    row.addEventListener('click', function () {
      const ind = row.getAttribute('data-ind');
      if (ind === 'volume') { journalShowVolume = !journalShowVolume; syncIndRow(row, journalShowVolume); }
      else if (ind === 'entryexit') { journalShowEntryExit = !journalShowEntryExit; syncIndRow(row, journalShowEntryExit); }
      if (journalChartState) drawJournalChart(document.getElementById('journalChartCanvas'), journalChartState.candles);
    });
  });
})();

function journalZoom(factor) {
  if (!journalChartState) return;
  const n = journalChartState.candles.length;
  const view = journalChartState.view || { visibleCount: n, offset: 0 };
  const center = n - view.offset - view.visibleCount / 2;
  let newVisible = Math.round(view.visibleCount * factor);
  newVisible = Math.max(6, Math.min(n, newVisible));
  const maxOffset = Math.max(0, n - newVisible);
  const newOffset = Math.max(0, Math.min(maxOffset, n - newVisible - (center - newVisible / 2)));
  journalChartState.view = { visibleCount: newVisible, offset: newOffset };
  drawJournalChart(document.getElementById('journalChartCanvas'), journalChartState.candles);
}
const journalZoomInBtnEl = document.getElementById('journalZoomIn');
if (journalZoomInBtnEl) journalZoomInBtnEl.addEventListener('click', function () { journalZoom(1 / 1.3); });
const journalZoomOutBtnEl = document.getElementById('journalZoomOut');
if (journalZoomOutBtnEl) journalZoomOutBtnEl.addEventListener('click', function () { journalZoom(1.3); });

const journalClearBtnEl = document.getElementById('journalClearDrawings');
if (journalClearBtnEl) {
  journalClearBtnEl.addEventListener('click', function () {
    journalChartDrawings = [];
    if (journalChartState) drawJournalChart(document.getElementById('journalChartCanvas'), journalChartState.candles);
    showAppToast('Построения на графике сделок очищены');
  });
}
const journalResetViewBtnEl = document.getElementById('journalResetView');
if (journalResetViewBtnEl) {
  journalResetViewBtnEl.addEventListener('click', function () {
    if (!journalChartState) return;
    const selPair = journalChartState.pairs && journalChartState.pairs[journalChartState.selectedPairIndex];
    journalChartState.view = selPair ? centerJournalViewOnPair(journalChartState.candles, selPair)
      : { visibleCount: Math.min(120, journalChartState.candles.length), offset: 0 };
    journalPriceScaleMult = 1;
    drawJournalChart(document.getElementById('journalChartCanvas'), journalChartState.candles);
  });
}

// Скриншот графика сделок — тот же Blob+ObjectURL+<a download> приём, что и у "своего графика"/CSV.
const journalScreenshotBtnEl = document.getElementById('journalScreenshot');
if (journalScreenshotBtnEl) {
  journalScreenshotBtnEl.addEventListener('click', function () {
    const srcCanvas = document.getElementById('journalChartCanvas');
    if (!srcCanvas || !journalChartState || !journalChartState.candles) { showAppToast('Нет данных для скриншота'); return; }
    const out = document.createElement('canvas');
    out.width = srcCanvas.width; out.height = srcCanvas.height;
    const octx = out.getContext('2d');
    octx.fillStyle = '#131722';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(srcCanvas, 0, 0);
    out.toBlob(function (blob) {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mexc-journal-' + (journalChartState.raw || 'chart') + '-' + Date.now() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      showAppToast('Скриншот графика сохранён');
    }, 'image/png');
  });
}

// Полноэкранный режим для модалки журнала — на весь .journal-modal (шапка+тулбар+график+список).
const journalFullscreenBtnEl = document.getElementById('journalFullscreen');
if (journalFullscreenBtnEl) {
  journalFullscreenBtnEl.addEventListener('click', function () {
    const modalEl = document.querySelector('#journalModal .journal-modal');
    if (!modalEl) return;
    if (!document.fullscreenElement) {
      modalEl.requestFullscreen().catch(function () { showAppToast('Не удалось включить полноэкранный режим'); });
    } else {
      document.exitFullscreen().catch(function () {});
    }
  });
  document.addEventListener('fullscreenchange', function () {
    const modalEl = document.querySelector('#journalModal .journal-modal');
    const isFs = document.fullscreenElement === modalEl;
    journalFullscreenBtnEl.classList.toggle('active', isFs);
    journalFullscreenBtnEl.querySelector('i').className = isFs ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line';
    journalFullscreenBtnEl.title = isFs ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим';
    setTimeout(function () {
      if (journalChartState) drawJournalChart(document.getElementById('journalChartCanvas'), journalChartState.candles);
    }, 60);
  });
}
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
  if (finresActiveExchangeConnected() && finresLastUpdatedAt) {
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

// Вкладки бирж на "Настройки аккаунта" (см. .exch-tabs в index.html) — клик переключает, какая
// панель (MEXC/Binance/OKX) видна, без скролла по странице в поисках нужной формы ключа.
(function wireAcctExchTabs() {
  const tabs = document.getElementById('acctExchTabs');
  if (!tabs) return;
  tabs.addEventListener('click', function (e) {
    const tab = e.target.closest('.exch-tab[data-exch-tab]');
    if (!tab) return;
    const id = tab.dataset.exchTab;
    tabs.querySelectorAll('.exch-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
    document.querySelectorAll('.exch-tab-panel').forEach(function (p) { p.classList.remove('active'); });
    const panel = document.getElementById('acctPanel' + id.charAt(0).toUpperCase() + id.slice(1));
    if (panel) panel.classList.add('active');
  });
})();

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
  CHART_MODE_KEY, OWN_CHART_DRAWINGS_KEY, PATTERN_HISTORY_KEY, DETECTOR_ENABLED_KEY, 'mexc_hide_dust',
  // Binance-Финрез (см. switchFinresExchange) — тот же принцип, свои отдельные ключи истории/известных
  // символов, плюс её собственные API-ключи (см. connectExchange/EXCHANGE_CONNECTORS).
  'exch_binance_api_key', 'exch_binance_api_secret', balanceHistoryKeyFor('binance'), knownSymbolsKeyFor('binance')
];
async function hydrateFromNativeStorageIfNeeded() {
  if (!window.Neutralino) return; // веб-версия: один и тот же origin/профиль браузера, восстанавливать нечего
  let hydratedApiKey = false;
  let hydratedBinanceKey = false;
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
    if (key === 'exch_binance_api_key' || key === 'exch_binance_api_secret') hydratedBinanceKey = true;
    if (key === BALANCE_HISTORY_KEY || key === KNOWN_SYMBOLS_KEY) hydratedAccountState = true;
    if (key === KNOWN_SYMBOLS_KEY) loadKnownSymbols(); // перечитать в уже загруженный в память объект
  }
  if (!hydratedApiKey && !hydratedBinanceKey && !hydratedAccountState) return;
  logI('Storage', 'локальный профиль браузера был пуст — восстановлены данные из резервного хранилища Neutralino (переживает пересборку .exe)');
  if (hydratedApiKey) {
    restoreSavedApiKeyAndConnect();
  } else if (hydratedAccountState && finresTab) {
    renderFinresTab();
    renderFinresHero();
  }
  if (hydratedBinanceKey) restoreSavedExchangeAndConnect('binance');
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
window.__patternFeed = function () { return patternFeed.map(function (e) { return Object.assign({ explanation: explainPatternEvent(e.ev), firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt }, e.ev); }); };
window.__drawMiniCandleChart = drawMiniCandleChart; // отладка рендера сетки "Графики" без реальной сети (см. её же комментарий)
window.__drawGraphsLoadingPlaceholder = drawGraphsLoadingPlaceholder;
window.__redrawGraphsGrid = redrawGraphsGrid;
window.__graphsCandlesFor = function (symbol) { return graphsCandles.get(symbol) || null; };
window.__coinFor = function (symbol) { return coinMap.get(symbol) || null; }; // отладка полей монеты (tpm/oi5m/dvol5m/range5m и т.д.)
window.__okxWatchlist = function () { return Array.from(okxWatchlist.keys()); };
window.__okxTier2TradesFor = function (symbol) { return okxTier2Trades.get(symbol) || []; };
window.__okxTier2DepthFor = function (symbol) { return okxTier2Depth.get(symbol) || []; };
window.__okxHandleMessage = handleOkxWsMessage; // отладка разбора сообщений OKX WS без реального сокета
window.__okxTier2Health = okxTier2Health;
window.__okxInstIdToSymbol = okxInstIdToSymbol; // прямая ссылка на Map — можно .set() вручную для отладки без реального сокета
window.__fetchKlines = fetchKlines; // отладка REST-свечей на любой бирже (raw, tf, limit, exchangeId)
window.__bitgetWatchlist = function () { return Array.from(bitgetWatchlist.keys()); };
window.__bitgetTier2TradesFor = function (symbol) { return bitgetTier2Trades.get(symbol) || []; };
window.__bitgetTier2DepthFor = function (symbol) { return bitgetTier2Depth.get(symbol) || []; };
window.__bitgetHandleMessage = handleBitgetWsMessage; // отладка разбора сообщений Bitget WS без реального сокета
window.__bitgetTier2Health = bitgetTier2Health;
window.__bitgetInstIdToSymbol = bitgetInstIdToSymbol;
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
  patternFeed.unshift({ key: ev.symbol + '|' + ev.detectorKey, ev: ev, firstSeenAt: Date.now(), lastSeenAt: Date.now() });
  updatePatternsPage();
  return ev;
};

window.__tableHoverFreeze = function () { return tableHoverFreezeSymbol; };
window.__frozenVisibleSymbols = function () { return frozenVisibleSymbols; };

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
// exchangeId — необязательный ('mexc' по умолчанию, как и раньше): 'binance' переключает Финрез на
// вкладку Binance ПЕРЕД тем, как насыпать туда те же синтетические данные — удобно для ручной
// проверки дизайна/переключателя без реального Binance-ключа.
window.__fakeFinresLogin = function (exchangeId) {
  __designTestMode = true;
  if (exchangeId && exchangeId !== finresActiveExchange) switchFinresExchange(exchangeId);
  if (finresActiveExchange === 'mexc') accountConnected = true;
  else exchangeConnections[finresActiveExchange] = Object.assign({ apiKey: 'fake', apiSecret: 'fake', passphrase: '', connected: true }, exchangeConnections[finresActiveExchange]);
  setAccountStatus('connected');
  renderFinresExchangeTabs();

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
    { asset: 'ETH', qty: 0.8, avgCost: 2200, currentPrice: financeUsdtPrice('ETH') || 2380, costBasis: 1760, value: 1904, unrealizedPnl: 144, unrealizedPct: 8.18 },
    { asset: 'SOL', qty: 10, avgCost: 105, currentPrice: financeUsdtPrice('SOL') || 98, costBasis: 1050, value: 980, unrealizedPnl: -70, unrealizedPct: -6.67 }
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

// Только для ручной проверки "своего графика" (панель инструментов, оси, зум) без реальной сети
// MEXC — реальный REST klines недоступен в песочнице разработки (CORS), а UI-верстку и интеракции
// (перетаскивание осей, глазки-индикаторы, скриншот/fullscreen) всё равно нужно проверять вживую.
// НЕ вызывается production-кодом, ничего не сохраняет между сессиями. Тот же принцип, что и у
// __testJournalChart выше.
window.__testOwnChart = function () {
  // Поля ниже — не только symbol/raw, а всё, что читает updateInfoPanel() (baseAsset/color/price/
  // change24/vol24/vol5/high/low) — она вызывается из общего scheduleRender() на каждый WS-тик,
  // пока currentCoin вообще установлен, независимо от того, какая страница/график сейчас открыты.
  currentCoin = {
    symbol: 'TEST/USDT', raw: 'TESTUSDT', baseAsset: 'TEST', color: '#1E80FF',
    price: 100, change24: 1.23, vol24: 1000000, vol5: 500, high: 107, low: 95
  };
  switchToOwnChartUi();
  rememberChartMode('TEST/USDT', 'own');
  updateToggleChartBtnLabel();
  let price = 100;
  const candles = [];
  const t0 = Date.now() - 300 * 5 * 60000;
  for (let i = 0; i < 300; i++) {
    const o = price;
    price *= 1 + (Math.random() - 0.5) * 0.02;
    const c = price;
    const h = Math.max(o, c) * (1 + Math.random() * 0.008);
    const l = Math.min(o, c) * (1 - Math.random() * 0.008);
    candles.push({ t: t0 + i * 5 * 60000, o: o, h: h, l: l, c: c, v: 1000 + Math.random() * 9000 });
  }
  ownChartCandles = candles;
  ownChartView = { offset: 0, visibleCount: 140 };
  ownChartPriceScaleMult = 1;
  ownChartLoadedRaw = 'TESTUSDT';
  ownChartLoadedTF = currentTF;
  ownChartDrawings = [];
  const canvas = document.getElementById('ownCandleChart');
  const emptyEl = document.getElementById('ownChartEmpty');
  if (emptyEl) emptyEl.style.display = 'none';
  const watermarkEl = document.getElementById('ochartWatermark');
  if (watermarkEl) watermarkEl.textContent = 'TEST/USDT';
  wireOwnChartInteractions(canvas);
  drawCandleChart(canvas, candles);
};

document.getElementById('langToggleLabel').textContent = currentLang === 'en' ? 'EN' : 'RU';
applyStaticI18n();

console.log('Vision Screener запущен (MEXC Spot WS v3, protobuf)');

})();
