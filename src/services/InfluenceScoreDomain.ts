import logger from '../lib/logger';

/**
 * InfluenceScoreDomain
 * --------------------
 * Pure types + math helpers + an injectable "store" abstraction that
 * powers the Influence Score system described in issue #16.
 *
 * The Influence Score is a 0–1000 ecosystem-wide reputation number
 * computed from six weighted sub-components:
 *
 *   1. Broadcast Quality (AI-rated, 0–100)  — 25%
 *   2. Engagement Rate  (views/impressions) — 20%
 *   3. Consistency      (posting frequency) — 15%
 *   4. Biometric Verification Level         — 15%
 *   5. Cross-App Activity (Quant apps used) — 15%
 *   6. Community Standing (reports)         — 10%
 *
 * Every sub-component is normalised to 0–100. The weighted sum is
 * multiplied by 10 to produce the public 0–1000 score.
 *
 * This file deliberately contains NO I/O. The `InfluenceStore`
 * interface is how higher-level services (the score service, the
 * decay worker, and the HTTP routes) read + write state. Production
 * code wires up `PrismaInfluenceStore`; tests + offline environments
 * wire up `InMemoryInfluenceStore`.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type InfluenceTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND';

export type InfluenceChallengeKind =
  | 'POST_STREAK'
  | 'BIOMETRIC_WEEK'
  | 'CROSS_APP_EXPLORER'
  | 'QUALITY_AUTHOR'
  | 'COMMUNITY_UPLIFT';

export type InfluenceChallengeStatus =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED';

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

export interface InfluenceScoreComponents {
  /** 0–100. AI-graded broadcast quality average. Weight 25%. */
  readonly broadcastQuality: number;
  /** 0–100. Ratio of views to impressions, normalised. Weight 20%. */
  readonly engagementRate: number;
  /** 0–100. Posting cadence score. Weight 15%. */
  readonly consistency: number;
  /** 0–100. Biometric verification level. Weight 15%. */
  readonly biometricLevel: number;
  /** 0–100. Unique Quant apps used in the last 30 days. Weight 15%. */
  readonly crossAppActivity: number;
  /** 0–100. Community standing (lowered by upheld reports). Weight 10%. */
  readonly communityStanding: number;
}

export interface InfluenceScore {
  readonly userId: string;
  readonly total: number; // 0–1000
  readonly components: InfluenceScoreComponents;
  readonly tier: InfluenceTier;
  readonly lastRecalculatedAt: Date;
  readonly boostPoints: number; // active boost contribution, already folded into total
}

export interface InfluenceScoreSnapshot {
  readonly userId: string;
  readonly total: number;
  readonly components: InfluenceScoreComponents;
  readonly tier: InfluenceTier;
  readonly snapshotAt: Date;
}

