/**
 * PushNotificationService — Web Push, Service Worker glue, sound config
 *
 * Issue #23 (sub-task 4). Sits downstream of `NotificationAggregator` and
 * `NotificationPriorityAI` and handles the OS-level push surface:
 *
 *   • Subscribes the browser to Web Push and persists the subscription.
 *   • Routes `UnifiedNotification` events into `Notification` objects via
 *     a Service Worker, with rich previews and interactive actions.
 *   • Per-app sound profiles (with a global mute and per-app overrides).
 *   • Mobile grouping — when more than `groupThreshold` notifications fire
 *     in `groupWindowMs`, they are coalesced into a single summary push
 *     ("5 new messages across 3 apps") that drills back into the inbox.
 *
 * The service deliberately treats every browser primitive (Notification,
 * ServiceWorkerRegistration, PushSubscription, fetch, Audio) as an
 * injectable adapter so the entire surface is unit-testable inside Node.
 */

import logger from '../lib/logger';
import {
  NotificationAggregator,
  QuantApp,
  QUANT_APPS,
  UnifiedNotification,
} from './NotificationAggregator';

// ---------------------------------------------------------------------------
// Adapter types — these mirror the relevant DOM shapes minus the bits we
// don't use, so we never need to depend on `lib.dom` from the server build.
// ---------------------------------------------------------------------------

export interface NotificationOptionsLike {
  body?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  image?: string;
  data?: unknown;
  silent?: boolean;
  requireInteraction?: boolean;
  actions?: Array<{ action: string; title: string; icon?: string }>;
  renotify?: boolean;
  timestamp?: number;
}

export interface NotificationLike {
  close(): void;
  onclick: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

export interface NotificationFactory {
  permission: 'default' | 'granted' | 'denied';
  requestPermission(): Promise<'default' | 'granted' | 'denied'>;
  show(title: string, options: NotificationOptionsLike): NotificationLike;
}

export interface PushSubscriptionLike {
  endpoint: string;
  expirationTime: number | null;
  toJSON(): {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
  };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  permissionState(opts: { userVisibleOnly: boolean }): Promise<'granted' | 'prompt' | 'denied'>;
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(opts: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array | string;
  }): Promise<PushSubscriptionLike>;
}

export interface ServiceWorkerRegistrationLike {
  pushManager: PushManagerLike;
  showNotification(title: string, options: NotificationOptionsLike): Promise<void>;
  active: { postMessage(data: unknown): void } | null;
  scope: string;
}

export interface ServiceWorkerContainerLike {
  ready: Promise<ServiceWorkerRegistrationLike>;
  register(scriptUrl: string, options?: { scope?: string }): Promise<ServiceWorkerRegistrationLike>;
  controller: { postMessage(data: unknown): void } | null;
  addEventListener(event: 'message', cb: (ev: { data: unknown }) => void): void;
}

export interface AudioPlayerLike {
  play(url: string, volume: number): Promise<void>;
}

/** Default audio player using the standard `Audio` constructor when present. */
export const defaultAudioPlayer: AudioPlayerLike = {
  async play(url: string, volume: number): Promise<void> {
    const g = globalThis as unknown as {
      Audio?: new (src?: string) => {
        volume: number;
        play(): Promise<void>;
      };
    };
    if (!g.Audio) return;
    try {
      const audio = new g.Audio(url);
      audio.volume = Math.max(0, Math.min(1, volume));
      await audio.play();
    } catch (err) {
      logger.debug({ err }, 'Audio playback rejected (likely autoplay policy)');
    }
  },
};

/** Default Notification factory bridging to the browser global. */
export function browserNotificationFactory(): NotificationFactory | null {
  const g = globalThis as unknown as {
    Notification?: {
      permission: 'default' | 'granted' | 'denied';
      requestPermission(): Promise<'default' | 'granted' | 'denied'>;
      new (title: string, options: NotificationOptionsLike): NotificationLike;
    };
  };
  if (!g.Notification) return null;
  const N = g.Notification;
  return {
    get permission() { return N.permission; },
    requestPermission: () => N.requestPermission(),
    show: (title, opts) => new N(title, opts),
  };
}

