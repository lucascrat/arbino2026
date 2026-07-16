import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { service } from '../logger.js';
import type { Candle, Direction, Signal } from '../types.js';
import type { MarketSentiment, SignalContext } from '../analysis/SignalEngine.js';

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

  // Learning
  private experiencePath: string;
  private experience: ExperienceDb;
  private lastSignalKey = '';
  private readonly maxExperienceEntries = 200;
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
Analise o grafico como uma trader profissional. Considere:
1. **Leitura do preco**: Os candles confirmam a direcao do sinal? Ha rompimentos, rejeicoes, continuacao ou exaustao?
2. **Indicadores**: RSI, MACD, Stochastic e Bollinger estao alinhados? Ha divergencias?
3. **Padroes**: Os padroes detectados sao confiaveis neste contexto de mercado?
4. **Tipo de mercado**: Esta tendencia, lateral ou volatil? Sua estrategia se adapta a ele.
5. **Aprendizado passado**: O historico mostra que esse padrao tem funcionado? Ajuste seu criterio com base nos resultados anteriores.

Decida de forma independente. Nao existe "porcentagem ideal de aprovacao" — apenas trades bem analisados. Voce pode aprovar ou bloquear livremente.

Importante: score >= 80 significa confluencia forte, mas nao eh garantia. Use seu julgamento profissional.
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
        content: `Voce e uma trader profissional senior com 15 anos de experiencia em opcoes binarias. Sua especialidade e analisar graficos em timeframes curtos (15s-60s) e identificar padroes com alta precisao.

## ESTRATEGIAS POR TIPO DE MERCADO

### Mercado em Tendencia Forte (ADX >= 25)
- REGRA PRINCIPAL: SEMPRE opere a favor da tendencia. NUNCA opere contra.
- CALL se tendencia for CALL (EMA9 > EMA21), PUT se for PUT (EMA9 < EMA21).
- Sinais contra a tendencia precisam de score >= 95 e padrao de reversao forte (Engulfing + pinbar) para serem considerados.
- Use MACD e ADX para confirmar forca da tendencia.
- Ignore RSI sobrecomprado/sobrevendido em tendencia forte (pode ficar extremo por muito tempo).

### Mercado Lateral/Ranging (ADX < 20)
- Foco em reversoes nos extremos: CALL no suporte, PUT na resistencia.
- Bollinger Bands e RSI sao mais confiaveis nesse cenario.
- Procure por pinbars, hammers, e estrelas nos extremos.
- Prefira operar quando o preco toca a banda de Bollinger.
- Cuidado com rompimentos falsos.

### Mercado em Transicao (ADX 20-25)
- Abordagem mista: observe se a tendencia esta se formando ou se desfazendo.
- Padroes de continuacao sao mais arriscados. Prefira esperar confirmacao.
- Se Stoch e MACD concordam, o sinal e mais confiavel.

### Mercado Volatil (ATR > 0.001% do preco)
- Reduza confianca. Volatilidade alta significa mais falsos sinais.
- Exija pelo menos 3 indicadores alinhados.
- Evite operar contra o momentum.

## REGRAS GERAIS
- NUNCA opere contra tendencia forte (ADX >= 25) a menos que score >= 95 com padrao de reversao.
- Confluencia de 3+ indicadores aumenta confiabilidade significativamente.
- Sentimento de multidao > 80% em uma direcao = vies contrarian (a maioria perde).
- Cada trade e uma decisao independente. Confie na sua analise, nao no historico.
- Voce aprende com cada resultado e melhora continuamente.
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

  stats(): { calls: number; enabled: boolean; approved: number; blocked: number; blockRate: number; experienceTrades: number; winRate: number } {
    return {
      calls: this.callCount,
      enabled: this.enabled,
      approved: this.approveCount,
      blocked: this.blockCount,
      blockRate: this.callCount > 0 ? this.blockCount / this.callCount : 0,
      experienceTrades: this.experience.totalApproved,
      winRate: this.experience.totalApproved > 0 ? (this.experience.totalWins / this.experience.totalApproved) * 100 : 0,
    };
  }
}
