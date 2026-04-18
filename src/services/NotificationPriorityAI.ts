/**
 * NotificationPriorityAI — Intelligent Notification Ranking Engine
 *
 * Ranks incoming notifications by urgency using a configurable scoring model,
 * learns from user interaction patterns (click-through behaviour per app),
 * and enforces a "Do Not Disturb" smart schedule that auto-enables during
 * detected sleep hours and user-defined focus blocks.
 *
 * Design goals:
 *  - Zero external runtime dependencies (runs in browser + Node / Jest).
 *  - Fully serialisable state so preferences survive page reloads.
 *  - All scoring functions are pure and individually testable.
 *  - DND schedule is evaluated lazily on each `shouldSuppress` call — no
 *    background timers required for basic correctness.
 */

import type { AggregatedNotification, QuantApp, NotificationEventType } from './NotificationAggregator';

// ---------------------------------------------------------------------------
// Priority scoring constants
// ---------------------------------------------------------------------------

/**
 * Base priority scores by event type.
 *
 *  Direct messages from close friends:  10
 *  Matches and social events:            8
 *  Content engagement (likes, comments): 5
 *  Marketing / promotional:              2
 *  System notifications:                 1
 */
export const BASE_PRIORITY: Record<NotificationEventType, number> = {
  message:          10,
  match:             8,
  metaverse_event:   7,
  broadcast:         5,
  video_engagement:  5,
  edit_share:        4,
  email:             4,
  web_clip:          3,
  ad_performance:    2,
};

/** Priority ceiling to prevent runaway boosts. */
export const MAX_PRIORITY = 10;

/** Minimum priority floor so nothing is completely silenced. */
export const MIN_PRIORITY = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DndBlock {
  /** Hour of day in 24-h format, 0–23. */
  readonly startHour: number;
  /** Hour of day in 24-h format, 0–23. */
  readonly endHour: number;
  /** Days of week: 0 = Sunday … 6 = Saturday.  Empty = every day. */
  readonly days?: readonly number[];
  readonly label?: string;
}

export interface UserPreferenceSnapshot {
  /** How many times the user has clicked a notification from each app. */
  readonly clicksByApp: Readonly<Record<QuantApp, number>>;
  /** How many notifications were delivered from each app (for rate calc). */
  readonly deliveryByApp: Readonly<Record<QuantApp, number>>;
  /** Manually configured DND blocks. */
  readonly dndBlocks: readonly DndBlock[];
  /** Whether smart sleep-hour DND is active. */
  readonly smartDndEnabled: boolean;
  /** Detected sleep window start hour (0–23). Default 23. */
  readonly sleepStartHour: number;
  /** Detected sleep window end hour (0–23). Default 7. */
  readonly sleepEndHour: number;
}

export interface PriorityResult {
  readonly score: number;
  readonly clamped: number;
  readonly baseScore: number;
  readonly boost: number;
  readonly suppressed: boolean;
  readonly suppressReason?: string;
}

export interface AIOptions {
  /** Override the base priority table. */
  readonly basePriority?: Partial<Record<NotificationEventType, number>>;
  /** Maximum boost from learned preferences. Default 3. */
  readonly maxPreferenceBoost?: number;
  /** Clock override for testing. */
  readonly now?: () => Date;
  /** Initial preferences to restore from storage. */
  readonly initialPreferences?: Partial<UserPreferenceSnapshot>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_APPS: QuantApp[] = [
  'quantchat', 'quantsink', 'quantchill', 'quantads',
  'quantedits', 'quanttube', 'quantmail', 'quantneon', 'quantbrowse',
];

function zeroAppRecord(): Record<QuantApp, number> {
  const out: Partial<Record<QuantApp, number>> = {};
  for (const app of ALL_APPS) out[app] = 0;
  return out as Record<QuantApp, number>;
}

/**
 * Determine whether `hour` (24-h) falls within the range [start, end).
 * Handles wrap-around (e.g., 23:00–07:00).
 */
export function hourInRange(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Wrap-around: e.g. start=23, end=7 → covers 23,0,1,2,3,4,5,6
  return hour >= start || hour < end;
}

/**
 * Check if `date` falls within a `DndBlock`.
 */
export function dateInDndBlock(date: Date, block: DndBlock): boolean {
  const hour = date.getHours();
  const dow = date.getDay();
  if (block.days && block.days.length > 0 && !block.days.includes(dow)) {
    return false;
  }
  return hourInRange(hour, block.startHour, block.endHour);
}

/**
 * Compute a preference boost for a given app based on click-through data.
 * Uses a Laplace-smoothed click-through rate (CTR) to avoid zero-division
 * and division by low delivery counts skewing the result.
 *
 * Returns a value in [0, maxBoost].
 */
export function computePreferenceBoost(
  app: QuantApp,
  clicksByApp: Readonly<Record<QuantApp, number>>,
  deliveryByApp: Readonly<Record<QuantApp, number>>,
  maxBoost: number,
): number {
  const clicks = clicksByApp[app] ?? 0;
  const deliveries = deliveryByApp[app] ?? 0;
  // Laplace smoothing: (clicks + 1) / (deliveries + 2)
  const smoothedCtr = (clicks + 1) / (deliveries + 2);
  // Normalise so average CTR (0.5) → 0 boost; perfect CTR (1.0) → maxBoost.
  const boost = (smoothedCtr - 0.5) * 2 * maxBoost;
  return Math.max(0, Math.min(maxBoost, boost));
}

// ---------------------------------------------------------------------------
// NotificationPriorityAI
// ---------------------------------------------------------------------------

export class NotificationPriorityAI {
  private readonly basePriority: Record<NotificationEventType, number>;
  private readonly maxPreferenceBoost: number;
  private readonly now: () => Date;

