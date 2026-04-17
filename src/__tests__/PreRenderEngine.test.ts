import PreRenderEngine, {
  ServiceWorkerBridge,
  PreRenderedCard,
} from '../services/PreRenderEngine';
import type { RankedItem, BroadcastItem } from '../services/PersonalizedFeedAI';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_TIME = new Date('2026-04-17T12:00:00Z').getTime();

function makeEngine(options: ConstructorParameters<typeof PreRenderEngine>[0] = {}) {
  return new PreRenderEngine({ now: () => BASE_TIME, ...options });
}

function makeBroadcast(id: string, ageHours: number, content?: string): BroadcastItem {
  return {
    id,
    content: content ?? `This is the headline for broadcast ${id}. Supporting detail about the topic follows here in the description.`,
    authorId: `author-${id}`,
    publishedAt: BASE_TIME - ageHours * 60 * 60 * 1_000,
    engagementCount: 100 + Number(id) * 10,
    tags: [`tag-${id}`, 'shared-tag'],
  };
}

function makeRankedItem(broadcastId: string, rank: number): RankedItem {
  return {
    broadcastId,
    score: 1 - rank * 0.05,
    contentScore: 0.6 - rank * 0.02,
    collaborativeScore: 0.4,
    timeDecay: 0.9,
    reason: 'matches your interests',
  };
}

function buildFixtures(count: number): {
  rankedItems: RankedItem[];
  broadcastMap: Map<string, BroadcastItem>;
} {
  const rankedItems: RankedItem[] = [];
  const broadcastMap = new Map<string, BroadcastItem>();
  for (let i = 0; i < count; i++) {
    const id = String(i + 1);
    rankedItems.push(makeRankedItem(id, i));
    broadcastMap.set(id, makeBroadcast(id, i));
  }
  return { rankedItems, broadcastMap };
}

// ---------------------------------------------------------------------------
// Null SW bridge (always succeeds silently)
// ---------------------------------------------------------------------------

class NullSWBridge implements ServiceWorkerBridge {
  async store(_userId: string, cards: readonly PreRenderedCard[]) {
    return cards.length;
  }
  async retrieve(_userId: string) {
    return null;
  }
  async invalidate(_userId: string) {
    return;
  }
}

// ---------------------------------------------------------------------------
// Tracking SW bridge (for spy assertions)
// ---------------------------------------------------------------------------

class TrackingSWBridge implements ServiceWorkerBridge {
  stored: Map<string, readonly PreRenderedCard[]> = new Map();
  invalidated: string[] = [];

