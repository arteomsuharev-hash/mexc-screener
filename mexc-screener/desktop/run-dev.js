#!/usr/bin/env node
// Пересобирает desktop-приложение из ТЕКУЩЕГО кода в ../web/ и сразу запускает получившийся
// исполняемый файл — рабочий цикл "поправил код -> запустил один скрипт -> увидел изменения".
//
// ВАЖНО, честно: Neutralino не умеет запускать .exe напрямую с "сырой" (нераспакованной) папкой
// ресурсов — исполняемому файлу обязательно нужен либо встроенный, либо лежащий рядом файл
// resources.neu (проверено экспериментально). Поэтому "запустить exe и увидеть новый код" без
// ПЕРЕСБОРКИ resources.neu невозможно в принципе — но сама пересборка здесь быстрая (не компиляция,
// а просто переупаковка файлов + копирование готовых бинарников движка), обычно 1-3 секунды.
// Этот скрипт делает пересборку и запуск ОДНИМ действием, чтобы это ощущалось как "просто
// перезапустил программу".
//
// Использование:
//   node run-dev.js            (или двойной клик на "update-and-run.bat" в Windows,
//                                либо ./run-dev.sh в macOS/Linux)
//
// Требования: Node.js + Neutralino CLI (npm install -g @neutralinojs/neu), один раз.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = __dirname;
const WEB = path.join(ROOT, '..', 'web');

function syncResourcesFromWeb() {
  const resCss = path.join(ROOT, 'resources', 'css');
  const resJsApp = path.join(ROOT, 'resources', 'js', 'app.js');
  const resJsCore = path.join(ROOT, 'resources', 'js', 'core-utils.js');
  const resJsTerminal = path.join(ROOT, 'resources', 'js', 'terminal.js');
  const resJsFilter2 = path.join(ROOT, 'resources', 'js', 'widget-filter2.js');
  const resIndex = path.join(ROOT, 'resources', 'index.html');
  const resAssets = path.join(ROOT, 'resources', 'assets');
  const webAssets = path.join(WEB, 'assets');

  fs.rmSync(resIndex, { force: true });
  fs.rmSync(resCss, { recursive: true, force: true });
  fs.rmSync(resJsApp, { force: true });
  fs.rmSync(resJsCore, { force: true });
  fs.rmSync(resJsTerminal, { force: true });
  fs.rmSync(resJsFilter2, { force: true });
  fs.rmSync(resAssets, { recursive: true, force: true });
  fs.mkdirSync(resCss, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'resources', 'js'), { recursive: true });
  if (fs.existsSync(webAssets)) fs.cpSync(webAssets, resAssets, { recursive: true });

  let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const marker = '<title>Vision Screener</title>';
  if (!html.includes('/js/neutralino.js')) {
    if (!html.includes(marker)) {
      throw new Error('Не нашёл "' + marker + '" в web/index.html — разметку кто-то поменял, проверьте вручную.');
    }
    html = html.replace(marker, marker + '\n<script src="/js/neutralino.js"></script>');
  }
  fs.writeFileSync(resIndex, html);
  fs.cpSync(path.join(WEB, 'css'), resCss, { recursive: true });
  fs.copyFileSync(path.join(WEB, 'js', 'app.js'), resJsApp);
  fs.copyFileSync(path.join(WEB, 'js', 'core-utils.js'), resJsCore);
  fs.copyFileSync(path.join(WEB, 'js', 'terminal.js'), resJsTerminal);
  fs.copyFileSync(path.join(WEB, 'js', 'widget-filter2.js'), resJsFilter2);
}

function platformBinaryName() {
  if (process.platform === 'win32') return 'mexc-screener-win_x64.exe';
  if (process.platform === 'darwin') return 'mexc-screener-mac_universal';
  return 'mexc-screener-linux_x64';
}

function runNeuBuild() {
  const candidates = [
    { cmd: 'neu', args: ['build', '--release'] },
    { cmd: 'npx', args: ['@neutralinojs/neu', 'build', '--release'] },
  ];
  for (const c of candidates) {
    const res = spawnSync(c.cmd, c.args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (!res.error) return res.status === 0;
  }
  console.error('Не удалось найти Neutralino CLI. Установите: npm install -g @neutralinojs/neu');
  return false;
}

console.log('==> 1/3  Синхронизирую web/ -> desktop/resources/ ...');
syncResourcesFromWeb();

console.log('==> 2/3  Пересобираю (neu build --release)...');
if (!runNeuBuild()) process.exit(1);

const exePath = path.join(ROOT, 'dist', 'mexc-screener', platformBinaryName());
if (!fs.existsSync(exePath)) {
  console.error('Не нашёл собранный файл:', exePath);
  process.exit(1);
}
if (process.platform !== 'win32') {
  try { fs.chmodSync(exePath, 0o755); } catch (e) { /* игнор */ }
}

console.log('==> 3/3  Запускаю', exePath);
const child = spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) });
child.unref();
console.log('Готово — приложение запущено с текущим кодом.');
