import {
  PushNotificationService,
  SERVICE_WORKER_SCRIPT,
  urlBase64ToUint8Array,
  DEFAULT_SOUND_PROFILES,
} from '../services/PushNotificationService';
import {
  NotificationAggregator,
  QuantApp,
  UnifiedNotification,
} from '../services/NotificationAggregator';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeNotificationFactory(permission: 'default' | 'granted' | 'denied' = 'granted') {
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const factory = {
    permission,
    requestPermission: jest.fn(async () => 'granted' as const),
    show: jest.fn((title: string, options: Record<string, unknown>) => {
      shown.push({ title, options });
      return { close: jest.fn(), onclick: null, onclose: null, onerror: null };
    }),
  };
  return { factory, shown };
}

function makeFakeServiceWorker() {
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const listeners: Array<(ev: { data: unknown }) => void> = [];
  const subscription = {
    endpoint: 'https://push/endpoint',
    expirationTime: null,
    toJSON: () => ({
      endpoint: 'https://push/endpoint',
      expirationTime: null,
      keys: { p256dh: 'p', auth: 'a' },
    }),
    unsubscribe: jest.fn(async () => true),
  };
  const registration = {
    scope: '/',
    active: null,
    showNotification: jest.fn(async (title: string, options: Record<string, unknown>) => {
      shown.push({ title, options });
    }),
    pushManager: {
      permissionState: jest.fn(async () => 'granted' as const),
      getSubscription: jest.fn(async () => null),
      subscribe: jest.fn(async () => subscription),
    },
  };
  const sw = {
    ready: Promise.resolve(registration),
    register: jest.fn(async () => registration),
    controller: null,
    addEventListener: (_e: 'message', cb: (ev: { data: unknown }) => void) => {
      listeners.push(cb);
    },
  };
  return { sw, registration, subscription, shown, listeners };
}

function makeAudio() {
  const plays: Array<{ url: string; volume: number }> = [];
  return {
    audio: {
      play: async (url: string, volume: number) => {
        plays.push({ url, volume });
      },
    },
    plays,
  };
}

// unused: makeNotification

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

