/**
 * NotificationAggregator — Cross-App Unified Notification Bus
 *
 * Issue #23 (World-First): a single notification hub that aggregates events
 * from ALL nine Quant apps over a shared WebSocket event bus and surfaces a
 * coherent inbox to the user. The aggregator is intentionally framework
 * agnostic — it ships zero React/DOM imports — so it can run identically
 * inside the Next.js client, an embedded service worker, the Express API
 * or the standalone notification micro-service.
 *
 * Responsibilities
 * ─────────────────────────────────────────────────────────────────────────
 *  1. Maintain a multiplexed WebSocket connection (with reconnect/backoff)
 *     to the shared "QuantBus" event channel and translate raw JSON frames
 *     into strongly-typed `UnifiedNotification` records.
 *  2. Apply de-duplication: the same logical event delivered through more
 *     than one upstream channel must surface to the UI exactly once.
 *  3. Apply rate limiting: at most 20 notifications per rolling minute may
 *     be surfaced; further events are queued and replayed in priority order
 *     when the window opens.
 *  4. Persist notifications via a pluggable `NotificationStore` (an
 *     IndexedDB adapter ships in `lib/indexedDbNotificationStore.ts`; an
 *     in-memory store is included here for tests and SSR).
 *  5. Emit lifecycle events (`notification`, `update`, `read`, `dismiss`,
 *     `connected`, `disconnected`, `error`) that React or any other UI
 *     layer can subscribe to.
 *
 * The aggregator is the entry-point used by `UnifiedNotificationUI`
 * (issue #23 sub-task 3) and is the upstream feeding `PushNotificationService`
 * (sub-task 4) and `NotificationPriorityAI` (sub-task 2).
 */

import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Public domain model
// ---------------------------------------------------------------------------

/** All Quant apps that may emit notifications. The list is closed. */
export const QUANT_APPS = [
  'quantsink',     // broadcast / social feed
  'quantchat',     // 1:1 and group messaging
  'quantchill',    // dating / matches
  'quantads',      // ads platform
  'quantedits',    // collaborative video editor
  'quanttube',     // long-form video
  'quantmail',     // email
  'quantneon',     // metaverse / virtual world
  'quantbrowse',   // browser companion / clip-saver
] as const;

export type QuantApp = (typeof QUANT_APPS)[number];

/** Discriminator used by upstream services to route events. */
export type NotificationKind =
  | 'message'           // Quantchat
  | 'broadcast'         // Quantsink
  | 'match'             // Quantchill
  | 'ad_performance'    // Quantads
  | 'edit_share'        // Quantedits
  | 'video_engagement'  // Quanttube
  | 'email'             // Quantmail
  | 'metaverse_event'   // Quantneon
  | 'web_clip'          // Quantbrowse
  | 'system';           // Cross-cutting platform notice

/** Map every kind to its emitting app for static safety. */
export const KIND_TO_APP: Readonly<Record<NotificationKind, QuantApp>> = {
  message:           'quantchat',
  broadcast:         'quantsink',
  match:             'quantchill',
  ad_performance:    'quantads',
  edit_share:        'quantedits',
  video_engagement:  'quanttube',
  email:             'quantmail',
  metaverse_event:   'quantneon',
  web_clip:          'quantbrowse',
  system:            'quantsink',
};

/** A single rich preview attached to a notification. */
export interface NotificationPreview {
  readonly type: 'image' | 'video' | 'text' | 'audio' | 'link';
  /** Absolute URL, data URI or short text snippet. */
  readonly value: string;
  /** Optional caption / alt text. */
  readonly caption?: string;
  /** Optional duration (seconds) for audio/video previews. */
  readonly durationSec?: number;
}