  private clicksByApp: Record<QuantApp, number>;
  private deliveryByApp: Record<QuantApp, number>;
  private dndBlocks: DndBlock[];
  private smartDndEnabled: boolean;
  private sleepStartHour: number;
  private sleepEndHour: number;

  constructor(options: AIOptions = {}) {
    this.basePriority = { ...BASE_PRIORITY, ...(options.basePriority ?? {}) };
    this.maxPreferenceBoost = options.maxPreferenceBoost ?? 3;
    this.now = options.now ?? (() => new Date());

    const prefs = options.initialPreferences ?? {};
    this.clicksByApp = { ...zeroAppRecord(), ...(prefs.clicksByApp ?? {}) };
    this.deliveryByApp = { ...zeroAppRecord(), ...(prefs.deliveryByApp ?? {}) };
    this.dndBlocks = [...(prefs.dndBlocks ?? [])];
    this.smartDndEnabled = prefs.smartDndEnabled ?? true;
    this.sleepStartHour = prefs.sleepStartHour ?? 23;
    this.sleepEndHour = prefs.sleepEndHour ?? 7;
  }

  // -------------------------------------------------------------------------
  // Core scoring
  // -------------------------------------------------------------------------

  /**
   * Compute a full priority result for a notification.
   * Does NOT mutate delivery counts — call `recordDelivery` separately.
   */
  score(notification: AggregatedNotification): PriorityResult {
    const base = this.basePriority[notification.type] ?? 1;
    const boost = computePreferenceBoost(
      notification.app,
      this.clicksByApp,
      this.deliveryByApp,
      this.maxPreferenceBoost,
    );
    const raw = base + boost;
    const clamped = Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, raw));

    const suppressCheck = this.checkDnd(this.now());
    const suppressed = suppressCheck.suppressed;
    const suppressReason = suppressCheck.reason;

