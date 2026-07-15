#!/bin/sh
set -e

# Inicia Xvfb (display virtual para o Chromium)
Xvfb :99 -screen 0 1366x850x24 &
sleep 1
export DISPLAY=:99

# Inicia x11vnc (VNC server) no mesmo display
x11vnc -display :99 -forever -nopw -quiet -listen 127.0.0.1 &
sleep 1

# Inicia o servidor API (que tambem serve o frontend)
exec node dist/server/main.js