/** A first-class action a user can perform from the notification surface. */
export interface NotificationAction {
  readonly id: string;
  readonly label: string;
  /**
   * High-level intent — the UI can map this to an icon and the aggregator
   * uses the value when relaying the action back upstream over the bus.
   */
  readonly intent:
    | 'reply'
    | 'like'
    | 'accept'
    | 'decline'
    | 'archive'
    | 'open'
    | 'share'
    | 'mute'
    | 'snooze';
  /** Free-form payload returned to the upstream service when invoked. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** The canonical normalized notification surfaced to UI / push layers. */
export interface UnifiedNotification {
  /** Stable globally unique id (uuid v4 expected). */
  readonly id: string;
  /** Logical de-dup key — same event from two channels MUST share this. */
  readonly dedupeKey: string;
  /** Originating Quant app. */
  readonly app: QuantApp;
  /** Kind of underlying event. */
  readonly kind: NotificationKind;
  /** Short headline. UI truncates at ~80 chars. */
  readonly title: string;
  /** Body / preview text — UI truncates at ~200 chars. */
  readonly body: string;
  /** Optional rich preview chips (images, videos…). */
  readonly previews: readonly NotificationPreview[];
  /** Quick actions usable directly from the notification surface. */
  readonly actions: readonly NotificationAction[];
  /** Deep link the UI should open if the notification is tapped. */
  readonly deepLink?: string;
  /** ISO-8601 timestamp the underlying event happened. */
  readonly occurredAt: string;
  /** ISO-8601 timestamp the aggregator received the notification. */
  readonly receivedAt: string;
  /** Originating user id, if applicable. */
  readonly senderId?: string;
  /** Originating user display name, if applicable. */
  readonly senderName?: string;
  /** AI-assigned priority 1-10 (filled by NotificationPriorityAI). */
  priority: number;
  /** Whether the user has seen the notification yet. */
  read: boolean;
  /** Whether the user explicitly dismissed the notification. */
  dismissed: boolean;
  /** Soft-mute window expiry (epoch ms) set by snooze action. */
  snoozedUntil?: number;
  /** Free-form metadata propagated from upstream. */
  readonly meta: Readonly<Record<string, unknown>>;
}

/** Raw frame received from the WebSocket bus. */
export interface RawBusEvent {
  readonly id?: string;
  readonly dedupeKey?: string;
  readonly app?: string;
  readonly kind?: string;
  readonly title?: string;
  readonly body?: string;
  readonly previews?: ReadonlyArray<{
    type?: string;
    value?: string;
    caption?: string;
    durationSec?: number;
  }>;
  readonly actions?: ReadonlyArray<{
    id?: string;
    label?: string;
    intent?: string;
    payload?: Record<string, unknown>;
  }>;
  readonly deepLink?: string;
  readonly occurredAt?: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Storage abstraction
// ---------------------------------------------------------------------------

/**
 * A persistence-agnostic store for notifications. The IndexedDB adapter
 * lives in `lib/indexedDbNotificationStore.ts`; this file ships an
 * in-memory implementation suitable for SSR, the test harness and the
 * Express side-car.
 */
export interface NotificationStore {
  put(notification: UnifiedNotification): Promise<void>;
  get(id: string): Promise<UnifiedNotification | undefined>;
  getByDedupeKey(key: string): Promise<UnifiedNotification | undefined>;
  list(filter?: NotificationListFilter): Promise<UnifiedNotification[]>;
  update(id: string, patch: Partial<UnifiedNotification>): Promise<UnifiedNotification | undefined>;
  delete(id: string): Promise<boolean>;
  /** Drop everything older than the given epoch millisecond timestamp. */
  pruneOlderThan(epochMs: number): Promise<number>;
  /** Drop every record. */
  clear(): Promise<void>;
  /** Total count (cheap). */
  count(): Promise<number>;
}

export interface NotificationListFilter {
  readonly app?: QuantApp;
  readonly read?: boolean;
  readonly dismissed?: boolean;
  /** Inclusive lower bound on `receivedAt`. */
  readonly sinceEpochMs?: number;
  /** Inclusive upper bound on `receivedAt`. */
  readonly untilEpochMs?: number;
  /** Maximum number of results. */
  readonly limit?: number;
  /** Sort field. Default `receivedAt`. */
  readonly orderBy?: 'priority' | 'receivedAt' | 'occurredAt';
  /** Sort direction. Default `desc`. */
  readonly order?: 'asc' | 'desc';
}

/** A simple Map-backed store. Suitable for tests, SSR and CLI usage. */
export class InMemoryNotificationStore implements NotificationStore {
  private readonly byId = new Map<string, UnifiedNotification>();
  private readonly byDedupe = new Map<string, string>();

  async put(notification: UnifiedNotification): Promise<void> {
    this.byId.set(notification.id, notification);
    this.byDedupe.set(notification.dedupeKey, notification.id);
  }

  async get(id: string): Promise<UnifiedNotification | undefined> {
    return this.byId.get(id);
  }

  async getByDedupeKey(key: string): Promise<UnifiedNotification | undefined> {
    const id = this.byDedupe.get(key);
    return id ? this.byId.get(id) : undefined;
  }

