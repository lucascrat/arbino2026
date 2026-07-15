#!/bin/sh
set -e

# Inicia Xvfb (display virtual para o Chromium)
Xvfb :99 -screen 0 1366x850x24 &
sleep 1
export DISPLAY=:99

# Inicia o servidor API (que tambem serve o frontend)
exec node dist/server/main.js
