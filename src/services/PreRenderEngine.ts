/**
 * PreRenderEngine — Service-Worker-Aware Feed Pre-Renderer
 *
 * The PreRenderEngine sits between the trend pipeline and the client
 * application.  Given a live stream of {@link BroadcastRecord} data, the
 * engine:
 *
 *   1. Ranks candidates per-user via {@link PersonalizedFeedAI}.
 *   2. Uses {@link TrendPredictor} to blend in trending topics even for
 *      brand-new users where the personal signal is sparse (cold start).
 *   3. Serialises the resulting pre-rendered feed payload.
 *   4. Pushes it into the browser's Cache API via a dispatcher abstraction
 *      (the abstraction lets us unit-test without `window`).
 *   5. Detects when the server-side fresh feed has diverged from what was
 *      pre-cached — in which case the cache is invalidated on the next
 *      refresh cycle.
 *
 * The pre-render cadence defaults to the same 30-minute interval used by
 * {@link TrendPredictor}, but is independently configurable.
 */

import logger from '../lib/logger';
import type { BroadcastRecord } from './TrendPredictor';
import type {
  FeedRankResult,
  PersonalizedFeedAI,
  RankedBroadcast,
} from './PersonalizedFeedAI';
import type { TrendPredictor, TrendPredictionSet } from './TrendPredictor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lightweight broadcast card projection for pre-rendering. */
export interface PreRenderedCard {
  readonly broadcastId: string;
  readonly authorId: string;
  readonly headline: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly postedAt: string;
  readonly engagement: number;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly followedAuthor: boolean;
  readonly trendIds: readonly string[];
}

export interface PreRenderedFeed {
  readonly userId: string;
  readonly cards: readonly PreRenderedCard[];
  readonly generatedAt: string;
  readonly expiresAt: string;
  /** Hash of the card ids used to detect divergence. */
  readonly integrityHash: string;
  /** Top trends referenced in the feed. */
  readonly topTrends: readonly string[];
}

/** Minimal contract for a cache backend (mirrors the Cache Storage API). */
export interface CacheDispatcher {
  put(key: string, payload: PreRenderedFeed): Promise<void>;
  get(key: string): Promise<PreRenderedFeed | null>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

/** Factory primitives used by the engine (allows timer stubbing in tests). */
export interface PreRenderSchedulerApi {
  setInterval(fn: () => void, ms: number): { id: number };
  clearInterval(handle: { id: number }): void;
}

export const defaultPreRenderScheduler: PreRenderSchedulerApi = {
  setInterval(fn, ms) {
    const id = setInterval(fn, ms) as unknown as number;
    return { id };
  },
  clearInterval(handle) {
    clearInterval(handle.id as unknown as ReturnType<typeof setInterval>);
  },
};

/** Options for constructing the engine. */
export interface PreRenderEngineOptions {
  readonly now?: () => Date;
  /** TTL (hours) of a pre-rendered feed.  Default 1. */
  readonly feedTtlHours?: number;
  /** How many cards to pre-render per user.  Default 20. */
  readonly cardsPerUser?: number;
  /** How many leading cards to fully render.  Default 5. */
  readonly fullyRenderedCount?: number;
  /** How many top trends to include in cold-start feeds.  Default 5. */
  readonly coldStartTrendCount?: number;
  /** Cache key prefix.  Default `"quantsink/feed"`. */
  readonly cacheKeyPrefix?: string;
}

/** Options accepted by {@link PreRenderEngine#preRenderForUsers}. */
export interface PreRenderBatchOptions {
  /** Override cards per user for this batch. */
  readonly cardsPerUser?: number;
}

// ---------------------------------------------------------------------------
// In-memory cache dispatcher (useful in tests and for server-side reuse)
// ---------------------------------------------------------------------------

export class InMemoryCacheDispatcher implements CacheDispatcher {
  private readonly store = new Map<string, PreRenderedFeed>();

