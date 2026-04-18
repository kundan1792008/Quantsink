/**
 * TrendPredictor — Predictive Trend Analysis Engine
 *
 * Analyses the last 24 hours of broadcast topics using a weighted TF-IDF
 * scheme combined with temporal decay so that very recent topics count
 * proportionally more than topics from the far end of the analysis window.
 *
 * The predictor identifies "rising" trends by measuring engagement velocity
 * across successive time windows — a topic whose engagement per unit time
 * has accelerated meaningfully (second derivative > 0) is flagged as rising.
 *
 * Finally, it projects a ranked list of topics that are most likely to
 * dominate the next six-hour broadcast window.  Predictions are cached and
 * regenerated every thirty minutes by the consuming layer (see
 * PreRenderEngine).
 *
 * The service is fully deterministic — all time / random primitives are
 * injectable — which lets us unit-test the pipeline end-to-end without
 * timing flakiness.
 */

import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single broadcast record that feeds the trend pipeline. */
export interface BroadcastRecord {
  /** Broadcast identifier (unique). */
  readonly id: string;
  /** Author user identifier. */
  readonly authorId: string;
  /** Raw textual body of the broadcast. */
  readonly text: string;
  /** ISO timestamp or Date for when the broadcast was posted. */
  readonly postedAt: Date;
  /** Explicit engagement signal — likes + replies + reshares. */
  readonly engagement: number;
  /** Optional explicit topic labels from moderators / creators. */
  readonly tags?: readonly string[];
}

/** Token and its weight inside the trend model. */
export interface TrendTerm {
  /** Canonicalised lowercase term. */
  readonly term: string;
  /** TF-IDF weighted score, 0..∞. */
  readonly score: number;
  /** Raw document frequency in the window. */
  readonly documentFrequency: number;
  /** Sum of engagement across documents containing the term. */
  readonly engagement: number;
}

/** A single trend prediction. */
export interface TrendPrediction {
  /** Stable identifier for the trend. */
  readonly id: string;
  /** Primary term that names the trend. */
  readonly term: string;
  /** Supporting related terms (bi-grams / co-occurring). */
  readonly relatedTerms: readonly string[];
  /** Final ranking score (higher = more likely to dominate). */
  readonly score: number;
  /** Velocity of engagement growth (delta / window). */
  readonly velocity: number;
  /** Acceleration — second derivative. Positive = rising trend. */
  readonly acceleration: number;
  /** Whether the trend is classified as rising (accelerating). */
  readonly rising: boolean;
  /** Sample broadcast ids contributing to this trend. */
  readonly supportingBroadcastIds: readonly string[];
  /** ISO timestamp the prediction was produced at. */
  readonly predictedAt: string;
}

/** Top-level prediction envelope. */
export interface TrendPredictionSet {
  /** Rolling window used to generate the predictions (hours). */
  readonly analysisWindowHours: number;
  /** Forecast horizon (hours). */
  readonly forecastHorizonHours: number;
  /** ISO timestamp of the end of the analysis window. */
  readonly generatedAt: string;
  /** Predictions sorted by score descending. */
  readonly predictions: readonly TrendPrediction[];
  /** Total broadcasts analysed. */
  readonly sampleSize: number;
  /** Total unique terms observed (post-filter). */
  readonly vocabularySize: number;
}

/** Options for instantiating the TrendPredictor. */
export interface TrendPredictorOptions {
  /** Injected clock for deterministic tests. */
  readonly now?: () => Date;
  /** How many hours of history to analyse.  Default 24. */
  readonly analysisWindowHours?: number;
  /** How many hours into the future we are projecting.  Default 6. */
  readonly forecastHorizonHours?: number;
  /** Number of top predictions to return.  Default 10. */
  readonly topK?: number;
  /** Minimum document frequency for a term to qualify.  Default 2. */
  readonly minDocumentFrequency?: number;
  /** Whether to include bi-grams.  Default true. */
  readonly includeBigrams?: boolean;
  /** Number of equally-sized sub-windows used for velocity. Default 6. */
  readonly velocityBuckets?: number;
  /** Temporal half-life in hours for recency weighting. Default 4. */
  readonly temporalHalfLifeHours?: number;
}

// ---------------------------------------------------------------------------
// Stopword list — intentionally compact to keep signal words
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'had', 'he', 'her', 'hers', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'just', 'may', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'to', 'too', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
  'with', 'you', 'your', 'yours', 'am', 'been', 'being', 'did', 'do',
  'does', 'doing', 'over', 'under', 'again', 'further', 'out', 'up',
  'down', 'off', 'above', 'below', 'about', 'against', 'between', 'very',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonicalise text into a list of unigram terms. */
