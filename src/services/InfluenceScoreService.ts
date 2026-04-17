/**
 * InfluenceScoreService — Social Credit & Influence Score Engine
 *
 * Every user gets a public Influence Score (0-1000) calculated from behaviour
 * across all 9 Quant apps.  The score is a weighted composite of six
 * components:
 *
 *   Component              Weight  Source
 *   ─────────────────────────────────────────────────────────────────────
 *   Broadcast Quality      25 %   AI-rated (QualityRatingAI, 0-100)
 *   Engagement Rate        20 %   views/impressions ratio (0-100)
 *   Consistency            15 %   posting frequency score (0-100)
 *   Biometric Level        15 %   verification strength (0-100)
 *   Cross-App Activity     15 %   how many Quant apps used (0-100)
 *   Community Standing     10 %   reports against user reduce this (0-100)
 *
 * Final score = Σ(component × weight) × 10   → range 0-1000.
 * Scores are stored in the `InfluenceScore` table and a daily
 * snapshot is appended to `ScoreHistory` (retained for 90 days).
 *
 * A `recalculate` call is idempotent within a 6-hour window; callers
 * can therefore invoke it on every relevant user action without
 * over-working the database.
 */

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { QualityRatingAI } from './QualityRatingAI';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScoreComponents {
  broadcastQuality: number;   // 0-100
  engagementRate: number;     // 0-100
  consistency: number;        // 0-100
  biometricLevel: number;     // 0-100
  crossAppActivity: number;   // 0-100
  communityStanding: number;  // 0-100
}

export interface InfluenceScoreResult {
  userId: string;
  totalScore: number;         // 0-1000
  components: ScoreComponents;
  tier: InfluenceTier;
  rankPosition: number | null; // 1-based global rank; null if not yet ranked
  lastCalculatedAt: Date;
}

export type InfluenceTier =
  | 'BRONZE'
  | 'SILVER'
  | 'GOLD'
  | 'PLATINUM'
  | 'DIAMOND';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  totalScore: number;
  tier: InfluenceTier;
  /** Positive = moved up, negative = moved down, 0 = no change vs yesterday. */
  rankChange: number;
}

