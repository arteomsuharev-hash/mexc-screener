// ============================================================================
// TERMINAL MANAGER — открытие монеты из скринера в стороннем торговом терминале.
//
// Архитектура (см. README/CLAUDE-заметки): Ticker -> TerminalManager -> выбранный
// адаптер -> SymbolNormalizer -> реальная попытка открыть символ. Один и тот же путь
// использует и ручной клик по тикеру (Full Mode и Widget Mode — оба вызывают
// MexcTerminal.openSymbol), и Auto Open — никакого отдельного/дублирующего кода открытия.
//
// ЧЕСТНО О ТОМ, ЧТО РЕАЛЬНО ПРОВЕРЕНО (не выдумано):
// - MetaScalp — официальный локальный HTTP API (127.0.0.1:17845-17855, MIT-лицензия,
//   github.com/MetaScalp/metascalp-sdk, доки metascalp.github.io/metascalp-sdk),
//   POST /api/change-ticker реально переключает тикер в открытом окне MetaScalp.
// - Tiger (TigerTrade) — документированный локальный WebSocket (ws://127.0.0.1:7819,
//   команда setLinkSymbol), см. support.tiger.com/english/development-for-tiger.trade-windows/tiger-api.
//   ВЫКЛЮЧЕН по умолчанию — включается в самом TigerTrade: Settings -> Local Signal
//   Server -> Enable Signal Server -> Save. Если сервер выключен/недоступен — это НЕ
//   ошибка приложения, честно откатываемся на запуск/фокус/буфер обмена.
// - Vataga.terminal — ни CLI-флагов, ни URI-схемы, ни локального API не найдено (ни в
//   реестре Windows, ни в её конфигах) — реально возможное: запустить процесс, если не
//   запущен, вывести окно на передний план и положить символ в буфer обмена, чтобы
//   пользователь вставил его сам (Ctrl+V). Это НЕ имитация автонавигации — OpenResult
//   честно говорит symbolNavigated=false для этого случая.
//
// Всё, что реально умеет запускать процессы/фокусировать окна на Windows, идёт через
// уже существующий в app.js мост nlCall('os.execCommand', ...) — тот же обходной путь,
// которым весь остальной код этого приложения уже пользуется вместо сломанного штатного
// Neutralino.os.execCommand() (см. комментарий у nlBridgeConnect в app.js). В веб-версии
// (без window.Neutralino) запуск процессов невозможен в принципе — тогда остаётся честно
// доступное: копирование в буфер обмена.
// ============================================================================
(function (global) {
  'use strict';

  // -- Разбор внутреннего формата символа скринера ("BTC/USDT" для MEXC, "BINANCE:CREAM/USDT"
  // для остальных бирж — см. exchangeOfSymbol/rawSymbol в app.js, та же логика продублирована
  // тут намеренно в одну строку каждая, чтобы этот модуль не зависел от порядка загрузки
  // относительно app.js — сам формат уже "заморожен" и одинаков по всему проекту). --
  function parseScreenerSymbol(sym) {
    const s = String(sym || '');
    const m = s.match(/^([A-Z]+):(.+)$/);
    const exchange = m ? m[1] : 'MEXC';
    const pair = m ? m[2] : s;
    const bare = pair.replace(/[/\-]/g, '').toUpperCase();
    return { exchange: exchange, pair: pair, bare: bare };
  }

  // ------------------------------------------------------------------------
  // SymbolNormalizer — единственное место, где решается, как символ должен выглядеть
  // для конкретного терминала. Подтверждено источником только для Tiger (см. ниже);
  // MetaScalp и Vataga формата не диктуют — им отдаём "голый" тикер без придуманного
  // форматирования.
  // ------------------------------------------------------------------------
  const TIGER_EXCHANGE_PREFIX = {
    MEXC: 'MEXC', BINANCE: 'BINANCE', BINANCEFUT: 'BINANCE', OKX: 'OKX', BITGET: 'BITGET',
    KUCOIN: 'KUCOIN', BINGX: 'BINGX', ASTER: 'ASTER', ASTERFUT: 'ASTER', GATEIO: 'GATEIO'
  };
  // Подтверждено из TigerTrade.exe.config (комментарии symbolDepthSection несут реальные примеры
  // "BINANCE:BTCUSDT", "BINANCE-FUT:BTCUSDT") — единственная биржа с отдельным кодом на фьючерсы.
  const TIGER_FUTURES_EXCHANGE_OVERRIDE = { BINANCEFUT: 'BINANCE-FUT', ASTERFUT: 'ASTER-FUT' };

  const METASCALP_EXCHANGE_NAME = {
    MEXC: 'MEXC', BINANCE: 'BINANCE', BINANCEFUT: 'BINANCE', OKX: 'OKX', BITGET: 'BITGET',
    KUCOIN: 'KUCOIN', BINGX: 'BINGX', ASTER: 'ASTERDEX', ASTERFUT: 'ASTERDEX'
    // GATEIO сюда намеренно не включён — MetaScalp такой биржи не документирует.
  };

  const SymbolNormalizer = {
    // Для буфера обмена / общего отображения — просто голый тикер без разделителей.
    bare: function (screenerSymbol) { return parseScreenerSymbol(screenerSymbol).bare; },
    exchange: function (screenerSymbol) { return parseScreenerSymbol(screenerSymbol).exchange; },
    isFutures: function (screenerSymbol) { return /FUT$/.test(parseScreenerSymbol(screenerSymbol).exchange); },
    forTiger: function (screenerSymbol) {
      const p = parseScreenerSymbol(screenerSymbol);
      const prefix = TIGER_EXCHANGE_PREFIX[p.exchange] || p.exchange;
      return prefix + ':' + p.bare;
    },
    metascalpExchangeName: function (screenerSymbol) {
      const p = parseScreenerSymbol(screenerSymbol);
      return METASCALP_EXCHANGE_NAME[p.exchange] || null;
    },
    tigerExchangeCode: function (screenerSymbol, market) {
      const p = parseScreenerSymbol(screenerSymbol);
      if (market === 'FUTURES' && TIGER_FUTURES_EXCHANGE_OVERRIDE[p.exchange]) return TIGER_FUTURES_EXCHANGE_OVERRIDE[p.exchange];
      return TIGER_EXCHANGE_PREFIX[p.exchange] || p.exchange;
    }
  };

  // ------------------------------------------------------------------------
  // Cooldown / duplicate-protection — используется и Auto Open (см. app.js), и (опционально)
  // может переиспользоваться где угодно ещё, где нужна защита "не чаще, чем раз в N секунд
  // на один и тот же ключ". Ручные клики по тикеру через это НЕ проходят намеренно — если
  // человек кликнул специально, второй раз подряд, это должно сработать каждый раз.
  // ------------------------------------------------------------------------
  function CooldownManager(cooldownSec) {
    this.cooldownSec = cooldownSec || 0;
    this._last = new Map();
  }
  CooldownManager.prototype.allow = function (key, now) {
    now = now == null ? Date.now() : now;
    const last = this._last.get(key) || 0;
    if (now - last < this.cooldownSec * 1000) return false;
    this._last.set(key, now);
    return true;
  };
  CooldownManager.prototype.reset = function (key) { this._last.delete(key); };

  // ------------------------------------------------------------------------
  // OS-уровень: запуск процесса, проверка "уже запущен ли", вывод окна на передний план.
  // Реализовано ЕДИНЫМ PowerShell-скриптом за один вызов nlCall('os.execCommand', ...) —
  // дешевле и надёжнее, чем несколько раундтрипов. Логика вывода окна на передний план
  // (AttachThreadInput-манёвр) — стандартный обход ограничения Windows на
  // SetForegroundWindow из процесса, который сейчас не в фокусе; без него скрытый вызов
  // просто молча не сработал бы в большинстве случаев.
  // ------------------------------------------------------------------------
  function psEscape(str) { return String(str).replace(/'/g, "''"); }

  function buildLaunchFocusScript(exePath, exeNameNoExt) {
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$exePath = '" + psEscape(exePath) + "'",
      "$procName = '" + psEscape(exeNameNoExt) + "'",
      "$result = @{ installed = $false; running = $false; launched = $false; focused = $false }",
      "if (Test-Path -LiteralPath $exePath) {",
      "  $result.installed = $true",
      "  $proc = Get-Process -Name $procName | Select-Object -First 1",
      "  if (-not $proc) {",
      "    try { Start-Process -FilePath $exePath -WorkingDirectory (Split-Path $exePath); $result.launched = $true } catch {}",
      "    $deadline = (Get-Date).AddSeconds(8)",
      "    while ((Get-Date) -lt $deadline -and -not $proc) {",
      "      Start-Sleep -Milliseconds 300",
      "      $proc = Get-Process -Name $procName | Select-Object -First 1",
      "    }",
      "  }",
      "  if ($proc) {",
      "    $result.running = $true",
      "    Add-Type -Namespace W -Name U -MemberDefinition '",
      "      [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
      "      [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
      "      [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
      "      [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "      [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
      "      [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);",
      "      [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
      "    '",
      "    $proc.Refresh(); $hwnd = $proc.MainWindowHandle",
      "    if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500; $proc.Refresh(); $hwnd = $proc.MainWindowHandle }",
      "    if ($hwnd -ne [IntPtr]::Zero) {",
      "      if ([W.U]::IsIconic($hwnd)) { [W.U]::ShowWindow($hwnd, 9) | Out-Null }",
      "      $fg = [W.U]::GetForegroundWindow(); $cur = [W.U]::GetCurrentThreadId(); $dummy = 0",
      "      $fgThread = if ($fg -ne [IntPtr]::Zero) { [W.U]::GetWindowThreadProcessId($fg, [ref]$dummy) } else { 0 }",
      "      $targetThread = [W.U]::GetWindowThreadProcessId($hwnd, [ref]$dummy)",
      "      $attached = @()",
      "      try {",
      "        if ($fgThread -ne 0 -and $fgThread -ne $cur) { [W.U]::AttachThreadInput($cur, $fgThread, $true) | Out-Null; $attached += $fgThread }",
      "        if ($targetThread -ne 0 -and $targetThread -ne $cur -and $attached -notcontains $targetThread) { [W.U]::AttachThreadInput($cur, $targetThread, $true) | Out-Null; $attached += $targetThread }",
      "        [W.U]::SetForegroundWindow($hwnd) | Out-Null",
      "      } finally { foreach ($t in $attached) { [W.U]::AttachThreadInput($cur, $t, $false) | Out-Null } }",
      "      Start-Sleep -Milliseconds 80",
      "      $result.focused = ([W.U]::GetForegroundWindow() -eq $hwnd)",
      "    }",
      "  }",
      "}",
      "$result | ConvertTo-Json -Compress"
    ].join("\n");
  }

  // Полная строка "powershell ... -EncodedCommand <base64>" для реального скрипта (с Add-Type/
  // P-Invoke блоком) выходит за ~8300 символов — ПОДТВЕРЖДЕНО живым тестом, что это реально
  // обрезает командную строку там, где Neutralino.os.execCommand на Windows прогоняет её через
  // cmd.exe (лимит там ~8191 символ): PowerShell получал битый/обрезанный скрипт и молча
  // выполнял его как есть (Test-Path на пустом/неверном $exePath просто возвращал false, без
  // видимой ошибки). Обход — писать скрипт во временный .ps1-файл и звать его через -File
  // (сама командная строка тогда — только путь к файлу, коротко, лимит больше не грозит).
  const PS_TEMP_SCRIPT_NAME = 'mexc_screener_terminal_focus.ps1';
  let _psTempDir = null;
  async function getPsTempDir() {
    if (_psTempDir) return _psTempDir;
    try {
      const v = await global.window.nlCall('os.getEnv', { key: 'TEMP' }, 5000);
      _psTempDir = v || 'C:\\Windows\\Temp';
    } catch (e) { _psTempDir = 'C:\\Windows\\Temp'; }
    return _psTempDir;
  }

  async function launchAndFocusExe(exePath, exeNameNoExt) {
    if (!global.window || !global.window.Neutralino || typeof global.window.nlCall !== 'function') {
      return { installed: null, running: false, launched: false, focused: false, unavailable: true };
    }
    const script = buildLaunchFocusScript(exePath, exeNameNoExt);
    try {
      const tempDir = await getPsTempDir();
      const scriptPath = tempDir.replace(/\\$/, '') + '\\' + PS_TEMP_SCRIPT_NAME;
      await global.window.nlCall('filesystem.writeFile', { path: scriptPath, data: script }, 5000);
      const command = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + scriptPath + '"';
      const res = await global.window.nlCall('os.execCommand', { command: command }, 15000);
      const out = (res && res.stdOut) ? res.stdOut.trim() : '';
      const parsed = out ? JSON.parse(out) : {};
      return {
        installed: !!parsed.installed, running: !!parsed.running,
        launched: !!parsed.launched, focused: !!parsed.focused, unavailable: false
      };
    } catch (e) {
      return { installed: null, running: false, launched: false, focused: false, unavailable: true, error: String(e && e.message || e) };
    }
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* попробуем fallback ниже */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------------------
  // OpenResult — единый формат ответа для любого адаптера. Ничего не "додумывает":
  // symbolNavigated=true ставится ТОЛЬКО когда реально подтверждён программный переход
  // (MetaScalp API 200 OK / Tiger WS отправлен успешно), а не когда просто запущен процесс.
  // ------------------------------------------------------------------------
  function OpenResult(success, launched, focused, symbolNavigated, clipboardCopied, message) {
    return { success: success, launched: launched, focused: focused, symbolNavigated: symbolNavigated, clipboardCopied: clipboardCopied, message: message };
  }

  // Общая заглушка для терминалов без известного API — запустить/сфокусировать + скопировать
  // символ в буфер. Используется Vataga всегда, а MetaScalp/Tiger — когда их API недоступен.
  async function processFallbackOpen(displayName, exePath, exeNameNoExt, bareSymbol) {
    const osResult = await launchAndFocusExe(exePath, exeNameNoExt);
    const clipboardCopied = await copyToClipboard(bareSymbol);

    if (osResult.unavailable) {
      const msg = clipboardCopied
        ? 'Автозапуск ' + displayName + ' доступен только в desktop-версии приложения. Символ «' + bareSymbol + '» скопирован в буфер обмена — вставьте вручную (Ctrl+V).'
        : 'Автозапуск ' + displayName + ' доступен только в desktop-версии приложения.';
      return OpenResult(clipboardCopied, false, false, false, clipboardCopied, msg);
    }
    if (osResult.installed === false) {
      return OpenResult(false, false, false, false, false, displayName + ' не найден по пути ' + exePath + '. Проверьте, что терминал установлен.');
    }
    if (!osResult.running) {
      return OpenResult(false, false, false, false, clipboardCopied, 'Не удалось запустить ' + displayName + '.');
    }
    const baseMsg = osResult.launched ? displayName + ' запущен.'
      : (osResult.focused ? displayName + ' открыт (окно на переднем плане).' : displayName + ' уже запущен, но окно не удалось вывести на передний план.');
    const msg = clipboardCopied
      ? baseMsg + ' Символ «' + bareSymbol + '» скопирован в буфер обмена — автонавигация этим терминалом не поддерживается, вставьте вручную (Ctrl+V) в поиск.'
      : baseMsg;
    return OpenResult(true, osResult.launched, osResult.focused, false, clipboardCopied, msg);
  }

  // ------------------------------------------------------------------------
  // MetaScalpAdapter — официальный локальный HTTP API.
  // ------------------------------------------------------------------------
  const METASCALP_PORT_RANGE = [17845, 17846, 17847, 17848, 17849, 17850, 17851, 17852, 17853, 17854, 17855];
  const METASCALP_TIMEOUT_MS = 1500;

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(function () { clearTimeout(timer); });
  }

  async function discoverMetaScalpPort() {
    const attempts = METASCALP_PORT_RANGE.map(async function (port) {
      try {
        const resp = await fetchWithTimeout('http://127.0.0.1:' + port + '/ping', {}, METASCALP_TIMEOUT_MS);
        if (!resp.ok) return null;
        const data = await resp.json();
        // Разные версии MetaScalp по-разному называли поле в /ping ("app" — подтверждено вживую
        // на реальном инстансе; "appName" — по официальной документации SDK) — принимаем оба.
        return (data && (data.app === 'MetaScalp' || data.appName === 'MetaScalp')) ? port : null;
      } catch (e) { return null; }
    });
    const results = await Promise.all(attempts);
    return results.find(function (p) { return p != null; }) || null;
  }

  // GET /api/connections — список РЕАЛЬНО подключённых у пользователя бирж (id/name/exchange/
  // market/state), см. metascalp.github.io/metascalp-sdk. state: 0=Disconnected, 1=Connecting,
  // 2=Connected, 3=Reconnecting, 4=Resetting — отсекаем только точно отключённые (0), остальное
  // (включая неизвестный формат state у более старых версий) считаем потенциально рабочим.
  async function metascalpListConnections(port) {
    try {
      const resp = await fetchWithTimeout('http://127.0.0.1:' + port + '/api/connections', {}, METASCALP_TIMEOUT_MS);
      if (!resp.ok) return [];
      const data = await resp.json();
      const list = Array.isArray(data) ? data : (data && data.connections) || [];
      // Реально подтверждённый вживую ответ MetaScalp — PascalCase (Exchange/Market/Name/State),
      // а не lowercase из публичной документации — читаем оба варианта на случай разных версий.
      return list.filter(function (c) { const st = c && (c.State !== undefined ? c.State : c.state); return st !== 0; });
    } catch (e) { return []; }
  }
  function connExchange(c) { return c && (c.Exchange !== undefined ? c.Exchange : c.exchange); }
  function connMarket(c) { return c && (c.Market !== undefined ? c.Market : c.market); }
  function connName(c) { return c && (c.Name !== undefined ? c.Name : c.name); }

  // POST /api/change-ticker, явный формат {exchange, market, ticker, binding} — нацелен на
  // КОНКРЕТНОЕ подключение (из /api/connections), а не на "угаданный" TickerPattern-паттерн.
  async function metascalpChangeTickerByConnection(port, exchange, market, ticker, binding) {
    const body = { exchange: exchange, market: market, ticker: ticker };
    if (binding) body.binding = binding;
    const resp = await fetchWithTimeout('http://127.0.0.1:' + port + '/api/change-ticker', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, METASCALP_TIMEOUT_MS);
    let payload = null;
    try { payload = await resp.json(); } catch (e) { /* тело могло быть пустым */ }
    return { ok: resp.ok, status: resp.status, payload: payload };
  }

  // Старый путь через TickerPattern ("EXCHANGE:SYMBOL[.p]") — fallback для версий MetaScalp без
  // /api/connections (либо если сейчас нет ни одного активного подключения).
  async function metascalpChangeTickerLegacy(port, pattern, binding) {
    const body = { TickerPattern: pattern };
    if (binding) body.Binding = binding;
    const resp = await fetchWithTimeout('http://127.0.0.1:' + port + '/api/change-ticker', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, METASCALP_TIMEOUT_MS);
    let payload = null;
    try { payload = await resp.json(); } catch (e) {}
    return { ok: resp.ok, status: resp.status, payload: payload };
  }
  async function metascalpApiOpenLegacy(port, bare, exchangeName, binding) {
    const basePattern = exchangeName ? (exchangeName + ':' + bare) : bare;
    const patterns = [basePattern, basePattern + '.p'];
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      let res;
      try {
        res = await metascalpChangeTickerLegacy(port, pattern, binding);
      } catch (e) {
        return { success: false, port: port, message: 'Запрос к MetaScalp API не удался: ' + (e && e.message || e) };
      }
      if (res.ok) return { success: true, port: port, message: 'MetaScalp переключён на ' + pattern + ' через API.' };
      const error = (res.payload && (res.payload.error || res.payload.Error)) || ('HTTP ' + res.status);
      if (String(error).indexOf('No connection found') === -1 || pattern.endsWith('.p')) {
        return { success: false, port: port, message: 'MetaScalp API отклонил запрос (' + res.status + '): ' + error };
      }
    }
    return { success: false, port: port, message: 'MetaScalp API: не найдено подключение ни спот, ни фьючерс.' };
  }

  // Основной путь: находим РЕАЛЬНЫЕ подключения пользователя и открываем тикер на них напрямую
  // (никаких угаданных названий бирж). Рассылаем ПО ВСЕМ живым подключениям ВСЕГДА, вне
  // зависимости от того, задан ли Binding:
  // - без Binding каждый вызов независимо обновляет "активную" панель СВОЕГО подключения — это
  //   подтверждено вживую (см. скриншот пользователя: 11 панелей на разных биржах, у каждой свой
  //   УНИКАЛЬНЫЙ Link, одновременно показывают одну монету без общей группы) — "активное окно" у
  //   MetaScalp оказалось привязано К КАЖДОМУ подключению отдельно, а не одно на всё приложение;
  // - с Binding те же вызовы ЕЩЁ и синхронизируют панели, которые пользователь сам объединил в эту
  //   Link-группу (тогда они начинают зеркалить друг друга, включая биржу — это отдельная функция,
  //   которую можно использовать по желанию, а не единственный способ открыть на нескольких биржах).
  // ViewMode:true подключения (просмотровые/демо, без своей активной панели — подтверждено вживую:
  // "No connection found" на Bybit Spot/Perp и OKX, у которых ViewMode=true) пропускаем сразу.
  async function metascalpApiOpen(screenerSymbol, binding) {
    const port = await discoverMetaScalpPort();
    if (port == null) return { success: false, port: null, message: 'MetaScalp API не отвечает ни на одном порту 17845-17855.' };

    const bare = SymbolNormalizer.bare(screenerSymbol);
    const detectedExchangeName = SymbolNormalizer.metascalpExchangeName(screenerSymbol);
    const allConnections = await metascalpListConnections(port);
    const connections = allConnections.filter(function (c) { return c && c.ViewMode !== true && c.viewMode !== true; });

    if (!connections.length) return metascalpApiOpenLegacy(port, bare, detectedExchangeName, binding);

    const targets = connections;
    const results = await Promise.all(targets.map(function (c) {
      return metascalpChangeTickerByConnection(port, connExchange(c), connMarket(c), bare, binding)
        .then(function (r) { return Object.assign({ conn: c }, r); })
        .catch(function (e) { return { conn: c, ok: false, status: 0, payload: { error: String(e && e.message || e) } }; });
    }));
    const succeeded = results.filter(function (r) { return r.ok; });

    if (!succeeded.length) {
      const firstErr = results[0] && results[0].payload && (results[0].payload.error || results[0].payload.Error);
      return { success: false, port: port, message: 'MetaScalp: тикер ' + bare + ' не найден ни на одном из ' + targets.length + ' подключений' + (firstErr ? ' (' + firstErr + ')' : '') + '.' };
    }
    const names = succeeded.map(function (r) { return connName(r.conn) || (connExchange(r.conn) + ' ' + connMarket(r.conn)); }).join(', ');
    return { success: true, port: port, message: 'MetaScalp: ' + bare + ' открыт (' + succeeded.length + '/' + targets.length + '): ' + names + '.' };
  }

  async function metascalpOpen(screenerSymbol, binding) {
    const apiResult = await metascalpApiOpen(screenerSymbol, binding);
    if (apiResult.success) return OpenResult(true, false, false, true, false, apiResult.message);
    if (apiResult.port != null) {
      // MetaScalp запущен и ответил — это настоящий отказ (плохой тикер/нет подключения), а не
      // "недоступен". Показываем как есть, не маскируем откатом на буфер обмена.
      return OpenResult(false, false, true, false, false, apiResult.message);
    }
    return processFallbackOpen('MetaScalp', TERMINAL_PATHS.metascalp.exePathFn(), 'MetaScalp', SymbolNormalizer.bare(screenerSymbol));
  }

  // ------------------------------------------------------------------------
  // MetaScalp "Комбо-окно" — родная функция самого MetaScalp, открывающая отдельное окно с
  // докингом стаканов сразу по многим биржам. Не задокументирована в публичном SDK, но РЕАЛЬНО
  // СУЩЕСТВУЕТ и подтверждена вживую: POST /api/combo с телом {Ticker: "SYMBOL"} — обнаружено
  // через сетевые запросы у эталонного конкурента (oculusdei.pro, тот же порт 127.0.0.1:17845-
  // 17855). ВАЖНО (тоже подтверждено вживую, методом проб): в отличие от /api/change-ticker,
  // сюда НЕ нужен ни префикс биржи ("MEXC:"), ни суффикс рынка (".p") — голый тикер вида
  // "BTCUSDT", а MetaScalp сам находит и открывает панели по всем подключениям, где такая пара
  // реально торгуется. С префиксом/суффиксом реальный тест дал честный отказ: "Combo not opened.
  // Rejected tickers: Gate:MAXUSDT.p, ...". Таймаут выше обычного (открытие окна медленнее
  // простого переключения тикера). Никаких хоткеев/фокуса окна/курсора не требуется.
  const METASCALP_COMBO_TIMEOUT_MS = 5000;
  async function metascalpComboOpen(screenerSymbol) {
    const port = await discoverMetaScalpPort();
    if (port == null) return OpenResult(false, false, false, false, false, 'MetaScalp API не отвечает ни на одном порту 17845-17855.');

    const bare = SymbolNormalizer.bare(screenerSymbol);
    const payload = { Ticker: bare };

    let resp;
    try {
      resp = await fetchWithTimeout('http://127.0.0.1:' + port + '/api/combo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }, METASCALP_COMBO_TIMEOUT_MS);
    } catch (e) {
      return OpenResult(false, false, false, false, false, 'Запрос комбо-окна к MetaScalp не удался: ' + (e && e.message || e));
    }
    let data = null;
    try { data = await resp.json(); } catch (e) {}
    if (!resp.ok) {
      const err = (data && (data.error || data.Error)) || ('HTTP ' + resp.status);
      return OpenResult(false, false, false, false, false, 'MetaScalp API (комбо-окно) отклонил запрос: ' + err);
    }
    return OpenResult(true, false, false, true, false, 'MetaScalp: комбо-окно для ' + bare + ' открыто.');
  }

  // ------------------------------------------------------------------------
  // TigerAdapter — документированный локальный WebSocket API (по умолчанию выключен).
  // ------------------------------------------------------------------------
  const TIGER_WS_URL = 'ws://127.0.0.1:7819';
  const TIGER_TIMEOUT_MS = 3000;

  function tigerSetLinkSymbol(exchangeCode, market, bareSymbol, linkGroup) {
    return new Promise(function (resolve) {
      let ws;
      let settled = false;
      const finish = function (result) { if (!settled) { settled = true; try { ws && ws.close(); } catch (e) {} resolve(result); } };
      const timer = setTimeout(function () { finish({ success: false, unreachable: true, message: 'Tiger API (ws://127.0.0.1:7819) не ответил за ' + (TIGER_TIMEOUT_MS / 1000) + 'с.' }); }, TIGER_TIMEOUT_MS);
      try {
        ws = new WebSocket(TIGER_WS_URL);
      } catch (e) {
        clearTimeout(timer);
        finish({ success: false, unreachable: true, message: 'Tiger API (ws://127.0.0.1:7819) недоступен.' });
        return;
      }
      ws.onopen = function () {
        try {
          ws.send(JSON.stringify({ type: 'setLinkSymbol', e: exchangeCode, m: market, symbol: bareSymbol, linkGroup: linkGroup }));
        } catch (e) {
          clearTimeout(timer);
          finish({ success: false, unreachable: false, message: 'Tiger API: не удалось отправить команду: ' + e.message });
          return;
        }
        clearTimeout(timer);
        finish({ success: true, unreachable: false, message: 'Tiger: setLinkSymbol ' + exchangeCode + '/' + market + '/' + bareSymbol + ' (linkGroup ' + linkGroup + ') отправлен.' });
      };
      ws.onerror = function () {
        clearTimeout(timer);
        finish({
          success: false, unreachable: true,
          message: 'Tiger API (ws://127.0.0.1:7819) недоступен. Включите в TigerTrade: Settings -> Local Signal Server -> Enable Signal Server -> Save.'
        });
      };
    });
  }

  async function tigerOpen(screenerSymbol, linkGroup) {
    linkGroup = linkGroup || 'A';
    const wantsFutures = SymbolNormalizer.isFutures(screenerSymbol);
    const market1 = wantsFutures ? 'FUTURES' : 'SPOT';
    const market2 = wantsFutures ? 'SPOT' : 'FUTURES';
    const bare = SymbolNormalizer.bare(screenerSymbol);

    let result = await tigerSetLinkSymbol(SymbolNormalizer.tigerExchangeCode(screenerSymbol, market1), market1, bare, linkGroup);
    if (!result.success && !result.unreachable) {
      // сервер ответил отказом (не launched) — пробуем второй тип рынка на всякий случай,
      // так же как MetaScalp-адаптер пробует спот/фьючерс.
      result = await tigerSetLinkSymbol(SymbolNormalizer.tigerExchangeCode(screenerSymbol, market2), market2, bare, linkGroup);
    }
    if (result.success) return OpenResult(true, false, false, true, false, result.message);
    if (!result.unreachable) return OpenResult(false, false, true, false, false, result.message);
    return processFallbackOpen('Tiger', TERMINAL_PATHS.tiger.exePathFn(), 'TigerTrade', bare);
  }

  // ------------------------------------------------------------------------
  // VatagaAdapter — API не найден (см. шапку файла), только запуск/фокус/буфер обмена.
  // ------------------------------------------------------------------------
  async function vatagaOpen(screenerSymbol) {
    return processFallbackOpen('Vataga', TERMINAL_PATHS.vataga.exePathFn(), 'Vataga.terminal', SymbolNormalizer.bare(screenerSymbol));
  }

  // ------------------------------------------------------------------------
  // Пути к исполняемым файлам. LOCALAPPDATA для MetaScalp подставляется динамически через
  // окружение процесса (не гадаем расположение профиля пользователя) — те же переменные,
  // что реально стоят на этой машине (см. аудит: C:\Users\<user>\AppData\Local\MetaScalp\...).
  // ------------------------------------------------------------------------
  let _localAppData = null;
  async function getLocalAppData() {
    if (_localAppData) return _localAppData;
    if (!global.window || !global.window.Neutralino || typeof global.window.nlCall !== 'function') return 'C:\\Users\\Public\\AppData\\Local';
    try {
      const v = await global.window.nlCall('os.getEnv', { key: 'LOCALAPPDATA' }, 5000);
      _localAppData = v || 'C:\\Users\\Public\\AppData\\Local';
    } catch (e) { _localAppData = 'C:\\Users\\Public\\AppData\\Local'; }
    return _localAppData;
  }
  // exePathFn читается синхронно из кэша _localAppData (прогревается заранее в openSymbol) —
  // чтобы не тащить async через все адаптеры только ради одного пути.
  const TERMINAL_PATHS = {
    metascalp: { displayName: 'MetaScalp', exePathFn: function () { return (_localAppData || 'C:\\Users\\Public\\AppData\\Local') + '\\MetaScalp\\current\\MetaScalp.exe'; } },
    vataga: { displayName: 'Vataga', exePathFn: function () { return 'C:\\Program Files\\Vataga\\Vataga.terminal\\Vataga.terminal.exe'; } },
    tiger: { displayName: 'Tiger', exePathFn: function () { return 'C:\\Program Files (x86)\\TigerTrade\\TigerTrade.exe'; } }
  };

  const ADAPTERS = {
    metascalp: function (symbol, binding) { return metascalpOpen(symbol, binding); },
    vataga: function (symbol) { return vatagaOpen(symbol); },
    tiger: function (symbol, binding) { return tigerOpen(symbol, binding); }
  };

  // ------------------------------------------------------------------------
  // TerminalManager — единая точка входа. И ручной клик по тикеру (Full/Widget Mode), и
  // Auto Open идут ТОЛЬКО через openSymbol ниже — см. её вызовы в app.js.
  // ------------------------------------------------------------------------
  async function openSymbol(terminalKey, screenerSymbol, binding) {
    await getLocalAppData(); // прогреваем кэш пути MetaScalp перед вызовом адаптера
    const adapter = ADAPTERS[terminalKey];
    if (!adapter) return OpenResult(false, false, false, false, false, 'Терминал «' + terminalKey + '» не поддерживается.');
    try {
      return await adapter(screenerSymbol, binding);
    } catch (e) {
      return OpenResult(false, false, false, false, false, 'Непредвиденная ошибка при открытии в терминале: ' + (e && e.message || e));
    }
  }

  function terminalDisplayName(terminalKey) {
    const t = TERMINAL_PATHS[terminalKey];
    return t ? t.displayName : terminalKey;
  }

  global.MexcTerminal = {
    TERMINAL_KEYS: ['metascalp', 'vataga', 'tiger'],
    displayName: terminalDisplayName,
    openSymbol: openSymbol,
    openMetaScalpCombo: function (screenerSymbol) {
      return getLocalAppData().then(function () { return metascalpComboOpen(screenerSymbol); });
    },
    SymbolNormalizer: SymbolNormalizer,
    CooldownManager: CooldownManager
  };
})(window);
