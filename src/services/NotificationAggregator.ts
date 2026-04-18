/**
 * NotificationAggregator — Cross-App Unified Notification Hub
 *
 * Central WebSocket event bus that receives notifications from all 9 Quant
 * applications (Quantchat, Quantsink, Quantchill, Quantads, Quantedits,
 * Quanttube, Quantmail, Quantneon, Quantbrowse) and aggregates them into a
 * single, deduplicated, rate-limited stream.
 *
 * Features:
 *  - WebSocket connection management with automatic reconnect and heartbeat.
 *  - Deduplication: suppress the same logical event received from multiple
 *    channels within a configurable time window (default 30 s).
 *  - Rate limiter: max 20 notifications per minute per source app.
 *  - IndexedDB persistence layer for offline access (browser) with an
 *    in-memory fallback for Node / Jest environments.
 *  - Typed event payloads for all 9 Quant apps.
 *  - Observable listener pattern — consumers subscribe and receive
 *    `AggregatedNotification` objects in priority-sorted order.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuantApp =
  | 'quantchat'
  | 'quantsink'
  | 'quantchill'
  | 'quantads'
  | 'quantedits'
  | 'quanttube'
  | 'quantmail'
  | 'quantneon'
  | 'quantbrowse';

export type NotificationEventType =
  | 'message'           // Quantchat
  | 'broadcast'         // Quantsink
  | 'match'             // Quantchill
  | 'ad_performance'    // Quantads
  | 'edit_share'        // Quantedits
  | 'video_engagement'  // Quanttube
  | 'email'             // Quantmail
  | 'metaverse_event'   // Quantneon
  | 'web_clip';         // Quantbrowse

export const APP_EVENT_MAP: Record<QuantApp, NotificationEventType> = {
  quantchat:    'message',
  quantsink:    'broadcast',
  quantchill:   'match',
  quantads:     'ad_performance',
  quantedits:   'edit_share',
  quanttube:    'video_engagement',
  quantmail:    'email',
  quantneon:    'metaverse_event',
  quantbrowse:  'web_clip',
};

export interface RawNotificationEvent {
  /** Unique identifier for this logical event (used for dedup). */
  readonly eventId: string;
  /** Source application. */
  readonly app: QuantApp;
  /** Event type category. */
  readonly type: NotificationEventType;
  /** Human-readable notification title. */
  readonly title: string;
  /** Optional body text / preview snippet. */
  readonly body?: string;
  /** Optional rich media URL (image / video thumbnail). */
  readonly mediaUrl?: string;
  /** ISO-8601 timestamp when the event occurred. */
  readonly occurredAt: string;
  /** Sender identity (userId, username, etc.) */
  readonly senderId?: string;
  readonly senderName?: string;
  /** Any app-specific metadata. */
  readonly metadata?: Record<string, unknown>;
}

export interface AggregatedNotification extends RawNotificationEvent {
  /** Internal auto-increment id for storage ordering. */
  readonly id: number;
  /** When the aggregator received this notification. */
  readonly receivedAt: string;
  /** Whether the user has read this notification. */
  read: boolean;
  /** Priority score assigned by NotificationPriorityAI (0–10). */
  priorityScore: number;
}

// ---------------------------------------------------------------------------
// Storage abstraction
// ---------------------------------------------------------------------------

export interface NotificationStore {
  put(notification: AggregatedNotification): Promise<void>;
  getAll(): Promise<AggregatedNotification[]>;
  markRead(id: number): Promise<void>;
  markAllRead(app?: QuantApp): Promise<void>;
  delete(id: number): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

/**
 * In-memory store — used in Node / Jest environments where IndexedDB is
 * unavailable.  Also acts as a caching layer in front of IndexedDB.
 */
export class InMemoryNotificationStore implements NotificationStore {
  private readonly map = new Map<number, AggregatedNotification>();

  async put(notification: AggregatedNotification): Promise<void> {
    this.map.set(notification.id, { ...notification });
  }

  async getAll(): Promise<AggregatedNotification[]> {
    return Array.from(this.map.values()).sort((a, b) => b.id - a.id);
  }

