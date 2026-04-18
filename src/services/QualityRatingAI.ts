import {
  BroadcastQualityRatingRecord,
  InMemoryInfluenceStore,
  InfluenceStore,
  clamp,
  clamp100,
  influenceLog,
} from './InfluenceScoreDomain';

/**
 * QualityRatingAI
 * ---------------
 * On-device Gemma-powered broadcast quality rater required by issue
 * #16. Responsibilities:
 *
 *  - Decompose each broadcast into five scoreable factors (originality,
 *    clarity, relevance, media quality, spelling/grammar).
 *  - Build a structured prompt and dispatch it to an injectable
 *    `GemmaModelClient` so the heavy model stays swappable (ONNX,
 *    llama.cpp, Google's on-device Gemma Nano, etc.).
 *  - Parse the structured JSON reply, validate it, and persist the
 *    rating to the injected `InfluenceStore` so the score service can
 *    later aggregate it.
 *  - Fall back to a deterministic heuristic rater when the model is
 *    offline so the wider pipeline never hard-fails.
 *
 * This file intentionally has no direct network dependency — all I/O
 * goes through the `GemmaModelClient` interface, which keeps the
 * service 100% unit-testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BroadcastForRating {
  readonly broadcastId: string;
  readonly authorId: string;
  readonly content: string;
  readonly mediaUrls?: readonly string[];
  /** Hashtags / topics declared by the author. */
  readonly topics?: readonly string[];
  /** Language hint ("en", "es", ...). Defaults to "en". */
  readonly language?: string;
}

export interface QualityFactors {
  readonly originality: number;   // 0–100
  readonly clarity: number;       // 0–100
  readonly relevance: number;     // 0–100
  readonly mediaQuality: number;  // 0–100
  readonly grammar: number;       // 0–100
}

export interface QualityRating extends QualityFactors {
  readonly score: number;         // 0–100 aggregate
  readonly explanation: string;
  readonly modelName: string;
  readonly ratedAt: Date;
  readonly broadcastId: string;
  readonly authorId: string;
}

export interface GemmaPromptMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface GemmaCompletionRequest {
  readonly messages: readonly GemmaPromptMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly seed?: number;
}

export interface GemmaCompletionResponse {
  readonly modelName: string;
  readonly text: string;
  readonly tokensUsed?: number;
}

export interface GemmaModelClient {
  readonly name: string;
  readonly isReady: () => boolean;
  readonly complete: (
    req: GemmaCompletionRequest,
  ) => Promise<GemmaCompletionResponse>;
}

export interface QualityRatingAIOptions {
  readonly model?: GemmaModelClient;
  readonly store?: InfluenceStore;
  readonly now?: () => Date;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly fallbackModelName?: string;
  readonly enablePersistence?: boolean;
}

// ---------------------------------------------------------------------------
// Factor math (pure, exported for tests)
// ---------------------------------------------------------------------------

export const FACTOR_WEIGHTS = Object.freeze({
  originality: 0.3,
  clarity: 0.2,
  relevance: 0.2,
  mediaQuality: 0.15,
  grammar: 0.15,
});

export function aggregateFactors(factors: QualityFactors): number {
  const total =
    factors.originality * FACTOR_WEIGHTS.originality +
    factors.clarity * FACTOR_WEIGHTS.clarity +
    factors.relevance * FACTOR_WEIGHTS.relevance +
    factors.mediaQuality * FACTOR_WEIGHTS.mediaQuality +
    factors.grammar * FACTOR_WEIGHTS.grammar;
  return clamp100(total);
}

// ---------------------------------------------------------------------------
// Heuristic factor scorers (used by the fallback rater)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'of', 'to', 'in', 'for', 'on', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'it', 'this', 'that', 'these', 'those', 'at', 'by', 'as', 'from', 'into',
  'you', 'your', 'we', 'our', 'they', 'their', 'i', 'my',
]);

const CLICHE_PHRASES = [
  'game changer',
  'think outside the box',
  'synergy',
  'paradigm shift',
  'move the needle',
  'circle back',
  'low hanging fruit',
  'hustle',
  'grind',
  'just dropped',
  'going viral',
];

const SHOUTING_RATIO_THRESHOLD = 0.35;

