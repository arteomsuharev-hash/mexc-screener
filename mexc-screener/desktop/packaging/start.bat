@echo off
chcp 65001 >nul
setlocal
set "EXE=%~dp0MEXC-Screener.exe"

if not exist "%EXE%" (
  echo Не найден файл MEXC-Screener.exe рядом с этим скриптом.
  echo Убедитесь, что вы распаковали ВЕСЬ архив целиком в одну папку.
  pause
  exit /b 1
)

echo Снимаю блокировку Windows ^(Mark of the Web^) с MEXC-Screener.exe...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath $args[0]" "%EXE%" >nul 2>&1

echo Готово. Запускаю MEXC Screener...
start "" "%EXE%"

timeout /t 2 >nul
endlocal