export interface BoostEvent {
  readonly id: string;
  readonly userId: string;
  readonly reason: string;
  readonly points: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface InfluenceChallenge {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: InfluenceChallengeKind;
  readonly status: InfluenceChallengeStatus;
  readonly progress: number;
  readonly target: number;
  readonly rewardPoints: number;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
}

export interface UserReportRecord {
  readonly id: string;
  readonly reporterId: string;
  readonly reportedId: string;
  readonly reason: string;
  readonly resolved: boolean;
  readonly upheld: boolean;
  readonly createdAt: Date;
}

export interface BroadcastQualityRatingRecord {
  readonly id: string;
  readonly authorId: string;
  readonly broadcastId: string;
  readonly score: number;
  readonly originality: number;
  readonly clarity: number;
  readonly relevance: number;
  readonly mediaQuality: number;
  readonly grammar: number;
  readonly explanation: string;
  readonly modelName: string;
  readonly createdAt: Date;
}

export interface CrossAppActivityRecord {
  readonly userId: string;
  readonly appKey: string;
  readonly lastUsedAt: Date;
}

/**
 * Raw signal inputs the scoring formula consumes. The
 * InfluenceScoreService builds this from the store + live system
 * signals (biometric level, etc.) before calling the pure math.
 */
export interface InfluenceSignalInputs {
  readonly userId: string;
  /** Average of the user's most recent broadcast quality ratings (0–100). */
  readonly averageBroadcastQuality: number;
  /** Impressions the user's broadcasts have received in the window. */
  readonly impressions: number;
  /** Views the user's broadcasts have received in the window. */
  readonly views: number;
  /** Days-in-a-row the user has posted (capped at 30). */
  readonly postStreakDays: number;
  /** Posts made in the last 30 days. */
  readonly postsLast30d: number;
  /** 0–100 biometric verification level reported by Quantmail. */
  readonly biometricLevel: number;
  /** Unique Quant apps the user has used in the last 30 days (0–9). */
  readonly uniqueQuantAppsUsed: number;
  /** Number of upheld reports filed against the user. */
  readonly upheldReports: number;
  /** Number of reports filed against the user that are still pending. */
  readonly pendingReports: number;
  /** Optional bonus points (e.g. from active boost events). */
  readonly activeBoostPoints?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INFLUENCE_COMPONENT_WEIGHTS = Object.freeze({
  broadcastQuality: 0.25,
  engagementRate: 0.2,
  consistency: 0.15,
  biometricLevel: 0.15,
  crossAppActivity: 0.15,
  communityStanding: 0.1,
}) satisfies Record<keyof InfluenceScoreComponents, number>;

export const INFLUENCE_TIER_THRESHOLDS: ReadonlyArray<{
  readonly tier: InfluenceTier;
  readonly min: number;
  readonly max: number;
  readonly accentColor: string;
  readonly label: string;
}> = Object.freeze([
  Object.freeze({
    tier: 'BRONZE' as const,
    min: 0,
    max: 200,
    accentColor: '#A97142',
    label: 'Bronze Broadcaster',
  }),
  Object.freeze({
    tier: 'SILVER' as const,
    min: 201,
    max: 400,
    accentColor: '#B0B0B0',
    label: 'Silver Signal',
  }),
  Object.freeze({
    tier: 'GOLD' as const,
    min: 401,
    max: 600,
    accentColor: '#C9A96E',
    label: 'Gold Voice',
  }),
  Object.freeze({
    tier: 'PLATINUM' as const,
    min: 601,
    max: 800,
    accentColor: '#CFD8DC',
    label: 'Platinum Influence',
  }),
  Object.freeze({
    tier: 'DIAMOND' as const,
    min: 801,
    max: 1000,
    accentColor: '#7FDBFF',
    label: 'Diamond Apex',
  }),
]);

/** Total unique Quant apps in the ecosystem (used to normalise cross-app). */
export const TOTAL_QUANT_APPS = 9;

/** Default history window used by leaderboards and graphs. */
export const DEFAULT_HISTORY_DAYS = 30;

/** Maximum number of days the service keeps score history for. */
export const MAX_HISTORY_DAYS = 90;

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clamp100(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

export function sumWeights(weights: Record<string, number>): number {
  return Object.values(weights).reduce((acc, w) => acc + w, 0);
}

/** Assert at module load time that the weights sum to 1. */
(function assertWeightsSumToOne(): void {
  const total = sumWeights(INFLUENCE_COMPONENT_WEIGHTS as unknown as Record<string, number>);
  const drift = Math.abs(total - 1);
  if (drift > 1e-6) {
    throw new Error(
      `INFLUENCE_COMPONENT_WEIGHTS must sum to 1.0 (got ${total.toFixed(6)}).`,
    );
  }
})();

/** Given a total score 0–1000, return the tier. */
export function tierForTotal(total: number): InfluenceTier {
  const clamped = clamp(total, 0, 1000);
  for (const def of INFLUENCE_TIER_THRESHOLDS) {
    if (clamped >= def.min && clamped <= def.max) {
      return def.tier;
    }
  }
  return 'BRONZE';
}

/** Return the tier-descriptor metadata for a given tier enum value. */
export function tierDescriptor(
  tier: InfluenceTier,
): (typeof INFLUENCE_TIER_THRESHOLDS)[number] {
  const found = INFLUENCE_TIER_THRESHOLDS.find((t) => t.tier === tier);
  if (!found) {
    throw new Error(`Unknown influence tier: ${tier}`);
  }
  return found;
}

/**
 * Normalise engagement rate — ratio of views to impressions — into a
 * 0–100 score. Users with no impressions yet get a neutral 10 to
 * avoid division-by-zero punishments.
 */
export function normaliseEngagementRate(views: number, impressions: number): number {
  if (impressions <= 0) return 10;
  const ratio = clamp(views / impressions, 0, 1);
  // A raw 35% view-through rate is the "perfect" target.
  const normalised = (ratio / 0.35) * 100;
  return clamp100(normalised);
}

/** Normalise posting cadence into 0–100. Streaks are weighted higher. */
export function normaliseConsistency(streakDays: number, postsLast30d: number): number {
  const streakComponent = clamp(streakDays, 0, 30) * 2; // up to 60
  const volumeComponent = clamp(postsLast30d, 0, 40);   // up to 40
  return clamp100(streakComponent + volumeComponent);
}

/** Cross-app activity: 0 when user only touched Quantsink, 100 when all 9 used. */
export function normaliseCrossApp(unique: number): number {
  const ratio = clamp(unique, 0, TOTAL_QUANT_APPS) / TOTAL_QUANT_APPS;
  return clamp100(ratio * 100);
}

/** Community standing: starts at 100, upheld reports deduct 15, pending deduct 5. */
export function normaliseCommunityStanding(upheld: number, pending: number): number {
  const raw = 100 - upheld * 15 - pending * 5;
  return clamp100(raw);
}

/**
 * Compute the six weighted sub-component scores (each 0–100) for a
 * given set of signal inputs.
 */
export function computeComponents(inputs: InfluenceSignalInputs): InfluenceScoreComponents {
  return {
    broadcastQuality: clamp100(inputs.averageBroadcastQuality),
    engagementRate: normaliseEngagementRate(inputs.views, inputs.impressions),
    consistency: normaliseConsistency(inputs.postStreakDays, inputs.postsLast30d),
    biometricLevel: clamp100(inputs.biometricLevel),
    crossAppActivity: normaliseCrossApp(inputs.uniqueQuantAppsUsed),
    communityStanding: normaliseCommunityStanding(inputs.upheldReports, inputs.pendingReports),
  };
}

/**
 * Given 0–100 sub-components, produce the weighted total on a 0–1000
 * scale. Any active boost points are added on top and the result is
 * clamped to 1000.
 */
export function weightedTotal(
  components: InfluenceScoreComponents,
  activeBoostPoints = 0,
): number {
  const weighted =
    components.broadcastQuality * INFLUENCE_COMPONENT_WEIGHTS.broadcastQuality +
    components.engagementRate * INFLUENCE_COMPONENT_WEIGHTS.engagementRate +
    components.consistency * INFLUENCE_COMPONENT_WEIGHTS.consistency +
    components.biometricLevel * INFLUENCE_COMPONENT_WEIGHTS.biometricLevel +
    components.crossAppActivity * INFLUENCE_COMPONENT_WEIGHTS.crossAppActivity +
    components.communityStanding * INFLUENCE_COMPONENT_WEIGHTS.communityStanding;
  const base = Math.round(weighted * 10);
  return clamp(base + activeBoostPoints, 0, 1000);
}

/**
 * High-level helper that computes components + total in one call.
 */
export function computeScoreFromInputs(inputs: InfluenceSignalInputs): {
  components: InfluenceScoreComponents;
  total: number;
  tier: InfluenceTier;
} {
  const components = computeComponents(inputs);
  const total = weightedTotal(components, inputs.activeBoostPoints ?? 0);
  const tier = tierForTotal(total);
  return { components, total, tier };
}

// ---------------------------------------------------------------------------
// Store abstraction
// ---------------------------------------------------------------------------

/**
 * Persistence layer for the Influence Score system. Implementations
 * are responsible for durability + indexing; the service layer above
 * is pure orchestration.
 */
export interface InfluenceStore {
  getScore(userId: string): Promise<InfluenceScore | null>;
  upsertScore(score: InfluenceScore): Promise<InfluenceScore>;
  listScoresOrdered(limit: number, cursor: number | null): Promise<InfluenceScore[]>;
  countScores(): Promise<number>;
  listScoresNear(userId: string, spread: number, limit: number): Promise<InfluenceScore[]>;

  appendHistory(snapshot: InfluenceScoreSnapshot): Promise<void>;
  listHistory(userId: string, days: number): Promise<InfluenceScoreSnapshot[]>;
  pruneHistoryOlderThan(cutoff: Date): Promise<number>;

  activeBoostPointsFor(userId: string, now: Date): Promise<number>;
  createBoost(boost: Omit<BoostEvent, 'id'>): Promise<BoostEvent>;
  listActiveBoosts(userId: string, now: Date): Promise<BoostEvent[]>;

  createChallenge(
    challenge: Omit<InfluenceChallenge, 'id'>,
  ): Promise<InfluenceChallenge>;
  listChallenges(userId: string): Promise<InfluenceChallenge[]>;
  updateChallenge(
    id: string,
    patch: Partial<InfluenceChallenge>,
  ): Promise<InfluenceChallenge>;

  listBroadcastQualityRatings(
    authorId: string,
    limit: number,
  ): Promise<BroadcastQualityRatingRecord[]>;
  upsertBroadcastQualityRating(
    rating: Omit<BroadcastQualityRatingRecord, 'id' | 'createdAt'>,
  ): Promise<BroadcastQualityRatingRecord>;

  listUpheldReports(userId: string): Promise<UserReportRecord[]>;
  listPendingReports(userId: string): Promise<UserReportRecord[]>;
  recordReport(
    report: Omit<UserReportRecord, 'id' | 'createdAt' | 'resolved' | 'upheld'>,
  ): Promise<UserReportRecord>;

  listCrossAppActivity(userId: string, windowDays: number): Promise<CrossAppActivityRecord[]>;
  recordCrossAppActivity(userId: string, appKey: string, at: Date): Promise<void>;

  listUsersWithScoreOlderThan(cutoff: Date, limit: number): Promise<string[]>;
  listAllActiveUserIds(limit: number): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * A deterministic, zero-dependency store used by tests and by any
 * runtime (dev CLI, single-binary) that does not have Postgres
 * available. Everything is held in process memory with Map-based
 * indexes.
 */
export class InMemoryInfluenceStore implements InfluenceStore {
  private readonly scores = new Map<string, InfluenceScore>();
  private readonly history: InfluenceScoreSnapshot[] = [];
  private readonly boosts = new Map<string, BoostEvent>();
  private readonly challenges = new Map<string, InfluenceChallenge>();
  private readonly ratings = new Map<string, BroadcastQualityRatingRecord>();
  private readonly reports = new Map<string, UserReportRecord>();
  private readonly crossApp = new Map<string, CrossAppActivityRecord>();
  private nextId = 1;

  private id(prefix: string): string {
    const value = this.nextId;
    this.nextId += 1;
    return `${prefix}-${value.toString(16).padStart(6, '0')}`;
  }

  async getScore(userId: string): Promise<InfluenceScore | null> {
    return this.scores.get(userId) ?? null;
  }

  async upsertScore(score: InfluenceScore): Promise<InfluenceScore> {
    this.scores.set(score.userId, score);
    return score;
  }

  async listScoresOrdered(limit: number, cursor: number | null): Promise<InfluenceScore[]> {
    const sorted = Array.from(this.scores.values()).sort((a, b) => b.total - a.total);
    const start = cursor === null ? 0 : Math.max(0, cursor);
    return sorted.slice(start, start + limit);
  }

  async countScores(): Promise<number> {
    return this.scores.size;
  }

  async listScoresNear(
    userId: string,
    spread: number,
    limit: number,
  ): Promise<InfluenceScore[]> {
    const target = this.scores.get(userId);
    if (!target) return [];
    return Array.from(this.scores.values())
      .filter((s) => Math.abs(s.total - target.total) <= spread)
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  async appendHistory(snapshot: InfluenceScoreSnapshot): Promise<void> {
    this.history.push(snapshot);
  }

  async listHistory(userId: string, days: number): Promise<InfluenceScoreSnapshot[]> {
    const cutoff = Date.now() - days * 86_400_000;
    return this.history
      .filter((h) => h.userId === userId && h.snapshotAt.getTime() >= cutoff)
      .sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime());
  }

  async pruneHistoryOlderThan(cutoff: Date): Promise<number> {
    const before = this.history.length;
    const cutoffMs = cutoff.getTime();
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i].snapshotAt.getTime() < cutoffMs) {
        this.history.splice(i, 1);
      }
    }
    return before - this.history.length;
  }

