FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
  wget curl ca-certificates \
  libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
  libgbm1 libasound2 libxshmfence1 libglib2.0-0 \
  libgtk-3-0 libcups2 libxcomposite1 libxdamage1 \
  libpango-1.0-0 libcairo2 libatspi2.0-0 \
  libx11-xcb1 libxcb1 libxext6 libxi6 libxrender1 \
  libxtst6 libxfixes3 libxss1 libxkbfile1 libxrandr2 \
  xvfb xauth x11vnc \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install && npx playwright install chromium

COPY tsconfig.json ./
COPY src/ src/
COPY frontend/ frontend/
COPY electron-launcher.cjs ./
COPY electron-preload.cjs ./

RUN npx tsc

ENV HEADLESS=false
ENV MODE=trade
ENV API_PORT=3456
ENV BINOMO_EMAIL=
ENV BINOMO_PASSWORD=
ENV ASSET=Z-CRY/IDX
ENV CANDLE_TIMEFRAME_SECONDS=15
ENV EXPIRATION_SECONDS=60
ENV ENTRY_VALUE=5
ENV MARTINGALE_LEVELS=0
ENV MARTINGALE_MULTIPLIER=2.0
ENV COOLDOWN_SECONDS=15
ENV MIN_SIGNAL_SCORE=80
ENV MAX_DAILY_TRADES=20
ENV MAX_DAILY_LOSS=100
ENV MAX_DAILY_PROFIT=0
ENV AI_ENABLED=false
ENV AI_ENDPOINT=https://api.groq.com/openai/v1
ENV AI_MODEL=llama-3.3-70b-versatile
ENV AI_MIN_CONFIDENCE=30
ENV AI_TIMEOUT_MS=30000
ENV RECORD_CANDLES=false
ENV SESSION_FILTER=synthetic
ENV POLL_INTERVAL_MS=1000
ENV DATA_DIR=/data
ENV USER_DATA_DIR=/data/.binomo-profile

VOLUME /data
EXPOSE 3456

COPY deploy/start.sh ./
RUN chmod +x start.sh

CMD ["sh", "-c", "./start.sh"]
