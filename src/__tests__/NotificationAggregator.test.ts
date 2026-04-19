import {
  InMemoryNotificationStore,
  NotificationAggregator,
  RawBusEvent,
  SlidingWindowRateLimiter,
  BusSocket,
  BusSocketFactory,
  UnifiedNotification,
} from '../services/NotificationAggregator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class FakeClock {
  constructor(public ms = 0) {}
  now = (): number => this.ms;
  advance(by: number): void { this.ms += by; }
}

interface FakeTimerHandle { id: number; run: () => void; at: number }

class FakeTimers {
  private nextId = 1;
  private readonly handles = new Map<number, FakeTimerHandle>();
  constructor(private readonly clock: FakeClock) {}

  setTimeout = (cb: () => void, ms: number): number => {
    const id = this.nextId++;
    this.handles.set(id, { id, run: cb, at: this.clock.now() + ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.handles.delete(handle as number);
  };
  setInterval = (cb: () => void, _ms: number): number => {
    const id = this.nextId++;
    this.handles.set(id, { id, run: cb, at: Infinity });
    return id;
  };
  clearInterval = (handle: unknown): void => {
    this.handles.delete(handle as number);
  };

  runPending(): void {
    for (const h of Array.from(this.handles.values())) {
      if (h.at <= this.clock.now()) {
        this.handles.delete(h.id);
        h.run();
      }
    }
  }
}

function makeFakeSocket(): { socket: BusSocket; factory: BusSocketFactory; trigger: {
  open: () => void;
  message: (raw: string) => void;
  close: (code?: number, reason?: string) => void;
  error: (err: Error) => void;
}; sent: string[] } {
  const sent: string[] = [];
  const hooks = {
    open: (): void => undefined,
    message: (_: string): void => undefined,
    close: (_c?: number, _r?: string): void => undefined,
    error: (_e: Error): void => undefined,
  };
  const socket: BusSocket = {
    url: 'ws://test.bus',
    send: (data) => { sent.push(data); },
    close: () => { /* no-op */ },
    onOpen: (cb) => { hooks.open = cb; },
    onMessage: (cb) => { hooks.message = cb; },
    onClose: (cb) => { hooks.close = cb; },
    onError: (cb) => { hooks.error = cb; },
  };
  const factory: BusSocketFactory = () => socket;
  return {
    socket,
    factory,
    sent,
    trigger: {
      open: () => hooks.open(),
      message: (raw) => hooks.message(raw),
      close: (c, r) => hooks.close(c, r),
      error: (e) => hooks.error(e),
    },
  };
}

function makeEvent(overrides: Partial<RawBusEvent> = {}): RawBusEvent {
  return {
    id: 'evt-1',
    dedupeKey: 'dk-1',
    app: 'quantchat',
    kind: 'message',
    title: 'Hello',
    body: 'Hi there',
    occurredAt: new Date(0).toISOString(),
    senderId: 'u-1',
    senderName: 'Ada',
    ...overrides,
  };
}

function makeAggregator(opts: {
  clock?: FakeClock;
  timers?: FakeTimers;
  socketFactory?: BusSocketFactory;
  maxPerMinute?: number;
} = {}) {
  const clock = opts.clock ?? new FakeClock();
  const timers = opts.timers ?? new FakeTimers(clock);
  const factory = opts.socketFactory ?? makeFakeSocket().factory;
  let counter = 0;
  const aggregator = new NotificationAggregator({
    busUrl: 'ws://test.bus',
    clock,
    timers,
    socketFactory: factory,
    idGenerator: () => `gen-${++counter}`,
    maxPerMinute: opts.maxPerMinute ?? 20,
  });
  return { aggregator, clock, timers };
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe('SlidingWindowRateLimiter', () => {
  it('admits up to capacity then denies', () => {
    const clock = new FakeClock();
    const l = new SlidingWindowRateLimiter(3, 1000, clock);
    expect(l.tryAdmit()).toBe(true);
    expect(l.tryAdmit()).toBe(true);
    expect(l.tryAdmit()).toBe(true);
    expect(l.tryAdmit()).toBe(false);
    expect(l.remaining()).toBe(0);
  });

  it('frees a slot when the window rolls forward', () => {
    const clock = new FakeClock();
    const l = new SlidingWindowRateLimiter(2, 1000, clock);
    l.tryAdmit(); l.tryAdmit();
    expect(l.tryAdmit()).toBe(false);
    clock.advance(1001);
    expect(l.tryAdmit()).toBe(true);
  });

  it('computes timeUntilSlotMs correctly', () => {
    const clock = new FakeClock();
    const l = new SlidingWindowRateLimiter(1, 1000, clock);
    l.tryAdmit();
    expect(l.timeUntilSlotMs()).toBe(1000);
    clock.advance(300);
    expect(l.timeUntilSlotMs()).toBe(700);
  });

  it('validates constructor arguments', () => {
    expect(() => new SlidingWindowRateLimiter(0, 1000)).toThrow();
    expect(() => new SlidingWindowRateLimiter(1, 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// InMemoryNotificationStore
// ---------------------------------------------------------------------------

describe('InMemoryNotificationStore', () => {
  const make = (id: string, overrides: Partial<UnifiedNotification> = {}): UnifiedNotification => ({
    id,
    dedupeKey: `dk-${id}`,
    app: 'quantsink',
    kind: 'broadcast',
    title: 'T',
    body: 'B',
    previews: [],
    actions: [],
    occurredAt: new Date(0).toISOString(),
    receivedAt: new Date(0).toISOString(),
    priority: 5,
    read: false,
    dismissed: false,
    meta: {},
    ...overrides,
  });

  it('stores, retrieves and lists', async () => {
    const s = new InMemoryNotificationStore();
    await s.put(make('a'));
    await s.put(make('b', { app: 'quantchat' }));
    expect((await s.get('a'))?.id).toBe('a');
    expect((await s.getByDedupeKey('dk-b'))?.id).toBe('b');
    expect((await s.list()).length).toBe(2);
    expect((await s.list({ app: 'quantchat' })).length).toBe(1);
    expect(await s.count()).toBe(2);
  });

  it('updates, deletes and prunes', async () => {
    const s = new InMemoryNotificationStore();
    await s.put(make('a', { receivedAt: new Date(1000).toISOString() }));
    const u = await s.update('a', { read: true });
    expect(u?.read).toBe(true);
    expect(await s.delete('a')).toBe(true);
    expect(await s.delete('a')).toBe(false);
    await s.put(make('old', { receivedAt: new Date(100).toISOString() }));
    await s.put(make('new', { receivedAt: new Date(10_000).toISOString() }));
    expect(await s.pruneOlderThan(1000)).toBe(1);
    expect(await s.count()).toBe(1);
  });

  it('sorts and limits', async () => {
    const s = new InMemoryNotificationStore();
    await s.put(make('low', { priority: 2 }));
    await s.put(make('high', { priority: 9 }));
    const byPri = await s.list({ orderBy: 'priority', order: 'desc', limit: 1 });
    expect(byPri).toHaveLength(1);
    expect(byPri[0].id).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// NotificationAggregator
// ---------------------------------------------------------------------------

describe('NotificationAggregator — normalization & events', () => {
  it('emits normalized notification on valid ingest', async () => {
    const { aggregator } = makeAggregator();
    const got: UnifiedNotification[] = [];
    aggregator.on('notification', (n) => got.push(n));
    const n = await aggregator.ingest(makeEvent());
    expect(n).toBeDefined();
    expect(got).toHaveLength(1);
    expect(got[0].app).toBe('quantchat');
    expect(got[0].kind).toBe('message');
    expect(got[0].priority).toBeGreaterThan(0);
  });

  it('derives app from kind when missing', async () => {
    const { aggregator } = makeAggregator();
    const n = await aggregator.ingest(makeEvent({ app: undefined, kind: 'match' }));
    expect(n?.app).toBe('quantchill');
  });

  it('truncates long titles / bodies', async () => {
    const { aggregator } = makeAggregator();
    const long = 'x'.repeat(5000);
    const n = await aggregator.ingest(makeEvent({ title: long, body: long }));
    expect(n?.title.length).toBeLessThanOrEqual(200);
    expect(n?.body.length).toBeLessThanOrEqual(1000);
  });

  it('drops events with invalid kind and emits error', async () => {
    const { aggregator } = makeAggregator();
    const errs: Error[] = [];
    aggregator.on('error', ({ error }) => errs.push(error));
    const out = await aggregator.ingest({ kind: 'nope' });
    expect(out).toBeUndefined();
    expect(errs.length).toBe(1);
  });

  it('ingestJson parses JSON and delegates', async () => {
    const { aggregator } = makeAggregator();
    const got: UnifiedNotification[] = [];
    aggregator.on('notification', (n) => got.push(n));
    await aggregator.ingestJson(JSON.stringify(makeEvent()));
    expect(got).toHaveLength(1);
  });

  it('ingestJson handles malformed JSON', async () => {
    const { aggregator } = makeAggregator();
    const errs: Error[] = [];
    aggregator.on('error', ({ error }) => errs.push(error));
    const out = await aggregator.ingestJson('not-json');
    expect(out).toBeUndefined();
    expect(errs.length).toBe(1);
  });
});

describe('NotificationAggregator — deduplication', () => {
  it('suppresses duplicate dedupeKey within the dedup window', async () => {
    const { aggregator } = makeAggregator();
    const dups: string[] = [];
    aggregator.on('duplicate', (d) => dups.push(d.dedupeKey));
    const first = await aggregator.ingest(makeEvent({ id: 'a', dedupeKey: 'shared' }));
    const second = await aggregator.ingest(makeEvent({ id: 'b', dedupeKey: 'shared' }));
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(dups).toEqual(['shared']);
  });

  it('allows the same dedupeKey after the window passes', async () => {
    const { aggregator, clock } = makeAggregator();
    await aggregator.ingest(makeEvent({ id: 'a', dedupeKey: 'shared' }));
    clock.advance(11 * 60_000);
    const again = await aggregator.ingest(makeEvent({ id: 'b', dedupeKey: 'shared' }));
    expect(again).toBeDefined();
  });
});

describe('NotificationAggregator — rate limiting', () => {
  it('queues events beyond the per-minute cap and releases them later', async () => {
    const { aggregator, clock, timers } = makeAggregator({ maxPerMinute: 3 });
    const delivered: UnifiedNotification[] = [];
    const rateLimited: number[] = [];
    aggregator.on('notification', (n) => delivered.push(n));
    aggregator.on('rateLimited', (r) => rateLimited.push(r.queued));
    for (let i = 0; i < 5; i += 1) {
      await aggregator.ingest(makeEvent({ id: `e${i}`, dedupeKey: `k${i}` }));
    }
    expect(delivered).toHaveLength(3);
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(aggregator.pendingCount()).toBe(2);

    clock.advance(60_001);
    timers.runPending();
    expect(delivered.length).toBe(5);
    expect(aggregator.pendingCount()).toBe(0);
  });

  it('evicts lowest-priority queued item when queue overflows', async () => {
    // Build a fresh aggregator with an explicit max queue length.
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const { factory } = makeFakeSocket();
    const agg = new NotificationAggregator({
      busUrl: 'ws://x',
      clock,
      timers,
      socketFactory: factory,
      idGenerator: (() => { let i = 0; return () => `g-${++i}`; })(),
      maxPerMinute: 1,
      maxQueueLength: 2,
    });
    await agg.ingest(makeEvent({ id: 'd', dedupeKey: 'd', kind: 'message' })); // delivered
    await agg.ingest(makeEvent({ id: 'q1', dedupeKey: 'q1', kind: 'system' })); // queued pri 1
    await agg.ingest(makeEvent({ id: 'q2', dedupeKey: 'q2', kind: 'system' })); // queued pri 1
    await agg.ingest(makeEvent({ id: 'q3', dedupeKey: 'q3', kind: 'message' })); // message — higher pri
    expect(agg.pendingCount()).toBe(2);
  });
});

describe('NotificationAggregator — user actions', () => {
  it('markRead flips read flag and emits events', async () => {
    const { aggregator } = makeAggregator();
    const updates: UnifiedNotification[] = [];
    aggregator.on('read', (n) => updates.push(n));
    const n = await aggregator.ingest(makeEvent());
    const readN = await aggregator.markRead(n!.id);
    expect(readN?.read).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it('markAllReadForApp only affects that app', async () => {
    const { aggregator } = makeAggregator();
    await aggregator.ingest(makeEvent({ id: 'a', dedupeKey: 'a', app: 'quantchat' }));
    await aggregator.ingest(makeEvent({ id: 'b', dedupeKey: 'b', app: 'quantsink', kind: 'broadcast' }));
    const n = await aggregator.markAllReadForApp('quantchat');
    expect(n).toBe(1);
    const chat = await aggregator.list({ app: 'quantchat' });
    const sink = await aggregator.list({ app: 'quantsink' });
    expect(chat.every((x) => x.read)).toBe(true);
    expect(sink.every((x) => !x.read)).toBe(true);
  });

  it('dismiss marks dismissed and suppresses from badge counts', async () => {
    const { aggregator } = makeAggregator();
    const n = await aggregator.ingest(makeEvent());
    await aggregator.dismiss(n!.id);
    const counts = await aggregator.badgeCounts();
    expect(counts.quantchat).toBe(0);
  });

  it('snoozed notifications do not appear in badge counts', async () => {
    const { aggregator, clock } = makeAggregator();
    const n = await aggregator.ingest(makeEvent());
    await aggregator.snooze(n!.id, 60_000);
    const counts = await aggregator.badgeCounts();
    expect(counts.quantchat).toBe(0);
    clock.advance(60_001);
    const counts2 = await aggregator.badgeCounts();
    expect(counts2.quantchat).toBe(1);
  });

  it('invokeAction relays upstream and marks read', async () => {
    const { socket, factory, sent, trigger } = makeFakeSocket();
    void socket;
    const { aggregator } = makeAggregator({ socketFactory: factory });
    aggregator.connect();
    trigger.open();
    const n = await aggregator.ingest(
      makeEvent({
        actions: [{ id: 'reply', label: 'Reply', intent: 'reply' }],
      }),
    );
    await aggregator.invokeAction(n!.id, 'reply', { text: 'hi' });
    const relayed = sent.find((s) => s.includes('NOTIFICATION_ACTION'));
    expect(relayed).toBeDefined();
    expect(relayed).toContain('"text":"hi"');
  });

  it('invokeAction throws on unknown action id', async () => {
    const { aggregator } = makeAggregator();
    const n = await aggregator.ingest(makeEvent());
    await expect(aggregator.invokeAction(n!.id, 'nope')).rejects.toThrow();
  });
});

describe('NotificationAggregator — socket lifecycle', () => {
  it('connects, emits connected, relays bus messages', async () => {
    const fake = makeFakeSocket();
    const { aggregator } = makeAggregator({ socketFactory: fake.factory });
    const got: UnifiedNotification[] = [];
    aggregator.on('notification', (n) => got.push(n));
    let connected = false;
    aggregator.on('connected', () => { connected = true; });

    aggregator.connect();
    fake.trigger.open();
    expect(connected).toBe(true);
    fake.trigger.message(JSON.stringify(makeEvent()));
    await new Promise((r) => setImmediate(r));
    expect(got).toHaveLength(1);
  });

  it('schedules reconnect on close', async () => {
    const fake = makeFakeSocket();
    const { aggregator, timers } = makeAggregator({ socketFactory: fake.factory });
    let disconnects = 0;
    aggregator.on('disconnected', () => disconnects++);
    aggregator.connect();
    fake.trigger.open();
    fake.trigger.close(1006, 'bye');
    expect(disconnects).toBe(1);
    // After reconnect timer fires, connect will be attempted again
    expect(() => timers.runPending()).not.toThrow();
  });
});

describe('NotificationAggregator — enforceStorageBudget', () => {
  it('drops oldest read items first when over capacity', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const { factory } = makeFakeSocket();
    let i = 0;
    const agg = new NotificationAggregator({
      busUrl: 'ws://x',
      clock,
      timers,
      socketFactory: factory,
      idGenerator: () => `g-${++i}`,
      maxStoredNotifications: 3,
      maxPerMinute: 100,
    });
    const a = await agg.ingest(makeEvent({ id: 'a', dedupeKey: 'a' }));
    await agg.markRead(a!.id);
    clock.advance(1);
    await agg.ingest(makeEvent({ id: 'b', dedupeKey: 'b' }));
    clock.advance(1);
    await agg.ingest(makeEvent({ id: 'c', dedupeKey: 'c' }));
    clock.advance(1);
    await agg.ingest(makeEvent({ id: 'd', dedupeKey: 'd' }));
    const all = await agg.list();
    expect(all.length).toBeLessThanOrEqual(3);
    expect(all.some((x) => x.id === a!.id)).toBe(false);
  });
});