  async markRead(id: number): Promise<void> {
    const n = this.map.get(id);
    if (n) this.map.set(id, { ...n, read: true });
  }

  async markAllRead(app?: QuantApp): Promise<void> {
    for (const [id, n] of this.map) {
      if (!app || n.app === app) {
        this.map.set(id, { ...n, read: true });
      }
    }
  }

  async delete(id: number): Promise<void> {
    this.map.delete(id);
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async count(): Promise<number> {
    return this.map.size;
  }

  /** Expose raw map for testing. */
  _raw(): ReadonlyMap<number, AggregatedNotification> {
    return this.map;
  }
}

/** IndexedDB-backed store (browser only). */
export class IndexedDBNotificationStore implements NotificationStore {
  private static readonly DB_NAME = 'quant-notifications';
  private static readonly STORE_NAME = 'notifications';
  private static readonly DB_VERSION = 1;

  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(
        IndexedDBNotificationStore.DB_NAME,
        IndexedDBNotificationStore.DB_VERSION,
      );
      req.onupgradeneeded = (ev) => {
        const db = (ev.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(IndexedDBNotificationStore.STORE_NAME)) {
          const store = db.createObjectStore(
            IndexedDBNotificationStore.STORE_NAME,
            { keyPath: 'id', autoIncrement: false },
          );
          store.createIndex('app', 'app', { unique: false });
          store.createIndex('read', 'read', { unique: false });
          store.createIndex('receivedAt', 'receivedAt', { unique: false });
        }
      };
      req.onsuccess = (ev) => resolve((ev.target as IDBOpenDBRequest).result);
      req.onerror = (ev) =>
        reject(new Error(`IndexedDB open failed: ${(ev.target as IDBOpenDBRequest).error}`));
    });
    return this.dbPromise;
  }

  async put(notification: AggregatedNotification): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBNotificationStore.STORE_NAME, 'readwrite');
      tx.objectStore(IndexedDBNotificationStore.STORE_NAME).put(notification);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAll(): Promise<AggregatedNotification[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBNotificationStore.STORE_NAME, 'readonly');
      const req = tx.objectStore(IndexedDBNotificationStore.STORE_NAME).getAll();
      req.onsuccess = () => {
        const results = (req.result as AggregatedNotification[]).sort((a, b) => b.id - a.id);
        resolve(results);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async markRead(id: number): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBNotificationStore.STORE_NAME, 'readwrite');
      const objectStore = tx.objectStore(IndexedDBNotificationStore.STORE_NAME);
      const getReq = objectStore.get(id);
      getReq.onsuccess = () => {
        if (getReq.result) {
          objectStore.put({ ...getReq.result, read: true });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async markAllRead(app?: QuantApp): Promise<void> {
    const all = await this.getAll();
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBNotificationStore.STORE_NAME, 'readwrite');
      const objectStore = tx.objectStore(IndexedDBNotificationStore.STORE_NAME);
      for (const n of all) {
        if (!app || n.app === app) {
          objectStore.put({ ...n, read: true });
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(id: number): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBNotificationStore.STORE_NAME, 'readwrite');
      tx.objectStore(IndexedDBNotificationStore.STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBNotificationStore.STORE_NAME, 'readwrite');
      tx.objectStore(IndexedDBNotificationStore.STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async count(): Promise<number> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBNotificationStore.STORE_NAME, 'readonly');
      const req = tx.objectStore(IndexedDBNotificationStore.STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Token-bucket rate limiter scoped per source app.
 * Default: 20 notifications per 60-second window.
 */
export class NotificationRateLimiter {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  /** app → list of reception timestamps within the current window */
  private readonly buckets = new Map<QuantApp, number[]>();

  constructor(maxPerWindow = 20, windowMs = 60_000) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  /**
   * Returns true if the notification from `app` may pass through;
   * false if the rate limit has been reached.
   */
  allow(app: QuantApp, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const bucket = (this.buckets.get(app) ?? []).filter((t) => t > cutoff);
    if (bucket.length >= this.maxPerWindow) {
      this.buckets.set(app, bucket);
      return false;
    }
    bucket.push(now);
    this.buckets.set(app, bucket);
    return true;
  }

  /** How many notifications remain in the window for `app`. */
  remaining(app: QuantApp, now: number = Date.now()): number {
    const cutoff = now - this.windowMs;
    const bucket = (this.buckets.get(app) ?? []).filter((t) => t > cutoff);
    return Math.max(0, this.maxPerWindow - bucket.length);
  }

  /** Reset all buckets (useful for testing). */
  reset(): void {
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// Deduplication cache
// ---------------------------------------------------------------------------

/**
 * In-memory deduplication cache.  Stores event IDs with expiry timestamps
 * so the same logical event received from multiple WebSocket channels is
 * only delivered once.
 */
export class DeduplicationCache {
  private readonly ttlMs: number;
  private readonly seen = new Map<string, number>();
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true if `eventId` has NOT been seen before (i.e., it should be
   * processed).  Registers the id on first call.
   */
  isNew(eventId: string, now: number = Date.now()): boolean {
    const expiresAt = this.seen.get(eventId);
    if (expiresAt !== undefined && now < expiresAt) return false;
    this.seen.set(eventId, now + this.ttlMs);
    return true;
  }

  /** Evict expired entries. Called automatically when `startAutoCleanup` is used. */
  evictExpired(now: number = Date.now()): void {
    for (const [id, expiresAt] of this.seen) {
      if (now >= expiresAt) this.seen.delete(id);
    }
  }

  /** Start periodic cleanup (browser / long-running server). */
  startAutoCleanup(intervalMs = 60_000): void {
    if (this.cleanupHandle) return;
    this.cleanupHandle = setInterval(() => this.evictExpired(), intervalMs);
    if (
      this.cleanupHandle &&
      typeof (this.cleanupHandle as unknown as { unref?: () => void }).unref === 'function'
    ) {
      (this.cleanupHandle as unknown as { unref: () => void }).unref();
    }
  }

  stopAutoCleanup(): void {
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
  }

  /** Current cache size (for diagnostics). */
  size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }
}

// ---------------------------------------------------------------------------
// WebSocket message shape from the unified event bus
// ---------------------------------------------------------------------------

interface EventBusMessage {
  readonly type: 'NOTIFICATION';
  readonly payload: RawNotificationEvent;
}

// ---------------------------------------------------------------------------
// NotificationAggregator
// ---------------------------------------------------------------------------

export type NotificationListener = (notification: AggregatedNotification) => void;

export interface AggregatorOptions {
  /** WebSocket URL of the unified Quant event bus. */
  readonly wsUrl?: string;
  /** Override the storage backend (useful for tests). */
  readonly store?: NotificationStore;
  /** Override the rate limiter (useful for tests). */
  readonly rateLimiter?: NotificationRateLimiter;
  /** Override the dedup cache (useful for tests). */
  readonly dedupCache?: DeduplicationCache;
  /** Reconnect delay in ms (exponential back-off base). Default 1000. */
  readonly reconnectBaseMs?: number;
  /** Maximum reconnect delay. Default 30 000. */
  readonly reconnectMaxMs?: number;
  /** Clock override for testing. */
  readonly now?: () => number;
  /** Auto-start connection on construction. Default false. */
  readonly autoConnect?: boolean;
}

/**
 * The NotificationAggregator is the single point of truth for all cross-app
 * notifications.  It manages the WebSocket lifecycle, deduplicates events,
 * applies rate limiting, persists to IndexedDB, and fans out to registered
 * listeners in priority order.
 */
export class NotificationAggregator {
  private readonly wsUrl: string;
  private readonly store: NotificationStore;
  private readonly rateLimiter: NotificationRateLimiter;
  private readonly dedupCache: DeduplicationCache;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly now: () => number;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private destroyed = false;
  private idCounter = 0;

  private readonly listeners = new Set<NotificationListener>();

  constructor(options: AggregatorOptions = {}) {
    this.wsUrl = options.wsUrl ?? 'wss://events.quant.app/ws';
    this.store = options.store ?? new InMemoryNotificationStore();
    this.rateLimiter = options.rateLimiter ?? new NotificationRateLimiter();
    this.dedupCache = options.dedupCache ?? new DeduplicationCache();
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.now = options.now ?? Date.now.bind(Date);

    this.dedupCache.startAutoCleanup();

    if (options.autoConnect) {
      this.connect();
    }
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  connect(): void {
    if (this.destroyed) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
    };

    this.ws.onmessage = (event) => {
      this.handleRawMessage(event.data as string);
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.connected = false;
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Gracefully shut down: close WebSocket and stop background work. */
  destroy(): void {
    this.destroyed = true;
    this.dedupCache.stopAutoCleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.listeners.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  private handleRawMessage(raw: string): void {
    let msg: EventBusMessage;
    try {
      msg = JSON.parse(raw) as EventBusMessage;
    } catch {
      return;
    }
    if (msg.type !== 'NOTIFICATION' || !msg.payload) return;
    this.ingest(msg.payload);
  }

  /**
   * Programmatically inject a `RawNotificationEvent` — the same pipeline
   * used by the WebSocket handler.  Useful for testing and for injecting
   * server-side push events.
   */
  ingest(event: RawNotificationEvent): AggregatedNotification | null {
    const nowMs = this.now();

    // 1. Deduplication check.
    if (!this.dedupCache.isNew(event.eventId, nowMs)) return null;

    // 2. Rate limit check.
    if (!this.rateLimiter.allow(event.app, nowMs)) return null;

    // 3. Build aggregated record.
    this.idCounter += 1;
    const notification: AggregatedNotification = {
      ...event,
      id: this.idCounter,
      receivedAt: new Date(nowMs).toISOString(),
      read: false,
      priorityScore: 0, // Will be updated by NotificationPriorityAI externally.
    };

    // 4. Persist asynchronously (do not await — fire and forget).
    this.store.put(notification).catch(() => {
      // Storage failures are non-fatal.
    });

    // 5. Fan out to listeners.
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        // Listener errors must not break the pipeline.
      }
    }

    return notification;
  }

  // -------------------------------------------------------------------------
  // Listener management
  // -------------------------------------------------------------------------

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  unsubscribe(listener: NotificationListener): void {
    this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  // -------------------------------------------------------------------------
  // Store proxy helpers
  // -------------------------------------------------------------------------

  async getAll(): Promise<AggregatedNotification[]> {
    return this.store.getAll();
  }

  async getByApp(app: QuantApp): Promise<AggregatedNotification[]> {
    const all = await this.store.getAll();
    return all.filter((n) => n.app === app);
  }

  async getUnread(): Promise<AggregatedNotification[]> {
    const all = await this.store.getAll();
    return all.filter((n) => !n.read);
  }

  async markRead(id: number): Promise<void> {
    return this.store.markRead(id);
  }

  async markAllRead(app?: QuantApp): Promise<void> {
    return this.store.markAllRead(app);
  }

  async deleteNotification(id: number): Promise<void> {
    return this.store.delete(id);
  }

  async clearAll(): Promise<void> {
    return this.store.clear();
  }

  async unreadCount(app?: QuantApp): Promise<number> {
    const unread = await this.getUnread();
    return app ? unread.filter((n) => n.app === app).length : unread.length;
  }

  /**
   * Returns a badge-count map for all 9 apps: { quantchat: 3, quantsink: 1, … }
   */
  async badgeCounts(): Promise<Record<QuantApp, number>> {
    const unread = await this.getUnread();
    const counts: Record<QuantApp, number> = {
      quantchat: 0,
      quantsink: 0,
      quantchill: 0,
      quantads: 0,
      quantedits: 0,
      quanttube: 0,
      quantmail: 0,
      quantneon: 0,
      quantbrowse: 0,
    };
    for (const n of unread) {
      counts[n.app] += 1;
    }
    return counts;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  diagnostics(): {
    connected: boolean;
    listenerCount: number;
    dedupCacheSize: number;
    reconnectAttempt: number;
    idCounter: number;
  } {
    return {
      connected: this.connected,
      listenerCount: this.listeners.size,
      dedupCacheSize: this.dedupCache.size(),
      reconnectAttempt: this.reconnectAttempt,
      idCounter: this.idCounter,
    };
  }
}

export default NotificationAggregator;