  async put(key: string, payload: PreRenderedFeed): Promise<void> {
    this.store.set(key, payload);
  }

  async get(key: string): Promise<PreRenderedFeed | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return Array.from(this.store.keys());
  }

  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fnv1aHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function headlineFromBody(body: string, maxLen = 92): string {
  const clean = body.trim().replace(/\s+/g, ' ');
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 40 ? lastSpace : maxLen;
  return `${clean.slice(0, cut)}…`;
}

function bodyExcerpt(body: string, maxLen = 280): string {
  const clean = body.trim().replace(/\s+/g, ' ');
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function coldStartScore(
  broadcast: BroadcastRecord,
  trends: TrendPredictionSet,
  nowMs: number,
): { score: number; trendIds: string[]; reasons: string[] } {
  const trendIds: string[] = [];
  const reasons: string[] = [];
  const text = broadcast.text.toLowerCase();
  const tagSet = new Set((broadcast.tags ?? []).map((t) => t.toLowerCase()));
  let score = 0;
  for (const trend of trends.predictions) {
    const termHits =
      (text.includes(trend.term) ? 1 : 0) +
      (tagSet.has(trend.term) ? 1.2 : 0) +
      trend.relatedTerms.filter((r) => text.includes(r)).length * 0.3;
    if (termHits > 0) {
      score += termHits * trend.score;
      trendIds.push(trend.id);
      if (trend.rising) {
        reasons.push(`Rising topic: ${trend.term}`);
      }
    }
  }
  const ageHours = Math.max(
    0,
    (nowMs - new Date(broadcast.postedAt).getTime()) / 3_600_000,
  );
  const recency = Math.pow(0.5, ageHours / 6);
  return {
    score: score * (0.7 + 0.3 * recency),
    trendIds,
    reasons,
  };
}

function projectCard(
  ranked: RankedBroadcast,
  trends: TrendPredictionSet,
): PreRenderedCard {
  const broadcast = ranked.broadcast;
  const loweredText = broadcast.text.toLowerCase();
  const trendIds: string[] = [];
  for (const trend of trends.predictions) {
    if (loweredText.includes(trend.term)) {
      trendIds.push(trend.id);
    }
  }
  return {
    broadcastId: broadcast.id,
    authorId: broadcast.authorId,
    headline: headlineFromBody(broadcast.text),
    body: bodyExcerpt(broadcast.text),
    tags: [...(broadcast.tags ?? [])],
    postedAt: new Date(broadcast.postedAt).toISOString(),
    engagement: broadcast.engagement,
    score: ranked.score,
    reasons: ranked.reasons,
    followedAuthor: ranked.followedAuthor,
    trendIds,
  };
}

function projectColdStartCard(
  broadcast: BroadcastRecord,
  scoredEntry: { score: number; trendIds: string[]; reasons: string[] },
): PreRenderedCard {
  return {
    broadcastId: broadcast.id,
    authorId: broadcast.authorId,
    headline: headlineFromBody(broadcast.text),
    body: bodyExcerpt(broadcast.text),
    tags: [...(broadcast.tags ?? [])],
    postedAt: new Date(broadcast.postedAt).toISOString(),
    engagement: broadcast.engagement,
    score: Math.round(scoredEntry.score * 10_000) / 10_000,
    reasons:
      scoredEntry.reasons.length > 0
        ? scoredEntry.reasons
        : ['Trending right now'],
    followedAuthor: false,
    trendIds: scoredEntry.trendIds,
  };
}

function hashCards(cards: readonly PreRenderedCard[]): string {
  return fnv1aHash(cards.map((c) => `${c.broadcastId}:${c.score}`).join('|'));
}

// ---------------------------------------------------------------------------
// PreRenderEngine — the main orchestrator
// ---------------------------------------------------------------------------

export class PreRenderEngine {
  private readonly now: () => Date;
  private readonly feedTtlHours: number;
  private readonly cardsPerUser: number;
  private readonly fullyRenderedCount: number;
  private readonly coldStartTrendCount: number;
  private readonly cacheKeyPrefix: string;

  constructor(
    private readonly feedAi: PersonalizedFeedAI,
    private readonly trendPredictor: TrendPredictor,
    private readonly cache: CacheDispatcher,
    options: PreRenderEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.feedTtlHours = options.feedTtlHours ?? 1;
    this.cardsPerUser = options.cardsPerUser ?? 20;
    this.fullyRenderedCount = options.fullyRenderedCount ?? 5;
    this.coldStartTrendCount = options.coldStartTrendCount ?? 5;
    this.cacheKeyPrefix = options.cacheKeyPrefix ?? 'quantsink/feed';
  }

  /** Build a deterministic cache key for a user. */
  keyFor(userId: string): string {
    return `${this.cacheKeyPrefix}/${userId}`;
  }

  /**
   * Produce a pre-rendered feed for a single user without touching the
   * cache.  Useful for server-side rendering.
   */
  buildFeed(
    userId: string,
    candidates: readonly BroadcastRecord[],
    options: { cardsPerUser?: number } = {},
  ): PreRenderedFeed {
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const cardLimit = options.cardsPerUser ?? this.cardsPerUser;

    const trends =
      this.trendPredictor.getLastPrediction() ??
      this.trendPredictor.predict(candidates);

    const profile = this.feedAi.getProfile(userId);

    let cards: PreRenderedCard[];

    if (!profile || profile.interactionCount === 0) {
      // Cold start: rank purely on trend match + recency.
      const scored = candidates
        .map((broadcast) => ({
          broadcast,
          scored: coldStartScore(broadcast, trends, nowMs),
        }))
        .sort((a, b) => b.scored.score - a.scored.score)
        .slice(0, cardLimit);

      cards = scored.map((entry) =>
        projectColdStartCard(entry.broadcast, entry.scored),
      );
    } else {
      const ranked: FeedRankResult = this.feedAi.rank(userId, candidates, {
        topK: cardLimit,
      });
      cards = ranked.ranked.map((r) => projectCard(r, trends));
    }

    const integrityHash = hashCards(cards);
    const topTrends = trends.predictions
      .slice(0, this.coldStartTrendCount)
      .map((t) => t.term);

    const feed: PreRenderedFeed = {
      userId,
      cards,
      generatedAt: nowDate.toISOString(),
      expiresAt: new Date(
        nowMs + this.feedTtlHours * 3_600_000,
      ).toISOString(),
      integrityHash,
      topTrends,
    };

    logger.debug(
      {
        userId,
        cardCount: cards.length,
        integrityHash,
        coldStart: !profile || profile.interactionCount === 0,
      },
      'PreRenderEngine built feed',
    );

    return feed;
  }

  /**
   * Build AND persist a pre-rendered feed to the cache dispatcher, ready
   * for instant service-worker delivery on next app open.
   */
  async preRenderForUser(
    userId: string,
    candidates: readonly BroadcastRecord[],
    options: { cardsPerUser?: number } = {},
  ): Promise<PreRenderedFeed> {
    const feed = this.buildFeed(userId, candidates, options);
    await this.cache.put(this.keyFor(userId), feed);
    return feed;
  }

  /** Pre-render for an explicit list of users. */
  async preRenderForUsers(
    userIds: readonly string[],
    candidates: readonly BroadcastRecord[],
    options: PreRenderBatchOptions = {},
  ): Promise<PreRenderedFeed[]> {
    const feeds: PreRenderedFeed[] = [];
    for (const userId of userIds) {
      const feed = await this.preRenderForUser(userId, candidates, {
        cardsPerUser: options.cardsPerUser,
      });
      feeds.push(feed);
    }
    return feeds;
  }

  /** Retrieve a previously-cached feed, respecting TTL. */
  async readCached(userId: string): Promise<PreRenderedFeed | null> {
    const cached = await this.cache.get(this.keyFor(userId));
    if (!cached) return null;
    const expiry = new Date(cached.expiresAt).getTime();
    if (Number.isFinite(expiry) && expiry < this.now().getTime()) {
      await this.cache.delete(this.keyFor(userId));
      return null;
    }
    return cached;
  }

  /**
   * Compare a cached feed against a freshly built one.  Returns a divergence
   * score in [0,1] — 0 means perfectly aligned, 1 means totally different.
   */
  divergence(cached: PreRenderedFeed, fresh: PreRenderedFeed): number {
    if (cached.cards.length === 0 && fresh.cards.length === 0) return 0;
    const cachedIds = new Set(cached.cards.map((c) => c.broadcastId));
    const freshIds = new Set(fresh.cards.map((c) => c.broadcastId));
    let intersection = 0;
    for (const id of cachedIds) {
      if (freshIds.has(id)) intersection += 1;
    }
    const union = new Set<string>([...cachedIds, ...freshIds]).size;
    if (union === 0) return 0;
    return 1 - intersection / union;
  }

  /**
   * Invalidate a user's feed if the freshly computed version has diverged
   * materially from the cached one.  Returns the action taken.
   */
  async refreshIfDiverged(
    userId: string,
    candidates: readonly BroadcastRecord[],
    threshold = 0.35,
  ): Promise<{ action: 'kept' | 'refreshed' | 'missing'; divergence: number }> {
    const cached = await this.readCached(userId);
    if (!cached) {
      await this.preRenderForUser(userId, candidates);
      return { action: 'missing', divergence: 1 };
    }
    const fresh = this.buildFeed(userId, candidates);
    const div = this.divergence(cached, fresh);
    if (div >= threshold) {
      await this.cache.put(this.keyFor(userId), fresh);
      return { action: 'refreshed', divergence: div };
    }
    return { action: 'kept', divergence: div };
  }

  /** Drop every cached feed (e.g. on global model updates). */
  async purgeAll(): Promise<number> {
    const keys = await this.cache.keys();
    let removed = 0;
    for (const key of keys) {
      if (key.startsWith(this.cacheKeyPrefix)) {
        await this.cache.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of cards that should be fully rendered by the client. */
  get fullRenderLimit(): number {
    return this.fullyRenderedCount;
  }
}

// ---------------------------------------------------------------------------
// Auto-refresh scheduler
// ---------------------------------------------------------------------------

export interface PreRenderScheduleOptions {
  /** Refresh cadence in minutes. Default 30. */
  readonly refreshEveryMinutes?: number;
  /** Scheduler (test-injectable). */
  readonly scheduler?: PreRenderSchedulerApi;
  /** Function that returns the users for which to pre-render. */
  readonly getUserIds: () => Promise<readonly string[]> | readonly string[];
  /** Function that returns the current candidate corpus. */
  readonly getCandidates: () =>
    | Promise<readonly BroadcastRecord[]>
    | readonly BroadcastRecord[];
  /** Called on every completed refresh cycle. */
  readonly onCycle?: (feeds: readonly PreRenderedFeed[]) => void;
  /** Called when a refresh cycle throws. */
  readonly onError?: (err: unknown) => void;
}

export function startPreRenderSchedule(
  engine: PreRenderEngine,
  options: PreRenderScheduleOptions,
): () => void {
  const scheduler = options.scheduler ?? defaultPreRenderScheduler;
  const intervalMs = (options.refreshEveryMinutes ?? 30) * 60_000;
  let disposed = false;

  const tick = async (): Promise<void> => {
    if (disposed) return;
    try {
      const [userIds, candidates] = await Promise.all([
        Promise.resolve(options.getUserIds()),
        Promise.resolve(options.getCandidates()),
      ]);
      const feeds = await engine.preRenderForUsers(userIds, candidates);
      options.onCycle?.(feeds);
    } catch (err) {
      options.onError?.(err);
      logger.warn({ err }, 'PreRenderEngine schedule tick failed');
    }
  };

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

export default PreRenderEngine;
