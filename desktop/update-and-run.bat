@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Не найден Node.js. Установите с https://nodejs.org и запустите этот файл ещё раз.
  pause
  exit /b 1
)

where neu >nul 2>&1
if errorlevel 1 (
  echo Не найден Neutralino CLI. Устанавливаю один раз: npm install -g @neutralinojs/neu
  call npm install -g @neutralinojs/neu
  if errorlevel 1 (
    echo Не удалось установить @neutralinojs/neu. Установите вручную и запустите этот файл снова.
    pause
    exit /b 1
  )
)

node run-dev.js
if errorlevel 1 (
  echo.
  echo Что-то пошло не так при сборке — смотрите сообщение об ошибке выше.
  pause
  exit /b 1
)

endlocal
