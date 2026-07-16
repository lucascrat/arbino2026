#!/bin/sh
set +e

# Limpa lock files do X11 e Chromium
rm -f /tmp/.X*-lock /tmp/.X11-unix/X*
rm -f /data/.binomo-profile/SingletonLock /data/.binomo-profile/SingletonSocket /data/.binomo-profile/SingletonCookie

# Inicia Xvfb (display virtual para o Chromium)
export DISPLAY=:99
nohup Xvfb :99 -screen 0 1360x850x24 +extension RANDR +extension GLX >/dev/null 2>&1 &
sleep 2

# Inicia x11vnc (VNC server) no mesmo display
# noxdamage: essencial para Chromium no Xvfb
nohup x11vnc -display :99 -forever -nopw -listen 127.0.0.1 -noxdamage -repeat -rfbport 5900 >/dev/null 2>&1 &
sleep 1

# Inicia o servidor API (que tambem serve o frontend)
exec node dist/server/main.js
