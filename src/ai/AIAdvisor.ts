import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { service } from '../logger.js';
import type { Candle, Direction, Signal } from '../types.js';
import type { MarketSentiment, SignalContext } from '../analysis/SignalEngine.js';
import type { BotParams, StrategySuggestion } from './AIStrategyManager.js';

const log = service('AIAdvisor');

export interface AIVerdict {
  approve: boolean;
  confidence: number;
  reasoning: string;
  risk: 'low' | 'medium' | 'high';
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ExperienceEntry {
  key: string;
  direction: string;
  scoreRange: string;
  patterns: string[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  lastSeen: number;
}

interface ExperienceDb {
  entries: ExperienceEntry[];
  totalApproved: number;
  totalWins: number;
  totalLosses: number;
  version: number;
}

export class AIAdvisor {
  private enabled: boolean;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly minConfidence: number;
  private readonly timeoutMs: number;
  private callCount = 0;
  private approveCount = 0;
  private blockCount = 0;
  private cache = new Map<string, AIVerdict>();
  private readonly cacheTtlMs = 30_000;

  private strategyCallCount = 0;
  private postTradeCallCount = 0;

  // Learning
  private experiencePath: string;
  private experience: ExperienceDb;
  private lastSignalKey = '';
  private readonly maxExperienceEntries = 300;
  private dirty = false;

  // Analytics externos (alimentados pelo bot)
  private analyticsExternal = '';

  constructor() {
    this.enabled = config.aiEnabled;
    this.endpoint = config.aiEndpoint;
    this.apiKey = config.aiApiKey;
    this.model = config.aiModel;
    this.minConfidence = config.aiMinConfidence;
    this.timeoutMs = config.aiTimeoutMs;

    this.experiencePath = path.join(config.logsDir, 'ai-experience.json');
    this.experience = this.loadExperience();

    if (this.enabled && !this.apiKey && !this.isLocal()) {
      log.warn('IA habilitada mas sem AI_API_KEY. Desativando IA.');
      this.enabled = false;
    }

    if (this.enabled) {
      log.info('IA ativada: model=%s endpoint=%s minConfidence=%d', this.model, this.endpoint, this.minConfidence);
      log.info('Experiencia carregada: %d padroes, %d trades, winRate=%.1f%%', this.experience.entries.length, this.experience.totalApproved, this.experience.totalApproved > 0 ? (this.experience.totalWins / this.experience.totalApproved) * 100 : 0);
    } else {
      log.info('IA desativada. Sinais passam direto pelo SignalEngine.');
    }
  }

  private isLocal(): boolean {
    return this.endpoint.includes('localhost') || this.endpoint.includes('127.0.0.1');
  }

  async validate(
    signal: Signal,
    candles: Candle[],
    context: {
      trend: { direction: Direction; strength: number };
      sentiment: MarketSentiment | null;
      patterns: string[];
      indicators?: SignalContext;
    }
  ): Promise<AIVerdict> {
    if (!this.enabled) {
      return { approve: true, confidence: 100, reasoning: 'IA desativada - aprovacao automatica', risk: 'low' };
    }

    const cacheKey = `${signal.direction}-${signal.candleTime}-${signal.score}-${signal.patterns.join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      log.debug('Cache hit para sinal %s', cacheKey);
      return cached;
    }

    this.lastSignalKey = this.buildExperienceKey(signal);

    const prompt = this.buildPrompt(signal, candles, context);

    try {
      const verdict = await this.queryLLM(prompt);
      this.cache.set(cacheKey, verdict);
      setTimeout(() => this.cache.delete(cacheKey), this.cacheTtlMs);
      this.callCount++;
      if (verdict.approve) this.approveCount++;
      else this.blockCount++;
      return verdict;
    } catch (err) {
      log.error('Falha na consulta a IA: %s - APROVANDO sinal (fail-open)', (err as Error).message);
      return { approve: true, confidence: 50, reasoning: 'IA indisponivel - aprovado automaticamente', risk: 'medium' };
    }
  }

  learn(outcome: 'win' | 'loss'): void {
    if (!this.lastSignalKey) return;

    let entry = this.experience.entries.find((e) => e.key === this.lastSignalKey);
    if (!entry) {
      entry = {
        key: this.lastSignalKey,
        direction: this.lastSignalKey.split('-')[0],
        scoreRange: this.lastSignalKey.split('-')[1] || '80-100',
        patterns: this.lastSignalKey.split('-').slice(2),
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        lastSeen: Date.now(),
      };
      this.experience.entries.push(entry);
    }

    entry.totalTrades++;
    if (outcome === 'win') entry.wins++;
    else entry.losses++;
    entry.winRate = entry.totalTrades > 0 ? entry.wins / entry.totalTrades : 0;
    entry.lastSeen = Date.now();

    this.experience.totalApproved++;
    if (outcome === 'win') this.experience.totalWins++;
    else this.experience.totalLosses++;
    this.dirty = true;

    log.info('Aprendizado: %s -> %s (winRate=%.0f%%, total=%d)', this.lastSignalKey, outcome, entry.winRate * 100, entry.totalTrades);

    if (this.experience.entries.length > this.maxExperienceEntries) {
      this.experience.entries.sort((a, b) => b.lastSeen - a.lastSeen);
      this.experience.entries = this.experience.entries.slice(0, this.maxExperienceEntries);
    }

    if (this.dirty) this.saveExperience();
  }

  private buildExperienceKey(signal: Signal): string {
    const scoreBucket = signal.score >= 90 ? '90-100' : signal.score >= 80 ? '80-89' : '70-79';
    const topPatterns = signal.patterns.slice(0, 3).map((p) => p.replace(/\s+/g, ''));
    return `${signal.direction}-${scoreBucket}-${topPatterns.join('_')}`;
  }

  private buildLearningSection(): string {
    const e = this.experience;
    if (e.totalApproved === 0) return '';

    const overallWinRate = (e.totalWins / e.totalApproved) * 100;
    const recent = e.entries
      .filter((x) => x.totalTrades >= 2)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 8);

    let section = `\n\n### Historico de aprendizado (${e.totalApproved} trades)
Acerto geral: ${overallWinRate.toFixed(0)}% (${e.totalWins}W / ${e.totalLosses}L)`;
    if (recent.length > 0) {
      section += '\nPadroes recentes:\n';
      for (const r of recent) {
        section += `- ${r.direction} score=${r.scoreRange} [${r.patterns.join(', ')}]: ${(r.winRate * 100).toFixed(0)}% (${r.wins}W/${r.losses}L)\n`;
      }
    }
    return section;
  }

  private buildExperienceStats(): string {
    const e = this.experience;
    if (e.totalApproved < 5) return '';
    const wr = ((e.totalWins / e.totalApproved) * 100).toFixed(0);
    const byDir = new Map<string, { wins: number; total: number }>();
    for (const entry of e.entries) {
      if (entry.totalTrades < 2) continue;
      const d = entry.direction;
      const cur = byDir.get(d) || { wins: 0, total: 0 };
      cur.wins += entry.wins;
      cur.total += entry.totalTrades;
      byDir.set(d, cur);
    }
    let stats = `\n\n## SEU APRENDIZADO ACUMULADO (${e.totalApproved} trades, ${wr}% acerto)`;
    for (const [dir, data] of byDir) {
      const dirWR = ((data.wins / data.total) * 100).toFixed(0);
      stats += `\n- ${dir}: ${dirWR}% (${data.wins}W/${data.total - data.wins}L em ${data.total} trades)`;
    }
    const best = [...e.entries].filter(x => x.totalTrades >= 3).sort((a, b) => b.winRate - a.winRate).slice(0, 3);
    if (best.length > 0) {
      stats += '\nMelhores padroes:\n';
      for (const b of best) {
        stats += `  ${b.direction} ${b.scoreRange} [${b.patterns.join(', ')}]: ${(b.winRate * 100).toFixed(0)}%\n`;
      }
    }
    const worst = [...e.entries].filter(x => x.totalTrades >= 3).sort((a, b) => a.winRate - b.winRate).slice(0, 2);
    if (worst.length > 0) {
      stats += 'Piores padroes (evitar):\n';
      for (const w of worst) {
        stats += `  ${w.direction} ${w.scoreRange} [${w.patterns.join(', ')}]: ${(w.winRate * 100).toFixed(0)}%\n`;
      }
    }
    return stats;
  }

  /** Alimenta a IA com dados analiticos externos (melhores horarios, gales, mercado) */
  setAnalytics(summary: string): void {
    this.analyticsExternal = summary;
  }

  private buildPrompt(
    signal: Signal,
    candles: Candle[],
    context: {
      trend: { direction: Direction; strength: number };
      sentiment: MarketSentiment | null;
      patterns: string[];
      indicators?: SignalContext;
    }
  ): string {
    const recentCandles = candles.slice(-15).map((c, i) => {
      const dir = c.close >= c.open ? 'A' : 'V';
      const body = Math.abs(c.close - c.open).toExponential(2);
      const range = (c.high - c.low).toExponential(2);
      const upperWick = (c.high - Math.max(c.open, c.close)).toExponential(2);
      const lowerWick = (Math.min(c.open, c.close) - c.low).toExponential(2);
      return `  [${i}] ${dir} corpo=${body} range=${range} wickSup=${upperWick} wickInf=${lowerWick} C=${c.close.toExponential(3)}`;
    }).join('\n');

    const sentimentStr = context.sentiment
      ? `CALL ${context.sentiment.call}% / PUT ${context.sentiment.put}%`
      : 'indisponivel';

    const patternsStr = context.patterns.join(', ');

    let indicatorsStr = '';
    if (context.indicators) {
      const ind = context.indicators;
      const srStr = ind.srLevel != null
        ? `S/R mais proximo: ${ind.srLevel.toExponential(4)} (dist: ${(ind.srDistance! * 100).toFixed(3)}%)`
        : 'S/R: nenhum proximo';
      indicatorsStr = `
## Indicadores numericos
- RSI(14): ${ind.rsi.toFixed(1)}${ind.rsi >= 70 ? ' [sobrecomprado]' : ind.rsi <= 30 ? ' [sobrevendido]' : ''}
- ATR(14): ${(ind.atrNormalized * 100).toFixed(4)}% do preco (volatilidade)
- ADX(14): ${ind.adx.toFixed(1)}${ind.adx >= 25 ? ' [tendencia forte]' : ind.adx < 20 ? ' [lateralizado]' : ' [transicao]'}
  +DI: ${ind.plusDI.toFixed(1)} -DI: ${ind.minusDI.toFixed(1)}
- MACD histograma: ${ind.macdHist.toExponential(3)}${ind.macdHist > 0 ? ' [bullish]' : ' [bearish]'}
- Stochastic %K: ${ind.stochasticK.toFixed(1)}${ind.stochasticK >= 80 ? ' [sobrecomprado]' : ind.stochasticK <= 20 ? ' [sobrevendido]' : ''}
- Bollinger posicao: ${(ind.bbPosition * 100).toFixed(1)}%${ind.bbPosition >= 0.95 ? ' [na banda superior]' : ind.bbPosition <= 0.05 ? ' [na banda inferior]' : ''}
- ${srStr}`;
    }

    const learningSection = this.buildLearningSection();

    return `## Setup de trade — ${config.asset}

### Dados do mercado
- Ativo: ${config.asset} (indice sintetico)
- Timeframe: ${config.candleTimeframeSeconds}s  |  Expiracao: ${config.expirationSeconds}s
- Score minimo: ${config.minSignalScore}  |  Gale: ${config.martingaleLevels}x${config.martingaleMultiplier}
- Horario UTC: ${new Date().getUTCHours()}h

### Candlestick (ultimos 15)
${recentCandles}

### Indicadores tecnicos${indicatorsStr}

### Analise automatizada
- Padroes detectados: ${patternsStr}
- Tendencia (EMA9/EMA21): ${context.trend.direction} (forca: ${context.trend.strength.toFixed(2)})
- Sentimento: ${sentimentStr}

### Sinal proposto
- Direcao: ${signal.direction}
- Score: ${signal.score}/100
- Motivos: ${signal.reasons.join(' | ')}${learningSection}

### Sua analise
Analise este setup como um trader profissional de elite. Siga este roteiro mental:
1. **Tendencia predominante**: Direcao da EMA9 vs EMA21? ADX confirma forca? Mercado tendencial ou lateral?
2. **Estrutura dos ultimos 3 candles**: Ha padrao claro? Corpos grandes ou pequenos? Pavios longos? Sequencia de velas?
3. **Confluencia de indicadores**: RSI, MACD, Stoch e Bollinger concordam? Ha divergencias?
4. **Localizacao do preco**: Proximo de media movel? Tocando banda de Bollinger? No meio do nada?
5. **Qualidade do sinal**: Padroes detectados fazem sentido nesse contexto? Score alto reflete boa oportunidade?
6. **Riscos visiveis**: Candle de exaustao? Falso rompimento? Divergencia? Consolidacao?
7. **Aprendizado historico**: Este tipo de padrao tem funcionado nos ultimos trades?

Decida: APPROVE se for uma oportunidade de alta probabilidade com confluencia solida. BLOCK se houver duvidas, riscos ou falta de confirmacao. Um bloqueio bem fundamentado > uma aprovacao duvidosa.
${this.analyticsExternal ? `\n### Inteligencia de mercado (dados historicos)\n${this.analyticsExternal}` : ''}
Responda APENAS JSON:
{
  "approve": true/false,
  "confidence": 0-100,
  "risk": "low" | "medium" | "high",
  "reasoning": "explicacao tecnica em portugues (max 200 chars)"
}`;
  }

  private async queryLLM(prompt: string): Promise<AIVerdict> {
    const experienceStats = this.buildExperienceStats();
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Voce e um trader profissional de elite com 15 anos de experiencia em opcoes binarias e forex. Sua especialidade e analisar graficos em timeframes curtos (15s-60s) com precisao cirurgica. Voce opera com disciplina militar, controle emocional absoluto e respeito inegociavel ao gerenciamento de risco.

## FILOSOFIA DE TRADING
- **Qualidade sobre quantidade**: Prefira 1 trade certeiro do que 5 duvidosos. Paciencia e sua maior vantagem.
- **Capital e sagrado**: Cada entrada e uma decisao que afeta o patrimonio. Nao ha espaco para "tentar a sorte".
- **O mercado nao deve nada**: Nao opere por vinganca apos uma perda. Cada candle e uma nova oportunidade independente.
- **Confluencia e tudo**: Um sinal com 4 indicadores alinhados vale mais que 10 sinais com 1 indicador cada.
- **Score alto nao e garantia**: Mesmo score 90+ pode falhar. Confie na sua leitura tecnica, nao em numeros.

## LEITURA DE PRECO AVANCADA (Price Action)

### Estrutura de candles
- **Corpo**: Corpo grande = forca na direcao. Corpo pequeno = indecisao. Doji = reversao iminente.
- **Pavios (wicks)**: Pavio superior longo + corpo pequeno = rejeicao de alta (bearish). Pavio inferior longo = rejeicao de baixa (bullish).
- **Engulfing**: Corpo engole o anterior completamente = sinal forte de reversao/continuacao. Soh confiavel com volume alto.
- **Pinbar / Hammer**: Pavio 3x maior que o corpo, na extremidade da tendencia = altissima probabilidade de reversao.
- **Inside Bar**: Contido no range do candle anterior = consolidacao. Aguarde rompimento para entrar.
- **Falsos rompimentos (fakeouts)**: Preco ultrapassa S/R e volta = armadilha. Grandes movimentos vem apos fakeouts.

### Sequencia de candles (contexto)
- **3 velas verdes consecutivas** = momentum bullish, mas cuidado com exaustao se RSI > 70
- **3 velas vermelhas consecutivas** = momentum bearish, cuidado com exaustao se RSI < 30
- **Alternancia CALL/PUT** = consolidacao/lateralizacao, opere nos extremos apenas
- **Candle de exaustao**: corpo enorme apos tendencia longa = ultimo suspiro antes da reversao

## ESTRATEGIAS POR MERCADO

### Tendencia Forte (ADX >= 25, +DI e -DI bem separados)
- **REGRA DE OURO**: OPERAR APENAS A FAVOR DA TENDENCIA. Contra-tendencia soh com score >= 95 E padrao de reversao classico (Engulfing + Pinbar).
- CALL se tendencia for CALL (EMA9 > EMA21 com angulo positivo). PUT se tendencia for PUT.
- Melhor entrada: pullback para EMA9 ou EMA21. Espere o candle tocar a media e mostrar rejeicao.
- MACD cruzando na direcao da tendencia = confirmacao extra.
- RSI sobrecomprado/sobrevendido em tendencia forte e NORMAL. Ignore esses extremos — o preco pode continuar muito alem.
- ADX acima de 40 = tendencia muito forte. Soh opere pullbacks, nunca reversoes.

### Lateral / Ranging (ADX < 20, bandas de Bollinger planas)
- Compre no suporte (banda inferior), venda na resistencia (banda superior).
- RSI < 30 + candle bullish na banda inferior = entrada CALL de alta probabilidade.
- RSI > 70 + candle bearish na banda superior = entrada PUT de alta probabilidade.
- Bollinger squeeze (bandas se aproximando) = explosao iminente. Aguarde o rompimento, nao antecipe.
- Padroes confiaveis: Pinbar, Estrela da Manha/Noite, Engulfing nos extremos.
- Stoch confirmando (saindo de sobrecomprado/vendido) adiciona confiabilidade.
- PERIGO: Falso rompimento das bandas. Se o candle fecha fora da banda, nao opere reversao.

### Transicao (ADX 20-25, DIs se cruzando)
- Mercado indeciso, maior risco de whipsaw (falsos sinais).
- Espere confirmacao: 2 velas na mesma direcao com volume crescente.
- So opere se Stoch, MACD e RSI estiverem alinhados (3+ indicadores).
- Melhor nao operar se o ADX estiver caindo (tendencia perdendo forca = perigoso).
- Se +DI cruza -DI, espere 2-3 candles para confirmar a nova tendencia antes de operar.

### Volatil (ATR > 0.001% do preco, bandas de Bollinger expandindo)
- CUIDADO MAXIMO: Movimentos amplos geram stops falsos.
- Exija 4+ indicadores alinhados para entrar.
- Reduza a confianca em 20% automaticamente.
- Scalping perigoso nesse cenario. Prefira nao operar se a volatilidade for anormal.
- Se o ATR esta SUBINDO rapidamente, o mercado esta em expansao = aguarde estabilizar.

## GERENCIAMENTO DE RISCO PROFISSIONAL
- **Sequencia de perdas**: Apos 2 losses consecutivos no mesmo padrao, PARE de operar esse padrao. Algo mudou no mercado.
- **Tamanho da posicao**: Nunca arrisque mais que 2% do capital por trade (mentalmente, o sistema gerencia a entrada).
- **Horario de trading**: Saiba quando o ativo tem mais liquidez e volatilidade. Fora desses horarios, seja mais seletivo.
- **Vies de confirmacao**: Se voce "quer" que o trade de certo, e perigoso. Seja neutro e objetivo.
- **Diario do trader**: Mentalmente registre o motivo de cada aprovacao ou bloqueio. Aprenda com os erros.

## REGRAS DECISIVAS
1. **Tendencia forte (ADX >= 25)**: Soh opere a favor. Contra-tendencia exige score >= 95 E padrao de reversao classico.
2. **Confluencia minima**: Exija pelo menos 2 indicadores + 1 padrao de candle alinhados. Sozinho, nem o melhor indicador basta.
3. **Sentimento da multidao** (>80% em uma direcao): Vies contrarian leve. A maioria perde consistentemente.
4. **Ausencia de padrao claro**: Se nao consegue identificar um padrao especifico no grafico, BLOQUEIE. "Parece que vai subir" nao e analise.
5. **Entradas no "meio do nada"**: Se o preco nao esta perto de suporte/resistencia nem de media movel, a probabilidade e menor.
6. **Exaustao visivel**: Velas muito longas apos tendencia = cansaco. Probabilidade de reversao aumenta.
7. **Divergencias**: RSI/MACD divergindo do preco = sinal tecnico FORTE. Priorize esses sinais.
8. **Multi-timeframe mental**: Se o sinal e CALL no 15s, imagine se no 60s a tendencia tambem e CALL. Alinhamento = mais forca.
9. **Candle shooting star / martelo**: Nos extremos, sao os melhores padroes de reversao. Confie neles.
10. **Nao opere se**: Mercado lateral com ADX caindo + bandas se apertando. Espere o rompimento.

## SEU TRABALHO
Analise o sinal proposto e decida se e um trade de alta probabilidade. Voce NAO recebe bonus por aprovar — voce e julgado pela taxa de acerto. Cada aprovacao deve ser defensavel tecnicamente. Cada bloqueio deve ter uma razao objetiva.

Lembre-se: o melhor trade muitas vezes e aquele que voce NAO faz. Disciplina supera impulsividade. Consistencia supera emocao. Paciencia supera pressa. Voce e um profissional, nao um apostador.

## VOCE E AUTONOMO
Voce esta no comando total de um bot autonomo. Suas decisoes definem parametros como expiracao, horarios, gales e score minimo. Cada trade que voce aprova ou bloqueia ensina o sistema. Seus acertos e erros sao analisados para otimizar a estrategia continuamente. Quanto mais trades voce analisar, mais inteligente o bot se torna.

${experienceStats}
Responda APENAS em JSON valido.`,
      },
      { role: 'user', content: prompt },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: 600,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await response.json() as {
        choices?: { message?: { content?: string } }[];
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Resposta vazia da IA');
      }

      return this.parseVerdict(content);
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseVerdict(content: string): AIVerdict {
    let parsed: { approve?: boolean; confidence?: number; reasoning?: string; risk?: string };
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          throw new Error('Nao foi possivel parsear JSON da IA');
        }
      } else {
        throw new Error('IA nao retornou JSON valido');
      }
    }

