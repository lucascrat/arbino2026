# arbinomo

Bot de **análise de gráfico em tempo real** e **execução automatizada** para a
plataforma Binomo, via automação de navegador (Playwright). Construído para
rodar **exclusivamente na conta DEMO** durante a fase de validação.

> Stack: Node.js + TypeScript + Playwright. Estratégia: price action (candles) +
> suporte/resistência + tendência, com confluência.

---

## ⚠️ Avisos honestos (leia antes de usar)

1. **Binomo não possui API pública oficial.** Este bot automatiza o navegador
   via Playwright. Isso **viola os Termos de Serviço** da plataforma e pode
   resultar em **banimento da conta**, mesmo em demo. Use por sua conta e risco.
2. **"Análise certeira" não existe em opções binárias.** O modelo matemático
   favorece a casa. Nenhum indicador garante resultado. O win rate realista de
   uma boa estratégia fica entre **55% e 65%** — e isso já é otimista. Com
   payout típico de ~80%, você precisa de **>55% de acerto só para empatar**.
3. **Backteste antes de confiar.** Resultados passados não garantem resultados
   futuros. Rodar em demo por semanas é o mínimo recomendado antes de qualquer
   uso em conta real (que este projeto **não recomenda**).
4. **O bot é uma ferramenta de estudo/automação**, não uma promessa de lucro.

O que o bot **faz** para aumentar a assertividade (qualidade sobre quantidade):

- Detecta **padrões de candle** (pinbar/martelo, engolfo, doji, marubozu,
  estrela cadente).
- Confirma com **tendência** (EMA9 vs EMA21).
- Confirma com **suporte/resistência** (pivôs agrupados).
- Só emite sinal quando há **alinhamento** (confluência) entre essas fontes.
- **Gate de score**: requer dominância **e** força absoluta mínima, evitando
  sinais fracos isolados ou contra-tendência.
- **Gestão de risco**: limite diário de trades, stop-loss diário, cooldown
  entre entradas, martingale opcional (desligado por padrão).

---

## Pré-requisitos

- Node.js 20+ (testado com Node 22)
- npm
- Conta **DEMO** na Binomo

## Instalação

```powershell
npm install
npx playwright install chromium
copy .env.example .env      # depois edite o .env com seus dados
```

## Configuração (`.env`)

| Variável | Descrição | Padrão |
|---|---|---|
| `BINOMO_EMAIL` / `BINOMO_PASSWORD` | Credenciais (opcional — pode logar manualmente) | vazio |
| `MODE` | `discovery` \| `trade` \| `backtest` | `discovery` |
| `USER_DATA_DIR` | Pasta do perfil persistente (salva o login) | `.binomo-profile` |
| `ASSET` | Ativo exato (RIC do WebSocket, ex: `Z-CRY/IDX`) | `Z-CRY/IDX` |
| `EXPIRATION_SECONDS` | Expiração (30/60/120/180/300) | `60` |
| `CANDLE_TIMEFRAME_SECONDS` | TF do candle agregado (5=ruído, 15=recomendado, 60=conservador) | `15` |
| `ENTRY_VALUE` | Valor da entrada (demo) | `10` |
| `MIN_SIGNAL_SCORE` | Score mínimo (80=muito seletivo, 70=balanceado, 60=agressivo) | `80` |
| `MAX_DAILY_TRADES` | Máximo de trades por dia | `20` |
| `MAX_DAILY_LOSS` | Stop-loss diário (unidades) | `50` |
| `MARTINGALE_LEVELS` | Níveis de martingale (0 = desligado) | `0` |
| `COOLDOWN_SECONDS` | Espera entre trades | `15` |
| `SESSION_FILTER` | Filtro de horário: `forex`/`synthetic`/`custom`/`always` | `synthetic` |
| `SESSION_START_HOUR` | Hora início (UTC, modo custom) | `7` |
| `SESSION_END_HOUR` | Hora fim (UTC, modo custom) | `16` |
| `RECORD_CANDLES` | Gravar candles em CSV para backtest | `true` |
| `HEADLESS` | `true` para rodar sem interface | `false` |

---

## Uso

### 1. Modo discovery (primeiro passo obrigatório)

Descobre como os dados do gráfico trafegam na Binomo (WebSockets e estado do
DOM) para que possamos ajustar seletores e o parser de candles.

```powershell
npm run discovery
```

O navegador abre, navega para `binomo.com/trading`. Faça login (manual ou via
`.env`). O bot captura por 60s e imprime:

- Frames WebSocket (URL, tamanho, payload) — veja `logs/bot.log`.
- Globais do `window` relacionados a chart/candle/ohlc.
- Heurística automática de parsing de candles (pode já funcionar).

