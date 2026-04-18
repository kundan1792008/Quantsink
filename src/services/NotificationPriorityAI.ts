/**
 * NotificationPriorityAI — Cross-App Notification Priority Engine
 *
 * Issue #23 (sub-task 2). Ranks every `UnifiedNotification` produced by the
 * `NotificationAggregator` on a 1-10 priority scale before it reaches the
 * UI / push surface. The scorer combines four sources of signal:
 *
 *   1. A static base table per notification kind (DM ≫ system).
 *   2. A "close-friend" affinity boost driven by the user's contact graph.
 *   3. A learned per-app preference vector — implicit feedback from clicks,
 *      dismissals and snoozes that nudges the model towards what the user
 *      actually engages with.
 *   4. A "Do Not Disturb" smart-schedule that suppresses everything below
 *      a configurable threshold during sleep windows, focus windows and
 *      manually-triggered DND blocks.
 *
 * The engine is deterministic given the same inputs (the learning rate
 * is a pure function of the feedback log, no PRNG involved) which keeps
 * unit tests stable. All clock and storage primitives are injectable.
 */

import logger from '../lib/logger';
import {
  Clock,
  KIND_TO_APP,
  NotificationKind,
  PriorityScorer,
  QUANT_APPS,
  QuantApp,
  SYSTEM_CLOCK,
  UnifiedNotification,
} from './NotificationAggregator';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PriorityFeedback {
  /** Strong positive — user opened or replied to the notification. */
  click: number;
  /** Mild positive — user expanded the preview. */
  expand: number;
  /** Mild negative — user dismissed without interacting. */
  dismiss: number;
  /** Strong negative — user muted or snoozed. */
  mute: number;
  /** Strong negative — user reported the notification as spam. */
  report: number;
}

export const ZERO_FEEDBACK: Readonly<PriorityFeedback> = Object.freeze({
  click: 0, expand: 0, dismiss: 0, mute: 0, report: 0,
});

export type FeedbackEvent = keyof PriorityFeedback;

/** Per-app learned preference state. */
export interface AppPreference {
  readonly app: QuantApp;
  /** Aggregate counts for each event type. */
  readonly feedback: PriorityFeedback;
  /** Computed bias term in score units (clamped to ±2). */
  readonly bias: number;
  /** Last update epoch ms. */
  readonly updatedAt: number;
}

/** A close-friend record used to apply DM-affinity boosts. */
export interface CloseFriend {
  readonly userId: string;
  /**
   * Affinity score 0-1; clients can grade by interaction recency. Higher
   * affinity yields larger DM/match boosts.
   */
  readonly affinity: number;
  /** Optional display name for diagnostics. */
  readonly displayName?: string;
}

/**
 * A "Do Not Disturb" rule defined by the user or detected by the engine.
 * Rules are applied in declaration order; the first matching rule wins.
 */
export interface DndRule {
  readonly id: string;
  readonly label: string;
  /** Days the rule applies on (0 = Sunday … 6 = Saturday). Empty = every day. */
  readonly daysOfWeek: readonly number[];
  /** Inclusive start minute of day (0-1439). */
  readonly startMinute: number;
  /** Exclusive end minute of day (0-1439). May wrap past midnight. */
  readonly endMinute: number;
  /**
   * Suppress every notification whose priority is BELOW this threshold.
   * Use 11 to suppress everything; use 0 to suppress nothing (i.e. simply
   * tag the notification as "during DND").
   */
  readonly suppressBelowPriority: number;
  /** Optional time-zone offset in minutes from UTC. Default 0 (UTC). */
  readonly tzOffsetMinutes?: number;
  /** If set, the rule expires at this epoch ms. */
  readonly expiresAt?: number;
}

export interface SmartScheduleConfig {
  /** Sleep window expressed in minutes-of-day. Default 23:00 → 07:00. */
  readonly sleepStartMinute: number;
  readonly sleepEndMinute: number;
  /** Focus window. Default 09:00 → 12:00 weekdays. */
  readonly focusStartMinute: number;
  readonly focusEndMinute: number;
  /** Time-zone offset minutes from UTC. */
  readonly tzOffsetMinutes: number;
  /** Suppress threshold during sleep. Default 8. */
  readonly sleepSuppressBelow: number;
  /** Suppress threshold during focus. Default 6. */
  readonly focusSuppressBelow: number;
}

