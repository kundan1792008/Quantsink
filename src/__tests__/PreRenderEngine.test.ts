import {
  InMemoryCacheDispatcher,
  PreRenderEngine,
  startPreRenderSchedule,
  type PreRenderSchedulerApi,
} from '../services/PreRenderEngine';
import { PersonalizedFeedAI } from '../services/PersonalizedFeedAI';
import { TrendPredictor, type BroadcastRecord } from '../services/TrendPredictor';

const NOW = new Date('2026-04-17T12:00:00Z');

function makeBroadcast(
  id: string,
  text: string,
  offsetMs: number,
  engagement = 100,
  authorId = `author-${id}`,
  tags: string[] = [],
): BroadcastRecord {
  return {
    id,
    text,
    authorId,
    engagement,
    tags,
    postedAt: new Date(NOW.getTime() - offsetMs),
  };
}

function makeEngine(now = NOW) {
  const ai = new PersonalizedFeedAI({ now: () => now });
  const trend = new TrendPredictor({ now: () => now, minDocumentFrequency: 1 });
  const cache = new InMemoryCacheDispatcher();
  const engine = new PreRenderEngine(ai, trend, cache, {
    now: () => now,
    cardsPerUser: 10,
    fullyRenderedCount: 3,
    feedTtlHours: 1,
  });
  return { ai, trend, cache, engine };
}

describe('PreRenderEngine — build', () => {
  const broadcasts: BroadcastRecord[] = [
    makeBroadcast('b1', 'alpha decay regime shift', 60_000, 400),
    makeBroadcast('b2', 'alpha decay accelerating', 120_000, 500),
    makeBroadcast('b3', 'kalman filter signal', 180_000, 200),
    makeBroadcast('b4', 'unrelated lunch notes', 240_000, 10),
  ];

  it('produces a cold-start feed when no profile exists', () => {
    const { engine } = makeEngine();
    const feed = engine.buildFeed('ghost', broadcasts);
    expect(feed.cards.length).toBeGreaterThan(0);
    expect(feed.integrityHash).toMatch(/[a-f0-9]{8}/);
    expect(feed.topTrends.length).toBeGreaterThan(0);
  });

  it('uses personalised ranking once the profile has interactions', () => {
    const { ai, engine } = makeEngine();
    ai.buildProfile(
      'alice',
      [
        { userId: 'alice', broadcastId: 'b1', kind: 'like', at: NOW },
        { userId: 'alice', broadcastId: 'b2', kind: 'like', at: NOW },
      ],
      broadcasts,
      [],
    );
    const feed = engine.buildFeed('alice', broadcasts);
    expect(feed.cards[0].broadcastId).not.toBe('b4');
  });

  it('persists feeds into the cache dispatcher', async () => {
    const { engine, cache } = makeEngine();
    await engine.preRenderForUser('alice', broadcasts);
    const cached = await cache.get(engine.keyFor('alice'));
    expect(cached).not.toBeNull();
    expect(cached!.userId).toBe('alice');
  });

  it('readCached honours TTL expiry', async () => {
    const base = NOW;
    const { engine, cache } = makeEngine(base);
    await engine.preRenderForUser('alice', broadcasts);
    expect(await engine.readCached('alice')).not.toBeNull();
    // Expire: build a new engine with advanced time sharing the same cache.
    const laterNow = new Date(base.getTime() + 2 * 3600_000);
    const ai = new PersonalizedFeedAI({ now: () => laterNow });
    const trend = new TrendPredictor({ now: () => laterNow, minDocumentFrequency: 1 });
    const engine2 = new PreRenderEngine(ai, trend, cache, {
      now: () => laterNow,
      feedTtlHours: 1,
    });
    expect(await engine2.readCached('alice')).toBeNull();
  });
});

