/**
 * QualityRatingAI — Broadcast Quality Rater
 *
 * Simulates an on-device Gemma-style language model that rates broadcast
 * quality on five axes (originality, clarity, relevance, media quality,
 * spelling/grammar) and returns a composite 0-100 score with a plain-English
 * explanation.
 *
 * In production this would delegate to the local Gemma inference endpoint;
 * in this implementation the heuristics are deterministic enough for unit
 * testing while being sophisticated enough to differentiate content quality.
 */

import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QualityDimension {
  /** Axis name. */
  readonly name: string;
  /** 0-100 score for this dimension. */
  readonly score: number;
  /** One-sentence explanation. */
  readonly rationale: string;
}

export interface QualityRating {
  /** Composite 0-100 score. */
  readonly score: number;
  /** Human-readable overall explanation. */
  readonly explanation: string;
  /** Per-dimension breakdown. */
  readonly dimensions: readonly QualityDimension[];
  /** ISO timestamp of when the rating was produced. */
  readonly ratedAt: string;
  /** Token-level analysis hint (length, avg word length). */
  readonly textStats: TextStats;
}

export interface TextStats {
  readonly charCount: number;
  readonly wordCount: number;
  readonly sentenceCount: number;
  readonly avgWordLength: number;
  readonly avgSentenceLength: number;
  readonly uniqueWordRatio: number;
}

export interface QualityRatingOptions {
  /** Injected clock for tests. */
  readonly now?: () => Date;
  /** Media attachment count — increases media quality dimension. */
  readonly mediaCount?: number;
  /** Whether the user is biometrically verified — slight uplift. */
  readonly biometricVerified?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Very fast approximate sentence splitter. */
function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Tokenise into lowercase words. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Score 1 — Originality (0-100).
 * Proxy: penalise repetition (unique word ratio) and very short content.
 */
function scoreOriginality(text: string, words: string[]): QualityDimension {
  if (words.length === 0) {
    return { name: 'Originality', score: 0, rationale: 'No content to evaluate.' };
  }
  const uniqueRatio = new Set(words).size / words.length;
  const lengthBonus = Math.min(words.length / 50, 1); // full bonus at 50+ words
  const raw = uniqueRatio * 0.7 + lengthBonus * 0.3;
  const score = Math.round(clamp(raw * 100, 0, 100));
  const rationale =
    score >= 75
      ? 'Strong vocabulary variety suggests original thinking.'
      : score >= 50
        ? 'Moderate originality; some word repetition detected.'
        : 'High repetition or very short content limits originality signals.';
  return { name: 'Originality', score, rationale };
}

/**
 * Score 2 — Clarity (0-100).
 * Proxy: average sentence length (15-20 words = optimal) + short word preference.
 */
function scoreClarity(sentences: string[], words: string[]): QualityDimension {
  if (sentences.length === 0 || words.length === 0) {
    return { name: 'Clarity', score: 0, rationale: 'No content to evaluate.' };
  }
  const avgSentLen = words.length / sentences.length;
  // Optimal sentence length ~15-20 words; penalise extremes.
  const sentPenalty = Math.abs(avgSentLen - 17.5) / 17.5;
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / words.length;
  // Shorter average word length → more accessible.
  const wordPenalty = Math.max(0, (avgWordLen - 5) / 5);
  const raw = 1 - clamp((sentPenalty + wordPenalty) / 2, 0, 1);
  const score = Math.round(clamp(raw * 100, 0, 100));
  const rationale =
    score >= 75
      ? 'Clear sentence structure and accessible vocabulary.'
      : score >= 50
        ? 'Readability is acceptable but could be improved with shorter sentences.'
        : 'Dense or run-on sentences reduce clarity.';
  return { name: 'Clarity', score, rationale };
}

/**
 * Score 3 — Relevance (0-100).
 * Proxy: presence of meaningful signal words vs filler words.
 */
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'can', 'could', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during',
  'this', 'that', 'these', 'those', 'it', 'its', 'and', 'or', 'but', 'so',
]);

function scoreRelevance(words: string[]): QualityDimension {
  if (words.length === 0) {
    return { name: 'Relevance', score: 0, rationale: 'No content to evaluate.' };
  }
  const signalWords = words.filter((w) => !FILLER_WORDS.has(w) && w.length > 3);
  const signalRatio = signalWords.length / words.length;
  const score = Math.round(clamp(signalRatio * 130, 0, 100)); // 130 factor so ~77% signal = 100
  const rationale =
    score >= 75
      ? 'Content is dense with meaningful signal words.'
      : score >= 50
        ? 'Reasonable signal-to-noise ratio; consider trimming filler.'
        : 'High proportion of filler words; strengthen the substantive content.';
  return { name: 'Relevance', score, rationale };
}

/**
 * Score 4 — Media Quality (0-100).
 * Proxy: media attachment count. 0 = 50 baseline; each attachment +10 up to 100.
 */
function scoreMediaQuality(mediaCount: number): QualityDimension {
  const score = Math.round(clamp(50 + mediaCount * 10, 0, 100));
  const rationale =
    mediaCount === 0
      ? 'No media attachments; adding visuals increases impact.'
      : mediaCount >= 3
        ? 'Rich media presence significantly boosts engagement potential.'
        : `${mediaCount} media attachment${mediaCount > 1 ? 's' : ''} adds visual context.`;
  return { name: 'Media Quality', score, rationale };
}

