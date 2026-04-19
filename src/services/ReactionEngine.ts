import logger from '../lib/logger';

/**
 * ReactionEngine — Real-Time Live Broadcast Reaction Stream
 * =========================================================
 *
 * The ReactionEngine is the server-side heart of Quantsink's live broadcast
 * "Emoji Storm".  During any live broadcast viewers fire emoji reactions
 * that rain across the player; the engine is responsible for ingesting
 * those reactions at scale, throttling abuse, classifying combo / super
 * effects, aggregating per-broadcast snapshots, and pushing those
 * snapshots out to every connected viewer through the existing
 * BroadcastWebSocket transport.
 *
 * Functional requirements (issue #21):
 *
 *   - Sustain ≥ 10 000 reactions/second with constant memory.
 *   - Per-user throttle: max 5 reactions / second / broadcast.
 *   - Reaction types:
 *       * EMOJI         — any Unicode emoji ("standard" weight 1).
 *       * SUPER         — animated, costs tokens, weight 25.
 *       * COMBO         — 3 identical emoji from the same user inside a
 *                          1-second sliding window auto-promotes the third
 *                          (and every subsequent identical emoji within the
 *                          window) to a COMBO with escalating multipliers
 *                          (3× / 5× / 8×).
 *   - Aggregate server-side and broadcast snapshots every 100 ms.
 *   - Detect "Reaction Storm" — > 100 reactions in any 1-second window
 *     across the broadcast — and flag the snapshot accordingly.
 *   - Maintain a rolling heat-map (2-second buckets, last 5 minutes) keyed
 *     by playback timestamp so the renderer can paint a hot/cold strip
 *     across the scrubber.
 *   - 100 % deterministic under test via injectable Clock / Scheduler /
 *     RNG / broadcaster primitives — same pattern used elsewhere in the
 *     codebase (see EphemeralBroadcastWorker, PhantomSocialService).
 *
 * Public API surface:
 *
 *   const engine = new ReactionEngine({ broadcaster, ...overrides });
 *   engine.start();
 *   engine.ingest({ broadcastId, userId, emoji, kind, ... });
 *   engine.subscribe(broadcastId, listener);
 *   engine.getSnapshot(broadcastId);
 *   engine.getHeatMap(broadcastId);
 *   engine.getCombo(broadcastId, userId, emoji);
 *   engine.stop();
 *
 * The engine never throws on unexpected input; every reject path returns a
 * structured `IngestResult` whose `accepted` flag tells the caller what
 * happened and why.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reaction classification.  COMBO is computed by the engine itself; clients
 * never submit COMBO directly — they submit EMOJI and the engine promotes.
 */
export type ReactionKind = 'EMOJI' | 'SUPER' | 'COMBO';

/**
 * A reaction as submitted by a viewer.  Clients may attach a playback
 * `videoTimeMs` so the heat-map can be aligned to the actual frame the
 * viewer was watching.  Without it the engine falls back to "now".
 */
export interface ReactionInput {
  readonly broadcastId: string;
  readonly userId: string;
  readonly emoji: string;
  readonly kind?: ReactionKind;
  readonly videoTimeMs?: number;
  readonly tokenCost?: number;
}

/**
 * Internal representation of a reaction once it has been accepted, fully
 * classified, and written to the per-broadcast pipeline.
 */
export interface AcceptedReaction {
  readonly broadcastId: string;
  readonly userId: string;
  readonly emoji: string;
  readonly kind: ReactionKind;
  readonly weight: number;
  readonly comboMultiplier: number;
  readonly tokenCost: number;
  readonly videoTimeMs: number | null;
  readonly receivedAt: Date;
}

/**
 * Result returned by `ingest()`.  Exposed verbatim to the caller / API
 * layer so rejections can be surfaced to the UI.
 */
export interface IngestResult {
  readonly accepted: boolean;
  readonly reason?:
    | 'OK'
    | 'INVALID_EMOJI'
    | 'INVALID_BROADCAST'
    | 'INVALID_USER'
    | 'THROTTLED'
    | 'ENGINE_STOPPED';
  readonly promotedToCombo?: boolean;
  readonly comboMultiplier?: number;
  readonly reaction?: AcceptedReaction;
}