function tokenise(content: string): string[] {
  return content
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function scoreOriginality(content: string): number {
  if (content.trim().length === 0) return 0;
  const tokens = tokenise(content);
  if (tokens.length === 0) return 0;

  const unique = new Set(tokens);
  const meaningful = tokens.filter((t) => !STOP_WORDS.has(t));
  const ttr = unique.size / tokens.length;

  const lower = content.toLowerCase();
  const clicheHits = CLICHE_PHRASES.reduce((n, p) => (lower.includes(p) ? n + 1 : n), 0);

  const volumeBoost = Math.min(25, meaningful.length / 2);
  let score = ttr * 100 + volumeBoost - clicheHits * 12;
  if (tokens.length < 6) score -= 20;
  if (tokens.length > 80) score += 5;
  return clamp100(score);
}

export function scoreClarity(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  const sentences = trimmed.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return 10;
  const wordsPerSentence =
    sentences.reduce((acc, s) => acc + tokenise(s).length, 0) / sentences.length;

  // Target 8–22 words per sentence.
  let score = 100;
  if (wordsPerSentence < 4) score -= 30;
  else if (wordsPerSentence < 8) score -= 10;
  else if (wordsPerSentence > 28) score -= 35;
  else if (wordsPerSentence > 22) score -= 15;

  const exclamations = (trimmed.match(/!/g) ?? []).length;
  if (exclamations > 2) score -= Math.min(25, (exclamations - 2) * 5);

  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length > 20) {
    const upper = letters.replace(/[^A-Z]/g, '').length;
    const ratio = upper / letters.length;
    if (ratio > SHOUTING_RATIO_THRESHOLD) score -= 30;
  }

  if (trimmed.length < 20) score -= 20;
  return clamp100(score);
}

export function scoreRelevance(
  content: string,
  topics: readonly string[] | undefined,
): number {
  if (!topics || topics.length === 0) {
    // No declared topic is neutral — posters get 60 by default.
    return 60;
  }
  const text = content.toLowerCase();
  let matches = 0;
  for (const topic of topics) {
    const needle = topic.toLowerCase().replace(/^#/, '').trim();
    if (!needle) continue;
    if (text.includes(needle)) matches += 1;
  }
  const ratio = matches / topics.length;
  return clamp100(40 + ratio * 60);
}

export function scoreMediaQuality(
  mediaUrls: readonly string[] | undefined,
  content: string,
): number {
  const count = mediaUrls?.length ?? 0;
  if (count === 0) {
    // Text-only broadcasts: give credit for non-trivial length.
    if (content.trim().length > 240) return 75;
    if (content.trim().length > 80) return 60;
    return 50;
  }
  const capped = Math.min(count, 5);
  const excess = Math.max(0, count - 5);
  let score = 55 + capped * 6 - excess * 8;
  const hasImage = (mediaUrls ?? []).some((u) => /\.(png|jpe?g|webp|avif|gif)$/i.test(u));
  const hasVideo = (mediaUrls ?? []).some((u) => /\.(mp4|webm|mov|m3u8)$/i.test(u));
  if (hasImage) score += 5;
  if (hasVideo) score += 10;
  return clamp100(score);
}

export function scoreGrammar(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;

  let penalty = 0;
  const doubleSpaces = (trimmed.match(/ {2,}/g) ?? []).length;
  penalty += Math.min(15, doubleSpaces * 3);

  const trailing = (trimmed.match(/\s+([,.;:!?])/g) ?? []).length;
  penalty += Math.min(12, trailing * 3);

  const repeated = (trimmed.match(/([!?.]){3,}/g) ?? []).length;
  penalty += Math.min(15, repeated * 5);

  // Missing capitalisation at the start of the broadcast.
  const first = trimmed[0];
  if (first && first === first.toLowerCase() && /[a-z]/.test(first)) {
    penalty += 6;
  }

  // Common misspellings — intentionally small list, tuned to avoid false positives.
  const misspellings = [
    /\bteh\b/i,
    /\brecieve\b/i,
    /\bdefinately\b/i,
    /\bseperate\b/i,
    /\boccured\b/i,
  ];
  for (const pattern of misspellings) {
    if (pattern.test(trimmed)) penalty += 6;
  }

  // Simple "their/there/they're" pairing — credit for correctness is given,
  // blatant conflation penalised.
  if (/\btheir is\b/i.test(trimmed) || /\bthere own\b/i.test(trimmed)) {
    penalty += 10;
  }

  return clamp100(100 - penalty);
}

export function heuristicRating(input: BroadcastForRating): QualityFactors {
  return {
    originality: scoreOriginality(input.content),
    clarity: scoreClarity(input.content),
    relevance: scoreRelevance(input.content, input.topics),
    mediaQuality: scoreMediaQuality(input.mediaUrls, input.content),
    grammar: scoreGrammar(input.content),
  };
}

// ---------------------------------------------------------------------------
// Prompt builder + response parser
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are Gemma, an on-device language model rating the quality of a social broadcast. ' +
  'Return STRICT JSON that matches the schema {"originality":0-100,"clarity":0-100,' +
  '"relevance":0-100,"mediaQuality":0-100,"grammar":0-100,"explanation":"..."}. ' +
  'No prose outside the JSON object. Scores must be integers.';

export function buildPrompt(broadcast: BroadcastForRating): GemmaCompletionRequest {
  const topics = broadcast.topics?.length
    ? broadcast.topics.map((t) => `#${t.replace(/^#/, '')}`).join(' ')
    : '(none declared)';
  const media = broadcast.mediaUrls?.length
    ? broadcast.mediaUrls.map((u) => `- ${u}`).join('\n')
    : '(text only)';
  const userPrompt = [
    `Language: ${broadcast.language ?? 'en'}`,
    `Topics: ${topics}`,
    'Media:',
    media,
    'Broadcast:',
    '```',
    broadcast.content,
    '```',
    '',
    'Rate the broadcast on the five factors and write a one-sentence explanation.',
  ].join('\n');

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: 256,
  };
}