  async list(filter: NotificationListFilter = {}): Promise<UnifiedNotification[]> {
    const out: UnifiedNotification[] = [];
    for (const n of Array.from(this.byId.values())) {
      if (filter.app && n.app !== filter.app) continue;
      if (typeof filter.read === 'boolean' && n.read !== filter.read) continue;
      if (typeof filter.dismissed === 'boolean' && n.dismissed !== filter.dismissed) continue;
      const recvMs = Date.parse(n.receivedAt);
      if (filter.sinceEpochMs !== undefined && recvMs < filter.sinceEpochMs) continue;
      if (filter.untilEpochMs !== undefined && recvMs > filter.untilEpochMs) continue;
      out.push(n);
    }
    const orderBy = filter.orderBy ?? 'receivedAt';
    const dir = (filter.order ?? 'desc') === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      if (orderBy === 'priority') return dir * (a.priority - b.priority);
      const av = Date.parse(orderBy === 'occurredAt' ? a.occurredAt : a.receivedAt);
      const bv = Date.parse(orderBy === 'occurredAt' ? b.occurredAt : b.receivedAt);
      return dir * (av - bv);
    });
    return typeof filter.limit === 'number' ? out.slice(0, filter.limit) : out;
  }

  async update(
    id: string,
    patch: Partial<UnifiedNotification>,
  ): Promise<UnifiedNotification | undefined> {
    const prior = this.byId.get(id);
    if (!prior) return undefined;
    const next: UnifiedNotification = { ...prior, ...patch };
    this.byId.set(id, next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const prior = this.byId.get(id);
    if (!prior) return false;
    this.byId.delete(id);
    this.byDedupe.delete(prior.dedupeKey);
    return true;
  }

  async pruneOlderThan(epochMs: number): Promise<number> {
    let removed = 0;
    for (const n of Array.from(this.byId.values())) {
      if (Date.parse(n.receivedAt) < epochMs) {
        this.byId.delete(n.id);
        this.byDedupe.delete(n.dedupeKey);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.byId.clear();
    this.byDedupe.clear();
  }

  async count(): Promise<number> {
    return this.byId.size;
  }
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding window
// ---------------------------------------------------------------------------

/** Pluggable clock for deterministic tests. */
export interface Clock {
  now(): number;
}

export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

/**
 * Simple sliding-window rate limiter. Used to cap user-visible
 * notifications at 20 per minute as required by the spec; events that
 * exceed the budget are queued by the aggregator and re-evaluated when
 * older events fall outside the window.
 */
export class SlidingWindowRateLimiter {
  private readonly events: number[] = [];

  constructor(
    public readonly capacity: number,
    public readonly windowMs: number,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {
    if (capacity <= 0) throw new Error('capacity must be positive');
    if (windowMs <= 0) throw new Error('windowMs must be positive');
  }

  /** Returns true if a new event is allowed; if so, records it. */
  tryAdmit(): boolean {
    this.evict();
    if (this.events.length >= this.capacity) return false;
    this.events.push(this.clock.now());
    return true;
  }

  /** Time in ms until the next admission slot opens. 0 if available. */
  timeUntilSlotMs(): number {
    this.evict();
    if (this.events.length < this.capacity) return 0;
    const oldest = this.events[0];
    return Math.max(0, oldest + this.windowMs - this.clock.now());
  }

  /** Number of slots still available in the current window. */
  remaining(): number {
    this.evict();
    return Math.max(0, this.capacity - this.events.length);
  }

  reset(): void {
    this.events.length = 0;
  }

  private evict(): void {
    const cutoff = this.clock.now() - this.windowMs;
    while (this.events.length && this.events[0] <= cutoff) this.events.shift();
  }
}

// ---------------------------------------------------------------------------
// Tiny event emitter (avoids a Node/EventEmitter import in the browser)
// ---------------------------------------------------------------------------

export type AggregatorEvents = {
  notification: UnifiedNotification;
  update: UnifiedNotification;
  read: UnifiedNotification;
  dismiss: UnifiedNotification;
  connected: { url: string };
  disconnected: { url: string; code?: number; reason?: string };
  error: { error: Error };
  rateLimited: { queued: number; nextSlotInMs: number };
  duplicate: { dedupeKey: string };
};

type Listener<T> = (payload: T) => void;

class TypedEmitter<E extends Record<string, unknown>> {
  private readonly listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {};

  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    const set = (this.listeners[event] ??= new Set<Listener<E[K]>>());
    set.add(listener);
    return () => set.delete(listener);
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.listeners[event]?.delete(listener);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        logger.warn({ err, event }, 'Notification listener threw');
      }
    }
  }

  removeAll(): void {
    for (const k of Object.keys(this.listeners)) {
      delete this.listeners[k as keyof E];
    }
  }
}

// ---------------------------------------------------------------------------
// Priority assignment hook
// ---------------------------------------------------------------------------

export interface PriorityScorer {
  score(input: UnifiedNotification): number;
}

/** Default scorer — coarse, app-derived; replaced by NotificationPriorityAI. */
export class DefaultPriorityScorer implements PriorityScorer {
  score(n: UnifiedNotification): number {
    switch (n.kind) {
      case 'message':          return 9;
      case 'match':            return 8;
      case 'broadcast':        return 6;
      case 'video_engagement': return 5;
      case 'edit_share':       return 5;
      case 'email':            return 4;
      case 'metaverse_event':  return 4;
      case 'web_clip':         return 3;
      case 'ad_performance':   return 2;
      case 'system':           return 1;
      default:                 return 5;
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket interface (intentionally minimal so we can swap implementations)
// ---------------------------------------------------------------------------

export interface BusSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Subscribe to lifecycle events. The factory must ensure handlers fire. */
  onOpen(cb: () => void): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
  onError(cb: (err: Error) => void): void;
  readonly url: string;
}

export type BusSocketFactory = (url: string) => BusSocket;

/**
 * Default factory built on the standard browser `WebSocket` global.
 * The factory is injected for tests so we never need a real network.
 */
export const defaultBusSocketFactory: BusSocketFactory = (url) => {
  // The DOM `WebSocket` may or may not be present (e.g. SSR). We treat it
  // as opaque to avoid a hard DOM dependency in the server build.
  const g = globalThis as unknown as {
    WebSocket?: new (u: string) => WebSocketLike;
  };
  if (!g.WebSocket) {
    throw new Error('No WebSocket implementation available in this runtime');
  }
  const ws = new g.WebSocket(url);
  const adapter: BusSocket = {
    url,
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onOpen: (cb) => { ws.onopen = () => cb(); },
    onMessage: (cb) => {
      ws.onmessage = (ev) => {
        const data = (ev as { data?: unknown }).data;
        cb(typeof data === 'string' ? data : String(data ?? ''));
      };
    },
    onClose: (cb) => {
      ws.onclose = (ev) => {
        const e = ev as { code?: number; reason?: string };
        cb(e.code, e.reason);
      };
    },
    onError: (cb) => {
      ws.onerror = () => cb(new Error('WebSocket error'));
    },
  };
  return adapter;
};

interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data?: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

// ---------------------------------------------------------------------------
// Aggregator configuration
// ---------------------------------------------------------------------------

export interface NotificationAggregatorConfig {
  /** Bus URL — typically `wss://bus.quant.systems/notifications`. */
  readonly busUrl: string;
  /** Max notifications surfaced per minute. Default 20. */
  readonly maxPerMinute?: number;
  /** Persistent store. Defaults to an in-memory store. */
  readonly store?: NotificationStore;
  /** Priority scorer. Defaults to `DefaultPriorityScorer`. */
  readonly priority?: PriorityScorer;
  /** Socket factory — defaults to the browser WebSocket. */
  readonly socketFactory?: BusSocketFactory;
  /** Reconnect backoff floor in ms. Default 1000. */
  readonly reconnectMinMs?: number;
  /** Reconnect backoff ceiling in ms. Default 30_000. */
  readonly reconnectMaxMs?: number;
  /** Reconnect jitter ratio (0-1). Default 0.25. */
  readonly reconnectJitter?: number;
  /** Maximum queue length while rate-limited. Default 500. */
  readonly maxQueueLength?: number;
  /** Maximum notifications to retain in the store. Default 1000. */
  readonly maxStoredNotifications?: number;
  /** Pluggable clock for deterministic tests. */
  readonly clock?: Clock;
  /** Pluggable timer primitives (default: real setTimeout/clearTimeout). */
  readonly timers?: TimerPrimitives;
  /** Pluggable id generator. Default uuid v4 via crypto.randomUUID fallback. */
  readonly idGenerator?: () => string;
}

export interface TimerPrimitives {
  setTimeout(handler: () => void, ms: number): number | NodeJS.Timeout;
  clearTimeout(handle: number | NodeJS.Timeout): void;
  setInterval(handler: () => void, ms: number): number | NodeJS.Timeout;
  clearInterval(handle: number | NodeJS.Timeout): void;
}

export const REAL_TIMERS: TimerPrimitives = {
  setTimeout: (h, ms) => setTimeout(h, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (h, ms) => setInterval(h, ms),
  clearInterval: (h) => clearInterval(h as never),
};

// ---------------------------------------------------------------------------
// Aggregator implementation
// ---------------------------------------------------------------------------

export class NotificationAggregator {
  private readonly emitter = new TypedEmitter<AggregatorEvents>();
  private readonly store: NotificationStore;
  private readonly priority: PriorityScorer;
  private readonly socketFactory: BusSocketFactory;
  private readonly clock: Clock;
  private readonly timers: TimerPrimitives;
  private readonly idGen: () => string;
  private readonly maxQueue: number;
  private readonly maxStored: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly jitter: number;

  private readonly limiter: SlidingWindowRateLimiter;
  private readonly pendingQueue: UnifiedNotification[] = [];
  private readonly recentDedupe = new Map<string, number>();
  /** Dedup window in ms — events sharing a key within this window collapse. */
  private static readonly DEDUPE_WINDOW_MS = 10 * 60_000;

  private socket: BusSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectHandle: number | NodeJS.Timeout | null = null;
  private flushHandle: number | NodeJS.Timeout | null = null;
  private closed = false;

  constructor(public readonly config: NotificationAggregatorConfig) {
    if (!config.busUrl) throw new Error('busUrl is required');
    this.store = config.store ?? new InMemoryNotificationStore();
    this.priority = config.priority ?? new DefaultPriorityScorer();
    this.socketFactory = config.socketFactory ?? defaultBusSocketFactory;
    this.clock = config.clock ?? SYSTEM_CLOCK;
    this.timers = config.timers ?? REAL_TIMERS;
    this.idGen = config.idGenerator ?? defaultIdGenerator;
    this.maxQueue = config.maxQueueLength ?? 500;
    this.maxStored = config.maxStoredNotifications ?? 1000;
    this.reconnectMinMs = config.reconnectMinMs ?? 1000;
    this.reconnectMaxMs = config.reconnectMaxMs ?? 30_000;
    this.jitter = clamp(config.reconnectJitter ?? 0.25, 0, 1);
    this.limiter = new SlidingWindowRateLimiter(
      config.maxPerMinute ?? 20,
      60_000,
      this.clock,
    );
  }

  // -------------------------------------------------------------------------
  // Public API — lifecycle
  // -------------------------------------------------------------------------

  /** Connects to the bus. Safe to call repeatedly (idempotent). */
  connect(): void {
    if (this.closed) throw new Error('Aggregator has been closed');
    if (this.socket) return;
    try {
      const sock = this.socketFactory(this.config.busUrl);
      this.attachSocket(sock);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ err: error }, 'Failed to construct bus socket');
      this.emitter.emit('error', { error });
      this.scheduleReconnect();
    }
  }

  /** Closes the aggregator permanently. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectHandle !== null) {
      this.timers.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.flushHandle !== null) {
      this.timers.clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.socket) {
      try { this.socket.close(1000, 'aggregator closed'); } catch (_e) { /* ignore */ }
      this.socket = null;
    }
    this.emitter.removeAll();
  }