  async store(userId: string, cards: readonly PreRenderedCard[]) {
    this.stored.set(userId, cards);
    return cards.length;
  }
  async retrieve(userId: string) {
    return this.stored.get(userId) ?? null;
  }
  async invalidate(userId: string) {
    this.invalidated.push(userId);
    this.stored.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// Basic cache population
// ---------------------------------------------------------------------------

describe('PreRenderEngine — preCacheFeed', () => {
  it('returns a UserFeedCache with the correct userId', async () => {
    const engine = makeEngine();
    const { rankedItems, broadcastMap } = buildFixtures(10);
    const entry = await engine.preCacheFeed('user-1', rankedItems, broadcastMap);
    expect(entry.userId).toBe('user-1');
  });

  it('stores up to feedCacheSize ranked IDs', async () => {
    const engine = makeEngine({ feedCacheSize: 5 });
    const { rankedItems, broadcastMap } = buildFixtures(20);
    const entry = await engine.preCacheFeed('user-1', rankedItems, broadcastMap);
    expect(entry.rankedIds.length).toBeLessThanOrEqual(5);
  });

  it('pre-renders only the first preRenderFirstN cards', async () => {
    const engine = makeEngine({ preRenderFirstN: 3 });
    const { rankedItems, broadcastMap } = buildFixtures(20);
    const entry = await engine.preCacheFeed('user-1', rankedItems, broadcastMap);
    expect(entry.preRenderedCards.length).toBeLessThanOrEqual(3);
  });

  it('assigns sequential rank to pre-rendered cards', async () => {
    const engine = makeEngine({ preRenderFirstN: 5 });
    const { rankedItems, broadcastMap } = buildFixtures(10);
    const entry = await engine.preCacheFeed('user-1', rankedItems, broadcastMap);
    entry.preRenderedCards.forEach((card, i) => {
      expect(card.rank).toBe(i);
    });
  });

  it('sets isFresh=true for cards published within the last hour', async () => {
    const engine = makeEngine({ preRenderFirstN: 5 });
    const rankedItems: RankedItem[] = [makeRankedItem('fresh-1', 0)];
    const broadcastMap = new Map<string, BroadcastItem>([
      ['fresh-1', makeBroadcast('fresh-1', 0.5)], // 30 min old
    ]);
    const entry = await engine.preCacheFeed('user-x', rankedItems, broadcastMap);
    expect(entry.preRenderedCards[0].payload.isFresh).toBe(true);
  });

  it('sets isFresh=false for cards older than 1 hour', async () => {
    const engine = makeEngine({ preRenderFirstN: 5 });
    const rankedItems: RankedItem[] = [makeRankedItem('old-1', 0)];
    const broadcastMap = new Map<string, BroadcastItem>([
      ['old-1', makeBroadcast('old-1', 3)], // 3 hours old
    ]);
    const entry = await engine.preCacheFeed('user-x', rankedItems, broadcastMap);
    expect(entry.preRenderedCards[0].payload.isFresh).toBe(false);
  });

  it('pushes pre-rendered cards to the SW bridge', async () => {
    const engine = makeEngine({ preRenderFirstN: 3 });
    const swBridge = new TrackingSWBridge();
    const { rankedItems, broadcastMap } = buildFixtures(10);
    await engine.preCacheFeed('user-sw', rankedItems, broadcastMap, swBridge);
    expect(swBridge.stored.has('user-sw')).toBe(true);
    expect(swBridge.stored.get('user-sw')!.length).toBeLessThanOrEqual(3);
  });

  it('htmlSnapshot contains the broadcast id as a data attribute', async () => {
    const engine = makeEngine({ preRenderFirstN: 1 });
    const { rankedItems, broadcastMap } = buildFixtures(1);
    const entry = await engine.preCacheFeed('user-1', rankedItems, broadcastMap);
    const card = entry.preRenderedCards[0];
    expect(card.htmlSnapshot).toContain(`data-broadcast-id="${card.broadcastId}"`);
  });
});

// ---------------------------------------------------------------------------
// Cache retrieval
// ---------------------------------------------------------------------------

describe('PreRenderEngine — getCachedFeed', () => {
  it('returns null when no cache exists', () => {
    const engine = makeEngine();
    expect(engine.getCachedFeed('unknown-user')).toBeNull();
  });

  it('returns the entry and increments hit counter', async () => {
    const engine = makeEngine();
    const { rankedItems, broadcastMap } = buildFixtures(5);
    await engine.preCacheFeed('user-1', rankedItems, broadcastMap);
    const entry = engine.getCachedFeed('user-1');
    expect(entry).not.toBeNull();
    expect(entry!.hits).toBe(1);
    engine.getCachedFeed('user-1');
    expect(engine.getCachedFeed('user-1')!.hits).toBe(3);
  });

  it('returns null and evicts entries past their TTL', async () => {
    const clock = { t: BASE_TIME };
    const engine = new PreRenderEngine({ now: () => clock.t, cacheTtlMs: 1_000 });
    const { rankedItems, broadcastMap } = buildFixtures(5);
    await engine.preCacheFeed('user-1', rankedItems, broadcastMap);
    clock.t += 2_000; // advance past TTL
    expect(engine.getCachedFeed('user-1')).toBeNull();
    expect(engine.hasCachedFeed('user-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasCachedFeed
// ---------------------------------------------------------------------------

describe('PreRenderEngine — hasCachedFeed', () => {
  it('returns false before any caching', () => {
    const engine = makeEngine();
    expect(engine.hasCachedFeed('nobody')).toBe(false);
  });

  it('returns true after successful caching', async () => {
    const engine = makeEngine();
    const { rankedItems, broadcastMap } = buildFixtures(5);
    await engine.preCacheFeed('user-check', rankedItems, broadcastMap);
    expect(engine.hasCachedFeed('user-check')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Divergence-based invalidation
// ---------------------------------------------------------------------------

describe('PreRenderEngine — invalidateIfDiverged', () => {
  it('invalidates when Jaccard distance exceeds threshold', async () => {
    const engine = makeEngine({ divergenceThreshold: 0.3 });
    const { rankedItems, broadcastMap } = buildFixtures(10);
    await engine.preCacheFeed('user-d', rankedItems, broadcastMap);

    // Completely new set of IDs
    const newIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const invalidated = await engine.invalidateIfDiverged('user-d', newIds);
    expect(invalidated).toBe(true);
    expect(engine.hasCachedFeed('user-d')).toBe(false);
  });

  it('keeps the cache when IDs are similar enough', async () => {
    const engine = makeEngine({ divergenceThreshold: 0.5 });
    const { rankedItems, broadcastMap } = buildFixtures(10);
    await engine.preCacheFeed('user-d', rankedItems, broadcastMap);

    // Same IDs — distance = 0
    const sameIds = rankedItems.map((r) => r.broadcastId);
    const invalidated = await engine.invalidateIfDiverged('user-d', sameIds);
    expect(invalidated).toBe(false);
    expect(engine.hasCachedFeed('user-d')).toBe(true);
  });

  it('returns false when no cache entry exists for the user', async () => {
    const engine = makeEngine();
    const result = await engine.invalidateIfDiverged('ghost-user', ['x', 'y']);
    expect(result).toBe(false);
  });

  it('calls SW bridge invalidate when entry is removed', async () => {
    const engine = makeEngine({ divergenceThreshold: 0.1 });
    const swBridge = new TrackingSWBridge();
    const { rankedItems, broadcastMap } = buildFixtures(5);
    await engine.preCacheFeed('user-sw-inv', rankedItems, broadcastMap, swBridge);
    await engine.invalidateIfDiverged('user-sw-inv', ['totally', 'different', 'ids'], swBridge);
    expect(swBridge.invalidated).toContain('user-sw-inv');
  });
});

// ---------------------------------------------------------------------------
// Force invalidation
// ---------------------------------------------------------------------------

describe('PreRenderEngine — invalidateUser', () => {
  it('removes the user entry from cache', async () => {
    const engine = makeEngine();
    const { rankedItems, broadcastMap } = buildFixtures(5);
    await engine.preCacheFeed('user-fi', rankedItems, broadcastMap);
    expect(engine.hasCachedFeed('user-fi')).toBe(true);
    await engine.invalidateUser('user-fi');
    expect(engine.hasCachedFeed('user-fi')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

describe('PreRenderEngine — getStats', () => {
  it('returns zero stats for an empty cache', () => {
    const engine = makeEngine();
    const stats = engine.getStats();
    expect(stats.totalUsers).toBe(0);
    expect(stats.totalPreRenderedCards).toBe(0);
    expect(stats.avgHitsPerUser).toBe(0);
  });

  it('increments totalUsers per cached user', async () => {
    const engine = makeEngine();
    const { rankedItems: r1, broadcastMap: m1 } = buildFixtures(5);
    const { rankedItems: r2, broadcastMap: m2 } = buildFixtures(5);
    await engine.preCacheFeed('ua', r1, m1);
    await engine.preCacheFeed('ub', r2, m2);
    expect(engine.getStats().totalUsers).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

describe('PreRenderEngine — flush', () => {
  it('clears all cache entries', async () => {
    const engine = makeEngine();
    const { rankedItems, broadcastMap } = buildFixtures(5);
    await engine.preCacheFeed('u1', rankedItems, broadcastMap);
    await engine.preCacheFeed('u2', rankedItems, broadcastMap);
    engine.flush();
    expect(engine.getCachedUserCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction under maxCachedUsers
// ---------------------------------------------------------------------------

describe('PreRenderEngine — LRU eviction', () => {
  it('evicts the LRU entry when capacity is exceeded', async () => {
    const engine = makeEngine({ maxCachedUsers: 3 });
    const { rankedItems, broadcastMap } = buildFixtures(5);

    await engine.preCacheFeed('u1', rankedItems, broadcastMap);
    await engine.preCacheFeed('u2', rankedItems, broadcastMap);
    await engine.preCacheFeed('u3', rankedItems, broadcastMap);
    // Hit u2 and u3 to make u1 the LRU
    engine.getCachedFeed('u2');
    engine.getCachedFeed('u3');
    // Adding u4 should evict u1
    await engine.preCacheFeed('u4', rankedItems, broadcastMap);
    expect(engine.getCachedUserCount()).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// SW fallback retrieval
// ---------------------------------------------------------------------------

describe('PreRenderEngine — getCachedFeedWithSWFallback', () => {
  it('returns the in-process entry when available', async () => {
    const engine = makeEngine();
    const { rankedItems, broadcastMap } = buildFixtures(5);
    await engine.preCacheFeed('u-sw', rankedItems, broadcastMap);
    const result = await engine.getCachedFeedWithSWFallback('u-sw');
    expect(result).not.toBeNull();
  });

  it('falls back to SW bridge when in-process cache misses', async () => {
    const engine = makeEngine();
    const swBridge = new TrackingSWBridge();
    const fakeCards: PreRenderedCard[] = [
      {
        broadcastId: 'sw-b1',
        rank: 0,
        htmlSnapshot: '<article>SW card</article>',
        payload: {
          id: 'sw-b1', headline: 'SW headline', description: 'SW desc',
          authorId: 'a1', publishedAt: BASE_TIME, engagementCount: 50,
          tags: [], relevanceScore: 75, isFresh: true,
        },
        renderedAt: BASE_TIME,
      },
    ];
    await swBridge.store('sw-user', fakeCards);
    const result = await engine.getCachedFeedWithSWFallback('sw-user', swBridge);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns null when both in-process and SW caches miss', async () => {
    const engine = makeEngine();
    const swBridge = new NullSWBridge();
    const result = await engine.getCachedFeedWithSWFallback('missing-user', swBridge);
    expect(result).toBeNull();
  });
});