export const DEFAULT_SMART_SCHEDULE: Readonly<SmartScheduleConfig> = Object.freeze({
  sleepStartMinute: 23 * 60,
  sleepEndMinute:    7 * 60,
  focusStartMinute:  9 * 60,
  focusEndMinute:   12 * 60,
  tzOffsetMinutes:   0,
  sleepSuppressBelow: 8,
  focusSuppressBelow: 6,
});

export interface PriorityDecision {
  /** Final 1-10 score after all adjustments. */
  readonly score: number;
  /** Score from the static kind table (unmodified base). */
  readonly base: number;
  /** Score adjustment from the close-friend graph (may be 0). */
  readonly closeFriendBoost: number;
  /** Score adjustment from learned preferences (may be 0 or negative). */
  readonly preferenceBoost: number;
  /** Score adjustment from urgency keywords / freshness. */
  readonly contentBoost: number;
  /** Whether the engine recommends suppressing the notification. */
  readonly suppress: boolean;
  /** Diagnostic — human-readable reason for `suppress`. Empty if not. */
  readonly suppressReason: string;
  /** Names of every DND rule that matched (informational). */
  readonly matchedDndRules: readonly string[];
  /** Tags for the UI: e.g. "vip", "urgent", "low-signal". */
  readonly tags: readonly string[];
}

/** Storage abstraction for persistent preference state. */
export interface PreferenceStore {
  load(): Promise<Record<QuantApp, AppPreference> | undefined>;
  save(state: Record<QuantApp, AppPreference>): Promise<void>;
}

export class InMemoryPreferenceStore implements PreferenceStore {
  private state: Record<QuantApp, AppPreference> | undefined;
  async load(): Promise<Record<QuantApp, AppPreference> | undefined> {
    return this.state ? cloneState(this.state) : undefined;
  }
  async save(state: Record<QuantApp, AppPreference>): Promise<void> {
    this.state = cloneState(state);
  }
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** Static base priority per kind, per the issue specification. */
export const BASE_PRIORITY: Readonly<Record<NotificationKind, number>> = Object.freeze({
  message:           7,   // direct messages — base; close-friend bumps to 10
  match:             8,
  broadcast:         5,
  video_engagement:  5,
  edit_share:        5,
  email:             4,
  metaverse_event:   4,
  web_clip:          3,
  ad_performance:    2,
  system:            1,
});

/** Maximum bias (per app) the learned model is allowed to apply. */
const MAX_PREF_BIAS = 2;
/** Aggressive learning rate for click events. */
const PREF_RATE = {
  click: 0.20,
  expand: 0.05,
  dismiss: -0.07,
  mute: -0.30,
  report: -0.50,
} as const;

const URGENT_KEYWORDS = [
  'urgent', 'now', 'immediately', 'security', 'verify', 'verification',
  'confirm', 'expires', 'expiring', 'critical', 'emergency', 'alert',
];

const PROMOTIONAL_KEYWORDS = [
  'sale', 'discount', 'promo', 'limited time', 'deal', 'offer',
  'subscribe', '% off', 'free trial', 'free shipping',
];

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

export interface NotificationPriorityAIConfig {
  readonly closeFriends?: ReadonlyArray<CloseFriend>;
  readonly dndRules?: ReadonlyArray<DndRule>;
  readonly smartSchedule?: Partial<SmartScheduleConfig>;
  readonly preferenceStore?: PreferenceStore;
  readonly clock?: Clock;
  /**
   * If true, the engine treats `quantsink` broadcast notifications from any
   * close friend the same as a direct message (yielding the +3 boost).
   */
  readonly treatBroadcastsFromFriendsAsDirect?: boolean;
}

export class NotificationPriorityAI implements PriorityScorer {
  private readonly clock: Clock;
  private readonly closeFriends = new Map<string, CloseFriend>();
  private dndRules: DndRule[] = [];
  private smartSchedule: SmartScheduleConfig;
  private readonly preferenceStore: PreferenceStore;
  private prefs: Record<QuantApp, AppPreference>;
  private readonly treatBroadcastsFromFriendsAsDirect: boolean;
  private hydrated = false;