/**
 * Score 5 — Spelling & Grammar (0-100).
 * Proxy: heuristic checks — excessive caps, missing space after punctuation,
 * repeated consecutive words, and very high numeric ratio.
 */
function scoreSpellingGrammar(text: string, words: string[]): QualityDimension {
  if (words.length === 0) {
    return { name: 'Spelling & Grammar', score: 0, rationale: 'No content to evaluate.' };
  }
  let deductions = 0;

  // Excessive ALL-CAPS words (>30% of words)
  const capsRatio = words.filter((w) => w === w.toUpperCase() && /[A-Z]/.test(w)).length / words.length;
  if (capsRatio > 0.3) deductions += 20;

  // Missing space after sentence-ending punctuation
  const missingSpaceMatches = (text.match(/[.!?][A-Za-z]/g) ?? []).length;
  deductions += Math.min(missingSpaceMatches * 5, 20);

  // Repeated consecutive words e.g. "the the"
  const repeatedWords = words.filter((w, i) => i > 0 && w === words[i - 1]).length;
  deductions += Math.min(repeatedWords * 10, 20);

  // Very high numeric ratio (often spam/low quality)
  const numericRatio = words.filter((w) => /^\d+$/.test(w)).length / words.length;
  if (numericRatio > 0.4) deductions += 15;

  const score = Math.round(clamp(100 - deductions, 0, 100));
  const rationale =
    score >= 80
      ? 'No significant spelling or grammar issues detected.'
      : score >= 55
        ? 'Minor formatting or style issues present.'
        : 'Several grammar or formatting issues reduce polish.';
  return { name: 'Spelling & Grammar', score, rationale };
}

/** Dimension weights used in the composite score. */
const DIMENSION_WEIGHTS: Record<string, number> = {
  'Originality':       0.20,
  'Clarity':           0.25,
  'Relevance':         0.25,
  'Media Quality':     0.15,
  'Spelling & Grammar': 0.15,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildExplanation(score: number, dimensions: readonly QualityDimension[]): string {
  const topDim = [...dimensions].sort((a, b) => b.score - a.score)[0];
  const bottomDim = [...dimensions].sort((a, b) => a.score - b.score)[0];

  if (score >= 80) {
    return `Excellent broadcast quality (${score}/100). Strongest dimension: ${topDim.name}.`;
  }
  if (score >= 60) {
    return `Good broadcast quality (${score}/100). Focus on improving ${bottomDim.name} to reach the next tier.`;
  }
  if (score >= 40) {
    return `Average broadcast quality (${score}/100). Key improvement areas: ${bottomDim.name} and ${dimensions.find((d) => d !== bottomDim && d.score <= 60)?.name ?? 'Clarity'}.`;
  }
  return `Below-average broadcast quality (${score}/100). Significant improvements needed: ${bottomDim.name} rated ${bottomDim.score}/100 — ${bottomDim.rationale}`;
}

// ---------------------------------------------------------------------------
// QualityRatingAI — main class
// ---------------------------------------------------------------------------

export class QualityRatingAI {
  private readonly now: () => Date;

  constructor(options: QualityRatingOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Rate broadcast content quality.
   *
   * @param content - Raw broadcast text.
   * @param options - Optional runtime overrides (mediaCount, biometricVerified).
   * @returns A QualityRating with composite score and per-dimension breakdown.
   */
  rate(content: string, options: QualityRatingOptions = {}): QualityRating {
    const text = (content ?? '').trim();
    const words = tokenise(text);
    const sentences = splitSentences(text);

    const mediaCount = options.mediaCount ?? 0;
    const biometricVerified = options.biometricVerified ?? false;

    const dimensions: QualityDimension[] = [
      scoreOriginality(text, words),
      scoreClarity(sentences, words),
      scoreRelevance(words),
      scoreMediaQuality(mediaCount),
      scoreSpellingGrammar(text, words),
    ];

    let composite = dimensions.reduce(
      (sum, d) => sum + d.score * (DIMENSION_WEIGHTS[d.name] ?? 0.2),
      0,
    );

    // Biometric uplift: +3 points for verified creators
    if (biometricVerified) {
      composite = Math.min(100, composite + 3);
    }

    const score = Math.round(clamp(composite, 0, 100));
    const explanation = buildExplanation(score, dimensions);

    const textStats: TextStats = {
      charCount: text.length,
      wordCount: words.length,
      sentenceCount: sentences.length,
      avgWordLength:
        words.length > 0
          ? Math.round((words.reduce((s, w) => s + w.length, 0) / words.length) * 10) / 10
          : 0,
      avgSentenceLength:
        sentences.length > 0
          ? Math.round((words.length / sentences.length) * 10) / 10
          : 0,
      uniqueWordRatio:
        words.length > 0
          ? Math.round((new Set(words).size / words.length) * 1000) / 1000
          : 0,
    };

    const rating: QualityRating = {
      score,
      explanation,
      dimensions,
      ratedAt: this.now().toISOString(),
      textStats,
    };

    logger.debug(
      { score, wordCount: words.length, mediaCount },
      'QualityRatingAI broadcast rated',
    );

    return rating;
  }
}

export default QualityRatingAI;
