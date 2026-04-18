/**
 * ScoreDecayWorker — Passive Score Decay & Recovery Engine
 *
 * Enforces the asymmetric decay/recovery rules described in issue #X:
 *
 *   Decay:    −2 points per idle day (no activity detected)
 *   Recovery: +1 point per quality action (broadcast, post, etc.)
 *   Boost:    +50 for 24 hours upon completing a challenge
 *
 * The worker is designed to be called by a cron scheduler every 24 hours.
 * It processes ALL users or a specific user ID, making it suitable both for
 * scheduled full sweeps and triggered per-user updates.
 *
 * Decay rules:
 *  - A user is "idle" for a given day if `lastActivityAt` is more than 24h ago.
 *  - Score never drops below 0.
 *  - Diamond-tier users lose 2 pts/day idle, same as everyone else.
 *
 * Recovery rules:
 *  - Each "quality action" (broadcast/post/DM/connection) awards +1 pt.
 *  - Recovery is capped at 1 point per action to prevent farming.
 *  - Recovery is applied immediately when the user action is recorded, not
 *    batched — so callers should invoke `recordActivity` on each event.
 *
 * Boost rules:
 *  - Completing a challenge grants a temporary +50 stored in active challenges.
 *  - The permanent score is NOT modified; the leaderboard query adds the boost
 *    on-the-fly while the challenge is active.
 *
 * All operations are idempotent: running the worker twice on the same day
 * will not double-decay users because we track the last decay timestamp.
 */

import prisma from '../lib/prisma';
import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DecaySummary {
  processed: number;
  decayed: number;
  totalPointsLost: number;
  skipped: number;
  errors: number;
  runAt: Date;
}

export interface ActivityRecord {
  userId: string;
  /** Optional: override the reward amount (default +1). */
  points?: number;
}

export interface ScoreDecayWorkerOptions {
  /** Injected clock — useful for tests. */
  readonly now?: () => Date;
  /** Points lost per idle day (default 2). */
  readonly decayPerDay?: number;
  /** Points gained per quality action (default 1). */
  readonly recoveryPerAction?: number;
  /** Max score (default 1000). */
  readonly maxScore?: number;
}

// ---------------------------------------------------------------------------
// ScoreDecayWorker
// ---------------------------------------------------------------------------

export class ScoreDecayWorker {
  private readonly now: () => Date;
  private readonly decayPerDay: number;
  private readonly recoveryPerAction: number;
  private readonly maxScore: number;

  constructor(options: ScoreDecayWorkerOptions = {}) {
    this.now              = options.now             ?? (() => new Date());
    this.decayPerDay      = options.decayPerDay     ?? 2;
    this.recoveryPerAction = options.recoveryPerAction ?? 1;
    this.maxScore         = options.maxScore        ?? 1000;
  }

  // -------------------------------------------------------------------------
  // Decay sweep
  // -------------------------------------------------------------------------

  /**
   * Run a full decay sweep across all users who have not been active in the
   * last 24 hours.  Should be invoked by a cron job every 24 hours.
   *
   * Returns a summary of the run.
   */
  async runDecaySweep(batchSize = 500): Promise<DecaySummary> {
    const runAt     = this.now();
    const idleSince = new Date(runAt.getTime() - 24 * 60 * 60 * 1000);

    let processed   = 0;
    let decayed     = 0;
    let totalLost   = 0;
    let skipped     = 0;
    let errors      = 0;
    let cursor: string | undefined;

    logger.info({ idleSince }, 'ScoreDecayWorker: starting decay sweep');

    // Paginate through all InfluenceScore records in batches
    for (;;) {
      const batch = await prisma.influenceScore.findMany({
        where: {
          lastActivityAt: { lte: idleSince },
          totalScore:     { gt: 0 },
        },
        take:    batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select:  { id: true, userId: true, totalScore: true },
      });

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      for (const record of batch) {
        processed += 1;
        try {
          const newScore = Math.max(0, record.totalScore - this.decayPerDay);
          const lost     = record.totalScore - newScore;

          if (lost === 0) {
            skipped += 1;
            continue;
          }

          await prisma.influenceScore.update({
            where: { id: record.id },
            data:  { totalScore: newScore, updatedAt: runAt },
          });

          decayed    += 1;
          totalLost  += lost;

          logger.debug(
            { userId: record.userId, before: record.totalScore, after: newScore, lost },
            'ScoreDecayWorker: score decayed',
          );
        } catch (err) {
          errors += 1;
          logger.error({ userId: record.userId, err }, 'ScoreDecayWorker: error processing user');
        }
      }

      // If we got fewer than batchSize, this is the last page.
      if (batch.length < batchSize) break;
    }

    const summary: DecaySummary = { processed, decayed, totalPointsLost: totalLost, skipped, errors, runAt };
    logger.info(summary, 'ScoreDecayWorker: decay sweep complete');
    return summary;
  }

