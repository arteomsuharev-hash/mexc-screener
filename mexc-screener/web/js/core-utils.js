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

  return {
    logRing: logRing,
    pushLogRing: pushLogRing,
    logD: logD,
    logI: logI,
    logW: logW,
    logE: logE,
    withRetry: withRetry,
    computeApiKeyFingerprint: computeApiKeyFingerprint
  };
});