**Com base nesses logs** você ajustará:
- O parser em `src/data/CandleFeed.ts` (registre via `feed.registerParser()`).
- Os seletores de botão em `src/execution/Trader.ts` (`callSelectors()` /
  `putSelectors()`) e de expiração/valor.

### 2. Modo trade (após discovery + ajustes)

```powershell
npm run build
node dist/index.js --mode=trade
```

Loop principal: captura candles → `SessionFilter` verifica horário →
`SignalEngine` avalia → se houver sinal com score ≥ `MIN_SIGNAL_SCORE` e o
`RiskManager` liberar → `Trader` executa → aguarda resultado (via saldo WS)
→ registra na gestão de risco. Candles são gravados em `logs/candles.csv`.

### 3. Modo backtest (off-line, sem navegador)

Roda a estratégia sobre candles gravados em `logs/candles.csv` e gera
métricas: win rate, profit factor, drawdown, sequências de win/loss.

```powershell
npm run build
node dist/index.js --mode=backtest
```

Para gerar dados sintéticos de teste (2000 candles):
```powershell
node dist/gendata.js
```

Relatório é salvo em `logs/backtest_<timestamp>.json`.

### 4. Smoke test offline do motor de análise

Valida o `SignalEngine` com candles sintéticos, sem abrir navegador:

```powershell
npm run build
node dist/smoke.js
```

---

## Padrões de candle detectados

| Padrão | Direção | Força | Descrição |
|---|---|---|---|
| PinbarBullish / PinbarBearish | CALL/PUT | 0.70 | Martelo com wick longa (rejeição) |
| BullishEngulfing / BearishEngulfing | CALL/PUT | 0.60-0.90 | Engolfo (candle engloba anterior) |
| Doji | (contra anterior) | 0.35 | Indecisão (corpo pequeno) |
| MarubozuBullish / MarubozuBearish | CALL/PUT | 0.55 | Continuação (corpo dominante) |
| ShootingStar / Hammer | PUT/CALL | 0.60 | Rejeição em topo/fundo |
| MorningStar / EveningStar | CALL/PUT | 0.80 | Reversão de 3 candles |
| ThreeWhiteSoldiers / ThreeBlackCrows | CALL/PUT | 0.70 | Continuação de 3 candles |
| TweezerTop / TweezerBottom | PUT/CALL | 0.65 | Pinça (2 candles com topo/fundo iguais) |
| BullishHarami / BearishHarami | CALL/PUT | 0.55 | Reversão (candle pequeno dentro do grande) |

---

## Arquitetura

```
src/
├── index.ts                 # entry point + tratamento de sinais
├── BinomoBot.ts             # orquestração (discovery / trade / backtest)
├── config.ts                # config via .env
├── logger.ts                # winston (console + arquivos)
├── types.ts                 # Candle, Signal, TradeResult, Direction
├── data/
│   ├── BrowserSession.ts    # Playwright: login persistente, WS interception
│   └── CandleFeed.ts        # parser Phoenix + agregação ticks→candles + CSV
├── analysis/
│   ├── CandlePatterns.ts    # 15 padrões de candle + trendBias (EMA9/EMA21)
│   ├── SupportResistance.ts # pivôs agrupados + confluência
│   ├── SignalEngine.ts      # confluência + score + gates + sentimento contrarian
│   └── SessionFilter.ts     # filtro de horário (forex/synthetic/custom)
├── execution/
│   └── Trader.ts            # clica CALL/PUT (#qa_trading_dealUpButton/Down)
├── risk/
│   └── RiskManager.ts       # limites diários, stop, cooldown, martingale
└── backtest/
    └── Backtester.ts        # backtest off-line + métricas (win rate, PF, DD)
```

---

## Roadmap (próximos passos recomendados)

1. **Rodar `discovery`** e ajustar `CandleFeed` + `Trader` à Binomo real.
2. **Backtest**: gravar histórico de candles e validar o `SignalEngine` off-line
   (medir win rate, drawdown, profit factor por ativo/expiração).
3. **Mais padrões**: tweezer, harami, morning/evening star, três soldados.
4. **Filtro de horário**: evitar entradas em momentos de baixa liquidez.
5. **Filtro de notícias** (redação econômica): pausar o bot em eventos de alto
   impacto.
6. **Métricas**: exportar relatório diário (CSV) com cada trade e理由.

---

## Aviso final

Este projeto é educacional. **Não use em conta real.** Opções binárias são
arriscadas e a maioria dos traders perde dinheiro. Automação não muda a
matemática — só executa mais rápido.