/**
 * Aggregated counts published every 100 ms.  Listeners receive this object
 * verbatim (it is frozen) and the server pipes it onto the WebSocket fan-out.
 */
export interface ReactionSnapshot {
  readonly broadcastId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly windowMs: number;
  readonly totalReactions: number;
  readonly weightedTotal: number;
  readonly perEmoji: ReadonlyArray<EmojiTally>;
  readonly superCount: number;
  readonly comboCount: number;
  readonly uniqueUsers: number;
  readonly storm: StormSignal;
  readonly cumulativeTotal: number;
  readonly cumulativeWeighted: number;
}

export interface EmojiTally {
  readonly emoji: string;
  readonly count: number;
  readonly weighted: number;
  readonly superCount: number;
  readonly comboCount: number;
}

export interface StormSignal {
  readonly active: boolean;
  readonly intensity: number;            // 0-1 normalised over storm threshold
  readonly tier: 'CALM' | 'BUBBLY' | 'STORM' | 'TORNADO';
  readonly oneSecondTotal: number;
  readonly screenShake: number;          // 0-1 amplitude hint for renderer
  readonly tornadoBoost: number;         // 0-1 vortex hint for renderer
}

export interface HeatMapBucket {
  readonly bucketStartMs: number;        // playback time, inclusive
  readonly bucketEndMs: number;          // playback time, exclusive
  readonly count: number;
  readonly weighted: number;
  readonly normalised: number;           // 0-1 vs hottest bucket in window
}

export interface HeatMap {
  readonly broadcastId: string;
  readonly bucketSizeMs: number;
  readonly buckets: ReadonlyArray<HeatMapBucket>;
  readonly hottestBucketMs: number | null;
  readonly totalSamples: number;
  readonly generatedAt: Date;
}

export type ReactionListener = (snapshot: ReactionSnapshot) => void;

export interface ReactionEngineOptions {
  /** Pluggable wall clock — defaults to Date.now. */
  readonly clock?: ClockApi;
  /** Pluggable scheduler — defaults to global setInterval/clearInterval. */
  readonly scheduler?: SchedulerApi;
  /** Pluggable RNG; only used for jitter on tornado boost. */
  readonly random?: () => number;
  /** Sink for accepted snapshots (typically BroadcastWebSocket.pushReactionSnapshot). */
  readonly broadcaster?: SnapshotBroadcaster;
  /** Aggregation window in ms; default 100. */
  readonly aggregationWindowMs?: number;
  /** Storm detection window in ms; default 1000. */
  readonly stormWindowMs?: number;
  /** Reactions/second above which we declare a STORM; default 100. */
  readonly stormThreshold?: number;
  /** Reactions/second above which we declare a TORNADO; default 400. */
  readonly tornadoThreshold?: number;
  /** Per-user reactions per second; default 5. */
  readonly perUserPerSecond?: number;
  /** Combo window in ms; default 1000. */
  readonly comboWindowMs?: number;
  /** Heat-map bucket size in ms; default 2000. */
  readonly heatBucketSizeMs?: number;
  /** Heat-map retention in ms; default 5 * 60_000 = 5 min. */
  readonly heatRetentionMs?: number;
  /** Hard cap on per-broadcast reactions per second before we drop early. */
  readonly hardCapPerSecond?: number;
}

export interface ClockApi {
  now(): number;
}

export interface TimerHandle {
  readonly __brand: 'reactionTimer';
}

