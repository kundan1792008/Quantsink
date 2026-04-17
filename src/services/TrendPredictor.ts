/**
 * TrendPredictor
 *
 * Analyses the last 24 hours of broadcast topics using TF-IDF scoring
 * combined with temporal weighting to surface rising trends.  The predictor
 * identifies topics with accelerating engagement velocity and returns the top
 * 10 most likely trending topics for the next 6-hour prediction window.
 *
 * Predictions are refreshed automatically every 30 minutes when the scheduler
 * is started via `startScheduler()`.
 */

import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BroadcastDocument {
  /** Unique broadcast identifier. */
  readonly id: string;
  /** Raw text content of the broadcast. */
  readonly content: string;
  /** UTC epoch ms when the broadcast was published. */
  readonly publishedAt: number;
  /** Cumulative engagement count at the time of ingestion. */
  readonly engagementCount: number;
  /** Optional engagement delta since previous sample (for velocity calc). */
  readonly engagementDelta?: number;
}

export interface TrendScore {
  /** The topic / term that is trending. */
  readonly topic: string;
  /** Composite trend score (0-∞, higher = stronger trend). */
  readonly score: number;
  /** Raw TF-IDF contribution to the score. */
  readonly tfidfScore: number;
  /** Temporal weighting factor applied (0-1, recent = 1). */
  readonly temporalWeight: number;
  /** Engagement velocity: delta engagement / time elapsed (normalised). */
  readonly velocity: number;
  /** Number of documents the topic appeared in. */
  readonly documentFrequency: number;
}

export interface PredictionWindow {
  /** ISO timestamp when the prediction was generated. */
  readonly generatedAt: string;
  /** Prediction covers broadcasts in this time range (epoch ms). */
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Top-10 predicted trending topics for the next 6-hour window. */
  readonly topTopics: readonly TrendScore[];
  /** Total documents analysed. */
  readonly documentCount: number;
}

export interface TrendPredictorOptions {
  /** Injected clock – useful for deterministic unit tests. */
  readonly now?: () => number;
  /** Analysis window in milliseconds (default: 24 hours). */
  readonly analysisWindowMs?: number;
  /** Prediction horizon in milliseconds (default: 6 hours). */
  readonly predictionHorizonMs?: number;
  /** Refresh interval in milliseconds (default: 30 minutes). */
  readonly refreshIntervalMs?: number;
  /** How many top topics to return (default: 10). */
  readonly topN?: number;
  /** Minimum document frequency to be considered a trend (default: 2). */
  readonly minDocFrequency?: number;
}

// ---------------------------------------------------------------------------
// Stop-word list — excluded from TF-IDF to reduce noise
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'shall', 'should', 'may', 'might', 'can', 'could',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you', 'he', 'she',
  'they', 'them', 'their', 'our', 'your', 'my', 'his', 'her', 'not', 'no',
  'so', 'if', 'as', 'i', 'me', 'us', 'all', 'more', 'also', 'just', 'than',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Tokenise text into lowercase, alphabetic-only terms of length ≥ 3.
 * Numbers are stripped; punctuation is treated as whitespace.
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * Compute term-frequency map for a single document.
 * Returns normalised TF (count / total words).
 */
function computeTF(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const total = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }
  return tf;
}

/**
 * Compute inverse-document-frequency for each term across all documents.
 * Uses smoothed IDF: ln((1 + N) / (1 + df)) + 1 to avoid division by zero.
 */
function computeIDF(allTokenSets: string[][]): Map<string, number> {
  const N = allTokenSets.length;
  const df = new Map<string, number>();
  for (const tokens of allTokenSets) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, docFreq] of df) {
    idf.set(term, Math.log((1 + N) / (1 + docFreq)) + 1);
  }
  return idf;
}

/**
 * Exponential temporal decay weight.
 * Documents published at `nowMs` receive weight 1.0;
 * a document published `windowMs` ago receives weight ~exp(-3) ≈ 0.05.
 */
function temporalWeight(publishedAt: number, nowMs: number, windowMs: number): number {
  const ageMs = Math.max(0, nowMs - publishedAt);
  const normalised = ageMs / windowMs;
  // Decay coefficient 3 → ~5% weight at the edge of the window
  return Math.exp(-3 * normalised);
}

/**
 * Normalise engagement delta into a velocity score in [0, 1].
 * Uses a soft-clamp via tanh so extreme outliers don't dominate.
 */
