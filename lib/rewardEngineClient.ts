/**
 * Client-side mirror of the server RewardEngine.
 *
 * The server `src/services/RewardEngine.ts` is authoritative for server-side
 * analytics and persistence. This module re-implements the same pure logic
 * for the browser using a no-op logger, so the React client can drive the
 * Variable Reward Slot Machine locally without crossing the Node/browser
 * boundary. The shapes and defaults are kept in sync intentionally.
 */

// ---------------------------------------------------------------------------
// Types (kept identical to src/services/RewardEngine.ts)
// ---------------------------------------------------------------------------

export type Rarity = "COMMON" | "RARE" | "LEGENDARY";

export interface RewardDefinition {
  readonly rarity: Rarity;
  readonly glyph: string;
  readonly label: string;
  readonly statusPoints: number;
  readonly animation: "pulse" | "shimmer" | "crown";
  readonly probability: number;
}

export interface MysteryBoxResult {
  readonly reward: RewardDefinition;
  readonly rarity: Rarity;
  readonly statusPoints: number;
  readonly drawnAt: Date;
  readonly triggeredByView: number;
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
  | "BRONZE"
  | "SILVER"
  | "GOLD"
  | "PLATINUM"
  | "DIAMOND";

export interface LossAversionState {
  readonly tier: StatusTier;
  readonly expiresAt: Date;
  readonly hoursRemaining: number;
  readonly warningLevel: "CALM" | "NUDGE" | "URGENT" | "CRITICAL";
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_REWARD_TABLE: readonly RewardDefinition[] = Object.freeze([
  Object.freeze({
    rarity: "COMMON" as const,
    glyph: "🔥",
    label: "Signal Spark",
    statusPoints: 5,
    animation: "pulse" as const,
    probability: 0.7,
  }),
  Object.freeze({
    rarity: "RARE" as const,
    glyph: "💎",
    label: "Prism Cut",
    statusPoints: 50,
    animation: "shimmer" as const,
    probability: 0.25,
  }),
  Object.freeze({
    rarity: "LEGENDARY" as const,
    glyph: "👑",
    label: "Sovereign Crown",
    statusPoints: 500,
    animation: "crown" as const,
    probability: 0.05,
  }),
]);

export const DEFAULT_MILESTONES: readonly ViewMilestone[] = Object.freeze([
  Object.freeze({
    threshold: 100,
    badgeName: "First Signal",
    tagline: "You've been heard. 100 pairs of eyes acknowledged the broadcast.",
    accentColor: "#9EC97A",
  }),
  Object.freeze({
    threshold: 500,
    badgeName: "Signal Amplifier",
    tagline: "500 views. The network is boosting your frequency.",
    accentColor: "#7A9FC9",
  }),
  Object.freeze({
    threshold: 1_000,
    badgeName: "Rising Voice",
    tagline: "You've reached 1K views! You're now a Rising Voice.",
    accentColor: "#C9A96E",
  }),
  Object.freeze({
    threshold: 10_000,
    badgeName: "Apex Broadcaster",
    tagline: "10,000 views. The algorithm knows your name.",
    accentColor: "#C97A9E",
  }),
]);

export const TIER_DECAY_HOURS: Record<StatusTier, number> = {
  BRONZE: 168,
  SILVER: 120,
  GOLD: 96,
  PLATINUM: 72,
  DIAMOND: 48,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
    if (roll < cumulative) return entry;
  }
  return table[table.length - 1];
}

export function tierForStatusPoints(points: number): StatusTier {
  if (points >= 5_000) return "DIAMOND";
  if (points >= 2_500) return "PLATINUM";
  if (points >= 1_000) return "GOLD";
  if (points >= 250) return "SILVER";
  return "BRONZE";
}

function randomId(prefix: string): string {
  const rnd = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface RewardEngineOptions {
  readonly drawEveryNthView?: number;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly rewardTable?: readonly RewardDefinition[];
  readonly milestones?: readonly ViewMilestone[];
}

export class RewardEngine {
  private readonly rewardTable: readonly RewardDefinition[];
  private readonly milestones: readonly ViewMilestone[];
  private readonly drawEveryNthView: number;
  private readonly random: () => number;
  private readonly now: () => Date;

  private views = 0;
  private totalStatusPoints = 0;
  private milestonesReached = new Set<number>();

  constructor(options: RewardEngineOptions = {}) {
    this.rewardTable = options.rewardTable ?? DEFAULT_REWARD_TABLE;
    this.milestones = options.milestones ?? DEFAULT_MILESTONES;
    this.drawEveryNthView = options.drawEveryNthView ?? 4;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
  }

  recordView(): { draw: MysteryBoxResult | null; newMilestones: readonly MilestoneReached[] } {
    this.views += 1;
    const newMilestones: MilestoneReached[] = [];
    for (const milestone of this.milestones) {
      if (this.views === milestone.threshold && !this.milestonesReached.has(milestone.threshold)) {
        this.milestonesReached.add(milestone.threshold);
        newMilestones.push({
          milestone,
          reachedAt: this.now(),
          viewsAtTrigger: this.views,
        });
      }
    }
    const draw = this.views % this.drawEveryNthView === 0 ? this.drawMysteryBox() : null;
    return { draw, newMilestones };
  }

  drawMysteryBox(): MysteryBoxResult {
    const roll = this.random();
    const reward = resolveRarity(roll, this.rewardTable);
    this.totalStatusPoints += reward.statusPoints;
    return {
      reward,
      rarity: reward.rarity,
      statusPoints: reward.statusPoints,
      drawnAt: this.now(),
      triggeredByView: this.views,
      id: randomId("mb"),
    };
  }

  computeLossAversion(lastBroadcastAt: Date): LossAversionState {
    const tier = tierForStatusPoints(this.totalStatusPoints);
    const decayHours = TIER_DECAY_HOURS[tier];
    const expiresAt = new Date(lastBroadcastAt.getTime() + decayHours * 3_600_000);
    const hoursRemaining = (expiresAt.getTime() - this.now().getTime()) / 3_600_000;

    let warningLevel: LossAversionState["warningLevel"];
    let message: string;
    if (hoursRemaining > decayHours * 0.5) {
      warningLevel = "CALM";
      message = `${tier} status is stable. Keep broadcasting to maintain it.`;
    } else if (hoursRemaining > decayHours * 0.25) {
      warningLevel = "NUDGE";
      message = `Your ${tier} status renews with every broadcast — stay loud.`;
    } else if (hoursRemaining > 0) {
      const hrs = Math.max(1, Math.round(hoursRemaining));
      warningLevel = "URGENT";
      message = `Your ${tier} Broadcaster status expires in ${hrs}h. Post now to maintain it.`;
    } else {
      warningLevel = "CRITICAL";
      message = `Your ${tier} status has lapsed. Broadcast immediately to reinstate it.`;
    }
    return { tier, expiresAt, hoursRemaining, warningLevel, message };
  }

  getViews(): number {
    return this.views;
  }

  getStatusPoints(): number {
    return this.totalStatusPoints;
  }

  getRewardTable(): readonly RewardDefinition[] {
    return this.rewardTable;
  }

  getMilestones(): readonly ViewMilestone[] {
    return this.milestones;
  }
}
