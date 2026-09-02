#!/usr/bin/env bash
# macOS/Linux версия update-and-run.bat — см. run-dev.js для деталей.
set -e
cd "$(dirname "$0")"
node run-dev.js "$@"