describe('PreRenderEngine — divergence / refresh', () => {
  const broadcasts: BroadcastRecord[] = [
    makeBroadcast('b1', 'alpha decay regime shift', 60_000, 400),
    makeBroadcast('b2', 'alpha decay accelerating', 120_000, 500),
    makeBroadcast('b3', 'kalman filter signal', 180_000, 200),
    makeBroadcast('b4', 'options volatility surface', 240_000, 300),
    makeBroadcast('b5', 'market microstructure dark pool', 300_000, 350),
  ];

  it('computes zero divergence for identical feeds', () => {
    const { engine } = makeEngine();
    const feed = engine.buildFeed('alice', broadcasts);
    expect(engine.divergence(feed, feed)).toBe(0);
  });

  it('computes non-zero divergence when feeds differ', () => {
    const { engine } = makeEngine();
    const feedA = engine.buildFeed('alice', broadcasts);
    const feedB = engine.buildFeed('alice', broadcasts.slice(0, 2));
    expect(engine.divergence(feedA, feedB)).toBeGreaterThan(0);
  });

  it('refreshes the cache when divergence exceeds the threshold', async () => {
    const { engine, cache } = makeEngine();
    await engine.preRenderForUser('alice', broadcasts);
    const hashBefore = (await cache.get(engine.keyFor('alice')))!.integrityHash;

    const newBroadcasts = [
      makeBroadcast('zzz', 'completely new breaking news', 10_000, 900),
    ];
    const outcome = await engine.refreshIfDiverged('alice', newBroadcasts, 0.1);
    expect(outcome.action).toBe('refreshed');
    expect(outcome.divergence).toBeGreaterThan(0);
    const hashAfter = (await cache.get(engine.keyFor('alice')))!.integrityHash;
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('keeps the cache when divergence is below threshold', async () => {
    const { engine } = makeEngine();
    await engine.preRenderForUser('alice', broadcasts);
    const outcome = await engine.refreshIfDiverged('alice', broadcasts, 0.5);
    expect(outcome.action).toBe('kept');
  });

  it('treats a missing cache as a cold miss', async () => {
    const { engine } = makeEngine();
    const outcome = await engine.refreshIfDiverged('fresh', broadcasts);
    expect(outcome.action).toBe('missing');
  });

  it('purges all cache entries under the engine prefix', async () => {
    const { engine } = makeEngine();
    await engine.preRenderForUsers(['alice', 'bob'], broadcasts);
    const removed = await engine.purgeAll();
    expect(removed).toBe(2);
  });
});

describe('PreRenderEngine — scheduling', () => {
  it('runs an eager pre-render cycle and wires interval', async () => {
    const { engine, cache } = makeEngine();
    const intervals: Array<() => void> = [];
    const scheduler: PreRenderSchedulerApi = {
      setInterval: (fn) => {
        intervals.push(fn);
        return { id: intervals.length };
      },
      clearInterval: () => undefined,
    };

    const corpus = [
      makeBroadcast('b1', 'alpha decay regime shift', 60_000, 400),
      makeBroadcast('b2', 'kalman filter signal', 90_000, 200),
    ];
    const users = ['alice'];
    const cycles: number[] = [];
    const dispose = startPreRenderSchedule(engine, {
      scheduler,
      refreshEveryMinutes: 30,
      getUserIds: () => users,
      getCandidates: () => corpus,
      onCycle: (feeds) => cycles.push(feeds.length),
    });

    await new Promise((r) => setImmediate(r));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(await cache.keys()).toContain(engine.keyFor('alice'));

    dispose();
  });

  it('surfaces scheduling errors via onError', async () => {
    const { engine } = makeEngine();
    const errors: unknown[] = [];
    const dispose = startPreRenderSchedule(engine, {
      scheduler: {
        setInterval: () => ({ id: 1 }),
        clearInterval: () => undefined,
      },
      getUserIds: () => {
        throw new Error('nope');
      },
      getCandidates: () => [],
      onError: (err) => errors.push(err),
    });
    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBe(1);
    dispose();
  });
});
