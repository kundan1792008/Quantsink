/**
 * PreRenderEngine
 *
 * Pre-fetches and caches the top-20 predicted feed items for each user so
 * that content is available instantly on app open — zero loading screens.
 *
 * Architecture:
 *  - In-process LRU-style cache stores up to `maxCachedUsersCount` user
 *    entries (default 500).
 *  - Each entry contains up to `preRenderCount` pre-rendered card payloads
 *    (default 20) and a staleness TTL.
 *  - A "pre-render" step serialises the first `preRenderFirstN` cards
 *    (default 5) into static HTML/JSON snapshots suitable for injection into
 *    a Service Worker cache.
 *  - The engine exposes a `ServiceWorkerBridge` interface so the browser-side
 *    SW can hydrate from these snapshots without a network round-trip.
 *  - Stale cache entries are automatically invalidated when the prediction
 *    diverges from cached content by more than `divergenceThreshold`.
 */

import logger from '../lib/logger';
import type { RankedItem, BroadcastItem } from './PersonalizedFeedAI';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PreRenderedCard {
  /** Broadcast ID. */
  readonly broadcastId: string;
  /** Rank position (0-indexed). */
  readonly rank: number;
  /** Static HTML snapshot of the card (for SW injection). */
  readonly htmlSnapshot: string;
  /** JSON-serialisable data payload for hydration. */
  readonly payload: BroadcastCardPayload;
  /** UTC epoch ms when this card was pre-rendered. */
  readonly renderedAt: number;
}

export interface BroadcastCardPayload {
  readonly id: string;
  readonly headline: string;
  readonly description: string;
  readonly authorId: string;
  readonly publishedAt: number;
  readonly engagementCount: number;
  readonly tags: readonly string[];
  readonly relevanceScore: number;
  readonly isFresh: boolean;
}

export interface UserFeedCache {
  readonly userId: string;
  /** All ranked broadcast IDs (up to feedSize). */
  readonly rankedIds: readonly string[];
  /** Full pre-rendered card objects for the first `preRenderFirstN` items. */
  readonly preRenderedCards: readonly PreRenderedCard[];
  /** Raw ranked items with scores, for divergence checking. */
  readonly rankedItems: readonly RankedItem[];
  /** UTC epoch ms when this cache entry was created. */
  readonly cachedAt: number;
  /** UTC epoch ms after which this entry is considered stale. */
  readonly expiresAt: number;
  /** Cache hit counter — how many times this entry was served. */
  hits: number;
}

export interface CacheStats {
  readonly totalUsers: number;
  readonly totalPreRenderedCards: number;
  readonly avgHitsPerUser: number;
  readonly oldestEntryMs: number | null;
  readonly newestEntryMs: number | null;
}

export interface PreRenderEngineOptions {
  /** Injected clock. */
  readonly now?: () => number;
  /** TTL for cache entries in milliseconds (default: 30 minutes). */
  readonly cacheTtlMs?: number;
  /** Maximum number of users to cache simultaneously (default: 500). */
  readonly maxCachedUsers?: number;
  /** Number of feed items to cache per user (default: 20). */
  readonly feedCacheSize?: number;
  /** Number of cards to fully pre-render (default: 5). */
  readonly preRenderFirstN?: number;
  /**
   * If the Jaccard distance between the new prediction and the cached
   * ranked IDs exceeds this threshold, the entry is invalidated (default: 0.4).
   */
  readonly divergenceThreshold?: number;
}

