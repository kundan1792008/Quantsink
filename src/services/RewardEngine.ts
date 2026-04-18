import logger from '../lib/logger';

/**
 * RewardEngine — honest achievement system.
 *
 * Three concerns, each fully transparent to the user:
 *  1. Milestone rewards at real view counts (100, 500, 1K, 10K).
 *  2. Reaction variety — viewers explicitly choose a reaction tier and spend
 *     a corresponding weight. No hidden RNG, no variable-ratio schedule.
 *  3. Broadcast streak tracking — consecutive calendar days a user has
 *     broadcast, identical in spirit to Duolingo / GitHub streaks.
 */

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export interface Milestone {
  threshold: number;
  tier: 'SPARK' | 'RISING' | 'APEX' | 'LEGENDARY';
  label: string;
}

export const MILESTONES: readonly Milestone[] = [
  { threshold: 100,   tier: 'SPARK',      label: 'First Hundred' },
  { threshold: 500,   tier: 'RISING',     label: 'Rising Signal' },
  { threshold: 1_000, tier: 'APEX',       label: 'Apex Broadcaster' },
  { threshold: 10_000, tier: 'LEGENDARY', label: 'Legendary Reach' },
] as const;

export interface MilestoneEvent {
  broadcastId: string;
  milestone: Milestone;
  reachedAt: Date;
  actualViewCount: number;
}

/**
 * Given a previous view count and a new view count for a broadcast,
 * return the list of milestones that were *newly* crossed.
 *
 * Pure function — no side effects, fully unit-testable.
 */
export function milestonesCrossed(
  previousViews: number,
  currentViews: number,
): Milestone[] {
  if (currentViews <= previousViews) return [];
  return MILESTONES.filter(
    (m) => previousViews < m.threshold && currentViews >= m.threshold,
  );
}

// ---------------------------------------------------------------------------
// Reactions — transparent, user-weighted
// ---------------------------------------------------------------------------

/**
 * Each reaction has a fixed, publicly-known weight. The viewer picks which
 * one to spend. There is no randomisation and no hidden outcome.
 */
export type ReactionKind = 'DIAMOND' | 'FIRE' | 'CROWN';

export interface ReactionDefinition {
  kind: ReactionKind;
  emoji: string;
  weight: number;   // how much this reaction contributes to the broadcast's engagement score
  label: string;
}

export const REACTIONS: readonly ReactionDefinition[] = [
  { kind: 'FIRE',    emoji: '🔥', weight: 1, label: 'Fire' },
  { kind: 'DIAMOND', emoji: '💎', weight: 3, label: 'Diamond' },
  { kind: 'CROWN',   emoji: '👑', weight: 10, label: 'Crown' },
] as const;

export function getReactionDefinition(kind: ReactionKind): ReactionDefinition {
  const def = REACTIONS.find((r) => r.kind === kind);
  if (!def) throw new Error(`Unknown reaction kind: ${kind}`);
  return def;
}

export interface ReactionEvent {
  broadcastId: string;
  viewerId: string;
  kind: ReactionKind;
  weight: number;
  at: Date;
}

export function recordReaction(
  broadcastId: string,
  viewerId: string,
  kind: ReactionKind,
  now: Date = new Date(),
): ReactionEvent {
  const def = getReactionDefinition(kind);
  const event: ReactionEvent = {
    broadcastId,
    viewerId,
    kind,
    weight: def.weight,
    at: now,
  };
  logger.info(
    { broadcastId, viewerId, kind, weight: def.weight },
    'reaction.recorded',
  );
  return event;
}

// ---------------------------------------------------------------------------
// Broadcast streak
// ---------------------------------------------------------------------------

export interface StreakState {
  /** Current streak length in consecutive calendar days. */
  currentStreak: number;
  /** Longest streak ever achieved by the user. */
  longestStreak: number;
  /** ISO date (YYYY-MM-DD, UTC) of the last recorded broadcast, or null. */
  lastBroadcastDate: string | null;
}

export const EMPTY_STREAK: StreakState = {
  currentStreak: 0,
  longestStreak: 0,
  lastBroadcastDate: null,
};

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayDiff(aKey: string, bKey: string): number {
  const a = Date.parse(`${aKey}T00:00:00Z`);
  const b = Date.parse(`${bKey}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Apply a new broadcast event to a streak state.
 * - Same day → streak unchanged.
 * - Next calendar day → streak +1.
 * - Gap > 1 day → streak resets to 1.
 */
export function applyBroadcastToStreak(
  state: StreakState,
  broadcastAt: Date,
): StreakState {
  const today = toUtcDateKey(broadcastAt);

  if (state.lastBroadcastDate === null) {
    return {
      currentStreak: 1,
      longestStreak: Math.max(1, state.longestStreak),
      lastBroadcastDate: today,
    };
  }

  const diff = dayDiff(state.lastBroadcastDate, today);

  if (diff < 0) {
    // Event older than last recorded — ignore to keep state monotonic.
    return state;
  }
  if (diff === 0) {
    return state;
  }

  const nextStreak = diff === 1 ? state.currentStreak + 1 : 1;
  return {
    currentStreak: nextStreak,
    longestStreak: Math.max(nextStreak, state.longestStreak),
    lastBroadcastDate: today,
  };
}

/**
 * Returns whether a streak is currently "at risk" — the user broadcast
 * yesterday but has not broadcast today yet.
 */
export function isStreakAtRisk(state: StreakState, now: Date = new Date()): boolean {
  if (!state.lastBroadcastDate || state.currentStreak === 0) return false;
  const today = toUtcDateKey(now);
  return dayDiff(state.lastBroadcastDate, today) === 1;
}

// ---------------------------------------------------------------------------
// RewardEngine — stateful orchestrator (in-memory; persistence is pluggable)
// ---------------------------------------------------------------------------

export class RewardEngine {
  private readonly viewCounts = new Map<string, number>();
  private readonly streaks = new Map<string, StreakState>();
  private readonly reachedMilestones = new Map<string, Set<number>>();

  recordViews(broadcastId: string, newTotal: number): MilestoneEvent[] {
    if (newTotal < 0) throw new Error('View count cannot be negative');
    const previous = this.viewCounts.get(broadcastId) ?? 0;
    if (newTotal < previous) {
      // Counts are monotonic; ignore regressions.
      return [];
    }
    this.viewCounts.set(broadcastId, newTotal);

    const crossed = milestonesCrossed(previous, newTotal);
    if (crossed.length === 0) return [];

    const seen = this.reachedMilestones.get(broadcastId) ?? new Set<number>();
    const fresh = crossed.filter((m) => !seen.has(m.threshold));
    fresh.forEach((m) => seen.add(m.threshold));
    this.reachedMilestones.set(broadcastId, seen);

    return fresh.map((milestone) => ({
      broadcastId,
      milestone,
      reachedAt: new Date(),
      actualViewCount: newTotal,
    }));
  }

  react(broadcastId: string, viewerId: string, kind: ReactionKind): ReactionEvent {
    return recordReaction(broadcastId, viewerId, kind);
  }

  recordBroadcast(userId: string, at: Date = new Date()): StreakState {
    const prior = this.streaks.get(userId) ?? EMPTY_STREAK;
    const next = applyBroadcastToStreak(prior, at);
    this.streaks.set(userId, next);
    return next;
  }

  getStreak(userId: string): StreakState {
    return this.streaks.get(userId) ?? EMPTY_STREAK;
  }

  getViews(broadcastId: string): number {
    return this.viewCounts.get(broadcastId) ?? 0;
  }
}