/** Default service-worker container reading from the browser global. */
export function browserServiceWorker(): ServiceWorkerContainerLike | null {
  const g = globalThis as unknown as {
    navigator?: { serviceWorker?: ServiceWorkerContainerLike };
  };
  return g.navigator?.serviceWorker ?? null;
}

// ---------------------------------------------------------------------------
// Sound profile
// ---------------------------------------------------------------------------

export interface SoundProfile {
  /** Path or URL to the audio file. */
  readonly src: string;
  /** 0-1 volume. */
  readonly volume: number;
  /** Optional human description. */
  readonly description?: string;
}

export const DEFAULT_SOUND_PROFILES: Readonly<Record<QuantApp, SoundProfile>> =
  Object.freeze({
    quantsink:    { src: '/sounds/quantsink.mp3',    volume: 0.7, description: 'Broadcast chime' },
    quantchat:    { src: '/sounds/quantchat.mp3',    volume: 0.9, description: 'Message ping' },
    quantchill:   { src: '/sounds/quantchill.mp3',   volume: 0.8, description: 'Match swirl' },
    quantads:     { src: '/sounds/quantads.mp3',     volume: 0.4, description: 'Ad blip' },
    quantedits:   { src: '/sounds/quantedits.mp3',   volume: 0.6, description: 'Edit swoosh' },
    quanttube:    { src: '/sounds/quanttube.mp3',    volume: 0.6, description: 'Engagement ping' },
    quantmail:    { src: '/sounds/quantmail.mp3',    volume: 0.5, description: 'Letter slide' },
    quantneon:    { src: '/sounds/quantneon.mp3',    volume: 0.7, description: 'Neon shimmer' },
    quantbrowse:  { src: '/sounds/quantbrowse.mp3',  volume: 0.4, description: 'Browser tick' },
  });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PushNotificationServiceConfig {
  /** VAPID public key (base64-url encoded). Required to subscribe. */
  readonly applicationServerKey?: string;
  /** Service worker script URL. Default `/sw-quant-notifications.js`. */
  readonly serviceWorkerUrl?: string;
  /** Service worker scope. Default `/`. */
  readonly serviceWorkerScope?: string;
  /** Backend endpoint receiving subscription registrations. */
  readonly subscribeEndpoint?: string;
  /** Backend endpoint receiving subscription removals. */
  readonly unsubscribeEndpoint?: string;
  /** Per-app sound overrides. Falls back to `DEFAULT_SOUND_PROFILES`. */
  readonly sounds?: Partial<Record<QuantApp, SoundProfile>>;
  /** If true, sounds are globally muted. */
  readonly muted?: boolean;
  /** Fire grouping push when this many fire inside `groupWindowMs`. */
  readonly groupThreshold?: number;
  /** Window for the grouping heuristic. Default 60_000 ms. */
  readonly groupWindowMs?: number;
  /** Tag used for the grouped push (so it replaces itself). */
  readonly groupTag?: string;
  /** Minimum priority eligible to surface as a push. Default 4. */
  readonly minPriority?: number;
  /** If true, only show pushes when document is hidden / unfocused. */
  readonly onlyWhenHidden?: boolean;
  /** Adapter overrides — primarily for tests. */
  readonly notificationFactory?: NotificationFactory | null;
  readonly serviceWorker?: ServiceWorkerContainerLike | null;
  readonly audio?: AudioPlayerLike;
  readonly fetch?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number }>;
  /** Visibility predicate, default reads `document.hidden`. */
  readonly isHidden?: () => boolean;
}

interface RecentPushRecord {
  readonly id: string;
  readonly app: QuantApp;
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

export class PushNotificationService {
  private readonly applicationServerKey?: string;
  private readonly serviceWorkerUrl: string;
  private readonly serviceWorkerScope: string;
  private readonly subscribeEndpoint?: string;
  private readonly unsubscribeEndpoint?: string;
  private readonly sounds: Record<QuantApp, SoundProfile>;
  private readonly groupThreshold: number;
  private readonly groupWindowMs: number;
  private readonly groupTag: string;
  private readonly minPriority: number;
  private readonly onlyWhenHidden: boolean;
  private readonly audio: AudioPlayerLike;
  private readonly fetcher?: PushNotificationServiceConfig['fetch'];
  private readonly isHidden: () => boolean;

