import {
  NotificationAggregator,
  InMemoryNotificationStore,
  NotificationRateLimiter,
  DeduplicationCache,
  APP_EVENT_MAP,
} from '../services/NotificationAggregator';
import type { RawNotificationEvent, QuantApp } from '../services/NotificationAggregator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idSeq = 0;

function makeEvent(
  overrides: Partial<RawNotificationEvent> = {},
): RawNotificationEvent {
  idSeq += 1;
  return {
    eventId: `evt-${idSeq}`,
    app: 'quantchat',
    type: 'message',
    title: `Test notification ${idSeq}`,
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryNotificationStore
// ---------------------------------------------------------------------------

describe('InMemoryNotificationStore', () => {
  it('stores and retrieves notifications', async () => {
    const store = new InMemoryNotificationStore();
    const n = {
      id: 1,
      eventId: 'e1',
      app: 'quantsink' as QuantApp,
      type: 'broadcast' as const,
      title: 'Hello',
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      read: false,
      priorityScore: 5,
    };
    await store.put(n);
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Hello');
  });

  it('marks single notification as read', async () => {
    const store = new InMemoryNotificationStore();
    const n = {
      id: 2,
      eventId: 'e2',
      app: 'quantchat' as QuantApp,
      type: 'message' as const,
      title: 'Msg',
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      read: false,
      priorityScore: 10,
    };
    await store.put(n);
    await store.markRead(2);
    const all = await store.getAll();
    expect(all[0].read).toBe(true);
  });

  it('marks all notifications as read for a specific app', async () => {
    const store = new InMemoryNotificationStore();
    for (let i = 1; i <= 4; i++) {
      await store.put({
        id: i,
        eventId: `e${i}`,
        app: (i <= 2 ? 'quantchat' : 'quantsink') as QuantApp,
        type: 'message' as const,
        title: `n${i}`,
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        read: false,
        priorityScore: 5,
      });
    }
    await store.markAllRead('quantchat');
    const all = await store.getAll();
    const chat = all.filter((n) => n.app === 'quantchat');
    const sink = all.filter((n) => n.app === 'quantsink');
    expect(chat.every((n) => n.read)).toBe(true);
    expect(sink.every((n) => !n.read)).toBe(true);
  });

  it('deletes a notification by id', async () => {
    const store = new InMemoryNotificationStore();
    await store.put({
      id: 10,
      eventId: 'e10',
      app: 'quanttube' as QuantApp,
      type: 'video_engagement' as const,
      title: 'Video',
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      read: false,
      priorityScore: 5,
    });
    expect(await store.count()).toBe(1);
    await store.delete(10);
    expect(await store.count()).toBe(0);
  });

  it('clears all notifications', async () => {
    const store = new InMemoryNotificationStore();
    for (let i = 0; i < 5; i++) {
      await store.put({
        id: 100 + i,
        eventId: `ec${i}`,
        app: 'quantmail' as QuantApp,
        type: 'email' as const,
        title: `mail ${i}`,
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        read: false,
        priorityScore: 4,
      });
    }
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NotificationRateLimiter
// ---------------------------------------------------------------------------

describe('NotificationRateLimiter', () => {
  it('allows notifications up to the limit', () => {
    const limiter = new NotificationRateLimiter(3, 60_000);
    const now = 1_000_000;
    expect(limiter.allow('quantchat', now)).toBe(true);
    expect(limiter.allow('quantchat', now)).toBe(true);
    expect(limiter.allow('quantchat', now)).toBe(true);
    expect(limiter.allow('quantchat', now)).toBe(false);
  });

  it('resets after the window expires', () => {
    const limiter = new NotificationRateLimiter(2, 1_000);
    let now = 1_000_000;
    limiter.allow('quantsink', now);
    limiter.allow('quantsink', now);
    expect(limiter.allow('quantsink', now)).toBe(false);
    // Advance past the window.
    now += 1_001;
    expect(limiter.allow('quantsink', now)).toBe(true);
  });

  it('tracks limits per app independently', () => {
    const limiter = new NotificationRateLimiter(1, 60_000);
    const now = 1_000_000;
    expect(limiter.allow('quantchat', now)).toBe(true);
    expect(limiter.allow('quantchat', now)).toBe(false);
    expect(limiter.allow('quantsink', now)).toBe(true); // different app
  });

  it('reports remaining capacity', () => {
    const limiter = new NotificationRateLimiter(5, 60_000);
    const now = 1_000_000;
    limiter.allow('quanttube', now);
    limiter.allow('quanttube', now);
    expect(limiter.remaining('quanttube', now)).toBe(3);
  });

  it('resets all buckets on reset()', () => {
    const limiter = new NotificationRateLimiter(1, 60_000);
    const now = 1_000_000;
    limiter.allow('quantchat', now);
    limiter.reset();
    expect(limiter.allow('quantchat', now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DeduplicationCache
// ---------------------------------------------------------------------------

describe('DeduplicationCache', () => {
  it('marks a new event id as new', () => {
    const cache = new DeduplicationCache(30_000);
    expect(cache.isNew('evt-abc', 1000)).toBe(true);
  });

  it('suppresses duplicate within TTL', () => {
    const cache = new DeduplicationCache(30_000);
    cache.isNew('evt-dup', 1000);
    expect(cache.isNew('evt-dup', 1000 + 1000)).toBe(false);
  });

  it('allows the same id after TTL expires', () => {
    const cache = new DeduplicationCache(500);
    cache.isNew('evt-ttl', 1000);
    expect(cache.isNew('evt-ttl', 1000 + 600)).toBe(true);
  });

  it('evicts expired entries', () => {
    const cache = new DeduplicationCache(100);
    cache.isNew('evt-evict', 1000);
    expect(cache.size()).toBe(1);
    cache.evictExpired(1000 + 200);
    expect(cache.size()).toBe(0);
  });

  it('clears all entries', () => {
    const cache = new DeduplicationCache(30_000);
    cache.isNew('a', 1000);
    cache.isNew('b', 1000);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// APP_EVENT_MAP
// ---------------------------------------------------------------------------

describe('APP_EVENT_MAP', () => {
  it('maps all 9 apps to event types', () => {
    const apps = Object.keys(APP_EVENT_MAP);
    expect(apps).toHaveLength(9);
    expect(APP_EVENT_MAP.quantchat).toBe('message');
    expect(APP_EVENT_MAP.quantsink).toBe('broadcast');
    expect(APP_EVENT_MAP.quantchill).toBe('match');
    expect(APP_EVENT_MAP.quantads).toBe('ad_performance');
    expect(APP_EVENT_MAP.quantedits).toBe('edit_share');
    expect(APP_EVENT_MAP.quanttube).toBe('video_engagement');
    expect(APP_EVENT_MAP.quantmail).toBe('email');
    expect(APP_EVENT_MAP.quantneon).toBe('metaverse_event');
    expect(APP_EVENT_MAP.quantbrowse).toBe('web_clip');
  });
});

// ---------------------------------------------------------------------------
// NotificationAggregator — core pipeline
// ---------------------------------------------------------------------------

describe('NotificationAggregator — ingest pipeline', () => {
  function makeAggregator() {
    const store = new InMemoryNotificationStore();
    const rateLimiter = new NotificationRateLimiter(20, 60_000);
    const dedupCache = new DeduplicationCache(30_000);
    const aggregator = new NotificationAggregator({
      store,
      rateLimiter,
      dedupCache,
      autoConnect: false,
    });
    return { aggregator, store };
  }

  it('ingests a valid event and returns an aggregated notification', () => {
    const { aggregator } = makeAggregator();
    const result = aggregator.ingest(makeEvent());
    expect(result).not.toBeNull();
    expect(result!.read).toBe(false);
    expect(result!.priorityScore).toBe(0);
    expect(typeof result!.id).toBe('number');
    aggregator.destroy();
  });

  it('deduplicates identical event ids', () => {
    const { aggregator } = makeAggregator();
    const evt = makeEvent({ eventId: 'dup-001' });
    const first = aggregator.ingest(evt);
    const second = aggregator.ingest(evt);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    aggregator.destroy();
  });

  it('drops notifications that exceed the rate limit', () => {
    const store = new InMemoryNotificationStore();
    const rateLimiter = new NotificationRateLimiter(3, 60_000);
    const dedupCache = new DeduplicationCache(30_000);
    const aggregator = new NotificationAggregator({
      store, rateLimiter, dedupCache, autoConnect: false,
    });

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(aggregator.ingest(makeEvent({ app: 'quantchat' })));
    }
    const passed = results.filter(Boolean);
    const dropped = results.filter((r) => r === null);
    expect(passed).toHaveLength(3);
    expect(dropped).toHaveLength(2);
    aggregator.destroy();
  });

  it('notifies listeners when a new event is ingested', () => {
    const { aggregator } = makeAggregator();
    const received: unknown[] = [];
    aggregator.subscribe((n) => received.push(n));
    aggregator.ingest(makeEvent());
    expect(received).toHaveLength(1);
    aggregator.destroy();
  });

  it('unsubscribe stops listener from receiving future events', () => {
    const { aggregator } = makeAggregator();
    const received: unknown[] = [];
    const unsub = aggregator.subscribe((n) => received.push(n));
    aggregator.ingest(makeEvent());
    unsub();
    aggregator.ingest(makeEvent());
    expect(received).toHaveLength(1);
    aggregator.destroy();
  });

  it('persists notification to store on ingest', async () => {
    const { aggregator, store } = makeAggregator();
    aggregator.ingest(makeEvent());
    // give the async store.put a tick to resolve
    await new Promise((r) => setTimeout(r, 10));
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    aggregator.destroy();
  });

  it('getByApp filters by source app', async () => {
    const { aggregator } = makeAggregator();
    aggregator.ingest(makeEvent({ app: 'quantchat' }));
    aggregator.ingest(makeEvent({ app: 'quantsink' }));
    aggregator.ingest(makeEvent({ app: 'quantchat' }));
    await new Promise((r) => setTimeout(r, 10));
    const chatOnly = await aggregator.getByApp('quantchat');
    expect(chatOnly).toHaveLength(2);
    aggregator.destroy();
  });

  it('markAllRead marks all unread items', async () => {
    const { aggregator } = makeAggregator();
    for (let i = 0; i < 3; i++) aggregator.ingest(makeEvent({ app: 'quantmail' }));
    await new Promise((r) => setTimeout(r, 10));
    await aggregator.markAllRead('quantmail');
    const unread = await aggregator.getUnread();
    expect(unread.filter((n) => n.app === 'quantmail')).toHaveLength(0);
    aggregator.destroy();
  });

  it('badgeCounts returns correct counts per app', async () => {
    const { aggregator } = makeAggregator();
    aggregator.ingest(makeEvent({ app: 'quantchat' }));
    aggregator.ingest(makeEvent({ app: 'quantchat' }));
    aggregator.ingest(makeEvent({ app: 'quanttube' }));
    await new Promise((r) => setTimeout(r, 10));
    const counts = await aggregator.badgeCounts();
    expect(counts.quantchat).toBe(2);
    expect(counts.quanttube).toBe(1);
    expect(counts.quantsink).toBe(0);
    aggregator.destroy();
  });

  it('diagnostics reports correct state', () => {
    const { aggregator } = makeAggregator();
    aggregator.ingest(makeEvent());
    const d = aggregator.diagnostics();
    expect(d.idCounter).toBe(1);
    expect(d.connected).toBe(false);
    aggregator.destroy();
  });
});