describe('PushNotificationService — lifecycle', () => {
  it('reports unsupported when no primitives are present', () => {
    const svc = new PushNotificationService({
      notificationFactory: null,
      serviceWorker: null,
    });
    expect(svc.isSupported()).toBe(false);
    expect(svc.permission()).toBe('unsupported');
  });

  it('requestPermission short-circuits when already granted', async () => {
    const { factory } = makeFakeNotificationFactory('granted');
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: null,
    });
    expect(await svc.requestPermission()).toBe('granted');
    expect(factory.requestPermission).not.toHaveBeenCalled();
  });

  it('subscribes through the service worker and POSTs to backend', async () => {
    const { factory } = makeFakeNotificationFactory('granted');
    const { sw, subscription } = makeFakeServiceWorker();
    const fetcher = jest.fn(async () => ({ ok: true, status: 200 }));
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: sw,
      applicationServerKey: 'aGVsbG8-d29ybGQ',
      subscribeEndpoint: '/api/push/subscribe',
      fetch: fetcher,
    });
    const sub = await svc.subscribe();
    expect(sub).toBe(subscription);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when VAPID key is missing', async () => {
    const { factory } = makeFakeNotificationFactory('granted');
    const { sw } = makeFakeServiceWorker();
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: sw,
    });
    await expect(svc.subscribe()).rejects.toThrow(/applicationServerKey/);
  });

  it('unsubscribe clears subscription and pings backend', async () => {
    const { factory } = makeFakeNotificationFactory('granted');
    const { sw, subscription } = makeFakeServiceWorker();
    const fetcher = jest.fn(async () => ({ ok: true, status: 200 }));
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: sw,
      applicationServerKey: 'aGVsbG8-d29ybGQ',
      subscribeEndpoint: '/s',
      unsubscribeEndpoint: '/u',
      fetch: fetcher,
    });
    await svc.subscribe();
    expect(await svc.unsubscribe()).toBe(true);
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(fetcher).toHaveBeenLastCalledWith('/u', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// Notification delivery
// ---------------------------------------------------------------------------

describe('PushNotificationService — delivery', () => {
  it('shows a single notification via service-worker registration', async () => {
    const { factory } = makeFakeNotificationFactory('granted');
    const { sw, registration } = makeFakeServiceWorker();
    const { audio, plays } = makeAudio();
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: sw,
      applicationServerKey: 'aGVsbG8-d29ybGQ',
      audio,
    });
    await svc.subscribe();

    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest({
      id: 'n1',
      dedupeKey: 'k1',
      app: 'quantchat',
      kind: 'message',
      title: 'Hi',
      body: 'body',
      occurredAt: new Date().toISOString(),
    });
    await flushMicrotasks();

    expect(registration.showNotification).toHaveBeenCalledTimes(1);
    expect(plays.length).toBe(1);
    expect(plays[0].url).toBe(DEFAULT_SOUND_PROFILES.quantchat.src);
  });

  it('falls back to the Notification constructor if no SW registration', async () => {
    const { factory, shown } = makeFakeNotificationFactory('granted');
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: null,
    });
    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest(rawMessage());
    await flushMicrotasks();
    expect(shown).toHaveLength(1);
  });

  it('skips below-threshold priorities', async () => {
    const { factory, shown } = makeFakeNotificationFactory('granted');
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: null,
      minPriority: 9,
    });
    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest(rawMessage({ kind: 'ad_performance' })); // priority 2
    await flushMicrotasks();
    expect(shown).toHaveLength(0);
  });

  it('respects app-level mute', async () => {
    const { factory, shown } = makeFakeNotificationFactory('granted');
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: null,
    });
    svc.setAppMuted('quantchat', true);
    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest(rawMessage());
    await flushMicrotasks();
    expect(shown).toHaveLength(0);
    expect(svc.isAppMuted('quantchat')).toBe(true);
  });

  it('snoozeApp temporarily blocks notifications', async () => {
    const { factory, shown } = makeFakeNotificationFactory('granted');
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: null,
    });
    svc.snoozeApp('quantchat', 60_000);
    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest(rawMessage());
    await flushMicrotasks();
    expect(shown).toHaveLength(0);
    expect(svc.isAppSnoozed('quantchat')).toBe(true);
  });

  it('global mute blocks all notifications', async () => {
    const { factory, shown } = makeFakeNotificationFactory('granted');
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: null,
      muted: true,
    });
    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest(rawMessage());
    await flushMicrotasks();
    expect(shown).toHaveLength(0);
  });

  it('groups notifications when threshold is met across multiple apps', async () => {
    const { factory } = makeFakeNotificationFactory('granted');
    const { sw, registration } = makeFakeServiceWorker();
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: sw,
      applicationServerKey: 'aGVsbG8-d29ybGQ',
      groupThreshold: 3,
    });
    await svc.subscribe();
    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest(rawMessage({ id: '1', dedupeKey: '1', app: 'quantchat' }));
    await agg.ingest(rawMessage({ id: '2', dedupeKey: '2', app: 'quantsink', kind: 'broadcast' }));
    await agg.ingest(rawMessage({ id: '3', dedupeKey: '3', app: 'quantmail', kind: 'email' }));
    await flushMicrotasks();
    const titles = registration.showNotification.mock.calls.map((c) => c[0]);
    expect(titles.some((t) => typeof t === 'string' && t.includes('new notifications'))).toBe(true);
  });

  it('onlyWhenHidden suppresses when document is focused', async () => {
    const { factory, shown } = makeFakeNotificationFactory('granted');
    const svc = new PushNotificationService({
      notificationFactory: factory,
      serviceWorker: null,
      onlyWhenHidden: true,
      isHidden: () => false,
    });
    const agg = makeAggregator();
    svc.attach(agg);
    await agg.ingest(rawMessage());
    await flushMicrotasks();
    expect(shown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sound configuration
// ---------------------------------------------------------------------------

describe('PushNotificationService — sound configuration', () => {
  it('setSoundProfile overrides the default', () => {
    const svc = new PushNotificationService();
    svc.setSoundProfile('quantsink', { src: '/custom.mp3', volume: 0.2 });
    expect(svc.getSoundProfile('quantsink').src).toBe('/custom.mp3');
  });

  it('snoozeApp rejects non-positive durations', () => {
    const svc = new PushNotificationService();
    expect(() => svc.snoozeApp('quantsink', 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('urlBase64ToUint8Array', () => {
  it('converts url-safe base64 into a Uint8Array', () => {
    const out = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles url-safe chars', () => {
    const out = urlBase64ToUint8Array('-_');
    expect(out).toBeInstanceOf(Uint8Array);
  });
});

describe('SERVICE_WORKER_SCRIPT', () => {
  it('contains the required event handlers', () => {
    expect(SERVICE_WORKER_SCRIPT).toContain("addEventListener('push'");
    expect(SERVICE_WORKER_SCRIPT).toContain("addEventListener('notificationclick'");
    expect(SERVICE_WORKER_SCRIPT).toContain("addEventListener('notificationclose'");
  });
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function makeAggregator(): NotificationAggregator {
  let i = 0;
  return new NotificationAggregator({
    busUrl: 'ws://test',
    socketFactory: () => ({
      url: 'ws://test',
      send: () => undefined,
      close: () => undefined,
      onOpen: () => undefined,
      onMessage: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    }),
    idGenerator: () => `g-${++i}`,
    maxPerMinute: 100,
  });
}

function rawMessage(
  overrides: { id?: string; dedupeKey?: string; app?: QuantApp; kind?: UnifiedNotification['kind'] } = {},
): Parameters<NotificationAggregator['ingest']>[0] {
  return {
    id: overrides.id ?? 'm-1',
    dedupeKey: overrides.dedupeKey ?? 'm-1',
    app: overrides.app ?? 'quantchat',
    kind: overrides.kind ?? 'message',
    title: 'Hi',
    body: 'body',
    occurredAt: new Date().toISOString(),
    senderId: 'u',
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