  async activeBoostPointsFor(userId: string, now: Date): Promise<number> {
    let total = 0;
    for (const b of this.boosts.values()) {
      if (
        b.userId === userId &&
        b.startsAt.getTime() <= now.getTime() &&
        b.expiresAt.getTime() > now.getTime() &&
        b.consumedAt === null
      ) {
        total += b.points;
      }
    }
    return total;
  }

  async createBoost(boost: Omit<BoostEvent, 'id'>): Promise<BoostEvent> {
    const full: BoostEvent = { id: this.id('boost'), ...boost };
    this.boosts.set(full.id, full);
    return full;
  }

  async listActiveBoosts(userId: string, now: Date): Promise<BoostEvent[]> {
    return Array.from(this.boosts.values()).filter(
      (b) =>
        b.userId === userId &&
        b.startsAt.getTime() <= now.getTime() &&
        b.expiresAt.getTime() > now.getTime() &&
        b.consumedAt === null,
    );
  }

  async createChallenge(
    challenge: Omit<InfluenceChallenge, 'id'>,
  ): Promise<InfluenceChallenge> {
    const full: InfluenceChallenge = { id: this.id('chal'), ...challenge };
    this.challenges.set(full.id, full);
    return full;
  }

  async listChallenges(userId: string): Promise<InfluenceChallenge[]> {
    return Array.from(this.challenges.values())
      .filter((c) => c.ownerId === userId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async updateChallenge(
    id: string,
    patch: Partial<InfluenceChallenge>,
  ): Promise<InfluenceChallenge> {
    const current = this.challenges.get(id);
    if (!current) throw new Error(`InMemoryInfluenceStore: unknown challenge ${id}`);
    const next: InfluenceChallenge = { ...current, ...patch, id: current.id };
    this.challenges.set(id, next);
    return next;
  }

  async listBroadcastQualityRatings(
    authorId: string,
    limit: number,
  ): Promise<BroadcastQualityRatingRecord[]> {
    return Array.from(this.ratings.values())
      .filter((r) => r.authorId === authorId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async upsertBroadcastQualityRating(
    rating: Omit<BroadcastQualityRatingRecord, 'id' | 'createdAt'>,
  ): Promise<BroadcastQualityRatingRecord> {
    const id = this.id('qr');
    const full: BroadcastQualityRatingRecord = {
      id,
      ...rating,
      createdAt: new Date(),
    };
    this.ratings.set(id, full);
    return full;
  }

  async listUpheldReports(userId: string): Promise<UserReportRecord[]> {
    return Array.from(this.reports.values()).filter(
      (r) => r.reportedId === userId && r.resolved && r.upheld,
    );
  }

  async listPendingReports(userId: string): Promise<UserReportRecord[]> {
    return Array.from(this.reports.values()).filter(
      (r) => r.reportedId === userId && !r.resolved,
    );
  }

  async recordReport(
    input: Omit<UserReportRecord, 'id' | 'createdAt' | 'resolved' | 'upheld'>,
  ): Promise<UserReportRecord> {
    const full: UserReportRecord = {
      id: this.id('rep'),
      ...input,
      resolved: false,
      upheld: false,
      createdAt: new Date(),
    };
    this.reports.set(full.id, full);
    return full;
  }

  async listCrossAppActivity(
    userId: string,
    windowDays: number,
  ): Promise<CrossAppActivityRecord[]> {
    const cutoff = Date.now() - windowDays * 86_400_000;
    return Array.from(this.crossApp.values()).filter(
      (r) => r.userId === userId && r.lastUsedAt.getTime() >= cutoff,
    );
  }

  async recordCrossAppActivity(
    userId: string,
    appKey: string,
    at: Date,
  ): Promise<void> {
    const key = `${userId}::${appKey}`;
    this.crossApp.set(key, { userId, appKey, lastUsedAt: at });
  }

  async listUsersWithScoreOlderThan(cutoff: Date, limit: number): Promise<string[]> {
    return Array.from(this.scores.values())
      .filter((s) => s.lastRecalculatedAt.getTime() < cutoff.getTime())
      .sort((a, b) => a.lastRecalculatedAt.getTime() - b.lastRecalculatedAt.getTime())
      .slice(0, limit)
      .map((s) => s.userId);
  }

  async listAllActiveUserIds(limit: number): Promise<string[]> {
    return Array.from(this.scores.keys()).slice(0, limit);
  }

  /** Introspection helper used by tests. */
  _snapshot(): {
    scores: InfluenceScore[];
    history: InfluenceScoreSnapshot[];
    boosts: BoostEvent[];
    challenges: InfluenceChallenge[];
    reports: UserReportRecord[];
  } {
    return {
      scores: Array.from(this.scores.values()),
      history: [...this.history],
      boosts: Array.from(this.boosts.values()),
      challenges: Array.from(this.challenges.values()),
      reports: Array.from(this.reports.values()),
    };
  }
}

/**
 * Log helper used across the influence layer so messages share a
 * consistent namespace.
 */
export function influenceLog(
  level: 'info' | 'warn' | 'error' | 'debug',
  payload: Record<string, unknown>,
  message: string,
): void {
  const merged = { component: 'InfluenceScore', ...payload };
  switch (level) {
    case 'info':
      logger.info(merged, message);
      break;
    case 'warn':
      logger.warn(merged, message);
      break;
    case 'error':
      logger.error(merged, message);
      break;
    default:
      logger.debug(merged, message);
  }
}