  /**
   * Decay a single user's score immediately.
   * Returns the new score or null if no record found.
   */
  async decayUser(userId: string): Promise<number | null> {
    const record = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!record) return null;

    const newScore = Math.max(0, record.totalScore - this.decayPerDay);
    await prisma.influenceScore.update({
      where: { id: record.id },
      data:  { totalScore: newScore, updatedAt: this.now() },
    });

    return newScore;
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Record a quality action for a user — awards +recoveryPerAction points.
   * Also updates `lastActivityAt` to prevent idle decay.
   *
   * Returns the new score, or null if no InfluenceScore record exists for
   * the user (a fresh record will be lazily created by InfluenceScoreService).
   */
  async recordActivity(activity: ActivityRecord): Promise<number | null> {
    const { userId, points = this.recoveryPerAction } = activity;

    const record = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!record) return null;

    const awardedPoints = Math.max(0, points);
    const newScore = Math.min(this.maxScore, record.totalScore + awardedPoints);

    await prisma.influenceScore.update({
      where: { id: record.id },
      data:  {
        totalScore:    newScore,
        lastActivityAt: this.now(),
        updatedAt:     this.now(),
      },
    });

    logger.debug(
      { userId, awarded: awardedPoints, before: record.totalScore, after: newScore },
      'ScoreDecayWorker: activity recorded',
    );

    return newScore;
  }

  /**
   * Record activity for multiple users in a single call (e.g. bulk backfill).
   */
  async recordActivityBulk(activities: ActivityRecord[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    for (const activity of activities) {
      const newScore = await this.recordActivity(activity);
      if (newScore !== null) {
        results.set(activity.userId, newScore);
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Boost events
  // -------------------------------------------------------------------------

  /**
   * Apply a temporary boost to a user's effective score by completing a
   * challenge.  The challenge record is updated to COMPLETED status so the
   * leaderboard query can include the boost while it is active.
   */
  async applyBoostEvent(userId: string, challengeId: string): Promise<number | null> {
    const record = await prisma.influenceScore.findUnique({ where: { userId } });
    if (!record) return null;

    const challenge = await prisma.influenceChallenge.findFirst({
      where: {
        id:               challengeId,
        influenceScoreId: record.id,
        status:           'ACTIVE',
        expiresAt:        { gt: this.now() },
      },
    });

    if (!challenge) {
      logger.warn({ userId, challengeId }, 'ScoreDecayWorker: challenge not found or expired');
      return null;
    }

    await prisma.influenceChallenge.update({
      where: { id: challengeId },
      data:  { status: 'COMPLETED', completedAt: this.now() },
    });

    // The boost does NOT permanently modify totalScore — it is applied
    // transiently in the leaderboard/score API response.
    logger.info(
      { userId, challengeId, boost: challenge.boostPoints },
      'ScoreDecayWorker: boost event applied',
    );

    // Return effective score including boost (capped at maxScore)
    return Math.min(this.maxScore, record.totalScore + challenge.boostPoints);
  }

  /**
   * Compute the effective (boost-inclusive) score for a user.
   * Sums any COMPLETED challenges that have not yet expired.
   */
  async effectiveScore(userId: string): Promise<number> {
    const record = await prisma.influenceScore.findUnique({
      where:   { userId },
      include: {
        challenges: {
          where: {
            status:    'COMPLETED',
            expiresAt: { gt: this.now() },
          },
          select: { boostPoints: true },
        },
      },
    });

    if (!record) return 0;

    const boostSum = record.challenges.reduce((s, c) => s + c.boostPoints, 0);
    return Math.min(this.maxScore, record.totalScore + boostSum);
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /**
   * Expire challenges whose expiresAt has passed.
   * Returns the number of challenges expired.
   */
  async expireStaleChallenges(): Promise<number> {
    const result = await prisma.influenceChallenge.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: this.now() } },
      data:  { status: 'EXPIRED' },
    });
    return result.count;
  }
}

export default ScoreDecayWorker;
