import logger from '../lib/logger';

/**
 * EphemeralBroadcastWorker — Self-Destruct Timer & Loss-Aversion Alerts
 *
 * Every broadcast published to the Quantsink Pro Zone is ephemeral by
 * default: it self-destructs after a configurable TTL (2h by default).
 * The worker is responsible for:
 *
 *  - Registering broadcasts with a creation timestamp + TTL.
 *  - Ticking at a fixed interval (default 1s) and emitting countdown
 *    snapshots consumed by the React timer UI.
 *  - Firing life-cycle events: `REGISTERED` / `TICK` / `WARNING` (when
 *    50%/75%/90% of the TTL has elapsed) / `EXPIRED` / `DESTROYED`.
 *  - Scheduling loss-aversion alerts based on the broadcaster's tier,
 *    so the UI can display "Your Platinum status expires in 3 days" at
 *    the appropriate moment.
 *
 * The worker is 100% deterministic when supplied with injectable clock,
 * scheduler and RNG primitives — the same pattern used by
 * `PhantomSocialService` — which makes Jest testing trivial.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BroadcastLifecycleState =
  | 'REGISTERED'
  | 'ACTIVE'
  | 'WARNING'
  | 'EXPIRED'
  | 'DESTROYED';

export interface EphemeralBroadcast {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly ttlMs: number;
  readonly ownerId: string;
  readonly headline: string;
  state: BroadcastLifecycleState;
}

export interface CountdownSnapshot {
  readonly broadcastId: string;
  readonly msRemaining: number;
  readonly percentRemaining: number;
  readonly state: BroadcastLifecycleState;
  readonly urgency: 'STEADY' | 'WARM' | 'HOT' | 'CRITICAL' | 'BURNT';
  readonly formatted: string;
  readonly at: Date;
}

export interface LossAversionAlert {
  readonly ownerId: string;
  readonly tier: string;
  readonly expiresAt: Date;
  readonly message: string;
  readonly level: 'NUDGE' | 'URGENT' | 'CRITICAL';
  readonly at: Date;
}

export type CountdownListener = (snapshot: CountdownSnapshot) => void;
export type LifecycleListener = (broadcast: EphemeralBroadcast) => void;
export type LossAversionListener = (alert: LossAversionAlert) => void;

export interface EphemeralBroadcastOptions {
  /** Default TTL applied when a broadcast is registered without one. */
  readonly defaultTtlMs?: number;
  /** Countdown tick cadence in ms. Default 1000. */
  readonly tickIntervalMs?: number;
  /** Clock override. */
  readonly now?: () => Date;
  /** Scheduler override (same shape as PhantomSocialService). */
  readonly scheduler?: SchedulerApi;
}

