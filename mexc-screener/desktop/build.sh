#!/usr/bin/env bash
# Собирает Windows/Mac/Linux desktop-приложение (Neutralino.js) из исходников веб-версии
# (../web/) и (опционально) встраивает получившийся Windows-архив обратно в web/index.html,
# чтобы кнопка «Скачать приложение» внутри самого скринера работала без стороннего хостинга.
#
# Требования:
#   - Node.js + npm
#   - Neutralino CLI: npm install -g @neutralinojs/neu   (или используйте npx, см. NEU ниже)
#   - python (3.x) — на некоторых Windows-машинах команда "python3" в PATH — это заглушка Microsoft
#     Store ("App execution alias"), которая ничего не делает и не является настоящим Python, даже
#     если реальный Python установлен. Поэтому ниже сам подбирает рабочий интерпретатор вместо того,
#     чтобы жёстко звать "python3" — так же, как NEU ниже уже переопределяем через переменную окружения.
#   - zip НЕ требуется — упаковка archив делает сам Python (модуль zipfile), не внешний бинарник,
#     которого в Git Bash на Windows обычно просто нет.
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

# Подбираем рабочий Python: пробуем по очереди и берём первый, который реально печатает версию
# (заглушка Microsoft Store у "python3" завершается с кодом 49 и без вывода — этого достаточно,
# чтобы её отличить от настоящего интерпретатора).
PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for cand in python3 python py; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "print(1)" >/dev/null 2>&1; then
      PYTHON="$cand"
      break
    fi
  done
fi
if [[ -z "$PYTHON" ]]; then
  echo "Не найден рабочий Python (python3/python/py). Установите с https://python.org и убедитесь,"
  echo "что в PATH стоит настоящий интерпретатор, а не заглушка Microsoft Store."
  echo "Либо укажите путь явно: PYTHON=/путь/к/python.exe ./build.sh"
  exit 1
fi
echo "    (использую Python: $($PYTHON --version 2>&1), команда: $PYTHON)"

echo "==> 1/4  Копирую исходники web/ в desktop/resources/ и добавляю мост Neutralino..."
rm -rf resources/index.html resources/css resources/js/app.js resources/js/core-utils.js resources/assets
mkdir -p resources/css resources/js resources/assets
cp ../web/index.html resources/index.html
cp -r ../web/css/. resources/css/
cp ../web/js/app.js resources/js/app.js
cp ../web/js/core-utils.js resources/js/core-utils.js
if [ -d ../web/assets ]; then cp -r ../web/assets/. resources/assets/; fi

# Единственная разница между веб- и desktop-версией разметки: подключение клиентской библиотеки
# Neutralino (resources/js/neutralino.js) — сам JS-код приложения (app.js) уже умеет работать в обоих
# режимах (см. window.Neutralino / nlCall / nativeCurlGet в app.js — progressive enhancement,
# отдельной сборки логики не требуется).
"$PYTHON" - << 'PYEOF'
import re
with open('resources/index.html', encoding='utf-8') as f:
    html = f.read()

# ВАЖНО: ../web/index.html может уже нести встроенный base64 предыдущей сборки (см. шаг --embed
# ниже) — если скопировать его как есть в ресурсы, новый .exe будет содержать внутри себя копию
# самого себя (той предыдущей сборки), новый zip после упаковки — расти на этот же довесок, и при
# каждом следующем "--embed" размер будет примерно УДВАИВАТЬСЯ (реально наблюдалось: 2.7МБ base64 ->
# 5.5МБ после одной лишней пересборки). Поэтому перед копированием в ресурсы всегда вырезаем старый
# встроенный блок — сборка должна идти только от исходников, а не от результата прошлой сборки.
html = re.sub(r'\s*<!-- Десктоп-версия MEXC Screener для Windows.*?-->\s*'
              r'<script type="text/plain" id="desktopAppData">.*?</script>\s*',
              '\n', html, count=1, flags=re.S)
html = re.sub(r'\s*<script type="text/plain" id="desktopAppData">.*?</script>\s*', '\n', html, count=1, flags=re.S)

marker = '<title>Vision Screener</title>'
assert html.count(marker) == 1, 'ожидался ровно один <title>Vision Screener</title>'
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
# Модулем zipfile, а не внешним бинарником "zip" — его в Git Bash на Windows обычно нет вообще.
"$PYTHON" - "$PKG_DIR" << 'PYEOF'
import sys, zipfile, pathlib
pkg_dir = pathlib.Path(sys.argv[1])
out = pathlib.Path('../MEXC-Screener-Windows.zip')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for name in ('MEXC-Screener.exe', 'README.txt', 'start.bat'):
        zf.write(pkg_dir / name, name)
PYEOF
rm -rf "$PKG_DIR"
echo "    -> ../MEXC-Screener-Windows.zip готов."

if [[ "${1:-}" == "--embed" ]]; then
  echo "==> 4/4  Встраиваю ../MEXC-Screener-Windows.zip обратно в ../web/index.html (base64)..."
  "$PYTHON" - << 'PYEOF'
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
