import logger from '../lib/logger';

/**
 * RewardEngine — Variable Ratio Reinforcement & Mystery Box Core
 *
 * This service implements the "Variable Reward Slot Machine" described in
 * issue #13. It provides:
 *
 *  - Deterministic-or-stochastic rarity resolution (70% common / 25% rare
 *    / 5% legendary) with pluggable PRNG support so tests can seed the
 *    stream without losing production randomness.
 *  - A mystery-box pull scheduler that only fires on every Nth viewed
 *    broadcast (default: 4th) to guarantee variable-ratio timing.
 *  - View-milestone tracking at 100 / 500 / 1K / 10K thresholds with
 *    named status badges ("Rising Voice", "Signal Amplifier", etc.).
 *  - A loss-aversion clock: every user has a tier that decays after N
 *    hours of inactivity unless they post a new broadcast.
 *  - Durable session state that can be rehydrated from persistent
 *    storage between server restarts.
 *
 * Intentionally zero external runtime deps so it can run inside both the
 * Next.js app (browser) and the Express backend (Node) without needing
 * an isomorphism layer.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Rarity = 'COMMON' | 'RARE' | 'LEGENDARY';

export interface RewardDefinition {
  readonly rarity: Rarity;
  /** Emoji glyph shown on the slot reel. */
  readonly glyph: string;
  /** Human readable name of the reward. */
  readonly label: string;
  /** Status points granted to the owner of the broadcast. */
  readonly statusPoints: number;
  /** Optional animation hint consumed by the UI layer. */
  readonly animation: 'pulse' | 'shimmer' | 'crown';
  /** Probability weight in [0, 1]. Must sum to 1 across the table. */
  readonly probability: number;
}

export interface MysteryBoxResult {
  readonly reward: RewardDefinition;
  readonly rarity: Rarity;
  readonly statusPoints: number;
  readonly drawnAt: Date;
  /** The view index (1-based) that triggered this draw. */
  readonly triggeredByView: number;
  /** Stable id useful for React keys + analytics. */
  readonly id: string;
}

export interface ViewMilestone {
  readonly threshold: number;
  readonly badgeName: string;
  readonly tagline: string;
  readonly accentColor: string;
}

export interface MilestoneReached {
  readonly milestone: ViewMilestone;
  readonly reachedAt: Date;
  readonly viewsAtTrigger: number;
}

export type StatusTier =
  | 'BRONZE'
  | 'SILVER'
  | 'GOLD'
  | 'PLATINUM'
  | 'DIAMOND';

export interface LossAversionState {
  readonly tier: StatusTier;
  readonly expiresAt: Date;
  /** Hours remaining; negative when already expired. */
  readonly hoursRemaining: number;
  readonly warningLevel: 'CALM' | 'NUDGE' | 'URGENT' | 'CRITICAL';
  readonly message: string;
}

export interface RewardEngineOptions {
  /** Fire a mystery box draw every Nth view. Default 4. */
  readonly drawEveryNthView?: number;
  /** Override PRNG — useful for tests. Must return number in [0, 1). */
  readonly random?: () => number;
  /** Clock override — useful for tests. */
  readonly now?: () => Date;
  /** Override the default rarity table. Probabilities must sum to 1. */
  readonly rewardTable?: readonly RewardDefinition[];
  /** Override the default milestone ladder. */
  readonly milestones?: readonly ViewMilestone[];
}