function normaliseVelocity(delta: number, maxExpectedDelta: number): number {
  if (maxExpectedDelta <= 0) return 0;
  const ratio = delta / maxExpectedDelta;
  // tanh maps ℝ → (-1, 1); we shift to [0, 1]
  return (Math.tanh(ratio * 2) + 1) / 2;
}

// ---------------------------------------------------------------------------
// TrendPredictor
// ---------------------------------------------------------------------------

export class TrendPredictor {
  private readonly now: () => number;
  private readonly analysisWindowMs: number;
  private readonly predictionHorizonMs: number;
  private readonly refreshIntervalMs: number;
  private readonly topN: number;
  private readonly minDocFrequency: number;

  private documents: BroadcastDocument[] = [];
  private lastPrediction: PredictionWindow | null = null;
  private schedulerHandle: ReturnType<typeof setInterval> | null = null;

  constructor(options: TrendPredictorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.analysisWindowMs = options.analysisWindowMs ?? 24 * 60 * 60 * 1_000; // 24 h
    this.predictionHorizonMs = options.predictionHorizonMs ?? 6 * 60 * 60 * 1_000; // 6 h
    this.refreshIntervalMs = options.refreshIntervalMs ?? 30 * 60 * 1_000;    // 30 min
    this.topN = options.topN ?? 10;
    this.minDocFrequency = options.minDocFrequency ?? 2;
  }

  // -------------------------------------------------------------------------
  // Document ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest one or more broadcast documents into the analysis corpus.
   * Documents outside the analysis window are silently ignored.
   */
  ingest(docs: BroadcastDocument | BroadcastDocument[]): void {
    const incoming = Array.isArray(docs) ? docs : [docs];
    const cutoff = this.now() - this.analysisWindowMs;
    for (const doc of incoming) {
      if (doc.publishedAt >= cutoff) {
        this.documents.push(doc);
      }
    }
    logger.debug({ ingested: incoming.length, total: this.documents.length }, 'TrendPredictor documents ingested');
  }

  /**
   * Evict all documents older than the analysis window from the internal corpus.
   */
  evictStale(): void {
    const cutoff = this.now() - this.analysisWindowMs;
    const before = this.documents.length;
    this.documents = this.documents.filter((d) => d.publishedAt >= cutoff);
    const evicted = before - this.documents.length;
    if (evicted > 0) {
      logger.debug({ evicted }, 'TrendPredictor stale documents evicted');
    }
  }

  // -------------------------------------------------------------------------
  // Core analysis
  // -------------------------------------------------------------------------

  /**
   * Run a full TF-IDF + temporal-velocity analysis pass over the current
   * document corpus and return the top-N trending topics.
   */
  predict(): PredictionWindow {
    this.evictStale();

    const nowMs = this.now();
    const docs = this.documents;

    if (docs.length === 0) {
      const empty: PredictionWindow = {
        generatedAt: new Date(nowMs).toISOString(),
        windowStart: nowMs,
        windowEnd: nowMs + this.predictionHorizonMs,
        topTopics: [],
        documentCount: 0,
      };
      this.lastPrediction = empty;
      return empty;
    }

    // 1. Tokenise every document
    const tokenSets = docs.map((d) => tokenise(d.content));

    // 2. Compute IDF across the full corpus
    const idf = computeIDF(tokenSets);

    // 3. Determine max engagement delta for velocity normalisation
    const maxDelta = docs.reduce(
      (m, d) => Math.max(m, d.engagementDelta ?? d.engagementCount),
      1,
    );

    // 4. Accumulate per-term composite scores
    //    score(term) = Σ_docs [ TF(term, doc) * IDF(term) * temporalWeight(doc) * (1 + velocity(doc)) ]
    const termScore = new Map<string, number>();
    const termTFIDF = new Map<string, number>();
    const termVelocity = new Map<string, number>();
    const termTemporal = new Map<string, number>();
    const termDocFreq = new Map<string, number>();

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const tokens = tokenSets[i];
      const tf = computeTF(tokens);
      const tWeight = temporalWeight(doc.publishedAt, nowMs, this.analysisWindowMs);
      const delta = doc.engagementDelta ?? doc.engagementCount;
      const vel = normaliseVelocity(delta, maxDelta);

      for (const [term, tfVal] of tf) {
        const idfVal = idf.get(term) ?? 1;
        const tfidfContrib = tfVal * idfVal;
        const composite = tfidfContrib * tWeight * (1 + vel);

        termScore.set(term, (termScore.get(term) ?? 0) + composite);
        termTFIDF.set(term, (termTFIDF.get(term) ?? 0) + tfidfContrib);
        termVelocity.set(term, Math.max(termVelocity.get(term) ?? 0, vel));
        termTemporal.set(term, Math.max(termTemporal.get(term) ?? 0, tWeight));
        termDocFreq.set(term, (termDocFreq.get(term) ?? 0) + 1);
      }
    }