    return {
      score: raw,
      clamped,
      baseScore: base,
      boost,
      suppressed,
      suppressReason,
    };
  }

  /**
   * Convenience: score + record delivery in one call.
   * Returns the clamped priority score (0–10).
   */
  scoreAndRecord(notification: AggregatedNotification): number {
    this.recordDelivery(notification.app);
    return this.score(notification).clamped;
  }

  /**
   * Sort an array of notifications from highest to lowest priority.
   * Does not mutate the input array.
   */
  sortByPriority(notifications: AggregatedNotification[]): AggregatedNotification[] {
    return [...notifications].sort(
      (a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0),
    );
  }

  // -------------------------------------------------------------------------
  // Do Not Disturb
  // -------------------------------------------------------------------------

  /**
   * Returns whether notifications should be suppressed at the given time.
   */
  shouldSuppress(date: Date = this.now()): { suppressed: boolean; reason?: string } {
    return this.checkDnd(date);
  }

  private checkDnd(date: Date): { suppressed: boolean; reason?: string } {
    // 1. Check manual DND blocks first.
    for (const block of this.dndBlocks) {
      if (dateInDndBlock(date, block)) {
        return {
          suppressed: true,
          reason: block.label ? `DND block: ${block.label}` : 'Do Not Disturb',
        };
      }
    }

    // 2. Check smart sleep-hour DND.
    if (this.smartDndEnabled) {
      const hour = date.getHours();
      if (hourInRange(hour, this.sleepStartHour, this.sleepEndHour)) {
        return { suppressed: true, reason: 'Smart sleep-hour DND' };
      }
    }

    return { suppressed: false };
  }

  addDndBlock(block: DndBlock): void {
    this.dndBlocks.push(block);
  }

  removeDndBlock(index: number): void {
    this.dndBlocks.splice(index, 1);
  }

  setDndBlocks(blocks: readonly DndBlock[]): void {
    this.dndBlocks = [...blocks];
  }

  getDndBlocks(): readonly DndBlock[] {
    return this.dndBlocks;
  }

  setSmartDnd(enabled: boolean): void {
    this.smartDndEnabled = enabled;
  }

  isSmartDndEnabled(): boolean {
    return this.smartDndEnabled;
  }

  /**
   * Update the smart sleep window (e.g., based on device usage patterns).
   */
  setSleepWindow(startHour: number, endHour: number): void {
    if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
      throw new RangeError('Sleep window hours must be in [0, 23].');
    }
    this.sleepStartHour = startHour;
    this.sleepEndHour = endHour;
  }

  getSleepWindow(): { startHour: number; endHour: number } {
    return { startHour: this.sleepStartHour, endHour: this.sleepEndHour };
  }

  // -------------------------------------------------------------------------
  // Preference learning
  // -------------------------------------------------------------------------

  /**
   * Record that the user interacted with (clicked) a notification from `app`.
   * This boosts the future priority of notifications from that app.
   */
  recordClick(app: QuantApp): void {
    this.clicksByApp[app] = (this.clicksByApp[app] ?? 0) + 1;
  }

  /**
   * Record that a notification from `app` was delivered (used as denominator
   * for CTR calculation).
   */
  recordDelivery(app: QuantApp): void {
    this.deliveryByApp[app] = (this.deliveryByApp[app] ?? 0) + 1;
  }

  /**
   * Get the inferred "most-preferred" app based on click-through rates.
   * Returns null if there is insufficient data.
   */
  topPreferredApp(): QuantApp | null {
    let bestApp: QuantApp | null = null;
    let bestBoost = -Infinity;
    for (const app of ALL_APPS) {
      const boost = computePreferenceBoost(
        app,
        this.clicksByApp,
        this.deliveryByApp,
        this.maxPreferenceBoost,
      );
      if (boost > bestBoost) {
        bestBoost = boost;
        bestApp = app;
      }
    }
    // Only return an app if it has meaningful data (at least 1 click).
    return bestApp && (this.clicksByApp[bestApp] ?? 0) > 0 ? bestApp : null;
  }

  /**
   * Return click-through rates for all apps, sorted descending.
   */
  ctrReport(): Array<{ app: QuantApp; ctr: number; clicks: number; deliveries: number }> {
    return ALL_APPS.map((app) => {
      const clicks = this.clicksByApp[app] ?? 0;
      const deliveries = this.deliveryByApp[app] ?? 0;
      const ctr = deliveries > 0 ? clicks / deliveries : 0;
      return { app, ctr, clicks, deliveries };
    }).sort((a, b) => b.ctr - a.ctr);
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  /** Serialise all learned preferences to a plain object for storage. */
  snapshot(): UserPreferenceSnapshot {
    return {
      clicksByApp: { ...this.clicksByApp },
      deliveryByApp: { ...this.deliveryByApp },
      dndBlocks: [...this.dndBlocks],
      smartDndEnabled: this.smartDndEnabled,
      sleepStartHour: this.sleepStartHour,
      sleepEndHour: this.sleepEndHour,
    };
  }

  /** Rehydrate from a previously captured snapshot. */
  restoreFrom(snapshot: UserPreferenceSnapshot): void {
    this.clicksByApp = { ...zeroAppRecord(), ...snapshot.clicksByApp };
    this.deliveryByApp = { ...zeroAppRecord(), ...snapshot.deliveryByApp };
    this.dndBlocks = [...(snapshot.dndBlocks ?? [])];
    this.smartDndEnabled = snapshot.smartDndEnabled ?? true;
    this.sleepStartHour = snapshot.sleepStartHour ?? 23;
    this.sleepEndHour = snapshot.sleepEndHour ?? 7;
  }

  /** Reset all learned data back to factory defaults. */
  resetPreferences(): void {
    this.clicksByApp = zeroAppRecord();
    this.deliveryByApp = zeroAppRecord();
    this.dndBlocks = [];
  }
}

export default NotificationPriorityAI;