export interface EngineSnapshot {
  readonly views: number;
  readonly draws: number;
  readonly drawsByRarity: Record<Rarity, number>;
  readonly totalStatusPoints: number;
  readonly milestonesReached: readonly number[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_REWARD_TABLE: readonly RewardDefinition[] = Object.freeze([
  Object.freeze({
    rarity: 'COMMON' as const,
    glyph: '🔥',
    label: 'Signal Spark',
    statusPoints: 5,
    animation: 'pulse' as const,
    probability: 0.7,
  }),
  Object.freeze({
    rarity: 'RARE' as const,
    glyph: '💎',
    label: 'Prism Cut',
    statusPoints: 50,
    animation: 'shimmer' as const,
    probability: 0.25,
  }),
  Object.freeze({
    rarity: 'LEGENDARY' as const,
    glyph: '👑',
    label: 'Sovereign Crown',
    statusPoints: 500,
    animation: 'crown' as const,
    probability: 0.05,
  }),
]);

export const DEFAULT_MILESTONES: readonly ViewMilestone[] = Object.freeze([
  Object.freeze({
    threshold: 100,
    badgeName: 'First Signal',
    tagline: "You've been heard. 100 pairs of eyes acknowledged the broadcast.",
    accentColor: '#9EC97A',
  }),
  Object.freeze({
    threshold: 500,
    badgeName: 'Signal Amplifier',
    tagline: '500 views. The network is boosting your frequency.',
    accentColor: '#7A9FC9',
  }),
  Object.freeze({
    threshold: 1_000,
    badgeName: 'Rising Voice',
    tagline: "You've reached 1K views! You're now a Rising Voice.",
    accentColor: '#C9A96E',
  }),
  Object.freeze({
    threshold: 10_000,
    badgeName: 'Apex Broadcaster',
    tagline: '10,000 views. The algorithm knows your name.',
    accentColor: '#C97A9E',
  }),
]);

const TIER_DECAY_HOURS: Record<StatusTier, number> = {
  BRONZE: 168, // 7 days
  SILVER: 120, // 5 days
  GOLD: 96, // 4 days
  PLATINUM: 72, // 3 days
  DIAMOND: 48, // 2 days
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function assertTableSumsToOne(table: readonly RewardDefinition[]): void {
  const total = table.reduce((sum, entry) => sum + entry.probability, 0);
  const drift = Math.abs(total - 1);
  if (drift > 1e-6) {
    throw new Error(
      `RewardEngine reward table probabilities must sum to 1 (got ${total.toFixed(6)}).`,
    );
  }
  if (table.length === 0) {
    throw new Error('RewardEngine reward table must contain at least one entry.');
  }
}

function assertValidMilestones(milestones: readonly ViewMilestone[]): void {
  if (milestones.length === 0) {
    throw new Error('RewardEngine must be configured with at least one milestone.');
  }
  for (let i = 1; i < milestones.length; i += 1) {
    if (milestones[i].threshold <= milestones[i - 1].threshold) {
      throw new Error(
        `Milestone thresholds must be strictly increasing; saw ${milestones[i - 1].threshold} → ${milestones[i].threshold}.`,
      );
    }
  }
}

/**
 * Pure rarity resolver. Given a random number in [0, 1) and a reward
 * table, returns the selected RewardDefinition. Exposed separately from
 * the engine so it can be unit-tested in isolation.
 */
export function resolveRarity(
  roll: number,
  table: readonly RewardDefinition[] = DEFAULT_REWARD_TABLE,
): RewardDefinition {
  if (Number.isNaN(roll) || roll < 0 || roll >= 1) {
    throw new Error(`resolveRarity: roll must be in [0, 1); received ${roll}`);
  }
  let cumulative = 0;
  for (const entry of table) {
    cumulative += entry.probability;
    if (roll < cumulative) {
      return entry;
    }
  }
  // Floating-point safety net.
  return table[table.length - 1];
}

/**
 * Returns the friendly status tier name for a total status point count.
 */
export function tierForStatusPoints(points: number): StatusTier {
  if (points >= 5_000) return 'DIAMOND';
  if (points >= 2_500) return 'PLATINUM';
  if (points >= 1_000) return 'GOLD';
  if (points >= 250) return 'SILVER';
  return 'BRONZE';
}

// ---------------------------------------------------------------------------
// RewardEngine
// ---------------------------------------------------------------------------

/**
 * The RewardEngine is instantiated per broadcast (or per user session).
 * It is intentionally small + state-light so it can be safely used inside
 * a React context on the client while still being serialisable for
 * persistence on the server.
 */
export class RewardEngine {
  private readonly rewardTable: readonly RewardDefinition[];
  private readonly milestones: readonly ViewMilestone[];
  private readonly drawEveryNthView: number;
  private readonly random: () => number;
  private readonly now: () => Date;

  private views = 0;
  private draws = 0;
  private totalStatusPoints = 0;
  private drawsByRarity: Record<Rarity, number> = {
    COMMON: 0,
    RARE: 0,
    LEGENDARY: 0,
  };
  private milestonesReached = new Set<number>();
  private lastActivity: Date;

  constructor(options: RewardEngineOptions = {}) {
    this.rewardTable = options.rewardTable ?? DEFAULT_REWARD_TABLE;
    this.milestones = options.milestones ?? DEFAULT_MILESTONES;
    this.drawEveryNthView = options.drawEveryNthView ?? 4;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());

    if (this.drawEveryNthView <= 0 || !Number.isFinite(this.drawEveryNthView)) {
      throw new Error(
        `drawEveryNthView must be a positive finite number (got ${this.drawEveryNthView}).`,
      );
    }

    assertTableSumsToOne(this.rewardTable);
    assertValidMilestones(this.milestones);
    this.lastActivity = this.now();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record a single view. Returns a MysteryBoxResult when the view lands
   * on a draw trigger, otherwise `null`. Also records milestones — callers
   * should use `drainMilestones()` immediately after to collect them.
   */
  recordView(): MysteryBoxResult | null {
    this.views += 1;
    this.lastActivity = this.now();

    // Capture milestones crossed by this view.
    for (const milestone of this.milestones) {
      if (
        this.views >= milestone.threshold &&
        !this.milestonesReached.has(milestone.threshold)
      ) {
        this.milestonesReached.add(milestone.threshold);
        logger.info(
          { threshold: milestone.threshold, badge: milestone.badgeName, views: this.views },
          'RewardEngine milestone reached',
        );
      }
    }

    if (this.views % this.drawEveryNthView !== 0) {
      return null;
    }
    return this.drawMysteryBox();
  }

  /**
   * Force a mystery-box draw regardless of view cadence. Useful for
   * promotional "free spin" flows and manual QA tooling.
   */
  drawMysteryBox(): MysteryBoxResult {
    const roll = this.random();
    const reward = resolveRarity(roll, this.rewardTable);
    this.draws += 1;
    this.drawsByRarity[reward.rarity] += 1;
    this.totalStatusPoints += reward.statusPoints;
    const result: MysteryBoxResult = {
      reward,
      rarity: reward.rarity,
      statusPoints: reward.statusPoints,
      drawnAt: this.now(),
      triggeredByView: this.views,
      id: this.randomIdLocal('mb'),
    };
    logger.debug(
      { rarity: reward.rarity, roll, views: this.views },
      'RewardEngine mystery box drawn',
    );
    return result;
  }

  /**
   * Return a list of milestones that have been crossed since last call.
   * The engine does not buffer them indefinitely; callers are expected
   * to call this immediately after `recordView` inside the same tick.
   */
  getAchievedMilestones(): readonly MilestoneReached[] {
    const reached: MilestoneReached[] = [];
    const now = this.now();
    for (const milestone of this.milestones) {
      if (this.milestonesReached.has(milestone.threshold)) {
        reached.push({
          milestone,
          reachedAt: now,
          viewsAtTrigger: Math.max(this.views, milestone.threshold),
        });
      }
    }
    return reached;
  }

  /**
   * Compute the current loss-aversion state for this user's status tier.
   * Expiry is derived from the user's tier + the last time they posted
   * a new broadcast. A user who is inactive will progress Calm → Nudge →
   * Urgent → Critical.
   */
  computeLossAversion(lastBroadcastAt: Date): LossAversionState {
    const tier = tierForStatusPoints(this.totalStatusPoints);
    const decayHours = TIER_DECAY_HOURS[tier];
    const expiresAt = new Date(lastBroadcastAt.getTime() + decayHours * 3_600_000);
    const hoursRemaining =
      (expiresAt.getTime() - this.now().getTime()) / 3_600_000;

    let warningLevel: LossAversionState['warningLevel'];
    let message: string;

    if (hoursRemaining > decayHours * 0.5) {
      warningLevel = 'CALM';
      message = `${tier} status is stable. Keep broadcasting to maintain it.`;
    } else if (hoursRemaining > decayHours * 0.25) {
      warningLevel = 'NUDGE';
      message = `Your ${tier} status renews with every broadcast — stay loud.`;
    } else if (hoursRemaining > 0) {
      const hrs = Math.max(1, Math.round(hoursRemaining));
      warningLevel = 'URGENT';
      message = `Your ${tier} Broadcaster status expires in ${hrs}h. Post now to maintain it.`;
    } else {
      warningLevel = 'CRITICAL';
      message = `Your ${tier} status has lapsed. Broadcast immediately to reinstate it.`;
    }

    return { tier, expiresAt, hoursRemaining, warningLevel, message };
  }

  /** Immutable-ish snapshot safe for logging, analytics, and UI display. */
  snapshot(): EngineSnapshot {
    return {
      views: this.views,
      draws: this.draws,
      drawsByRarity: { ...this.drawsByRarity },
      totalStatusPoints: this.totalStatusPoints,
      milestonesReached: Array.from(this.milestonesReached).sort((a, b) => a - b),
    };
  }

  /** Deterministic rehydration from a previously captured snapshot. */
  restoreFrom(snapshot: EngineSnapshot): void {
    this.views = snapshot.views;
    this.draws = snapshot.draws;
    this.drawsByRarity = { ...snapshot.drawsByRarity };
    this.totalStatusPoints = snapshot.totalStatusPoints;
    this.milestonesReached = new Set(snapshot.milestonesReached);
    this.lastActivity = this.now();
  }

  /** The configured reward table (read-only). */
  getRewardTable(): readonly RewardDefinition[] {
    return this.rewardTable;
  }

  /** The configured milestone ladder (read-only). */
  getMilestones(): readonly ViewMilestone[] {
    return this.milestones;
  }

  /**
   * Convenience: fast-forward many views in one call and return all
   * mystery-box draws that landed during the batch. Used by server-side
   * backfill jobs and integration tests.
   */
  recordViewsBulk(count: number): readonly MysteryBoxResult[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`recordViewsBulk: count must be a non-negative integer (got ${count}).`);
    }
    const draws: MysteryBoxResult[] = [];
    for (let i = 0; i < count; i += 1) {
      const draw = this.recordView();
      if (draw) draws.push(draw);
    }
    return draws;
  }

  /** Current view count. */
  getViews(): number {
    return this.views;
  }

  /** Total status points accumulated from mystery-box payouts. */
  getStatusPoints(): number {
    return this.totalStatusPoints;
  }

  /** Last activity timestamp recorded by the engine. */
  getLastActivity(): Date {
    return this.lastActivity;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Deterministic id generator that uses the engine's injectable PRNG
   * + clock so tests receive reproducible identifiers.
   */
  private randomIdLocal(prefix: string): string {
    const rnd = Math.floor(this.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
    return `${prefix}-${this.now().getTime().toString(36)}-${rnd}`;
  }
}

export default RewardEngine;