  private muted: boolean;
  private notificationFactory: NotificationFactory | null;
  private serviceWorker: ServiceWorkerContainerLike | null;
  private registration: ServiceWorkerRegistrationLike | null = null;
  private subscription: PushSubscriptionLike | null = null;
  private detach: (() => void) | null = null;
  private aggregator: NotificationAggregator | null = null;

  private readonly recent: RecentPushRecord[] = [];
  private readonly perAppMute = new Map<QuantApp, boolean>();
  private readonly perAppSnooze = new Map<QuantApp, number>();

  constructor(config: PushNotificationServiceConfig = {}) {
    this.applicationServerKey = config.applicationServerKey;
    this.serviceWorkerUrl = config.serviceWorkerUrl ?? '/sw-quant-notifications.js';
    this.serviceWorkerScope = config.serviceWorkerScope ?? '/';
    this.subscribeEndpoint = config.subscribeEndpoint;
    this.unsubscribeEndpoint = config.unsubscribeEndpoint;
    this.sounds = { ...DEFAULT_SOUND_PROFILES, ...(config.sounds ?? {}) };
    this.groupThreshold = config.groupThreshold ?? 5;
    this.groupWindowMs = config.groupWindowMs ?? 60_000;
    this.groupTag = config.groupTag ?? 'quant-grouped';
    this.minPriority = clamp(config.minPriority ?? 4, 1, 10);
    this.onlyWhenHidden = !!config.onlyWhenHidden;
    this.muted = !!config.muted;
    this.notificationFactory =
      config.notificationFactory === undefined
        ? browserNotificationFactory()
        : config.notificationFactory;
    this.serviceWorker =
      config.serviceWorker === undefined ? browserServiceWorker() : config.serviceWorker;
    this.audio = config.audio ?? defaultAudioPlayer;
    this.fetcher = config.fetch;
    this.isHidden = config.isHidden ?? defaultIsHidden;
  }

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  /** Whether the runtime supports Web Push at all. */
  isSupported(): boolean {
    return !!this.notificationFactory && !!this.serviceWorker;
  }

  /** Current OS notification permission. `'unsupported'` if no API present. */
  permission(): 'default' | 'granted' | 'denied' | 'unsupported' {
    if (!this.notificationFactory) return 'unsupported';
    return this.notificationFactory.permission;
  }

  /** Prompts the user for notification permission if not already granted. */
  async requestPermission(): Promise<'default' | 'granted' | 'denied' | 'unsupported'> {
    if (!this.notificationFactory) return 'unsupported';
    if (this.notificationFactory.permission === 'granted') return 'granted';
    if (this.notificationFactory.permission === 'denied') return 'denied';
    return this.notificationFactory.requestPermission();
  }

  /**
   * Registers the service worker, subscribes to Web Push, and POSTs the
   * subscription to the backend so it can be used for server-initiated
   * pushes. Idempotent — repeated calls return the existing subscription.
   */
  async subscribe(): Promise<PushSubscriptionLike | null> {
    if (!this.serviceWorker) return null;
    if (!this.applicationServerKey) {
      throw new Error('applicationServerKey is required to subscribe to Web Push');
    }
    if (this.subscription) return this.subscription;

    try {
      this.registration =
        (await this.serviceWorker.ready.catch(() => null)) ??
        (await this.serviceWorker.register(this.serviceWorkerUrl, {
          scope: this.serviceWorkerScope,
        }));
    } catch (err) {
      logger.warn({ err }, 'Service worker registration failed');
      throw err;
    }

    const existing = await this.registration.pushManager.getSubscription();
    if (existing) {
      this.subscription = existing;
    } else {
      this.subscription = await this.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(this.applicationServerKey),
      });
    }