export function tokenise(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s#@'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Produce bi-gram terms from an ordered token list. */
export function bigrams(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const firstToken = tokens[i];
    const secondToken = tokens[i + 1];
    if (firstToken.length > 2 && secondToken.length > 2) {
      out.push(`${firstToken} ${secondToken}`);
    }
  }
  return out;
}

/**
 * Convert a date to a millisecond epoch safely.  Accepts Date, ISO string,
 * or numeric epoch.
 */
function epochOf(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/** Stable hash for generating prediction ids without a crypto dependency. */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Clamp helper. */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Core data structures
// ---------------------------------------------------------------------------

interface TermStat {
  term: string;
  /** Engagement-weighted tf. */
  termFrequency: number;
  /** Number of distinct documents containing the term. */
  documentFrequency: number;
  /** Total engagement of supporting docs. */
  engagement: number;
  /** Broadcast ids contributing to the term. */
  supporting: Set<string>;
  /** Per-bucket engagement for velocity calculations. */
  bucketEngagement: number[];
}

interface PairCooccurrence {
  count: number;
  engagement: number;
}

// ---------------------------------------------------------------------------
// TrendPredictor class
// ---------------------------------------------------------------------------

export class TrendPredictor {
  private readonly now: () => Date;
  private readonly analysisWindowHours: number;
  private readonly forecastHorizonHours: number;
  private readonly topK: number;
  private readonly minDocumentFrequency: number;
  private readonly includeBigrams: boolean;
  private readonly velocityBuckets: number;
  private readonly temporalHalfLifeHours: number;

  /** Last produced prediction set, kept for cheap reads. */
  private lastPrediction: TrendPredictionSet | null = null;

  constructor(options: TrendPredictorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.analysisWindowHours = options.analysisWindowHours ?? 24;
    this.forecastHorizonHours = options.forecastHorizonHours ?? 6;
    this.topK = options.topK ?? 10;
    this.minDocumentFrequency = options.minDocumentFrequency ?? 2;
    this.includeBigrams = options.includeBigrams ?? true;
    this.velocityBuckets = options.velocityBuckets ?? 6;
    this.temporalHalfLifeHours = options.temporalHalfLifeHours ?? 4;

    if (this.analysisWindowHours <= 0) {
      throw new Error('analysisWindowHours must be positive');
    }
    if (this.velocityBuckets < 2) {
      throw new Error('velocityBuckets must be at least 2 for velocity calc');
    }
  }

  /** Return the last prediction set (or null if never produced). */
  getLastPrediction(): TrendPredictionSet | null {
    return this.lastPrediction;
  }

  /**
   * Produce a fresh prediction set from the supplied broadcast corpus.
   *
   * The corpus is expected to be unordered — we will filter anything outside
   * the analysis window and sort internally.
   */
  predict(broadcasts: readonly BroadcastRecord[]): TrendPredictionSet {
    const generatedAtDate = this.now();
    const windowEndMs = generatedAtDate.getTime();
    const windowStartMs = windowEndMs - this.analysisWindowHours * 3_600_000;

    const inWindow = broadcasts.filter((b) => {
      const t = epochOf(b.postedAt);
      return t >= windowStartMs && t <= windowEndMs;
    });

    if (inWindow.length === 0) {
      const empty: TrendPredictionSet = {
        analysisWindowHours: this.analysisWindowHours,
        forecastHorizonHours: this.forecastHorizonHours,
        generatedAt: generatedAtDate.toISOString(),
        predictions: [],
        sampleSize: 0,
        vocabularySize: 0,
      };
      this.lastPrediction = empty;
      logger.debug({ sampleSize: 0 }, 'TrendPredictor produced empty prediction');
      return empty;
    }

    const bucketSizeMs =
      (this.analysisWindowHours * 3_600_000) / this.velocityBuckets;

    const termStats = new Map<string, TermStat>();
    const pairs = new Map<string, PairCooccurrence>();
    const totalDocs = inWindow.length;

    for (const b of inWindow) {
      const tokens = tokenise(b.text);
      const extraTags = (b.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean);
      const terms = new Set<string>([...tokens, ...extraTags]);

      if (this.includeBigrams) {
        for (const bg of bigrams(tokens)) {
          terms.add(bg);
        }
      }

      const postedMs = epochOf(b.postedAt);
      const ageHours = Math.max(0, (windowEndMs - postedMs) / 3_600_000);
      const recencyWeight = Math.pow(0.5, ageHours / this.temporalHalfLifeHours);
      const weightedEngagement =
        (1 + Math.log1p(Math.max(0, b.engagement))) * recencyWeight;

      const bucketIndex = clamp(
        Math.floor((postedMs - windowStartMs) / bucketSizeMs),
        0,
        this.velocityBuckets - 1,
      );

      for (const term of terms) {
        let stat = termStats.get(term);
        if (!stat) {
          stat = {
            term,
            termFrequency: 0,
            documentFrequency: 0,
            engagement: 0,
            supporting: new Set<string>(),
            bucketEngagement: new Array<number>(this.velocityBuckets).fill(0),
          };
          termStats.set(term, stat);
        }
        stat.termFrequency += weightedEngagement;
        stat.documentFrequency += 1;
        stat.engagement += Math.max(0, b.engagement);
        stat.supporting.add(b.id);
        stat.bucketEngagement[bucketIndex] += Math.max(0, b.engagement);
      }

      // Co-occurrence for related terms — only from unigram list to keep
      // the pair space bounded.
      const uniqueUnigrams = Array.from(new Set(tokens));
      for (let i = 0; i < uniqueUnigrams.length; i += 1) {
        for (let j = i + 1; j < uniqueUnigrams.length; j += 1) {
          const [firstTerm, secondTerm] = [uniqueUnigrams[i], uniqueUnigrams[j]].sort();
          const key = `${firstTerm}||${secondTerm}`;
          const existing = pairs.get(key);
          if (existing) {
            existing.count += 1;
            existing.engagement += Math.max(0, b.engagement);
          } else {
            pairs.set(key, { count: 1, engagement: Math.max(0, b.engagement) });
          }
        }
      }
    }

    // Filter out very-low-support terms.
    const eligible = Array.from(termStats.values()).filter(
      (s) => s.documentFrequency >= this.minDocumentFrequency,
    );

    // Precompute IDF and scores.
    const scored = eligible.map((s) => {
      const idf = Math.log((1 + totalDocs) / (1 + s.documentFrequency)) + 1;
      const tfIdf = s.termFrequency * idf;
      return { stat: s, tfIdf };
    });

    // Velocity and acceleration per term.
    const scoredWithDynamics = scored.map((entry) => {
      const buckets = entry.stat.bucketEngagement;
      // Velocity = average delta over last half of buckets minus first half.
      const half = Math.floor(buckets.length / 2);
      const earlySum = buckets.slice(0, half).reduce((a, b) => a + b, 0);
      const lateSum = buckets.slice(half).reduce((a, b) => a + b, 0);
      const velocity =
        (lateSum - earlySum) / Math.max(1, this.analysisWindowHours / 2);

      // Acceleration = difference between the last two deltas.
      let acceleration = 0;
      if (buckets.length >= 3) {
        const d1 = buckets[buckets.length - 1] - buckets[buckets.length - 2];
        const d2 = buckets[buckets.length - 2] - buckets[buckets.length - 3];
        acceleration = d1 - d2;
      }

      // Composite score boosts rising trends slightly above mature ones.
      const risingBoost = acceleration > 0 ? 1 + Math.log1p(acceleration) * 0.2 : 1;
      const velocityBoost = 1 + Math.log1p(Math.max(0, velocity)) * 0.25;
      const composite = entry.tfIdf * risingBoost * velocityBoost;

      return {
        stat: entry.stat,
        tfIdf: entry.tfIdf,
        velocity,
        acceleration,
        rising: acceleration > 0 && velocity >= 0,
        composite,
      };
    });

    scoredWithDynamics.sort((a, b) => b.composite - a.composite);

    // Build predictions with related terms via co-occurrence.
    const predictions: TrendPrediction[] = [];
    const seen = new Set<string>();

    for (const entry of scoredWithDynamics) {
      if (predictions.length >= this.topK) break;
      const term = entry.stat.term;
      if (seen.has(term)) continue;
      seen.add(term);

      const related = this.collectRelatedTerms(term, pairs, seen);

      const prediction: TrendPrediction = {
        id: `trend_${stableHash(`${term}:${generatedAtDate.toISOString()}`)}`,
        term,
        relatedTerms: related,
        score: Math.round(entry.composite * 1000) / 1000,
        velocity: Math.round(entry.velocity * 1000) / 1000,
        acceleration: Math.round(entry.acceleration * 1000) / 1000,
        rising: entry.rising,
        supportingBroadcastIds: Array.from(entry.stat.supporting).slice(0, 12),
        predictedAt: generatedAtDate.toISOString(),
      };
      predictions.push(prediction);
    }

    const set: TrendPredictionSet = {
      analysisWindowHours: this.analysisWindowHours,
      forecastHorizonHours: this.forecastHorizonHours,
      generatedAt: generatedAtDate.toISOString(),
      predictions,
      sampleSize: totalDocs,
      vocabularySize: termStats.size,
    };

    this.lastPrediction = set;

    logger.debug(
      {
        sampleSize: totalDocs,
        vocabularySize: termStats.size,
        top: predictions.slice(0, 3).map((p) => p.term),
      },
      'TrendPredictor produced predictions',
    );

    return set;
  }

  /**
   * Produce a list of top terms only — useful for lightweight use cases
   * where a caller doesn't need the full trend envelope.
   */
  topTerms(broadcasts: readonly BroadcastRecord[], limit = this.topK): TrendTerm[] {
    const set = this.predict(broadcasts);
    return set.predictions.slice(0, limit).map((p) => ({
      term: p.term,
      score: p.score,
      documentFrequency: p.supportingBroadcastIds.length,
      engagement: 0,
    }));
  }

  /**
   * Classify an arbitrary text against the most recent prediction set.
   * Returns the best matching prediction, or null if none match.
   */
  classifyText(text: string): TrendPrediction | null {
    if (!this.lastPrediction) return null;
    const tokens = new Set(tokenise(text));
    let best: TrendPrediction | null = null;
    let bestMatch = 0;
    for (const p of this.lastPrediction.predictions) {
      let matches = 0;
      if (tokens.has(p.term)) matches += 2;
      for (const rel of p.relatedTerms) {
        if (tokens.has(rel)) matches += 1;
      }
      if (matches > bestMatch) {
        bestMatch = matches;
        best = p;
      }
    }
    return bestMatch > 0 ? best : null;
  }

  private collectRelatedTerms(
    term: string,
    pairs: Map<string, PairCooccurrence>,
    exclude: ReadonlySet<string>,
  ): string[] {
    // For bi-gram trends, we don't have pair data — return the constituent
    // tokens as related terms.
    if (term.includes(' ')) {
      return term.split(' ').filter((t) => !exclude.has(t)).slice(0, 4);
    }

    const matches: Array<{ other: string; weight: number }> = [];
    for (const [key, value] of pairs.entries()) {
      const [a, b] = key.split('||');
      if (a === term && !exclude.has(b)) {
        matches.push({ other: b, weight: value.count + Math.log1p(value.engagement) });
      } else if (b === term && !exclude.has(a)) {
        matches.push({ other: a, weight: value.count + Math.log1p(value.engagement) });
      }
    }
    matches.sort((x, y) => y.weight - x.weight);
    return matches.slice(0, 4).map((m) => m.other);
  }
}

// ---------------------------------------------------------------------------
// Scheduler helper
// ---------------------------------------------------------------------------

/**
 * Minimal timer primitives that we can stub in tests.  Mirrors the
 * approach used by {@link PhantomSocialService}.
 */
export interface TrendSchedulerApi {
  setInterval(fn: () => void, ms: number): { id: number };
  clearInterval(handle: { id: number }): void;
}

/** Default scheduler — wraps the global setInterval / clearInterval. */
export const defaultTrendScheduler: TrendSchedulerApi = {
  setInterval(fn, ms) {
    const id = setInterval(fn, ms) as unknown as number;
    return { id };
  },
  clearInterval(handle) {
    clearInterval(handle.id as unknown as ReturnType<typeof setInterval>);
  },
};

export interface ScheduledPredictorOptions {
  /** Hours of prediction cadence.  Defaults to 0.5 hours (30 minutes). */
  readonly refreshIntervalHours?: number;
  /** Scheduler primitive. */
  readonly scheduler?: TrendSchedulerApi;
  /** Fetches the current broadcast corpus to re-predict on. */
  readonly fetchBroadcasts: () => Promise<readonly BroadcastRecord[]> | readonly BroadcastRecord[];
  /** Optional callback on each completed prediction cycle. */
  readonly onPrediction?: (set: TrendPredictionSet) => void;
  /** Optional error callback. */
  readonly onError?: (err: unknown) => void;
}

/**
 * Start an auto-refreshing trend predictor.  Returns a disposer that stops
 * the interval.  Runs one prediction eagerly on start so consumers always
 * have something to read.
 */
export function startScheduledPredictor(
  predictor: TrendPredictor,
  options: ScheduledPredictorOptions,
): () => void {
  const scheduler = options.scheduler ?? defaultTrendScheduler;
  const intervalMs = (options.refreshIntervalHours ?? 0.5) * 3_600_000;

  let disposed = false;

  const tick = async (): Promise<void> => {
    if (disposed) return;
    try {
      const corpus = await options.fetchBroadcasts();
      const set = predictor.predict(corpus);
      options.onPrediction?.(set);
    } catch (err) {
      options.onError?.(err);
      logger.warn({ err }, 'TrendPredictor scheduled tick failed');
    }
  };

  // Eager first run.
  void tick();
  const handle = scheduler.setInterval(() => {
    void tick();
  }, intervalMs);

  return () => {
    if (disposed) return;
    disposed = true;
    scheduler.clearInterval(handle);
  };
}

export default TrendPredictor;