export interface LeaderboardPage {
  entries: LeaderboardEntry[];
  totalUsers: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export interface ScoreHistoryPoint {
  date: string;               // ISO date string (YYYY-MM-DD)
  score: number;
  components: ScoreComponents;
}

export interface ChallengeResult {
  challengeId: string;
  challengeType: string;
  boostPoints: number;
  expiresAt: Date;
  message: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const COMPONENT_WEIGHTS: Record<keyof ScoreComponents, number> = {
  broadcastQuality:  0.25,
  engagementRate:    0.20,
  consistency:       0.15,
  biometricLevel:    0.15,
  crossAppActivity:  0.15,
  communityStanding: 0.10,
};

/** Recalculation is skipped if the last run was within this many ms. */
const RECALC_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Snapshot history is retained for this many days. */
const HISTORY_RETENTION_DAYS = 90;

/** Challenge boost duration in ms (24 hours). */
const CHALLENGE_BOOST_MS = 24 * 60 * 60 * 1000;

/** Challenge types available for new challenges. */
const AVAILABLE_CHALLENGES = [
  'DAILY_POST',
  'ENGAGEMENT_SPIKE',
  'CROSS_APP_VISIT',
  'BIOMETRIC_REFRESH',
  'COMMUNITY_VOUCH',
] as const;

const qai = new QualityRatingAI();

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Map a 0-1000 total score to a named tier. */
export function tierForScore(score: number): InfluenceTier {
  if (score >= 801) return 'DIAMOND';
  if (score >= 601) return 'PLATINUM';
  if (score >= 401) return 'GOLD';
  if (score >= 201) return 'SILVER';
  return 'BRONZE';
}

/** UTC midnight for a given date — used to bucket daily snapshots. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Component calculators
// ---------------------------------------------------------------------------

/**
 * Broadcast Quality (0-100)
 * Average AI quality score across the user's last 20 broadcasts.
 */
async function calcBroadcastQuality(userId: string): Promise<number> {
  const broadcasts = await prisma.broadcast.findMany({
    where:   { authorId: userId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take:    20,
    select:  { content: true, biometricVerified: true },
  });

  if (broadcasts.length === 0) return 0;

  const scores = broadcasts.map((b) =>
    qai.rate(b.content, { biometricVerified: b.biometricVerified }).score,
  );
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  return clamp(Math.round(avg), 0, 100);
}

/**
 * Engagement Rate (0-100)
 * Uses DeepPost view/like counts as a proxy for impressions.
 * 0 views = 0; reaching a combined engagement rate of 20% = 100.
 */
async function calcEngagementRate(userId: string): Promise<number> {
  const posts = await prisma.deepPost.findMany({
    where:  { authorId: userId, isDeleted: false, isPublished: true },
    select: { views: true, likes: true },
    take:   20,
    orderBy: { publishedAt: 'desc' },
  });

  if (posts.length === 0) {
    // Fall back to short posts
    const shortPosts = await prisma.shortPost.findMany({
      where:  { authorId: userId, isDeleted: false },
      select: { likes: true, reposts: true },
      take:   20,
      orderBy: { createdAt: 'desc' },
    });
    if (shortPosts.length === 0) return 0;
    const totalEngagement = shortPosts.reduce((s, p) => s + p.likes + p.reposts, 0);
    // Assume 50 impressions per short post
    const totalImpressions = shortPosts.length * 50;
    const rate = totalEngagement / totalImpressions;
    return clamp(Math.round(rate * 500), 0, 100); // 20% rate = 100 pts
  }

  const totalViews = posts.reduce((s, p) => s + p.views, 0);
  const totalLikes = posts.reduce((s, p) => s + p.likes, 0);
  if (totalViews === 0) return 0;
  const rate = totalLikes / totalViews;
  return clamp(Math.round(rate * 500), 0, 100);
}

/**
 * Consistency (0-100)
 * Based on posting frequency over the last 30 days.
 * Posting every day = 100; once a week = ~50; less = scaled down.
 */
async function calcConsistency(userId: string): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [broadcastCount, shortPostCount, deepPostCount] = await Promise.all([
    prisma.broadcast.count({
      where: { authorId: userId, deletedAt: null, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.shortPost.count({
      where: { authorId: userId, isDeleted: false, createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.deepPost.count({
      where: { authorId: userId, isDeleted: false, createdAt: { gte: thirtyDaysAgo } },
    }),
  ]);

  const total = broadcastCount + shortPostCount + deepPostCount;
  // 30 posts in 30 days = 100 (once a day); scale linearly.
  return clamp(Math.round((total / 30) * 100), 0, 100);
}

/**
 * Biometric Level (0-100)
 * If isVerified = true → 100; otherwise 0.
 * Can be extended to a multi-tier scheme (basic / advanced / retina, etc.).
 */
async function calcBiometricLevel(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { isVerified: true },
  });
  if (!user) return 0;
  return user.isVerified ? 100 : 30; // 30 baseline for unverified (registered users)
}

/**
 * Cross-App Activity (0-100)
 * Proxy based on content diversity: broadcasts + short posts + deep posts +
 * connections + DMs, each representing a distinct interaction surface.
 * 5 or more distinct active surfaces = 100.
 */
async function calcCrossAppActivity(userId: string): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [hasBroadcast, hasShortPost, hasDeepPost, hasConnection, hasDM] = await Promise.all([
    prisma.broadcast.count({
      where: { authorId: userId, deletedAt: null, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.shortPost.count({
      where: { authorId: userId, isDeleted: false, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.deepPost.count({
      where: { authorId: userId, isDeleted: false, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.connection.count({
      where: { fromUserId: userId, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.directMessage.count({
      where: { senderId: userId, createdAt: { gte: sevenDaysAgo } },
    }),
  ]);

  const activeSurfaces = [hasBroadcast, hasShortPost, hasDeepPost, hasConnection, hasDM].filter(
    (n) => n > 0,
  ).length;

  return clamp(activeSurfaces * 20, 0, 100);
}

/**
 * Community Standing (0-100)
 * Starts at 100 and decays based on reports/blocks against the user.
 * Each incoming block/report = -10 pts (floored at 0).
 */
async function calcCommunityStanding(userId: string): Promise<number> {
  const reportCount = await prisma.connection.count({
    where: { toUserId: userId, status: 'BLOCKED' },
  });
  return clamp(100 - reportCount * 10, 0, 100);
}

// ---------------------------------------------------------------------------
// Core composite scorer
// ---------------------------------------------------------------------------

async function computeComponents(userId: string): Promise<ScoreComponents> {
  const [
    broadcastQuality,
    engagementRate,
    consistency,
    biometricLevel,
    crossAppActivity,
    communityStanding,
  ] = await Promise.all([
    calcBroadcastQuality(userId),
    calcEngagementRate(userId),
    calcConsistency(userId),
    calcBiometricLevel(userId),
    calcCrossAppActivity(userId),
    calcCommunityStanding(userId),
  ]);

  return {
    broadcastQuality,
    engagementRate,
    consistency,
    biometricLevel,
    crossAppActivity,
    communityStanding,
  };
}

function compositeScore(components: ScoreComponents): number {
  const raw = (Object.keys(COMPONENT_WEIGHTS) as (keyof ScoreComponents)[]).reduce(
    (sum, key) => sum + components[key] * COMPONENT_WEIGHTS[key],
    0,
  );
  // raw is 0-100; multiply by 10 to get 0-1000
  return clamp(Math.round(raw * 10), 0, 1000);
}

// ---------------------------------------------------------------------------
// InfluenceScoreService
// ---------------------------------------------------------------------------

export class InfluenceScoreService {
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Recalculate the influence score for a single user.
   *
   * Skips recalculation if the last run was within the 6-hour cooldown
   * (unless `force = true`).  After calculating, writes the result to
   * `InfluenceScore` and appends a `ScoreHistory` row for today.
   */
  async recalculate(userId: string, force = false): Promise<InfluenceScoreResult> {
    const existing = await prisma.influenceScore.findUnique({ where: { userId } });

    if (!force && existing) {
      const age = this.now().getTime() - existing.lastCalculatedAt.getTime();
      if (age < RECALC_COOLDOWN_MS) {
        logger.debug({ userId, ageMs: age }, 'InfluenceScoreService: skipping recalc (cooldown)');
        return this.toResult(existing, userId);
      }
    }

    const components = await computeComponents(userId);
    const totalScore = compositeScore(components);

    const record = await prisma.influenceScore.upsert({
      where:  { userId },
      update: {
        totalScore,
        ...components,
        lastCalculatedAt: this.now(),
        updatedAt: this.now(),
      },
      create: {
        userId,
        totalScore,
        ...components,
        lastCalculatedAt: this.now(),
        lastActivityAt:   this.now(),
      },
    });

    // Persist daily snapshot
    await this.persistSnapshot(record.id, totalScore, components);

    logger.info({ userId, totalScore, tier: tierForScore(totalScore) }, 'InfluenceScore updated');

    return this.toResult(record, userId);
  }

  /**
   * Return the current score for a user (without triggering a recalculation).
   * If no record exists, one is created with zero scores.
   */
  async getScore(userId: string): Promise<InfluenceScoreResult> {
    let record = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!record) {
      record = await prisma.influenceScore.create({
        data: {
          userId,
          totalScore:       0,
          broadcastQuality: 0,
          engagementRate:   0,
          consistency:      0,
          biometricLevel:   0,
          crossAppActivity: 0,
          communityStanding:0,
          lastCalculatedAt: this.now(),
          lastActivityAt:   this.now(),
        },
      });
    }
    return this.toResult(record, userId);
  }

  /**
   * Return a paginated leaderboard sorted by totalScore descending.
   *
   * @param page     1-based page number.
   * @param pageSize Results per page (max 100).
   * @param myUserId Optional: the requesting user's ID, used for rank change.
   */
  async getLeaderboard(
    page: number,
    pageSize: number,
    _myUserId?: string,
  ): Promise<LeaderboardPage> {
    const take   = Math.min(pageSize, 100);
    const skip   = (page - 1) * take;

    const [total, rows] = await Promise.all([
      prisma.influenceScore.count(),
      prisma.influenceScore.findMany({
        skip,
        take: take + 1,
        orderBy: { totalScore: 'desc' },
        include: {
          user: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      }),
    ]);

    const hasNextPage = rows.length > take;
    const items       = hasNextPage ? rows.slice(0, take) : rows;

    // Compute rank changes by comparing today's score vs yesterday's snapshot
    const userIds = items.map((r) => r.userId);
    const yesterday = utcMidnight(new Date(this.now().getTime() - 24 * 60 * 60 * 1000));

    const yesterdaySnapshots = await prisma.scoreHistory.findMany({
      where: {
        influenceScore: { userId: { in: userIds } },
        snapshotDate: yesterday,
      },
      select: { score: true, influenceScore: { select: { userId: true } } },
    });

    const yesterdayMap = new Map<string, number>(
      yesterdaySnapshots.map((s) => [s.influenceScore.userId, s.score]),
    );

    // Build rank-sorted list of userIds for yesterday to determine rank change
    const allScoresYesterday = await prisma.scoreHistory.groupBy({
      by: ['influenceScoreId'],
      where: { snapshotDate: yesterday },
      _max: { score: true },
    });

    const yesterdayRankList = [...allScoresYesterday]
      .sort((a, b) => (b._max.score ?? 0) - (a._max.score ?? 0))
      .map((r) => r.influenceScoreId);

    const influenceIdToUserId = new Map(items.map((r) => [r.id, r.userId]));

    const rankChangeForUser = (userId: string, currentRank: number): number => {
      const influenceId = items.find((r) => r.userId === userId)?.id;
      if (!influenceId) return 0;
      const yesterdayRank = yesterdayRankList.indexOf(influenceId) + 1;
      if (yesterdayRank === 0) return 0;
      return yesterdayRank - currentRank; // positive = improved rank
    };

    // Suppress unused variable warning
    void influenceIdToUserId;
    void yesterdayMap;

    const entries: LeaderboardEntry[] = items.map((row, idx) => {
      const currentRank = skip + idx + 1;
      return {
        rank:         currentRank,
        userId:       row.userId,
        displayName:  row.user.displayName,
        avatarUrl:    row.user.avatarUrl,
        totalScore:   Math.round(row.totalScore),
        tier:         tierForScore(row.totalScore),
        rankChange:   rankChangeForUser(row.userId, currentRank),
      };
    });

    return { entries, totalUsers: total, page, pageSize: take, hasNextPage };
  }

  /**
   * Return the "Nearby" leaderboard — users within ±50 of the given user's score.
   */
  async getNearbyLeaderboard(userId: string): Promise<LeaderboardEntry[]> {
    const me = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!me) return [];

    const lo = Math.max(0, me.totalScore - 50);
    const hi = Math.min(1000, me.totalScore + 50);

    const rows = await prisma.influenceScore.findMany({
      where:   { totalScore: { gte: lo, lte: hi } },
      orderBy: { totalScore: 'desc' },
      take:    50,
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });

    return rows.map((row, idx) => ({
      rank:        idx + 1,
      userId:      row.userId,
      displayName: row.user.displayName,
      avatarUrl:   row.user.avatarUrl,
      totalScore:  Math.round(row.totalScore),
      tier:        tierForScore(row.totalScore),
      rankChange:  0, // simplified for nearby view
    }));
  }

  /**
   * Return the last N days of score history for a user.
   */
  async getHistory(userId: string, days = 30): Promise<ScoreHistoryPoint[]> {
    const record = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!record) return [];

    const since = utcMidnight(new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000));

    const rows = await prisma.scoreHistory.findMany({
      where:   { influenceScoreId: record.id, snapshotDate: { gte: since } },
      orderBy: { snapshotDate: 'asc' },
      select:  {
        snapshotDate: true,
        score:        true,
        broadcastQuality: true,
        engagementRate:   true,
        consistency:      true,
        biometricLevel:   true,
        crossAppActivity: true,
        communityStanding:true,
      },
    });

    return rows.map((r) => ({
      date:  isoDateStr(r.snapshotDate),
      score: Math.round(r.score),
      components: {
        broadcastQuality:  Math.round(r.broadcastQuality),
        engagementRate:    Math.round(r.engagementRate),
        consistency:       Math.round(r.consistency),
        biometricLevel:    Math.round(r.biometricLevel),
        crossAppActivity:  Math.round(r.crossAppActivity),
        communityStanding: Math.round(r.communityStanding),
      },
    }));
  }

  /**
   * Start a challenge for the user.  Returns the new challenge details.
   * A user may only have one ACTIVE challenge of each type at a time.
   */
  async startChallenge(
    userId: string,
    challengeType?: string,
  ): Promise<ChallengeResult> {
    let record = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!record) {
      record = await prisma.influenceScore.create({
        data: {
          userId,
          totalScore: 0,
          broadcastQuality: 0,
          engagementRate: 0,
          consistency: 0,
          biometricLevel: 0,
          crossAppActivity: 0,
          communityStanding: 0,
          lastCalculatedAt: this.now(),
          lastActivityAt: this.now(),
        },
      });
    }

    // Pick a challenge type
    const type = (
      AVAILABLE_CHALLENGES.includes(challengeType as typeof AVAILABLE_CHALLENGES[number])
        ? challengeType
        : AVAILABLE_CHALLENGES[Math.floor(Math.random() * AVAILABLE_CHALLENGES.length)]
    ) as typeof AVAILABLE_CHALLENGES[number];

    // Check for existing active challenge of this type
    const existing = await prisma.influenceChallenge.findFirst({
      where: {
        influenceScoreId: record.id,
        challengeType:    type,
        status:           'ACTIVE',
        expiresAt:        { gt: this.now() },
      },
    });

    if (existing) {
      return {
        challengeId:   existing.id,
        challengeType: existing.challengeType,
        boostPoints:   existing.boostPoints,
        expiresAt:     existing.expiresAt,
        message:       `Challenge "${type}" already active. Complete it to earn +${existing.boostPoints} boost points.`,
      };
    }

    const expiresAt = new Date(this.now().getTime() + CHALLENGE_BOOST_MS);

    const challenge = await prisma.influenceChallenge.create({
      data: {
        influenceScoreId: record.id,
        challengeType:    type,
        boostPoints:      50,
        expiresAt,
        status:           'ACTIVE',
      },
    });

    return {
      challengeId:   challenge.id,
      challengeType: challenge.challengeType,
      boostPoints:   challenge.boostPoints,
      expiresAt:     challenge.expiresAt,
      message:       `Challenge "${type}" started! Complete within 24 hours to earn +50 boost points.`,
    };
  }

  /**
   * Apply any completed challenges to the user's score.
   * Called internally after recalculate.
   */
  async applyActiveChallengeBoosts(userId: string): Promise<number> {
    const record = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!record) return 0;

    const activeChallenges = await prisma.influenceChallenge.findMany({
      where: {
        influenceScoreId: record.id,
        status:           'COMPLETED',
        expiresAt:        { gt: this.now() },
      },
    });

    const totalBoost = activeChallenges.reduce((s, c) => s + c.boostPoints, 0);
    if (totalBoost === 0) return 0;

    const boosted = clamp(record.totalScore + totalBoost, 0, 1000);
    await prisma.influenceScore.update({
      where: { id: record.id },
      data:  { totalScore: boosted },
    });

    return totalBoost;
  }

  /**
   * Expire challenges that have passed their expiry time.
   */
  async expireStaleChallenges(): Promise<number> {
    const result = await prisma.influenceChallenge.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: this.now() } },
      data:  { status: 'EXPIRED' },
    });
    return result.count;
  }

  /**
   * Prune score history older than 90 days.
   */
  async pruneOldHistory(): Promise<number> {
    const cutoff = utcMidnight(
      new Date(this.now().getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );
    const result = await prisma.scoreHistory.deleteMany({
      where: { snapshotDate: { lt: cutoff } },
    });
    return result.count;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async persistSnapshot(
    influenceScoreId: string,
    score: number,
    components: ScoreComponents,
  ): Promise<void> {
    const today = utcMidnight(this.now());
    await prisma.scoreHistory.upsert({
      where:  { influenceScoreId_snapshotDate: { influenceScoreId, snapshotDate: today } },
      update: { score, ...components },
      create: { influenceScoreId, score, snapshotDate: today, ...components },
    });
  }

  private async toResult(
    record: {
      userId: string;
      totalScore: number;
      broadcastQuality: number;
      engagementRate: number;
      consistency: number;
      biometricLevel: number;
      crossAppActivity: number;
      communityStanding: number;
      lastCalculatedAt: Date;
    },
    userId: string,
  ): Promise<InfluenceScoreResult> {
    const rankPosition = await this.getRankPosition(userId);
    return {
      userId,
      totalScore: Math.round(record.totalScore),
      components: {
        broadcastQuality:  Math.round(record.broadcastQuality),
        engagementRate:    Math.round(record.engagementRate),
        consistency:       Math.round(record.consistency),
        biometricLevel:    Math.round(record.biometricLevel),
        crossAppActivity:  Math.round(record.crossAppActivity),
        communityStanding: Math.round(record.communityStanding),
      },
      tier:             tierForScore(record.totalScore),
      rankPosition,
      lastCalculatedAt: record.lastCalculatedAt,
    };
  }

  private async getRankPosition(userId: string): Promise<number | null> {
    const me = await prisma.influenceScore.findUnique({
      where:  { userId },
      select: { totalScore: true },
    });
    if (!me) return null;
    const above = await prisma.influenceScore.count({
      where: { totalScore: { gt: me.totalScore } },
    });
    return above + 1;
  }
}

export default InfluenceScoreService;