    if (this.subscribeEndpoint && this.fetcher) {
      const body = JSON.stringify(this.subscription.toJSON());
      const res = await this.fetcher(this.subscribeEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'Subscription registration failed');
      }
    }

    this.serviceWorker.addEventListener('message', (ev) => this.onWorkerMessage(ev.data));

    return this.subscription;
  }

  /** Unsubscribes locally and notifies the backend. */
  async unsubscribe(): Promise<boolean> {
    if (!this.subscription) return false;
    let ok = false;
    try { ok = await this.subscription.unsubscribe(); } catch (_e) { /* ignore */ }
    if (this.unsubscribeEndpoint && this.fetcher) {
      try {
        await this.fetcher(this.unsubscribeEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: this.subscription.endpoint }),
        });
      } catch (err) {
        logger.warn({ err }, 'Backend unsubscribe failed');
      }
    }
    this.subscription = null;
    return ok;
  }

  /**
   * Wires the service to a `NotificationAggregator` so that every
   * `notification` event becomes a push (subject to grouping, mute and
   * priority thresholds). Returns a detach function.
   */
  attach(aggregator: NotificationAggregator): () => void {
    this.detach?.();
    this.aggregator = aggregator;
    const off = aggregator.on('notification', (n) => {
      void this.handleNotification(n);
    });
    this.detach = () => {
      off();
      this.aggregator = null;
      this.detach = null;
    };
    return this.detach;
  }

  // -------------------------------------------------------------------------
  // Sound configuration
  // -------------------------------------------------------------------------

  setSoundProfile(app: QuantApp, profile: SoundProfile): void {
    this.sounds[app] = { ...profile };
  }

  getSoundProfile(app: QuantApp): SoundProfile {
    return { ...this.sounds[app] };
  }

  setGloballyMuted(muted: boolean): void {
    this.muted = muted;
  }

  isGloballyMuted(): boolean {
    return this.muted;
  }

  setAppMuted(app: QuantApp, muted: boolean): void {
    if (muted) this.perAppMute.set(app, true);
    else this.perAppMute.delete(app);
  }

  isAppMuted(app: QuantApp): boolean {
    return this.perAppMute.get(app) === true;
  }

  snoozeApp(app: QuantApp, durationMs: number): void {
    if (durationMs <= 0) throw new Error('durationMs must be positive');
    this.perAppSnooze.set(app, Date.now() + durationMs);
  }

  isAppSnoozed(app: QuantApp): boolean {
    const until = this.perAppSnooze.get(app);
    if (!until) return false;
    if (until > Date.now()) return true;
    this.perAppSnooze.delete(app);
    return false;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  recentPushes(): readonly RecentPushRecord[] {
    return [...this.recent];
  }

  // -------------------------------------------------------------------------
  // Core fan-out
  // -------------------------------------------------------------------------

  private async handleNotification(n: UnifiedNotification): Promise<void> {
    if (this.permission() !== 'granted') return;
    if (n.priority < this.minPriority) return;
    if (this.muted) return;
    if (this.isAppMuted(n.app) || this.isAppSnoozed(n.app)) return;
    if (this.onlyWhenHidden && !this.isHidden()) return;

    this.evictOldPushes();
    if (this.shouldGroup(n)) {
      await this.showGrouped(n);
      this.recent.push({ id: n.id, app: n.app, at: Date.now() });
      return;
    }

    await this.showSingle(n);
    this.recent.push({ id: n.id, app: n.app, at: Date.now() });
  }

  private shouldGroup(n: UnifiedNotification): boolean {
    return this.recent.length + 1 >= this.groupThreshold &&
      uniqueApps([...this.recent, { id: n.id, app: n.app, at: Date.now() }]) >= 2;
  }

  private evictOldPushes(): void {
    const cutoff = Date.now() - this.groupWindowMs;
    while (this.recent.length && this.recent[0].at < cutoff) this.recent.shift();
  }

  private async showSingle(n: UnifiedNotification): Promise<void> {
    const sound = this.sounds[n.app];
    const options: NotificationOptionsLike = {
      body: n.body,
      tag: n.dedupeKey,
      icon: appIcon(n.app),
      badge: appBadge(n.app),
      image: previewImage(n),
      data: {
        notificationId: n.id,
        app: n.app,
        deepLink: n.deepLink,
      },
      silent: this.muted,
      requireInteraction: n.priority >= 9,
      actions: n.actions.slice(0, 2).map((a) => ({
        action: a.id,
        title: a.label,
      })),
      renotify: false,
      timestamp: Date.parse(n.occurredAt) || Date.now(),
    };
    await this.deliver(n.title, options);
    if (sound && !this.muted) {
      await this.audio.play(sound.src, sound.volume);
    }
  }

  private async showGrouped(_trigger: UnifiedNotification): Promise<void> {
    const all = [...this.recent, { id: _trigger.id, app: _trigger.app, at: Date.now() }];
    const apps = uniqueApps(all);
    const total = all.length;
    const title = `${total} new notifications`;
    const body = `${total} new across ${apps} app${apps === 1 ? '' : 's'}`;
    const options: NotificationOptionsLike = {
      body,
      tag: this.groupTag,
      icon: appIcon('quantsink'),
      badge: appBadge('quantsink'),
      data: { kind: 'grouped' },
      silent: true,
      renotify: true,
      timestamp: Date.now(),
    };
    await this.deliver(title, options);
  }

  private async deliver(title: string, options: NotificationOptionsLike): Promise<void> {
    if (this.registration) {
      await this.registration.showNotification(title, options);
      return;
    }
    if (this.notificationFactory) {
      const handle = this.notificationFactory.show(title, options);
      handle.onerror = (err) => logger.warn({ err }, 'Notification surface error');
      return;
    }
    logger.debug('No surface available to deliver notification');
  }

  private onWorkerMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as { type?: string; notificationId?: string; actionId?: string };
    if (msg.type === 'NOTIFICATION_CLICK' && msg.notificationId) {
      void this.aggregator?.markRead(msg.notificationId);
    } else if (msg.type === 'NOTIFICATION_ACTION' && msg.notificationId && msg.actionId) {
      void this.aggregator?.invokeAction(msg.notificationId, msg.actionId);
    } else if (msg.type === 'NOTIFICATION_DISMISS' && msg.notificationId) {
      void this.aggregator?.dismiss(msg.notificationId);
    }
  }
}