/**
 * Extract the first balanced `{...}` block from the model output.
 * Gemma occasionally emits pre/post chatter; this forgiving extractor
 * recovers the JSON payload without relying on non-standard parsers.
 */
export function extractJsonBlock(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseGemmaResponse(text: string): QualityFactors & { explanation: string } {
  const block = extractJsonBlock(text);
  if (!block) {
    throw new Error('QualityRatingAI: model response did not contain a JSON block.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    throw new Error(
      `QualityRatingAI: failed to JSON.parse model response: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('QualityRatingAI: parsed response is not an object.');
  }
  const p = parsed as Record<string, unknown>;
  const num = (field: string): number => {
    const raw = p[field];
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
      throw new Error(`QualityRatingAI: "${field}" missing or not a number.`);
    }
    return clamp100(raw);
  };
  return {
    originality: num('originality'),
    clarity: num('clarity'),
    relevance: num('relevance'),
    mediaQuality: num('mediaQuality'),
    grammar: num('grammar'),
    explanation:
      typeof p.explanation === 'string' && p.explanation.length > 0
        ? p.explanation.slice(0, 500)
        : 'No explanation provided.',
  };
}

// ---------------------------------------------------------------------------
// Default heuristic-only model
// ---------------------------------------------------------------------------

class HeuristicGemmaClient implements GemmaModelClient {
  readonly name = 'gemma-heuristic-fallback';
  readonly isReady = (): boolean => true;
  async complete(): Promise<GemmaCompletionResponse> {
    throw new Error(
      'HeuristicGemmaClient.complete called — the fallback path must be handled by QualityRatingAI directly.',
    );
  }
}

// ---------------------------------------------------------------------------
// QualityRatingAI service
// ---------------------------------------------------------------------------

export class QualityRatingAI {
  private readonly model: GemmaModelClient;
  private readonly store: InfluenceStore;
  private readonly now: () => Date;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fallbackModelName: string;
  private readonly enablePersistence: boolean;

  constructor(options: QualityRatingAIOptions = {}) {
    this.model = options.model ?? new HeuristicGemmaClient();
    this.store = options.store ?? new InMemoryInfluenceStore();
    this.now = options.now ?? (() => new Date());
    this.temperature = clamp(options.temperature ?? 0.2, 0, 1);
    this.maxTokens = Math.max(32, options.maxTokens ?? 256);
    this.fallbackModelName = options.fallbackModelName ?? 'gemma-heuristic-fallback';
    this.enablePersistence = options.enablePersistence ?? true;
  }

  /** Rate a broadcast and persist the result to the store. */
  async rateBroadcast(input: BroadcastForRating): Promise<QualityRating> {
    this.assertInput(input);
    const ratedAt = this.now();
    const promptReq = buildPrompt(input);
    const promptWithOverrides: GemmaCompletionRequest = {
      ...promptReq,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    };

    let factors: QualityFactors;
    let explanation: string;
    let modelName: string;

    try {
      if (!this.model.isReady()) throw new Error('model not ready');
      const response = await this.model.complete(promptWithOverrides);
      const parsed = parseGemmaResponse(response.text);
      factors = {
        originality: parsed.originality,
        clarity: parsed.clarity,
        relevance: parsed.relevance,
        mediaQuality: parsed.mediaQuality,
        grammar: parsed.grammar,
      };
      explanation = parsed.explanation;
      modelName = response.modelName || this.model.name;
    } catch (err) {
      influenceLog(
        'warn',
        {
          broadcastId: input.broadcastId,
          error: (err as Error).message,
          model: this.model.name,
        },
        'QualityRatingAI falling back to heuristic rater',
      );
      factors = heuristicRating(input);
      explanation = this.composeHeuristicExplanation(factors);
      modelName = this.fallbackModelName;
    }

    const score = aggregateFactors(factors);
    const rating: QualityRating = {
      score,
      ...factors,
      explanation,
      modelName,
      ratedAt,
      broadcastId: input.broadcastId,
      authorId: input.authorId,
    };

    if (this.enablePersistence) {
      await this.persistRating(rating);
    }

    influenceLog(
      'info',
      {
        broadcastId: input.broadcastId,
        authorId: input.authorId,
        score,
        model: modelName,
      },
      'QualityRatingAI produced rating',
    );

    return rating;
  }

  /**
   * Convenience helper — returns just the aggregate score (0–100).
   */
  async rateBroadcastScore(input: BroadcastForRating): Promise<number> {
    const rating = await this.rateBroadcast(input);
    return rating.score;
  }

  /** Rate several broadcasts sequentially. Returns in input order. */
  async rateBroadcasts(
    inputs: readonly BroadcastForRating[],
  ): Promise<readonly QualityRating[]> {
    const out: QualityRating[] = [];
    for (const item of inputs) {
      out.push(await this.rateBroadcast(item));
    }
    return out;
  }

  /**
   * Compute the running average quality for a given author across
   * their most recent `limit` broadcasts. Returns 0 when the author
   * has no ratings yet.
   */
  async averageQualityForAuthor(authorId: string, limit = 20): Promise<number> {
    const ratings = await this.store.listBroadcastQualityRatings(authorId, limit);
    if (ratings.length === 0) return 0;
    const sum = ratings.reduce((acc, r) => acc + r.score, 0);
    return Math.round(sum / ratings.length);
  }

  /** Return the most recent ratings for an author. */
  async recentRatings(
    authorId: string,
    limit = 10,
  ): Promise<readonly BroadcastQualityRatingRecord[]> {
    return this.store.listBroadcastQualityRatings(authorId, limit);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private composeHeuristicExplanation(factors: QualityFactors): string {
    const pairs: Array<[keyof QualityFactors, string]> = [
      ['originality', 'originality'],
      ['clarity', 'clarity'],
      ['relevance', 'topical relevance'],
      ['mediaQuality', 'media quality'],
      ['grammar', 'grammar'],
    ];
    const strongest = [...pairs].sort(
      (a, b) => factors[b[0]] - factors[a[0]],
    )[0];
    const weakest = [...pairs].sort(
      (a, b) => factors[a[0]] - factors[b[0]],
    )[0];
    return (
      `Heuristic fallback: strongest on ${strongest[1]} (${factors[strongest[0]]}), ` +
      `weakest on ${weakest[1]} (${factors[weakest[0]]}).`
    );
  }

  private assertInput(input: BroadcastForRating): void {
    if (!input.broadcastId) {
      throw new Error('QualityRatingAI: broadcastId is required.');
    }
    if (!input.authorId) {
      throw new Error('QualityRatingAI: authorId is required.');
    }
    if (typeof input.content !== 'string') {
      throw new Error('QualityRatingAI: content must be a string.');
    }
    if (input.content.length > 5000) {
      throw new Error('QualityRatingAI: content exceeds 5000 characters.');
    }
  }

  private async persistRating(rating: QualityRating): Promise<void> {
    try {
      await this.store.upsertBroadcastQualityRating({
        authorId: rating.authorId,
        broadcastId: rating.broadcastId,
        score: rating.score,
        originality: rating.originality,
        clarity: rating.clarity,
        relevance: rating.relevance,
        mediaQuality: rating.mediaQuality,
        grammar: rating.grammar,
        explanation: rating.explanation,
        modelName: rating.modelName,
      });
    } catch (err) {
      influenceLog(
        'error',
        { error: (err as Error).message, broadcastId: rating.broadcastId },
        'QualityRatingAI failed to persist rating',
      );
    }
  }
}

export default QualityRatingAI;