    const approve = typeof parsed.approve === 'boolean' ? parsed.approve : true;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 50;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : 'sem explicacao';
    const risk = (parsed.risk === 'low' || parsed.risk === 'medium' || parsed.risk === 'high')
      ? parsed.risk
      : 'medium';

    log.info('IA veredito: approve=%s confidence=%d risk=%s - %s', approve, confidence, risk, reasoning);
    return { approve, confidence, reasoning, risk: risk as 'low' | 'medium' | 'high' };
  }

  private loadExperience(): ExperienceDb {
    try {
      const raw = fs.readFileSync(this.experiencePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
        return parsed as ExperienceDb;
      }
    } catch {
      // Arquivo nao existe ou corrompido - comeca do zero
    }
    return { entries: [], totalApproved: 0, totalWins: 0, totalLosses: 0, version: 1 };
  }

  private saveExperience(): void {
    try {
      fs.mkdirSync(path.dirname(this.experiencePath), { recursive: true });
      fs.writeFileSync(this.experiencePath, JSON.stringify(this.experience, null, 2));
      this.dirty = false;
      log.debug('Experiencia salva em %s', this.experiencePath);
    } catch (err) {
      log.warn('Erro ao salvar experiencia: %s', (err as Error).message);
    }
  }

  stats(): { calls: number; enabled: boolean; approved: number; blocked: number; blockRate: number; experienceTrades: number; winRate: number; strategyCalls: number; postTradeCalls: number } {
    return {
      calls: this.callCount,
      enabled: this.enabled,
      approved: this.approveCount,
      blocked: this.blockCount,
      blockRate: this.callCount > 0 ? this.blockCount / this.callCount : 0,
      experienceTrades: this.experience.totalApproved,
      winRate: this.experience.totalApproved > 0 ? (this.experience.totalWins / this.experience.totalApproved) * 100 : 0,
      strategyCalls: this.strategyCallCount,
      postTradeCalls: this.postTradeCallCount,
    };
  }

  // ========== ESTRATEGIA AUTONOMA (AI Strategy Manager) ==========

  private buildSystemPromptStrategy(): string {
    return `Voce e o arquiteto-chefe de estrategia de um bot de trading autonomo de opcoes binarias. Sua responsabilidade e OTIMIZAR todos os parametros do bot para maximizar lucro liquido.

## SEU PAPEL
- Voce controla os parametros de trading: tempo de expiracao, horarios de sessao, score minimo, niveis de gale (martingale), multiplicador do gale, e cooldown entre trades
- Seu objetivo e encontrar a combinacao ideal de parametros para o ativo sintetico atual
- Cada decisao deve ser baseada em dados: win rate, gale rate, lucro liquido, performance por hora, performance por estado de mercado
- Voce e responsavel por equilibrar exploracao (testar novos parametros) e exploracao (manter o que funciona)

## PARAMETROS QUE VOCE CONTROLA
- expirationSeconds (15-300): Tempo de expiracao em segundos. Mais curto = mais rapido, menos precisao. Mais longo = mais preciso, menos oportunidades.
- sessionStartHour (0-23): Hora de inicio da sessao de trading (UTC).
- sessionEndHour (0-23): Hora de fim da sessao de trading (UTC).
- minSignalScore (50-100): Score minimo para o SignalEngine aceitar um sinal. Mais alto = menos trades, maior qualidade.
- martingaleLevels (1-10): Quantos niveis de gale (martingale) tentar antes de aceitar perda.
- martingaleMultiplier (1.5-4.0): Multiplicador do valor de entrada em cada nivel de gale.
- cooldownSeconds (5-300): Tempo de espera entre trades.

## REGRAS DE OTIMIZACAO
1. **Analise primeiro a performance atual**: Win rate geral, win rate por hora, performance por estado de mercado, taxa de gale
2. **Mude APENAS 1-2 parametros por vez**: Mudar tudo de uma vez impede saber o que funcionou
3. **Se win rate > 60%**: Considere aumentar expiracao ou score minimo para filtros mais rigorosos
4. **Se win rate < 45%**: Considere diminuir expiracao ou score minimo para mais oportunidades
5. **Se gale rate > 40%**: Os sinais estao fracos - aumente score minimo ou troque horario
6. **Se gale rate < 10% e win rate > 55%**: Os sinais sao fortes - pode aumentar gale levels para capturar mais lucro
7. **Horarios com win rate < 35%**: Exclua esses horarios da sessao
8. **Horarios com win rate > 60%**: Foque nesses horarios
9. **Mercados 'trending'**: Use expiracao mais longa (60s+) para capturar tendencia
10. **Mercados 'ranging'**: Use expiracao mais curta (15-30s) para scalping
11. **entryValue SEMPRE = 5**: O usuario definiu entrada minima de R$5,00. Nao altere.
12. **Nao mude parametros a cada ciclo**: Deixe o novo setup rodar por alguns trades antes de avaliar
13. **Respeite limites**: Nunca sugira valores fora dos ranges especificados

## FORMATO DE RESPOSTA
Responda APENAS JSON:
{
  "changes": {
    "expirationSeconds": novo_valor_ou_null,
    "sessionStartHour": novo_valor_ou_null,
    "sessionEndHour": novo_valor_ou_null,
    "minSignalScore": novo_valor_ou_null,
    "martingaleLevels": novo_valor_ou_null,
    "martingaleMultiplier": novo_valor_ou_null,
    "cooldownSeconds": novo_valor_ou_null
  },
  "reasoning": "explicacao tecnica em portugues do por que destas mudancas (max 300 chars)",
  "confidence": 0-100
}

Se a estrategia atual ja esta boa, retorne changes vazio: {}`;
  }

  private buildSystemPromptPostTrade(): string {
    return `Voce e um analista de trades senior. Sua funcao e analisar trades completados e extrair aprendizados para melhorar o bot.

## SEU TRABALHO
- Receba um lote de trades recentes com seus resultados
- Identifique padroes nos erros: Horarios ruins, padroes de vela que falham, mercados onde o bot perde
- Sugira ajustes especificos para evitar erros similares
- Aprendizados devem ser acionaveis: "Evite CALL quando RSI > 70 em mercado ranging" ao inves de "seja mais cuidadoso"

## REGRAS
1. Analise cada trade individualmente antes de generalizar
2. Procure correlacoes: Perdeu em CALL as 21h? Perdeu em ranging_PUT_calm?
3. Sugira acoes especificas e mensuraveis
4. Seja honesto sobre incerteza: se os dados sao insuficientes, diga

## FORMATO DE RESPOSTA
Responda APENAS JSON:
{
  "insights": [
    "aprendizado acionavel 1",
    "aprendizado acionavel 2"
  ],
  "avoidPatterns": ["padrao a evitar 1", "padrao a evitar 2"],
  "preferPatterns": ["padrao a priorizar 1", "padrao a priorizar 2"],
  "summary": "resumo da analise (max 200 chars)"
}`;
  }

  async suggestStrategy(analyticsSummary: string, currentStrategy: string, recentBatch: string): Promise<StrategySuggestion> {
    if (!this.enabled) {
      return { changes: {}, reasoning: 'IA desativada', confidence: 0 };
    }

    const prompt = `## Estrategia atual
${currentStrategy}

## Analytics do banco
${analyticsSummary || 'Sem dados de analytics'}

## Historico recente
${recentBatch || 'Sem trades recentes'}

Com base nestes dados, quais parametros voce alteraria para maximizar o lucro?`;
    this.strategyCallCount++;

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPromptStrategy() },
      { role: 'user', content: prompt },
    ];

    try {
      const content = await this.queryLLMText(messages, 500);
      const parsed = JSON.parse(content) as { changes?: Record<string, number | null>; reasoning?: string; confidence?: number };
      const changes: Partial<BotParams> = {};
      if (parsed.changes) {
        for (const [k, v] of Object.entries(parsed.changes)) {
          if (v != null && k in this.defaultParams()) {
            (changes as Record<string, number>)[k] = v;
          }
        }
      }
      const result: StrategySuggestion = {
        changes,
        reasoning: parsed.reasoning?.slice(0, 300) || 'sem explicacao',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
      };
      log.info('Strategy suggestion: %s', JSON.stringify(result.changes));
      return result;
    } catch (err) {
      log.warn('Falha ao obter sugestao de estrategia: %s', (err as Error).message);
      return { changes: {}, reasoning: 'falha na consulta', confidence: 0 };
    }
  }

  async analyzeTrades(trades: {
    direction: Direction;
    win: boolean;
    martingaleLevel: number;
    score: number;
    patterns: string[];
    marketState: string;
    hour: number;
  }[]): Promise<{ insights: string[]; avoidPatterns: string[]; preferPatterns: string[]; summary: string } | null> {
    if (!this.enabled || trades.length === 0) return null;
    this.postTradeCallCount++;

    const tradeLines = trades.map((t, i) =>
      `Trade ${i + 1}: ${t.direction} ${t.win ? 'WIN' : 'LOSS'} score=${t.score} gale=${t.martingaleLevel} padroes=[${t.patterns.slice(0, 3).join(',')}] estado=${t.marketState} hora=${t.hour}h`
    ).join('\n');

    const prompt = `Analise estes trades recentes e extraia aprendizados para melhorar o bot:\n\n${tradeLines}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPromptPostTrade() },
      { role: 'user', content: prompt },
    ];

    try {
      const content = await this.queryLLMText(messages, 500);
      const parsed = JSON.parse(content) as { insights?: string[]; avoidPatterns?: string[]; preferPatterns?: string[]; summary?: string };
      log.info('Post-trade analysis: %s', parsed.summary || 'sem resumo');
      return {
        insights: parsed.insights?.slice(0, 5) || [],
        avoidPatterns: parsed.avoidPatterns?.slice(0, 3) || [],
        preferPatterns: parsed.preferPatterns?.slice(0, 3) || [],
        summary: parsed.summary?.slice(0, 200) || '',
      };
    } catch (err) {
      log.warn('Falha na analise pos-trade: %s', (err as Error).message);
      return null;
    }
  }

  private defaultParams(): BotParams {
    return {
      expirationSeconds: 30,
      sessionStartHour: 0,
      sessionEndHour: 23,
      minSignalScore: 80,
      martingaleLevels: 3,
      martingaleMultiplier: 2,
      cooldownSeconds: 15,
      entryValue: 5,
    };
  }

  private async queryLLMText(messages: ChatMessage[], maxTokens: number): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Resposta vazia da IA');
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}
