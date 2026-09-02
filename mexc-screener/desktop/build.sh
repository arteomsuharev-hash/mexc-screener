#!/usr/bin/env bash
# Собирает Windows/Mac/Linux desktop-приложение (Neutralino.js) из исходников веб-версии
# (../web/) и (опционально) встраивает получившийся Windows-архив обратно в web/index.html,
# чтобы кнопка «Скачать приложение» внутри самого скринера работала без стороннего хостинга.
#
# Требования:
#   - Node.js + npm
#   - Neutralino CLI: npm install -g @neutralinojs/neu   (или используйте npx, см. NEU ниже)
#   - python3
#
# Использование:
#   cd desktop
#   ./build.sh              # собрать десктоп-приложение (без встраивания в web/index.html)
#   ./build.sh --embed      # собрать И встроить итоговый zip в ../web/index.html
set -euo pipefail
cd "$(dirname "$0")"

NEU="${NEU:-neu}"
if ! command -v "$NEU" >/dev/null 2>&1; then
  echo "Не найден 'neu' в PATH. Установите: npm install -g @neutralinojs/neu"
  echo "Либо используйте npx: NEU='npx @neutralinojs/neu' ./build.sh"
  exit 1
fi

echo "==> 1/4  Копирую исходники web/ в desktop/resources/ и добавляю мост Neutralino..."
rm -rf resources/index.html resources/css resources/js/app.js resources/js/core-utils.js
mkdir -p resources/css resources/js
cp ../web/index.html resources/index.html
cp -r ../web/css/. resources/css/
cp ../web/js/app.js resources/js/app.js
cp ../web/js/core-utils.js resources/js/core-utils.js

# Единственная разница между веб- и desktop-версией разметки: подключение клиентской библиотеки
# Neutralino (resources/js/neutralino.js) — сам JS-код приложения (app.js) уже умеет работать в обоих
# режимах (см. window.Neutralino / nlCall / nativeCurlGet в app.js — progressive enhancement,
# отдельной сборки логики не требуется).
python3 - << 'PYEOF'
import re
with open('resources/index.html', encoding='utf-8') as f:
    html = f.read()
marker = '<title>MEXC Screener</title>'
assert html.count(marker) == 1, 'ожидался ровно один <title>MEXC Screener</title>'
html = html.replace(marker, marker + '\n<script src="/js/neutralino.js"></script>', 1)
with open('resources/index.html', 'w', encoding='utf-8') as f:
    f.write(html)
PYEOF

echo "==> 2/4  Собираю приложение (neu build --release --embed-resources)..."
rm -rf dist
$NEU build --release --embed-resources

echo "==> 3/4  Упаковываю Windows-версию в MEXC-Screener-Windows.zip (exe + инструкция + анти-блокировщик)..."
PKG_DIR="$(mktemp -d)"
cp dist/mexc-screener/mexc-screener-win_x64.exe "$PKG_DIR/MEXC-Screener.exe"
cp packaging/README.txt "$PKG_DIR/README.txt"
cp packaging/start.bat "$PKG_DIR/start.bat"
rm -f ../MEXC-Screener-Windows.zip
(cd "$PKG_DIR" && zip -X ../MEXC-Screener-Windows.zip.tmp MEXC-Screener.exe README.txt start.bat >/dev/null)
mv "$PKG_DIR/../MEXC-Screener-Windows.zip.tmp" ../MEXC-Screener-Windows.zip
rm -rf "$PKG_DIR"
echo "    -> ../MEXC-Screener-Windows.zip готов."

if [[ "${1:-}" == "--embed" ]]; then
  echo "==> 4/4  Встраиваю ../MEXC-Screener-Windows.zip обратно в ../web/index.html (base64)..."
  python3 - << 'PYEOF'
import re, base64
with open('../web/index.html', encoding='utf-8') as f:
    html = f.read()
with open('../MEXC-Screener-Windows.zip', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')

comment = ('<!-- Десктоп-версия MEXC Screener для Windows, встроена как base64, чтобы кнопка '
           '"Скачать приложение"\n     в боковой панели работала прямо из этого файла, без внешнего '
           'хостинга. -->\n')
tag = '<script type="text/plain" id="desktopAppData">' + b64 + '</script>\n'

if '<script type="text/plain" id="desktopAppData">' in html:
    html = re.sub(r'<script type="text/plain" id="desktopAppData">.*?</script>\s*',
                   tag, html, count=1, flags=re.S)
else:
    html = html.replace('</body>', comment + tag + '</body>', 1)

with open('../web/index.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('Встроено:', len(b64), 'символов base64')
PYEOF
  echo "    -> ../web/index.html обновлён (кнопка «Скачать приложение» теперь работает)."
else
  echo "==> 4/4  Пропущено (запустите с флагом --embed, если нужно встроить архив в web/index.html)."
fi

echo "Готово."