export interface SchedulerApi {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = { readonly __brand: 'timer' } | ReturnType<typeof setTimeout>;

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1_000; // 2 hours
const DEFAULT_TICK_MS = 1_000;

const defaultScheduler: SchedulerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a millisecond count as `HH:MM:SS` (or `MM:SS` when < 1h).
 * Returns `00:00` when msRemaining is <= 0.
 */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00';
  const totalSeconds = Math.floor(msRemaining / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** Map a percent-remaining value to a named urgency bucket. */
export function urgencyFor(percentRemaining: number): CountdownSnapshot['urgency'] {
  if (percentRemaining <= 0) return 'BURNT';
  if (percentRemaining <= 0.1) return 'CRITICAL';
  if (percentRemaining <= 0.25) return 'HOT';
  if (percentRemaining <= 0.5) return 'WARM';
  return 'STEADY';
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class EphemeralBroadcastWorker {
  private readonly defaultTtlMs: number;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly scheduler: SchedulerApi;

  private broadcasts: Map<string, EphemeralBroadcast> = new Map();
  private warningsFired: Map<string, Set<number>> = new Map();
  private tickHandle: TimerHandle | null = null;
  private started = false;
  private countdownListeners: Set<CountdownListener> = new Set();
  private lifecycleListeners: Set<LifecycleListener> = new Set();
  private lossAversionListeners: Set<LossAversionListener> = new Set();

  constructor(options: EphemeralBroadcastOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? defaultScheduler;

    if (this.defaultTtlMs <= 0) {
      throw new Error(`defaultTtlMs must be positive (got ${this.defaultTtlMs}).`);
    }
    if (this.tickIntervalMs <= 0) {
      throw new Error(`tickIntervalMs must be positive (got ${this.tickIntervalMs}).`);
    }
  }

  // -------------------------------------------------------------------------
  // Public API — lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a broadcast for countdown tracking. If `ttlMs` is omitted
   * the worker uses the configured default. Returns the newly created
   * `EphemeralBroadcast` record.
   */
  register(input: {
    id: string;
    ownerId: string;
    headline: string;
    ttlMs?: number;
    createdAt?: Date;
  }): EphemeralBroadcast {
    if (!input.id) throw new Error('register: id is required.');
    if (this.broadcasts.has(input.id)) {
      throw new Error(`register: broadcast ${input.id} is already registered.`);
    }
    const createdAt = input.createdAt ?? this.now();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (ttlMs <= 0) {
      throw new Error(`register: ttlMs must be positive (got ${ttlMs}).`);
    }
    const broadcast: EphemeralBroadcast = {
      id: input.id,
      ownerId: input.ownerId,
      headline: input.headline,
      createdAt,
      ttlMs,
      expiresAt: new Date(createdAt.getTime() + ttlMs),
      state: 'REGISTERED',
    };
    this.broadcasts.set(broadcast.id, broadcast);
    this.warningsFired.set(broadcast.id, new Set());
    this.emitLifecycle(broadcast);
    broadcast.state = 'ACTIVE';
    logger.info(
      { broadcastId: broadcast.id, ttlMs, expiresAt: broadcast.expiresAt },
      'EphemeralBroadcastWorker registered broadcast',
    );
    return broadcast;
  }

  /**
   * Remove a broadcast from the worker. Emits a DESTROYED lifecycle
   * event so UI layers can clean up animations. Returns true when a
   * broadcast was present and removed.
   */
  destroy(id: string): boolean {
    const bc = this.broadcasts.get(id);
    if (!bc) return false;
    bc.state = 'DESTROYED';
    this.emitLifecycle(bc);
    this.broadcasts.delete(id);
    this.warningsFired.delete(id);
    return true;
  }

  /**
   * Start the worker's interval tick. Idempotent. Call `stop()` on
   * unmount to avoid leaking timers.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleTick();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.tickHandle) {
      this.scheduler.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Manually trigger a single tick. Used by tests and by embedding
   * contexts that want to drive the clock explicitly.
   */
  tickOnce(): readonly CountdownSnapshot[] {
    const snapshots: CountdownSnapshot[] = [];
    const now = this.now();
    for (const broadcast of this.broadcasts.values()) {
      const snapshot = this.snapshotFor(broadcast, now);
      snapshots.push(snapshot);
      this.emitCountdown(snapshot);
      this.maybeFireWarnings(broadcast, snapshot);
      if (snapshot.msRemaining <= 0 && broadcast.state !== 'EXPIRED') {
        broadcast.state = 'EXPIRED';
        this.emitLifecycle(broadcast);
      }
    }
    return snapshots;
  }

  // -------------------------------------------------------------------------
  // Public API — loss aversion
  // -------------------------------------------------------------------------

  /**
   * Publish a loss-aversion alert. Used by higher-level orchestrators
   * (e.g. `RewardEngine.computeLossAversion`) that have already decided
   * the tier/expiry. We still classify the level here so callers don't
   * need to repeat the policy.
   */
  publishLossAversion(input: {
    ownerId: string;
    tier: string;
    expiresAt: Date;
  }): LossAversionAlert {
    const msRemaining = input.expiresAt.getTime() - this.now().getTime();
    const hoursRemaining = msRemaining / 3_600_000;

    let level: LossAversionAlert['level'];
    let message: string;

    if (hoursRemaining <= 0) {
      level = 'CRITICAL';
      message = `Your ${input.tier} status has lapsed. Broadcast immediately to reinstate it.`;
    } else if (hoursRemaining <= 24) {
      level = 'URGENT';
      const hrs = Math.max(1, Math.round(hoursRemaining));
      message = `Your ${input.tier} Broadcaster status expires in ${hrs}h. Post now to maintain it.`;
    } else {
      level = 'NUDGE';
      const days = Math.max(1, Math.round(hoursRemaining / 24));
      message = `Your ${input.tier} Broadcaster status expires in ${days} day${days === 1 ? '' : 's'}. Post now to maintain it.`;
    }

    const alert: LossAversionAlert = {
      ownerId: input.ownerId,
      tier: input.tier,
      expiresAt: input.expiresAt,
      message,
      level,
      at: this.now(),
    };
    this.emitLossAversion(alert);
    return alert;
  }

  // -------------------------------------------------------------------------
  // Listener registration
  // -------------------------------------------------------------------------

  onCountdown(listener: CountdownListener): () => void {
    this.countdownListeners.add(listener);
    return () => {
      this.countdownListeners.delete(listener);
    };
  }

  onLifecycle(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  onLossAversion(listener: LossAversionListener): () => void {
    this.lossAversionListeners.add(listener);
    return () => {
      this.lossAversionListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  getBroadcast(id: string): EphemeralBroadcast | undefined {
    return this.broadcasts.get(id);
  }

  listBroadcasts(): readonly EphemeralBroadcast[] {
    return Array.from(this.broadcasts.values());
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Compute a snapshot without emitting events — purely functional. */
  snapshotFor(broadcast: EphemeralBroadcast, now: Date = this.now()): CountdownSnapshot {
    const elapsed = now.getTime() - broadcast.createdAt.getTime();
    const msRemaining = Math.max(0, broadcast.ttlMs - elapsed);
    const percentRemaining = broadcast.ttlMs === 0 ? 0 : msRemaining / broadcast.ttlMs;
    const urgency = urgencyFor(percentRemaining);
    const state: BroadcastLifecycleState =
      msRemaining <= 0 ? 'EXPIRED' : urgency === 'STEADY' ? 'ACTIVE' : 'WARNING';
    return {
      broadcastId: broadcast.id,
      msRemaining,
      percentRemaining,
      state,
      urgency,
      formatted: formatCountdown(msRemaining),
      at: now,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private scheduleTick(): void {
    if (!this.started) return;
    this.tickHandle = this.scheduler.setTimeout(() => {
      this.tickOnce();
      this.scheduleTick();
    }, this.tickIntervalMs);
  }

  private maybeFireWarnings(broadcast: EphemeralBroadcast, snapshot: CountdownSnapshot): void {
    const fired = this.warningsFired.get(broadcast.id);
    if (!fired) return;
    const thresholds = [0.5, 0.25, 0.1];
    for (const t of thresholds) {
      if (snapshot.percentRemaining <= t && !fired.has(t)) {
        fired.add(t);
        broadcast.state = 'WARNING';
        this.emitLifecycle(broadcast);
      }
    }
  }

  private emitCountdown(snapshot: CountdownSnapshot): void {
    this.countdownListeners.forEach((l) => {
      try {
        l(snapshot);
      } catch (err) {
        logger.warn({ err }, 'EphemeralBroadcastWorker countdown listener threw');
      }
    });
  }

  private emitLifecycle(broadcast: EphemeralBroadcast): void {
    this.lifecycleListeners.forEach((l) => {
      try {
        l(broadcast);
      } catch (err) {
        logger.warn({ err }, 'EphemeralBroadcastWorker lifecycle listener threw');
      }
    });
  }

  private emitLossAversion(alert: LossAversionAlert): void {
    this.lossAversionListeners.forEach((l) => {
      try {
        l(alert);
      } catch (err) {
        logger.warn({ err }, 'EphemeralBroadcastWorker loss-aversion listener threw');
      }
    });
  }
}

export default EphemeralBroadcastWorker;