// ---------------------------------------------------------------------------
// Service-worker handler script (string-built so it can be served as JS)
// ---------------------------------------------------------------------------

/**
 * The body of the Service Worker script consumers can serve at
 * `/sw-quant-notifications.js`. Bundlers can import this string and write
 * it to disk during the static-asset build step. The handler:
 *
 *   • Parses incoming push payloads.
 *   • Calls `self.registration.showNotification` with rich options.
 *   • Forwards click/action/close events back to the page via
 *     `client.postMessage`, which `PushNotificationService.onWorkerMessage`
 *     translates into aggregator actions.
 */
export const SERVICE_WORKER_SCRIPT = `/* quant-notifications service worker */
self.addEventListener('install', (event) => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
  const title = payload.title || 'Quant';
  const opts  = payload.options || {};
  event.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      const msg = action
        ? { type: 'NOTIFICATION_ACTION', notificationId: data.notificationId, actionId: action }
        : { type: 'NOTIFICATION_CLICK',  notificationId: data.notificationId };
      for (const c of all) c.postMessage(msg);
      if (data.deepLink && self.clients.openWindow) {
        return self.clients.openWindow(data.deepLink);
      }
      return undefined;
    }),
  );
});
self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {};
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
    for (const c of all) c.postMessage({ type: 'NOTIFICATION_DISMISS', notificationId: data.notificationId });
  });
});
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultIsHidden(): boolean {
  const g = globalThis as unknown as { document?: { hidden?: boolean } };
  return !!g.document?.hidden;
}

function uniqueApps(records: ReadonlyArray<{ app: QuantApp }>): number {
  const set = new Set<QuantApp>();
  for (const r of records) set.add(r.app);
  return set.size;
}

function appIcon(app: QuantApp): string {
  return `/icons/${app}.png`;
}

function appBadge(app: QuantApp): string {
  return `/icons/${app}-badge.png`;
}

function previewImage(n: UnifiedNotification): string | undefined {
  for (const p of n.previews) {
    if (p.type === 'image' || p.type === 'video') return p.value;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Standard helper to convert a base64-url VAPID key into a Uint8Array. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const g = globalThis as unknown as {
    atob?: (data: string) => string;
    Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string; length: number; [i: number]: number } };
  };
  let raw: string;
  if (g.atob) {
    raw = g.atob(base64);
  } else if (g.Buffer) {
    raw = g.Buffer.from(base64, 'base64').toString('binary');
  } else {
    throw new Error('No base64 decoder available in this runtime');
  }
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// Re-export the app list and sounds for downstream UI menus.
export { QUANT_APPS };