/** Minimal interface representing a Service Worker Cache interaction. */
export interface ServiceWorkerBridge {
  /**
   * Store pre-rendered cards in the SW cache under a versioned URL pattern.
   * Returns the number of cards successfully stored.
   */
  store(userId: string, cards: readonly PreRenderedCard[]): Promise<number>;
  /**
   * Retrieve cached cards for a user from the SW cache.
   * Returns null if no cache entry exists.
   */
  retrieve(userId: string): Promise<readonly PreRenderedCard[] | null>;
  /**
   * Invalidate all cached entries for a user.
   */
  invalidate(userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTML snapshot generator
// ---------------------------------------------------------------------------

/**
 * Produce a minimal, self-contained HTML card string that can be injected
 * into the DOM before React hydration.
 *
 * The markup is intentionally lightweight — it provides visual structure for
 * instant paint while the full React component hydrates in the background.
 */
function generateHtmlSnapshot(payload: BroadcastCardPayload, rank: number): string {
  const tagsHtml = payload.tags
    .map((t) => `<span class="qs-tag">${escapeHtml(t)}</span>`)
    .join('');

  const freshBadge = payload.isFresh
    ? '<span class="qs-fresh-badge" aria-label="Fresh content">FRESH</span>'
    : '<span class="qs-cached-badge" aria-label="Pre-cached content">PRE-CACHED</span>';

  return `<article
  class="qs-broadcast-card qs-pre-rendered"
  data-broadcast-id="${escapeAttr(payload.id)}"
  data-rank="${rank}"
  data-rendered-at="${payload.publishedAt}"
  aria-label="Broadcast by author ${escapeAttr(payload.authorId)}"
>
  <header class="qs-card-header">
    ${freshBadge}
    <h2 class="qs-headline">${escapeHtml(payload.headline)}</h2>
  </header>
  <p class="qs-description">${escapeHtml(payload.description)}</p>
  <footer class="qs-card-footer">
    <div class="qs-tags">${tagsHtml}</div>
    <span class="qs-engagement">${payload.engagementCount.toLocaleString()}</span>
    <span class="qs-relevance">${payload.relevanceScore}%</span>
  </footer>
</article>`.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Divergence check
// ---------------------------------------------------------------------------

/**
 * Jaccard distance between two ordered lists of broadcast IDs.
 * Uses set semantics — order is ignored for the distance calculation.
 * Returns a value in [0, 1] where 0 = identical, 1 = no overlap.
 */
function jaccardDistance(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const id of setA) {
    if (setB.has(id)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

// ---------------------------------------------------------------------------
// LRU eviction helper
// ---------------------------------------------------------------------------

/** Return the userId with the fewest hits (evict least-used entry). */
function lruEvictTarget(cache: Map<string, UserFeedCache>): string {
  let minHits = Infinity;
  let candidate = '';
  for (const [uid, entry] of cache) {
    if (entry.hits < minHits) {
      minHits = entry.hits;
      candidate = uid;
    }
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// PreRenderEngine
// ---------------------------------------------------------------------------

export class PreRenderEngine {
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxCachedUsers: number;
  private readonly feedCacheSize: number;
  private readonly preRenderFirstN: number;
  private readonly divergenceThreshold: number;

  private readonly cache = new Map<string, UserFeedCache>();

  constructor(options: PreRenderEngineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.cacheTtlMs = options.cacheTtlMs ?? 30 * 60 * 1_000;
    this.maxCachedUsers = options.maxCachedUsers ?? 500;
    this.feedCacheSize = options.feedCacheSize ?? 20;
    this.preRenderFirstN = options.preRenderFirstN ?? 5;
    this.divergenceThreshold = options.divergenceThreshold ?? 0.4;
  }

  // -------------------------------------------------------------------------
  // Cache population
  // -------------------------------------------------------------------------

  /**
   * Pre-render and cache the feed for a user.
   *
   * @param userId         Target user.
   * @param rankedItems    Output from PersonalizedFeedAI.rankFeed().
   * @param broadcastMap   Lookup map from broadcast ID → BroadcastItem.
   * @param swBridge       Optional Service Worker bridge for offline support.
   * @returns The populated UserFeedCache entry.
   */
  async preCacheFeed(
    userId: string,
    rankedItems: readonly RankedItem[],
    broadcastMap: Map<string, BroadcastItem>,
    swBridge?: ServiceWorkerBridge,
  ): Promise<UserFeedCache> {
    const nowMs = this.now();

    // Evict stale entries and enforce max cache size
    this.evictStaleEntries();
    if (this.cache.size >= this.maxCachedUsers && !this.cache.has(userId)) {
      const evictTarget = lruEvictTarget(this.cache);
      if (evictTarget) this.cache.delete(evictTarget);
    }

    const capped = rankedItems.slice(0, this.feedCacheSize);
    const rankedIds = capped.map((r) => r.broadcastId);

    // Build pre-rendered cards for first N items
    const preRenderedCards: PreRenderedCard[] = [];
    for (let i = 0; i < Math.min(this.preRenderFirstN, capped.length); i++) {
      const item = capped[i];
      const broadcast = broadcastMap.get(item.broadcastId);
      if (!broadcast) continue;

      const ageFactor = (nowMs - broadcast.publishedAt) / (60 * 60 * 1_000);
      const isFresh = ageFactor < 1; // fresh if < 1 hour old

      const payload: BroadcastCardPayload = {
        id: broadcast.id,
        headline: this.extractHeadline(broadcast.content),
        description: this.extractDescription(broadcast.content),
        authorId: broadcast.authorId,
        publishedAt: broadcast.publishedAt,
        engagementCount: broadcast.engagementCount,
        tags: broadcast.tags ?? [],
        relevanceScore: Math.round(item.contentScore * 100),
        isFresh,
      };

      const htmlSnapshot = generateHtmlSnapshot(payload, i);

      preRenderedCards.push({
        broadcastId: item.broadcastId,
        rank: i,
        htmlSnapshot,
        payload,
        renderedAt: nowMs,
      });
    }

    const entry: UserFeedCache = {
      userId,
      rankedIds,
      preRenderedCards,
      rankedItems: capped,
      cachedAt: nowMs,
      expiresAt: nowMs + this.cacheTtlMs,
      hits: 0,
    };

    this.cache.set(userId, entry);

    // Push to Service Worker cache for offline support
    if (swBridge && preRenderedCards.length > 0) {
      try {
        const stored = await swBridge.store(userId, preRenderedCards);
        logger.debug({ userId, stored }, 'PreRenderEngine pushed to SW cache');
      } catch (err) {
        logger.warn({ userId, err }, 'PreRenderEngine SW cache push failed — continuing in-process');
      }
    }

    logger.info(
      { userId, rankedCount: capped.length, preRenderedCount: preRenderedCards.length },
      'PreRenderEngine feed pre-cached',
    );

    return entry;
  }

  // -------------------------------------------------------------------------
  // Cache retrieval
  // -------------------------------------------------------------------------

  /**
   * Retrieve a user's cached feed.
   * Returns null if no entry exists or the entry has expired.
   * Increments the hit counter on success.
   */
  getCachedFeed(userId: string): UserFeedCache | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (this.now() > entry.expiresAt) {
      this.cache.delete(userId);
      logger.debug({ userId }, 'PreRenderEngine cache entry expired on retrieval');
      return null;
    }
    entry.hits++;
    return entry;
  }

  /**
   * Attempt to retrieve from SW cache if in-process cache misses.
   * Falls back gracefully if the bridge is unavailable.
   */
  async getCachedFeedWithSWFallback(
    userId: string,
    swBridge?: ServiceWorkerBridge,
  ): Promise<UserFeedCache | readonly PreRenderedCard[] | null> {
    const inProcess = this.getCachedFeed(userId);
    if (inProcess) return inProcess;

    if (!swBridge) return null;

    try {
      const swCards = await swBridge.retrieve(userId);
      if (swCards && swCards.length > 0) {
        logger.debug({ userId, cardCount: swCards.length }, 'PreRenderEngine SW cache hit');
        return swCards;
      }
    } catch (err) {
      logger.warn({ userId, err }, 'PreRenderEngine SW cache retrieve failed');
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------

  /**
   * Invalidate the cache entry for a user if the new ranked IDs diverge
   * from the cached IDs beyond the configured threshold.
   *
   * @returns true if the entry was invalidated, false if it was kept.
   */
  async invalidateIfDiverged(
    userId: string,
    newRankedIds: readonly string[],
    swBridge?: ServiceWorkerBridge,
  ): Promise<boolean> {
    const entry = this.cache.get(userId);
    if (!entry) return false;

    const distance = jaccardDistance(entry.rankedIds, newRankedIds);
    if (distance > this.divergenceThreshold) {
      this.cache.delete(userId);
      if (swBridge) {
        try {
          await swBridge.invalidate(userId);
        } catch (err) {
          logger.warn({ userId, err }, 'PreRenderEngine SW invalidation failed');
        }
      }
      logger.info({ userId, distance }, 'PreRenderEngine cache invalidated due to divergence');
      return true;
    }

    return false;
  }

  /**
   * Unconditionally remove a user's cache entry.
   */
  async invalidateUser(userId: string, swBridge?: ServiceWorkerBridge): Promise<void> {
    this.cache.delete(userId);
    if (swBridge) {
      try {
        await swBridge.invalidate(userId);
      } catch (err) {
        logger.warn({ userId, err }, 'PreRenderEngine SW force-invalidation failed');
      }
    }
  }

  /**
   * Evict all entries that have passed their TTL.
   * Called automatically on each `preCacheFeed` invocation.
   */
  evictStaleEntries(): void {
    const nowMs = this.now();
    let evicted = 0;
    for (const [uid, entry] of this.cache) {
      if (nowMs > entry.expiresAt) {
        this.cache.delete(uid);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.debug({ evicted }, 'PreRenderEngine stale entries evicted');
    }
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Return aggregate statistics about the current cache state.
   */
  getStats(): CacheStats {
    let totalCards = 0;
    let totalHits = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const entry of this.cache.values()) {
      totalCards += entry.preRenderedCards.length;
      totalHits += entry.hits;
      if (oldest === null || entry.cachedAt < oldest) oldest = entry.cachedAt;
      if (newest === null || entry.cachedAt > newest) newest = entry.cachedAt;
    }

    return {
      totalUsers: this.cache.size,
      totalPreRenderedCards: totalCards,
      avgHitsPerUser: this.cache.size > 0 ? totalHits / this.cache.size : 0,
      oldestEntryMs: oldest,
      newestEntryMs: newest,
    };
  }

  /**
   * Return the number of users currently in the cache.
   */
  getCachedUserCount(): number {
    return this.cache.size;
  }

  /**
   * Check whether a valid (non-expired) cache entry exists for a user.
   */
  hasCachedFeed(userId: string): boolean {
    const entry = this.cache.get(userId);
    if (!entry) return false;
    return this.now() <= entry.expiresAt;
  }

  /**
   * Flush the entire cache. Useful for testing or forced global refresh.
   */
  flush(): void {
    const count = this.cache.size;
    this.cache.clear();
    logger.info({ count }, 'PreRenderEngine cache flushed');
  }

  // -------------------------------------------------------------------------
  // Content extraction helpers
  // -------------------------------------------------------------------------

  /**
   * Extract a headline from broadcast content.
   * Uses the first sentence (up to 120 characters) as the headline.
   */
  private extractHeadline(content: string): string {
    const first = content.split(/[.!?\n]/)[0]?.trim() ?? content;
    return first.length > 120 ? first.slice(0, 117) + '…' : first;
  }

  /**
   * Extract a short description from broadcast content.
   * Uses content after the first sentence, up to 280 characters.
   */
  private extractDescription(content: string): string {
    const parts = content.split(/[.!?\n]/);
    const body = parts.slice(1).join('. ').trim();
    if (!body) return content.slice(0, 280);
    return body.length > 280 ? body.slice(0, 277) + '…' : body;
  }
}

export default PreRenderEngine;