  constructor(config: NotificationPriorityAIConfig = {}) {
    this.clock = config.clock ?? SYSTEM_CLOCK;
    this.smartSchedule = { ...DEFAULT_SMART_SCHEDULE, ...(config.smartSchedule ?? {}) };
    this.preferenceStore = config.preferenceStore ?? new InMemoryPreferenceStore();
    this.prefs = emptyPrefs(this.clock.now());
    this.treatBroadcastsFromFriendsAsDirect = !!config.treatBroadcastsFromFriendsAsDirect;
    if (config.closeFriends) {
      for (const f of config.closeFriends) this.addCloseFriend(f);
    }
    if (config.dndRules) {
      this.dndRules = [...config.dndRules];
    }
  }

  // -------------------------------------------------------------------------
  // Public state mutators
  // -------------------------------------------------------------------------

  addCloseFriend(friend: CloseFriend): void {
    if (!friend.userId) throw new Error('CloseFriend.userId required');
    if (friend.affinity < 0 || friend.affinity > 1) {
      throw new Error('CloseFriend.affinity must be 0-1');
    }
    this.closeFriends.set(friend.userId, { ...friend });
  }

  removeCloseFriend(userId: string): boolean {
    return this.closeFriends.delete(userId);
  }

  getCloseFriends(): readonly CloseFriend[] {
    return [...this.closeFriends.values()];
  }

  setDndRules(rules: ReadonlyArray<DndRule>): void {
    for (const r of rules) validateDndRule(r);
    this.dndRules = [...rules];
  }

  addDndRule(rule: DndRule): void {
    validateDndRule(rule);
    this.dndRules.push(rule);
  }

  removeDndRule(id: string): boolean {
    const before = this.dndRules.length;
    this.dndRules = this.dndRules.filter((r) => r.id !== id);
    return this.dndRules.length !== before;
  }

  /** Ad-hoc DND — block everything below `priority` for `durationMs`. */
  enableManualDnd(durationMs: number, suppressBelowPriority = 11): DndRule {
    if (durationMs <= 0) throw new Error('durationMs must be positive');
    const expiresAt = this.clock.now() + durationMs;
    const rule: DndRule = {
      id: `manual-${expiresAt}`,
      label: 'Manual Do Not Disturb',
      daysOfWeek: [],
      startMinute: 0,
      endMinute: 1440,
      suppressBelowPriority,
      expiresAt,
    };
    this.dndRules.push(rule);
    return rule;
  }

  setSmartSchedule(patch: Partial<SmartScheduleConfig>): void {
    this.smartSchedule = { ...this.smartSchedule, ...patch };
  }

  getSmartSchedule(): SmartScheduleConfig {
    return { ...this.smartSchedule };
  }

  /** Lazy hydration of stored preferences. Idempotent. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const loaded = await this.preferenceStore.load();
    if (loaded) {
      this.prefs = mergePrefs(this.prefs, loaded);
    }
    this.hydrated = true;
  }

  /** Persist current preferences. */
  async persist(): Promise<void> {
    await this.preferenceStore.save(cloneState(this.prefs));
  }

  // -------------------------------------------------------------------------
  // Feedback ingestion (drives the learning loop)
  // -------------------------------------------------------------------------

  async recordFeedback(app: QuantApp, event: FeedbackEvent): Promise<AppPreference> {
    if (!QUANT_APPS.includes(app)) throw new Error(`Unknown app: ${app}`);
    const prior = this.prefs[app];
    const next: AppPreference = {
      app,
      feedback: { ...prior.feedback, [event]: prior.feedback[event] + 1 },
      bias: clamp(prior.bias + PREF_RATE[event], -MAX_PREF_BIAS, MAX_PREF_BIAS),
      updatedAt: this.clock.now(),
    };
    this.prefs[app] = next;
    await this.persist();
    logger.debug({ app, event, bias: next.bias }, 'preference updated');
    return next;
  }