    // 5. Filter by minimum document frequency and build ranked list
    const ranked: TrendScore[] = [];
    for (const [topic, score] of termScore) {
      const docFreq = termDocFreq.get(topic) ?? 0;
      if (docFreq < this.minDocFrequency) continue;
      ranked.push({
        topic,
        score,
        tfidfScore: termTFIDF.get(topic) ?? 0,
        temporalWeight: termTemporal.get(topic) ?? 0,
        velocity: termVelocity.get(topic) ?? 0,
        documentFrequency: docFreq,
      });
    }
    ranked.sort((a, b) => b.score - a.score);

    const topTopics = ranked.slice(0, this.topN);

    const window: PredictionWindow = {
      generatedAt: new Date(nowMs).toISOString(),
      windowStart: nowMs,
      windowEnd: nowMs + this.predictionHorizonMs,
      topTopics,
      documentCount: docs.length,
    };

    this.lastPrediction = window;
    logger.info(
      { topics: topTopics.map((t) => t.topic), documentCount: docs.length },
      'TrendPredictor prediction generated',
    );
    return window;
  }

  /**
   * Returns the most recent prediction without recomputing.
   * Returns null if `predict()` has never been called.
   */
  getLastPrediction(): PredictionWindow | null {
    return this.lastPrediction;
  }

  /**
   * Returns all documents currently held in the analysis corpus.
   */
  getCorpusSize(): number {
    return this.documents.length;
  }

  // -------------------------------------------------------------------------
  // Velocity analysis
  // -------------------------------------------------------------------------

  /**
   * Identify "rising" topics — those whose engagement velocity is in the top
   * quartile of all scored terms.  Useful for real-time surfacing of breakout
   * content before it becomes mainstream.
   */
  getRisingTopics(prediction: PredictionWindow): readonly TrendScore[] {
    if (prediction.topTopics.length === 0) return [];
    const sorted = [...prediction.topTopics].sort((a, b) => b.velocity - a.velocity);
    const cutoff = Math.ceil(sorted.length * 0.25);
    return sorted.slice(0, Math.max(1, cutoff));
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /**
   * Start the automatic 30-minute refresh scheduler.
   * Safe to call multiple times — will not create duplicate intervals.
   */
  startScheduler(onPrediction?: (window: PredictionWindow) => void): void {
    if (this.schedulerHandle !== null) return;
    this.schedulerHandle = setInterval(() => {
      const result = this.predict();
      onPrediction?.(result);
    }, this.refreshIntervalMs);
    logger.info({ intervalMs: this.refreshIntervalMs }, 'TrendPredictor scheduler started');
  }

  /**
   * Stop the automatic refresh scheduler.
   */
  stopScheduler(): void {
    if (this.schedulerHandle !== null) {
      clearInterval(this.schedulerHandle);
      this.schedulerHandle = null;
      logger.info('TrendPredictor scheduler stopped');
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /**
   * Clear all ingested documents and reset the last prediction.
   */
  reset(): void {
    this.documents = [];
    this.lastPrediction = null;
  }

  /**
   * Return a lightweight snapshot of current corpus statistics.
   */
  corpusStats(): {
    documentCount: number;
    oldestPublishedAt: number | null;
    newestPublishedAt: number | null;
    avgEngagement: number;
  } {
    if (this.documents.length === 0) {
      return { documentCount: 0, oldestPublishedAt: null, newestPublishedAt: null, avgEngagement: 0 };
    }
    let oldest = Infinity;
    let newest = -Infinity;
    let totalEng = 0;
    for (const d of this.documents) {
      if (d.publishedAt < oldest) oldest = d.publishedAt;
      if (d.publishedAt > newest) newest = d.publishedAt;
      totalEng += d.engagementCount;
    }
    return {
      documentCount: this.documents.length,
      oldestPublishedAt: oldest,
      newestPublishedAt: newest,
      avgEngagement: totalEng / this.documents.length,
    };
  }
}

export default TrendPredictor;