  /** True when a socket is connected and the aggregator is listening. */
  isConnected(): boolean {
    return this.socket !== null && !this.closed;
  }

  // -------------------------------------------------------------------------
  // Public API — events
  // -------------------------------------------------------------------------

  on<K extends keyof AggregatorEvents>(
    event: K,
    listener: Listener<AggregatorEvents[K]>,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof AggregatorEvents>(
    event: K,
    listener: Listener<AggregatorEvents[K]>,
  ): void {
    this.emitter.off(event, listener);
  }

  // -------------------------------------------------------------------------
  // Public API — direct ingestion (also used by tests)
  // -------------------------------------------------------------------------

  /**
   * Ingests a raw bus event. Returns the resulting notification (after
   * normalization, scoring and dedup) or `undefined` if it was suppressed
   * as a duplicate. If the rate-limit is exhausted, the notification is
   * stored and queued for deferred delivery.
   */
  async ingest(raw: RawBusEvent): Promise<UnifiedNotification | undefined> {
    let normalized: UnifiedNotification;
    try {
      normalized = this.normalize(raw);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ err: error, raw }, 'Dropping invalid bus event');
      this.emitter.emit('error', { error });
      return undefined;
    }

    if (this.isDuplicate(normalized.dedupeKey)) {
      this.emitter.emit('duplicate', { dedupeKey: normalized.dedupeKey });
      return undefined;
    }
    this.recordDedupe(normalized.dedupeKey);