  getPreferences(): Readonly<Record<QuantApp, AppPreference>> {
    return cloneState(this.prefs);
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  /**
   * Implements `PriorityScorer.score`. Returns a final 1-10 priority value.
   */
  score(notification: UnifiedNotification): number {
    return this.evaluate(notification).score;
  }

  /**
   * Evaluate a notification and return the full decision (score plus
   * diagnostics). The aggregator stores only the score; the UI uses the
   * full decision to label notifications and explain DND behaviour.
   */
  evaluate(notification: UnifiedNotification): PriorityDecision {
    const base = BASE_PRIORITY[notification.kind] ?? 5;

    // --- Close-friend boost ------------------------------------------------
    let closeFriendBoost = 0;
    let isFromFriend = false;
    if (notification.senderId) {
      const friend = this.closeFriends.get(notification.senderId);
      if (friend) {
        isFromFriend = true;
        if (notification.kind === 'message') {
          // DM from a close friend → push the score up to 10 deterministically.
          closeFriendBoost = 10 - base + (friend.affinity - 1);
        } else if (notification.kind === 'match') {
          closeFriendBoost = 1 + friend.affinity;
        } else if (
          this.treatBroadcastsFromFriendsAsDirect &&
          notification.kind === 'broadcast'
        ) {
          closeFriendBoost = 2 + friend.affinity;
        } else {
          closeFriendBoost = 0.5 + friend.affinity * 0.5;
        }
      }
    }

    // --- Learned preferences ----------------------------------------------
    const preferenceBoost = this.prefs[notification.app]?.bias ?? 0;

    // --- Content-derived signal -------------------------------------------
    let contentBoost = 0;
    const haystack = `${notification.title} ${notification.body}`.toLowerCase();
    let urgentHit = false;
    let promoHit = false;
    for (const kw of URGENT_KEYWORDS) {
      if (haystack.includes(kw)) { contentBoost += 1; urgentHit = true; break; }
    }
    for (const kw of PROMOTIONAL_KEYWORDS) {
      if (haystack.includes(kw)) { contentBoost -= 1; promoHit = true; break; }
    }
    // Fresh notifications get a slight boost (within last 60 s).
    const ageMs = Math.max(0, this.clock.now() - Date.parse(notification.occurredAt));
    if (ageMs < 60_000) contentBoost += 0.5;
    if (ageMs > 24 * 60 * 60_000) contentBoost -= 1;

    // --- DND scheduling ----------------------------------------------------
    const matched: string[] = [];
    let suppress = false;
    let suppressReason = '';
    let suppressThreshold = -Infinity;
    for (const rule of this.activeDndRules()) {
      if (this.matchesRule(rule)) {
        matched.push(rule.label);
        if (rule.suppressBelowPriority > suppressThreshold) {
          suppressThreshold = rule.suppressBelowPriority;
        }
      }
    }
    const sleep = this.matchesSchedule('sleep');
    const focus = this.matchesSchedule('focus');
    if (sleep) {
      matched.push('Sleep window');
      if (this.smartSchedule.sleepSuppressBelow > suppressThreshold) {
        suppressThreshold = this.smartSchedule.sleepSuppressBelow;
      }
    }
    if (focus) {
      matched.push('Focus window');
      if (this.smartSchedule.focusSuppressBelow > suppressThreshold) {
        suppressThreshold = this.smartSchedule.focusSuppressBelow;
      }
    }

    const rawScore = base + closeFriendBoost + preferenceBoost + contentBoost;
    const score = clamp(Math.round(rawScore), 1, 10);

    if (suppressThreshold > -Infinity && score < suppressThreshold) {
      suppress = true;
      suppressReason = matched[0] ?? 'Quiet hours';
    }

    const tags: string[] = [];
    if (isFromFriend) tags.push('vip');
    if (urgentHit) tags.push('urgent');
    if (promoHit) tags.push('promotional');
    if (suppress) tags.push('quiet-hours');
    if (preferenceBoost >= 1) tags.push('preferred-app');
    if (preferenceBoost <= -1) tags.push('low-signal');

    return {
      score,
      base,
      closeFriendBoost,
      preferenceBoost,
      contentBoost,
      suppress,
      suppressReason,
      matchedDndRules: matched,
      tags,
    };
  }

  // -------------------------------------------------------------------------
  // DND helpers
  // -------------------------------------------------------------------------

  private activeDndRules(): DndRule[] {
    const now = this.clock.now();
    this.dndRules = this.dndRules.filter((r) => !r.expiresAt || r.expiresAt > now);
    return this.dndRules;
  }

  private matchesRule(rule: DndRule): boolean {
    const tz = rule.tzOffsetMinutes ?? 0;
    const local = new Date(this.clock.now() + tz * 60_000);
    const dow = local.getUTCDay();
    if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(dow)) return false;
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    return minuteIsBetween(minute, rule.startMinute, rule.endMinute);
  }