export interface SchedulerApi {
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface SnapshotBroadcaster {
  publish(snapshot: ReactionSnapshot): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_AGGREGATION_WINDOW_MS = 100;
const DEFAULT_STORM_WINDOW_MS = 1_000;
const DEFAULT_STORM_THRESHOLD = 100;
const DEFAULT_TORNADO_THRESHOLD = 400;
const DEFAULT_PER_USER_PER_SECOND = 5;
const DEFAULT_COMBO_WINDOW_MS = 1_000;
const DEFAULT_HEAT_BUCKET_SIZE_MS = 2_000;
const DEFAULT_HEAT_RETENTION_MS = 5 * 60_000;
const DEFAULT_HARD_CAP_PER_SECOND = 25_000;

const DEFAULT_SUPER_WEIGHT = 25;
const DEFAULT_EMOJI_WEIGHT = 1;
const COMBO_MULTIPLIER_TABLE: ReadonlyArray<number> = [3, 5, 8, 13, 21];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Permissive emoji validator — we accept any non-empty string ≤ 32
 * characters and reject anything that contains control / whitespace /
 * obvious markup.  We deliberately do NOT whitelist a fixed emoji set:
 * the spec says "any Unicode emoji" and grapheme cluster handling for
 * the entire emoji plane in TypeScript is impractical.  The boundary
 * checks below catch the vast majority of abuse vectors (XSS, log
 * injection, gigantic payloads) without false-rejecting legitimate
 * skin-tone, flag and ZWJ combinations.
 */
export function isValidEmoji(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  if (input.length === 0 || input.length > 32) return false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x20) return false;            // ASCII control
    if (code === 0x7f) return false;          // DEL
    if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
  }
  if (/[\s<>"'`]/.test(input)) return false;
  return true;
}

/**
 * Resolve the multiplier for the n-th consecutive identical emoji.
 * `streakLength` counts the trigger reaction itself (so the first combo
 * is `streakLength === 3`).  Lengths beyond the table cap at the last
 * value to avoid runaway multipliers from spammy bots.
 */
export function comboMultiplierFor(streakLength: number): number {
  if (streakLength < 3) return 1;
  const idx = Math.min(streakLength - 3, COMBO_MULTIPLIER_TABLE.length - 1);
  return COMBO_MULTIPLIER_TABLE[idx];
}

/**
 * Map a reactions-per-second figure to the public storm tier the
 * renderer animates against.  Pure function — exported for tests.
 */
export function classifyStorm(
  oneSecondTotal: number,
  stormThreshold: number,
  tornadoThreshold: number
): StormSignal['tier'] {
  if (oneSecondTotal >= tornadoThreshold) return 'TORNADO';
  if (oneSecondTotal >= stormThreshold) return 'STORM';
  if (oneSecondTotal >= Math.max(20, Math.floor(stormThreshold / 5))) return 'BUBBLY';
  return 'CALM';
}

/**
 * Clamp helper used by the snapshot builder.  Centralised so the
 * intensity / shake / boost numbers in StormSignal cannot drift outside
 * 0-1 even if upstream constants are mis-configured.
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// Per-broadcast state
// ---------------------------------------------------------------------------

interface PendingTally {
  count: number;
  weighted: number;
  superCount: number;
  comboCount: number;
}

interface ComboTracker {
  emoji: string;
  count: number;
  windowStart: number;
  lastAt: number;
}

interface BroadcastState {
  readonly broadcastId: string;
  readonly userTimestamps: Map<string, number[]>;
  readonly comboTrackers: Map<string, ComboTracker>;
  readonly pending: Map<string, PendingTally>;
  readonly listeners: Set<ReactionListener>;
  readonly recentEvents: ReactionEvent[]; // for storm window
  readonly heatBuckets: Map<number, { count: number; weighted: number }>;
  pendingTotal: number;
  pendingWeighted: number;
  pendingUniqueUsers: Set<string>;
  pendingSuper: number;
  pendingCombo: number;
  cumulativeTotal: number;
  cumulativeWeighted: number;
}

interface ReactionEvent {
  readonly weight: number;
  readonly receivedAt: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const realClock: ClockApi = { now: () => Date.now() };
const realScheduler: SchedulerApi = {
  setInterval(fn: () => void, ms: number): TimerHandle {
    const handle = setInterval(fn, ms);
    return handle as unknown as TimerHandle;
  },
  clearInterval(handle: TimerHandle): void {
    clearInterval(handle as unknown as ReturnType<typeof setInterval>);
  },
};

export class ReactionEngine {
  private readonly clock: ClockApi;
  private readonly scheduler: SchedulerApi;
  private readonly random: () => number;
  private readonly broadcaster: SnapshotBroadcaster | null;
  private readonly aggregationWindowMs: number;
  private readonly stormWindowMs: number;
  private readonly stormThreshold: number;
  private readonly tornadoThreshold: number;
  private readonly perUserPerSecond: number;
  private readonly comboWindowMs: number;
  private readonly heatBucketSizeMs: number;
  private readonly heatRetentionMs: number;
  private readonly hardCapPerSecond: number;

  private readonly broadcasts = new Map<string, BroadcastState>();
  private timer: TimerHandle | null = null;
  private running = false;

  constructor(options: ReactionEngineOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.scheduler = options.scheduler ?? realScheduler;
    this.random = options.random ?? Math.random;
    this.broadcaster = options.broadcaster ?? null;
    this.aggregationWindowMs = options.aggregationWindowMs ?? DEFAULT_AGGREGATION_WINDOW_MS;
    this.stormWindowMs = options.stormWindowMs ?? DEFAULT_STORM_WINDOW_MS;
    this.stormThreshold = options.stormThreshold ?? DEFAULT_STORM_THRESHOLD;
    this.tornadoThreshold = options.tornadoThreshold ?? DEFAULT_TORNADO_THRESHOLD;
    this.perUserPerSecond = options.perUserPerSecond ?? DEFAULT_PER_USER_PER_SECOND;
    this.comboWindowMs = options.comboWindowMs ?? DEFAULT_COMBO_WINDOW_MS;
    this.heatBucketSizeMs = options.heatBucketSizeMs ?? DEFAULT_HEAT_BUCKET_SIZE_MS;
    this.heatRetentionMs = options.heatRetentionMs ?? DEFAULT_HEAT_RETENTION_MS;
    this.hardCapPerSecond = options.hardCapPerSecond ?? DEFAULT_HARD_CAP_PER_SECOND;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = this.scheduler.setInterval(() => this.flush(), this.aggregationWindowMs);
    logger.info(
      { aggregationWindowMs: this.aggregationWindowMs, stormThreshold: this.stormThreshold },
      'ReactionEngine started'
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    logger.info({ broadcasts: this.broadcasts.size }, 'ReactionEngine stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Number of broadcasts currently being tracked. Useful for ops dashboards. */
  trackedBroadcastCount(): number {
    return this.broadcasts.size;
  }

  /** Drop all state for a broadcast (called when the stream ends). */
  closeBroadcast(broadcastId: string): void {
    const state = this.broadcasts.get(broadcastId);
    if (!state) return;
    state.listeners.clear();
    this.broadcasts.delete(broadcastId);
    logger.info({ broadcastId }, 'ReactionEngine broadcast closed');
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  subscribe(broadcastId: string, listener: ReactionListener): () => void {
    const state = this.ensureState(broadcastId);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  ingest(input: ReactionInput): IngestResult {
    if (!this.running) {
      return { accepted: false, reason: 'ENGINE_STOPPED' };
    }
    if (typeof input.broadcastId !== 'string' || input.broadcastId.length === 0) {
      return { accepted: false, reason: 'INVALID_BROADCAST' };
    }
    if (typeof input.userId !== 'string' || input.userId.length === 0) {
      return { accepted: false, reason: 'INVALID_USER' };
    }
    if (!isValidEmoji(input.emoji)) {
      return { accepted: false, reason: 'INVALID_EMOJI' };
    }

    const state = this.ensureState(input.broadcastId);
    const now = this.clock.now();

    if (!this.passesUserThrottle(state, input.userId, now)) {
      return { accepted: false, reason: 'THROTTLED' };
    }
    if (!this.passesGlobalCap(state, now)) {
      return { accepted: false, reason: 'THROTTLED' };
    }

    const baseKind: ReactionKind = input.kind === 'SUPER' ? 'SUPER' : 'EMOJI';
    let multiplier = 1;
    let promotedToCombo = false;
    let kind: ReactionKind = baseKind;

    if (baseKind === 'EMOJI') {
      const tracker = this.advanceCombo(state, input.userId, input.emoji, now);
      if (tracker.count >= 3) {
        kind = 'COMBO';
        multiplier = comboMultiplierFor(tracker.count);
        promotedToCombo = true;
      }
    }

    const weight =
      (kind === 'SUPER' ? DEFAULT_SUPER_WEIGHT : DEFAULT_EMOJI_WEIGHT) * multiplier;

    const reaction: AcceptedReaction = {
      broadcastId: input.broadcastId,
      userId: input.userId,
      emoji: input.emoji,
      kind,
      weight,
      comboMultiplier: multiplier,
      tokenCost: typeof input.tokenCost === 'number' && input.tokenCost > 0 ? input.tokenCost : 0,
      videoTimeMs:
        typeof input.videoTimeMs === 'number' && Number.isFinite(input.videoTimeMs)
          ? Math.max(0, Math.floor(input.videoTimeMs))
          : null,
      receivedAt: new Date(now),
    };

    this.recordAccepted(state, reaction, now);

    return {
      accepted: true,
      reason: 'OK',
      promotedToCombo,
      comboMultiplier: multiplier,
      reaction,
    };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  getSnapshot(broadcastId: string): ReactionSnapshot | null {
    const state = this.broadcasts.get(broadcastId);
    if (!state) return null;
    return this.buildSnapshot(state, this.clock.now(), false);
  }

  getCombo(broadcastId: string, userId: string, emoji: string): number {
    const state = this.broadcasts.get(broadcastId);
    if (!state) return 0;
    const tracker = state.comboTrackers.get(`${userId}::${emoji}`);
    if (!tracker) return 0;
    if (this.clock.now() - tracker.windowStart > this.comboWindowMs) return 0;
    return tracker.count;
  }

  getHeatMap(broadcastId: string): HeatMap | null {
    const state = this.broadcasts.get(broadcastId);
    if (!state) return null;
    const now = this.clock.now();
    this.evictOldHeatBuckets(state, now);

    const sortedKeys = Array.from(state.heatBuckets.keys()).sort((a, b) => a - b);
    let hottestBucketMs: number | null = null;
    let hottestCount = 0;
    let totalSamples = 0;

    for (const key of sortedKeys) {
      const bucket = state.heatBuckets.get(key)!;
      totalSamples += bucket.count;
      if (bucket.count > hottestCount) {
        hottestCount = bucket.count;
        hottestBucketMs = key;
      }
    }

    const buckets: HeatMapBucket[] = sortedKeys.map((key) => {
      const bucket = state.heatBuckets.get(key)!;
      return {
        bucketStartMs: key,
        bucketEndMs: key + this.heatBucketSizeMs,
        count: bucket.count,
        weighted: bucket.weighted,
        normalised: hottestCount > 0 ? bucket.count / hottestCount : 0,
      };
    });

    return Object.freeze({
      broadcastId,
      bucketSizeMs: this.heatBucketSizeMs,
      buckets: Object.freeze(buckets),
      hottestBucketMs,
      totalSamples,
      generatedAt: new Date(now),
    });
  }

  // -------------------------------------------------------------------------
  // Flush — invoked every aggregationWindowMs by the scheduler
  // -------------------------------------------------------------------------

  /**
   * Build snapshots for every broadcast that received traffic, push them
   * to subscribers and the broadcaster, then clear pending tallies.
   * Exposed publicly for tests that drive the engine with a manual
   * scheduler.
   */
  flush(): ReactionSnapshot[] {
    const now = this.clock.now();
    const out: ReactionSnapshot[] = [];
    for (const state of this.broadcasts.values()) {
      if (state.pendingTotal === 0) {
        // Even with zero pending we still want to evict storm history so
        // the storm signal correctly decays back to CALM on the next tick.
        this.evictOldEvents(state, now);
        continue;
      }
      const snapshot = this.buildSnapshot(state, now, true);
      out.push(snapshot);
      this.dispatch(state, snapshot);
      this.resetPending(state);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureState(broadcastId: string): BroadcastState {
    let state = this.broadcasts.get(broadcastId);
    if (state) return state;
    state = {
      broadcastId,
      userTimestamps: new Map(),
      comboTrackers: new Map(),
      pending: new Map(),
      listeners: new Set(),
      recentEvents: [],
      heatBuckets: new Map(),
      pendingTotal: 0,
      pendingWeighted: 0,
      pendingUniqueUsers: new Set(),
      pendingSuper: 0,
      pendingCombo: 0,
      cumulativeTotal: 0,
      cumulativeWeighted: 0,
    };
    this.broadcasts.set(broadcastId, state);
    return state;
  }

  private passesUserThrottle(state: BroadcastState, userId: string, now: number): boolean {
    let timestamps = state.userTimestamps.get(userId);
    const cutoff = now - 1_000;
    if (!timestamps) {
      timestamps = [];
      state.userTimestamps.set(userId, timestamps);
    }
    // Drop expired timestamps from the head.
    let drop = 0;
    while (drop < timestamps.length && timestamps[drop] <= cutoff) drop++;
    if (drop > 0) timestamps.splice(0, drop);

    if (timestamps.length >= this.perUserPerSecond) return false;
    timestamps.push(now);
    return true;
  }

  private passesGlobalCap(state: BroadcastState, now: number): boolean {
    this.evictOldEvents(state, now);
    return state.recentEvents.length < this.hardCapPerSecond;
  }

  private advanceCombo(
    state: BroadcastState,
    userId: string,
    emoji: string,
    now: number
  ): ComboTracker {
    const key = `${userId}::${emoji}`;
    let tracker = state.comboTrackers.get(key);
    if (!tracker || now - tracker.windowStart > this.comboWindowMs) {
      tracker = { emoji, count: 1, windowStart: now, lastAt: now };
      state.comboTrackers.set(key, tracker);
      // Also forget any stale combo tracker the user had on a different
      // emoji — the spec says "3 same emoji in a row".
      for (const [otherKey, otherTracker] of state.comboTrackers) {
        if (otherKey === key) continue;
        if (otherKey.startsWith(`${userId}::`)) {
          if (now - otherTracker.lastAt > this.comboWindowMs) {
            state.comboTrackers.delete(otherKey);
          }
        }
      }
      return tracker;
    }
    tracker.count += 1;
    tracker.lastAt = now;
    return tracker;
  }

  private recordAccepted(state: BroadcastState, reaction: AcceptedReaction, now: number): void {
    let tally = state.pending.get(reaction.emoji);
    if (!tally) {
      tally = { count: 0, weighted: 0, superCount: 0, comboCount: 0 };
      state.pending.set(reaction.emoji, tally);
    }
    tally.count += 1;
    tally.weighted += reaction.weight;
    if (reaction.kind === 'SUPER') tally.superCount += 1;
    if (reaction.kind === 'COMBO') tally.comboCount += 1;

    state.pendingTotal += 1;
    state.pendingWeighted += reaction.weight;
    state.pendingUniqueUsers.add(reaction.userId);
    if (reaction.kind === 'SUPER') state.pendingSuper += 1;
    if (reaction.kind === 'COMBO') state.pendingCombo += 1;

    state.cumulativeTotal += 1;
    state.cumulativeWeighted += reaction.weight;

    state.recentEvents.push({ weight: reaction.weight, receivedAt: now });

    if (reaction.videoTimeMs !== null) {
      this.recordHeat(state, reaction.videoTimeMs, reaction.weight, now);
    }
  }

  private recordHeat(
    state: BroadcastState,
    videoTimeMs: number,
    weight: number,
    now: number
  ): void {
    const bucketKey = Math.floor(videoTimeMs / this.heatBucketSizeMs) * this.heatBucketSizeMs;
    let bucket = state.heatBuckets.get(bucketKey);
    if (!bucket) {
      bucket = { count: 0, weighted: 0 };
      state.heatBuckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    bucket.weighted += weight;
    this.evictOldHeatBuckets(state, now);
  }

  private evictOldHeatBuckets(state: BroadcastState, _now: number): void {
    if (state.heatBuckets.size <= Math.ceil(this.heatRetentionMs / this.heatBucketSizeMs)) {
      return;
    }
    const keys = Array.from(state.heatBuckets.keys()).sort((a, b) => a - b);
    const overflow = keys.length - Math.ceil(this.heatRetentionMs / this.heatBucketSizeMs);
    for (let i = 0; i < overflow; i++) state.heatBuckets.delete(keys[i]);
  }

  private evictOldEvents(state: BroadcastState, now: number): void {
    const cutoff = now - this.stormWindowMs;
    let drop = 0;
    while (drop < state.recentEvents.length && state.recentEvents[drop].receivedAt <= cutoff) {
      drop++;
    }
    if (drop > 0) state.recentEvents.splice(0, drop);
  }

  private buildSnapshot(
    state: BroadcastState,
    now: number,
    consumePending: boolean
  ): ReactionSnapshot {
    this.evictOldEvents(state, now);
    const oneSecondTotal = state.recentEvents.length;
    const tier = classifyStorm(oneSecondTotal, this.stormThreshold, this.tornadoThreshold);
    const intensity = clamp01(oneSecondTotal / Math.max(1, this.stormThreshold));
    const tornadoRange = Math.max(1, this.tornadoThreshold - this.stormThreshold);
    const tornadoBoost = clamp01((oneSecondTotal - this.stormThreshold) / tornadoRange);
    const jitter = (this.random() - 0.5) * 0.05; // ±2.5 % so the renderer feels alive
    const screenShake =
      tier === 'STORM' || tier === 'TORNADO'
        ? clamp01(0.4 + tornadoBoost * 0.6 + jitter)
        : 0;

    const perEmoji: EmojiTally[] = [];
    if (consumePending) {
      for (const [emoji, tally] of state.pending) {
        perEmoji.push(
          Object.freeze({
            emoji,
            count: tally.count,
            weighted: tally.weighted,
            superCount: tally.superCount,
            comboCount: tally.comboCount,
          })
        );
      }
    } else {
      // For diagnostic snapshots we still want to expose what's queued but
      // we mustn't mutate the pending counters; copy out as-is.
      for (const [emoji, tally] of state.pending) {
        perEmoji.push(
          Object.freeze({
            emoji,
            count: tally.count,
            weighted: tally.weighted,
            superCount: tally.superCount,
            comboCount: tally.comboCount,
          })
        );
      }
    }
    perEmoji.sort((a, b) => b.weighted - a.weighted || b.count - a.count);

    const snapshot: ReactionSnapshot = Object.freeze({
      broadcastId: state.broadcastId,
      windowStart: new Date(now - this.aggregationWindowMs),
      windowEnd: new Date(now),
      windowMs: this.aggregationWindowMs,
      totalReactions: state.pendingTotal,
      weightedTotal: state.pendingWeighted,
      perEmoji: Object.freeze(perEmoji),
      superCount: state.pendingSuper,
      comboCount: state.pendingCombo,
      uniqueUsers: state.pendingUniqueUsers.size,
      storm: Object.freeze({
        active: tier === 'STORM' || tier === 'TORNADO',
        intensity,
        tier,
        oneSecondTotal,
        screenShake,
        tornadoBoost,
      }),
      cumulativeTotal: state.cumulativeTotal,
      cumulativeWeighted: state.cumulativeWeighted,
    });

    return snapshot;
  }

  private dispatch(state: BroadcastState, snapshot: ReactionSnapshot): void {
    if (this.broadcaster) {
      try {
        this.broadcaster.publish(snapshot);
      } catch (err) {
        logger.warn({ err }, 'ReactionEngine broadcaster.publish failed');
      }
    }
    for (const listener of state.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        logger.warn({ err }, 'ReactionEngine listener threw');
      }
    }
  }

  private resetPending(state: BroadcastState): void {
    state.pending.clear();
    state.pendingTotal = 0;
    state.pendingWeighted = 0;
    state.pendingUniqueUsers = new Set();
    state.pendingSuper = 0;
    state.pendingCombo = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton (used by HTTP handlers / WebSocket bridge)
// ---------------------------------------------------------------------------

let singleton: ReactionEngine | null = null;

/**
 * Lazily-instantiated process-wide ReactionEngine.  The first caller may
 * pass options; subsequent callers receive the already-running instance.
 */
export function getReactionEngine(options?: ReactionEngineOptions): ReactionEngine {
  if (!singleton) {
    singleton = new ReactionEngine(options);
    singleton.start();
  }
  return singleton;
}

/** Test-only — wipe the singleton so each test starts from a clean slate. */
export function __resetReactionEngineSingleton(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