    // Score the notification before storing so consumers can rely on it.
    normalized.priority = clamp(this.priority.score(normalized), 1, 10);

    await this.store.put(normalized);

    if (this.limiter.tryAdmit()) {
      this.emitter.emit('notification', normalized);
    } else {
      this.enqueueDeferred(normalized);
    }

    await this.enforceStorageBudget();
    return normalized;
  }

  /** Ingests a JSON-encoded payload — used by the socket handler. */
  async ingestJson(json: string): Promise<UnifiedNotification | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitter.emit('error', { error });
      return undefined;
    }
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return this.ingest(parsed as RawBusEvent);
  }

  // -------------------------------------------------------------------------
  // Public API — user actions
  // -------------------------------------------------------------------------

  async markRead(id: string): Promise<UnifiedNotification | undefined> {
    const updated = await this.store.update(id, { read: true });
    if (updated) {
      this.emitter.emit('read', updated);
      this.emitter.emit('update', updated);
      this.relayUpstream({ type: 'NOTIFICATION_READ', id });
    }
    return updated;
  }

  async markAllReadForApp(app: QuantApp): Promise<number> {
    const items = await this.store.list({ app, read: false });
    let n = 0;
    for (const item of items) {
      const updated = await this.store.update(item.id, { read: true });
      if (updated) {
        this.emitter.emit('read', updated);
        this.emitter.emit('update', updated);
        n += 1;
      }
    }
    if (n > 0) this.relayUpstream({ type: 'NOTIFICATIONS_READ_BULK', app, count: n });
    return n;
  }

  async markAllReadGlobally(): Promise<number> {
    const items = await this.store.list({ read: false });
    let n = 0;
    for (const item of items) {
      const updated = await this.store.update(item.id, { read: true });
      if (updated) {
        this.emitter.emit('read', updated);
        this.emitter.emit('update', updated);
        n += 1;
      }
    }
    if (n > 0) this.relayUpstream({ type: 'NOTIFICATIONS_READ_BULK', count: n });
    return n;
  }

  async dismiss(id: string): Promise<UnifiedNotification | undefined> {
    const updated = await this.store.update(id, { dismissed: true, read: true });
    if (updated) {
      this.emitter.emit('dismiss', updated);
      this.emitter.emit('update', updated);
      this.relayUpstream({ type: 'NOTIFICATION_DISMISSED', id });
    }
    return updated;
  }

  async snooze(id: string, ms: number): Promise<UnifiedNotification | undefined> {
    if (ms <= 0) throw new Error('snooze duration must be positive');
    const until = this.clock.now() + ms;
    const updated = await this.store.update(id, { snoozedUntil: until });
    if (updated) this.emitter.emit('update', updated);
    return updated;
  }

  /**
   * Invokes a quick action (reply, like, accept…) defined on a notification
   * by relaying the action and its payload back over the bus. Returns the
   * notification if found, otherwise undefined.
   */
  async invokeAction(
    notificationId: string,
    actionId: string,
    extra?: Record<string, unknown>,
  ): Promise<UnifiedNotification | undefined> {
    const n = await this.store.get(notificationId);
    if (!n) return undefined;
    const action = n.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`No action ${actionId} on notification ${notificationId}`);
    this.relayUpstream({
      type: 'NOTIFICATION_ACTION',
      notificationId,
      actionId,
      intent: action.intent,
      payload: { ...(action.payload ?? {}), ...(extra ?? {}) },
    });
    // Most actions imply read.
    return this.markRead(notificationId);
  }

  /** Lists notifications respecting an optional filter. */
  list(filter?: NotificationListFilter): Promise<UnifiedNotification[]> {
    return this.store.list(filter);
  }

  /** Returns counts grouped by app — used to badge the dashboard. */
  async badgeCounts(): Promise<Record<QuantApp, number>> {
    const all = await this.store.list({ read: false, dismissed: false });
    const out = Object.fromEntries(QUANT_APPS.map((a) => [a, 0])) as Record<QuantApp, number>;
    const now = this.clock.now();
    for (const n of all) {
      if (n.snoozedUntil && n.snoozedUntil > now) continue;
      out[n.app] = (out[n.app] ?? 0) + 1;
    }
    return out;
  }

  /** Convenience: total unread, dismissed-aware. */
  async unreadCount(): Promise<number> {
    const counts = await this.badgeCounts();
    return Object.values(counts).reduce((s, x) => s + x, 0);
  }

  /** Returns a snapshot of the underlying store for diagnostics. */
  storeRef(): NotificationStore {
    return this.store;
  }

  /** Number of items currently waiting for a rate-limit slot. */
  pendingCount(): number {
    return this.pendingQueue.length;
  }

  // -------------------------------------------------------------------------
  // Internals — socket lifecycle
  // -------------------------------------------------------------------------

  private attachSocket(sock: BusSocket): void {
    this.socket = sock;
    sock.onOpen(() => {
      this.reconnectAttempt = 0;
      this.emitter.emit('connected', { url: sock.url });
      logger.info({ url: sock.url }, 'NotificationAggregator connected');
    });
    sock.onMessage((raw) => {
      void this.ingestJson(raw);
    });
    sock.onClose((code, reason) => {
      this.emitter.emit('disconnected', { url: sock.url, code, reason });
      logger.info({ url: sock.url, code, reason }, 'NotificationAggregator disconnected');
      this.socket = null;
      if (!this.closed) this.scheduleReconnect();
    });
    sock.onError((err) => {
      this.emitter.emit('error', { error: err });
      logger.warn({ err }, 'NotificationAggregator socket error');
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectHandle !== null) return;
    const expBase = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * 2 ** this.reconnectAttempt,
    );
    const jitterAmount = expBase * this.jitter;
    const delay = Math.max(0, expBase + (Math.random() * 2 - 1) * jitterAmount);
    this.reconnectAttempt += 1;
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = null;
      this.connect();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Internals — normalization
  // -------------------------------------------------------------------------

  private normalize(raw: RawBusEvent): UnifiedNotification {
    const kind = parseKind(raw.kind);
    const app = parseApp(raw.app, kind);
    const id = (raw.id && String(raw.id)) || this.idGen();
    const occurredAt = isoTimestamp(raw.occurredAt) ?? new Date(this.clock.now()).toISOString();
    const receivedAt = new Date(this.clock.now()).toISOString();
    const dedupeKey = (raw.dedupeKey && String(raw.dedupeKey)) || `${app}:${kind}:${id}`;
    const title = clipString(raw.title ?? defaultTitle(kind), 200);
    const body = clipString(raw.body ?? '', 1000);
    const previews = normalizePreviews(raw.previews);
    const actions = normalizeActions(raw.actions);
    return {
      id,
      dedupeKey,
      app,
      kind,
      title,
      body,
      previews,
      actions,
      deepLink: raw.deepLink ? String(raw.deepLink) : undefined,
      occurredAt,
      receivedAt,
      senderId: raw.senderId ? String(raw.senderId) : undefined,
      senderName: raw.senderName ? String(raw.senderName) : undefined,
      priority: 5,
      read: false,
      dismissed: false,
      meta: Object.freeze({ ...(raw.meta ?? {}) }),
    };
  }

  // -------------------------------------------------------------------------
  // Internals — dedup
  // -------------------------------------------------------------------------

  private isDuplicate(key: string): boolean {
    this.evictExpiredDedupe();
    return this.recentDedupe.has(key);
  }

  private recordDedupe(key: string): void {
    this.recentDedupe.set(key, this.clock.now());
  }

  private evictExpiredDedupe(): void {
    const cutoff = this.clock.now() - NotificationAggregator.DEDUPE_WINDOW_MS;
    for (const [k, ts] of Array.from(this.recentDedupe.entries())) {
      if (ts < cutoff) this.recentDedupe.delete(k);
    }
  }

  // -------------------------------------------------------------------------
  // Internals — rate-limit queue
  // -------------------------------------------------------------------------

  private enqueueDeferred(n: UnifiedNotification): void {
    if (this.pendingQueue.length >= this.maxQueue) {
      // Drop the lowest-priority item to make room — newer/higher priority wins.
      let minIdx = 0;
      for (let i = 1; i < this.pendingQueue.length; i += 1) {
        if (this.pendingQueue[i].priority < this.pendingQueue[minIdx].priority) minIdx = i;
      }
      const dropped = this.pendingQueue.splice(minIdx, 1)[0];
      logger.debug({ dropped: dropped.id }, 'Rate-limit queue full, evicting low-priority');
    }
    this.pendingQueue.push(n);
    this.pendingQueue.sort((a, b) => b.priority - a.priority);
    const next = this.limiter.timeUntilSlotMs();
    this.emitter.emit('rateLimited', { queued: this.pendingQueue.length, nextSlotInMs: next });
    this.scheduleFlush(next);
  }

  private scheduleFlush(ms: number): void {
    if (this.flushHandle !== null) return;
    const delay = Math.max(50, ms);
    this.flushHandle = this.timers.setTimeout(() => {
      this.flushHandle = null;
      this.flushDeferred();
    }, delay);
  }

  private flushDeferred(): void {
    while (this.pendingQueue.length > 0 && this.limiter.tryAdmit()) {
      const next = this.pendingQueue.shift();
      if (next) this.emitter.emit('notification', next);
    }
    if (this.pendingQueue.length > 0) {
      this.scheduleFlush(this.limiter.timeUntilSlotMs());
    }
  }

  // -------------------------------------------------------------------------
  // Internals — storage budget
  // -------------------------------------------------------------------------

  private async enforceStorageBudget(): Promise<void> {
    const total = await this.store.count();
    if (total <= this.maxStored) return;
    // Drop the oldest dismissed/read items first; then fall back to age.
    const all = await this.store.list({ orderBy: 'receivedAt', order: 'asc' });
    const overflow = total - this.maxStored;
    let removed = 0;
    for (const n of all) {
      if (removed >= overflow) break;
      if (n.dismissed || n.read) {
        await this.store.delete(n.id);
        removed += 1;
      }
    }
    if (removed < overflow) {
      for (const n of all) {
        if (removed >= overflow) break;
        await this.store.delete(n.id);
        removed += 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals — upstream relay
  // -------------------------------------------------------------------------

  private relayUpstream(message: Record<string, unknown>): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      logger.warn({ err }, 'Failed to relay action upstream');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseKind(value: unknown): NotificationKind {
  const v = String(value ?? '').toLowerCase();
  switch (v) {
    case 'message':
    case 'broadcast':
    case 'match':
    case 'ad_performance':
    case 'edit_share':
    case 'video_engagement':
    case 'email':
    case 'metaverse_event':
    case 'web_clip':
    case 'system':
      return v as NotificationKind;
    default:
      throw new Error(`Unknown notification kind: ${String(value)}`);
  }
}

function parseApp(value: unknown, fallbackKind: NotificationKind): QuantApp {
  const v = String(value ?? '').toLowerCase();
  if ((QUANT_APPS as readonly string[]).includes(v)) return v as QuantApp;
  return KIND_TO_APP[fallbackKind];
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

function clipString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function normalizePreviews(
  raw: RawBusEvent['previews'],
): readonly NotificationPreview[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationPreview[] = [];
  for (const p of raw) {
    if (!p || typeof p.value !== 'string') continue;
    const type = p.type as NotificationPreview['type'];
    if (!type || !['image', 'video', 'text', 'audio', 'link'].includes(type)) continue;
    out.push({
      type,
      value: p.value,
      caption: typeof p.caption === 'string' ? p.caption : undefined,
      durationSec: typeof p.durationSec === 'number' ? p.durationSec : undefined,
    });
  }
  return out;
}

function normalizeActions(
  raw: RawBusEvent['actions'],
): readonly NotificationAction[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationAction[] = [];
  for (const a of raw) {
    if (!a || typeof a.id !== 'string' || typeof a.label !== 'string') continue;
    const intent = a.intent as NotificationAction['intent'];
    if (
      !intent ||
      !['reply', 'like', 'accept', 'decline', 'archive', 'open', 'share', 'mute', 'snooze']
        .includes(intent)
    ) continue;
    out.push({
      id: a.id,
      label: a.label,
      intent,
      payload: a.payload ? Object.freeze({ ...a.payload }) : undefined,
    });
  }
  return out;
}

function defaultTitle(kind: NotificationKind): string {
  switch (kind) {
    case 'message':          return 'New message';
    case 'broadcast':        return 'New broadcast';
    case 'match':            return 'It’s a match';
    case 'ad_performance':   return 'Ad performance update';
    case 'edit_share':       return 'Edit shared with you';
    case 'video_engagement': return 'New engagement on your video';
    case 'email':            return 'New email';
    case 'metaverse_event':  return 'Metaverse event';
    case 'web_clip':         return 'Saved clip';
    case 'system':           return 'System notice';
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const HEX = '0123456789abcdef';
function defaultIdGenerator(): string {
  // Prefer crypto.randomUUID when available (modern Node, browser).
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  // Fallback: 32-hex pseudo-uuid using Math.random — adequate for ids only.
  let s = '';
  for (let i = 0; i < 32; i += 1) s += HEX[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${
    HEX[8 + Math.floor(Math.random() * 4)]
  }${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

/**
 * Build an aggregator pre-wired with an in-memory store. Mostly used
 * by tests, the React `UnifiedNotificationUI` (which swaps in an
 * IndexedDB-backed store at runtime) and the Node side-car worker.
 */
export function createInMemoryAggregator(
  config: Omit<NotificationAggregatorConfig, 'store'>,
): NotificationAggregator {
  return new NotificationAggregator({ ...config, store: new InMemoryNotificationStore() });
}