  private matchesSchedule(kind: 'sleep' | 'focus'): boolean {
    const tz = this.smartSchedule.tzOffsetMinutes;
    const local = new Date(this.clock.now() + tz * 60_000);
    const dow = local.getUTCDay();
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (kind === 'focus') {
      // Focus windows only apply on weekdays (Mon-Fri).
      if (dow === 0 || dow === 6) return false;
      return minuteIsBetween(
        minute,
        this.smartSchedule.focusStartMinute,
        this.smartSchedule.focusEndMinute,
      );
    }
    return minuteIsBetween(
      minute,
      this.smartSchedule.sleepStartMinute,
      this.smartSchedule.sleepEndMinute,
    );
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Returns a snapshot of the engine state for debugging dashboards. */
  describe(): {
    closeFriends: number;
    dndRules: number;
    schedule: SmartScheduleConfig;
    biases: Record<QuantApp, number>;
  } {
    const biases = Object.fromEntries(
      QUANT_APPS.map((a) => [a, this.prefs[a].bias]),
    ) as Record<QuantApp, number>;
    return {
      closeFriends: this.closeFriends.size,
      dndRules: this.activeDndRules().length,
      schedule: this.getSmartSchedule(),
      biases,
    };
  }
}

// ---------------------------------------------------------------------------
// Sanity helper to keep the static base table in sync with the issue spec
// ---------------------------------------------------------------------------

/**
 * Returns the spec-mandated priority bucket given a kind. Unlike
 * `BASE_PRIORITY` (which the model uses as an internal seed) this returns
 * the documented values used in the issue's examples — which the UI
 * displays in tooltips so users understand why a notification ranked
 * where it did.
 */
export function specPriorityBucket(kind: NotificationKind): { label: string; value: number } {
  switch (kind) {
    case 'message':
      return { label: 'Direct messages from close friends', value: 10 };
    case 'match':
      return { label: 'Matches and social events', value: 8 };
    case 'broadcast':
    case 'video_engagement':
    case 'edit_share':
      return { label: 'Content engagement (likes, comments)', value: 5 };
    case 'email':
    case 'metaverse_event':
    case 'web_clip':
      return { label: 'Cross-app updates', value: 4 };
    case 'ad_performance':
      return { label: 'Marketing / promotional', value: 2 };
    case 'system':
      return { label: 'System notifications', value: 1 };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyPrefs(now: number): Record<QuantApp, AppPreference> {
  const out = {} as Record<QuantApp, AppPreference>;
  for (const app of QUANT_APPS) {
    out[app] = {
      app,
      feedback: { ...ZERO_FEEDBACK },
      bias: 0,
      updatedAt: now,
    };
  }
  return out;
}

function cloneState(
  state: Record<QuantApp, AppPreference>,
): Record<QuantApp, AppPreference> {
  const out = {} as Record<QuantApp, AppPreference>;
  for (const app of QUANT_APPS) {
    const src = state[app] ?? {
      app, feedback: { ...ZERO_FEEDBACK }, bias: 0, updatedAt: 0,
    };
    out[app] = {
      app: src.app,
      feedback: { ...src.feedback },
      bias: src.bias,
      updatedAt: src.updatedAt,
    };
  }
  return out;
}

function mergePrefs(
  base: Record<QuantApp, AppPreference>,
  loaded: Record<QuantApp, AppPreference>,
): Record<QuantApp, AppPreference> {
  const out = cloneState(base);
  for (const app of QUANT_APPS) {
    const l = loaded[app];
    if (l) out[app] = { ...l, feedback: { ...ZERO_FEEDBACK, ...l.feedback } };
  }
  return out;
}

function validateDndRule(rule: DndRule): void {
  if (!rule.id) throw new Error('DndRule.id required');
  if (!rule.label) throw new Error('DndRule.label required');
  if (rule.startMinute < 0 || rule.startMinute > 1440) {
    throw new Error('DndRule.startMinute out of range');
  }
  if (rule.endMinute < 0 || rule.endMinute > 1440) {
    throw new Error('DndRule.endMinute out of range');
  }
  for (const d of rule.daysOfWeek) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new Error('DndRule.daysOfWeek values must be 0-6');
    }
  }
}

function minuteIsBetween(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  // Wraps past midnight (e.g. 23:00 → 07:00).
  return minute >= start || minute < end;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// Used by the touch-test harness — re-export the underlying constants so a
// downstream service can introspect tunables without importing internals.
export const PRIORITY_AI_CONSTANTS = Object.freeze({
  BASE_PRIORITY,
  PREF_RATE,
  MAX_PREF_BIAS,
  URGENT_KEYWORDS,
  PROMOTIONAL_KEYWORDS,
  DEFAULT_SMART_SCHEDULE,
});
