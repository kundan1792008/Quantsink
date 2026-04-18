import {
  BoostEvent,
  DEFAULT_HISTORY_DAYS,
  INFLUENCE_COMPONENT_WEIGHTS,
  INFLUENCE_TIER_THRESHOLDS,
  InMemoryInfluenceStore,
  InfluenceChallenge,
  InfluenceChallengeKind,
  InfluenceScore,
  InfluenceScoreSnapshot,
  InfluenceSignalInputs,
  InfluenceStore,
  InfluenceTier,
  MAX_HISTORY_DAYS,
  UserReportRecord,
  clamp,
  computeComponents,
  computeScoreFromInputs,
  influenceLog,
  tierDescriptor,
  tierForTotal,
  weightedTotal,
} from './InfluenceScoreDomain';

import QualityRatingAI from './QualityRatingAI';

/**
 * InfluenceScoreService
 * ---------------------
 * High-level orchestrator for the Influence Score system (issue #16).
 *
 *   • Calculates the public 0–1000 score from the six weighted
 *     sub-components: Broadcast Quality, Engagement Rate, Consistency,
 *     Biometric Verification Level, Cross-App Activity, Community
 *     Standing.
 *   • Appends a historical snapshot on every recalculation so the
 *     leaderboard UI can render the 30-day line chart required by the
 *     issue.
 *   • Prunes historical snapshots older than 90 days on every write.
 *   • Starts, progresses and completes "Boost" challenges.
 *   • Exposes leaderboard + "nearby" queries that the HTTP routes and
 *     the React leaderboard component consume.
 *
 * The service is deliberately I/O-light: all persistence goes through
 * the injected `InfluenceStore`, all time-sensitive calls go through
 * the injected `now()` clock, and it pulls the latest broadcast
 * quality numbers from an injected `QualityRatingAI`. That makes the
 * service deterministic under test.
 */

// ---------------------------------------------------------------------------
// Signal provider + options
// ---------------------------------------------------------------------------

/**
 * Live signals the service cannot reasonably persist itself: the
 * biometric verification level returned by Quantmail, the raw view
 * counts captured by the broadcast WebSocket, the user's posting
 * streak, etc. Implementations read these from the rest of the
 * Quantsink runtime.
 */
export interface InfluenceSignalProvider {
  /** 0–100 biometric verification level currently associated with user. */
  biometricLevel(userId: string): Promise<number>;
  /** Impressions the user's broadcasts have received in the last 30d. */
  impressionsLast30d(userId: string): Promise<number>;
  /** Views the user's broadcasts have received in the last 30d. */
  viewsLast30d(userId: string): Promise<number>;
  /** Number of consecutive days with at least one broadcast. */
  currentPostStreakDays(userId: string): Promise<number>;
  /** Number of broadcasts the user has authored in the last 30d. */
  postsLast30d(userId: string): Promise<number>;
  /** Quant ecosystem apps the user has touched in the last 30d. */
  uniqueQuantAppsLast30d(userId: string): Promise<number>;
}

export interface InfluenceScoreServiceOptions {
  readonly store?: InfluenceStore;
  readonly quality?: QualityRatingAI;
  readonly signals?: InfluenceSignalProvider;
  readonly now?: () => Date;
  /** Recalculation cadence in milliseconds. Default 6h. */
  readonly recalcIntervalMs?: number;
  /** Max rolling window for storing historical snapshots. Default 90 days. */
  readonly historyWindowDays?: number;
  /** Max rows returned from listUsersWithScoreOlderThan per recalculation tick. */
  readonly recalcBatchSize?: number;
  /** Maximum leaderboard page size. */
  readonly maxLeaderboardPage?: number;
  /** Score window used by the "nearby" tab. */
  readonly nearbySpread?: number;
  /** How many of the user's most recent ratings contribute to the average. */
  readonly qualitySampleSize?: number;
}

/**
 * Default signal provider used when callers instantiate the service
 * without wiring custom data sources. Returns safe zeros so the score
 * never blows up in dev.
 */
export class NullSignalProvider implements InfluenceSignalProvider {
  async biometricLevel(): Promise<number> { return 0; }
  async impressionsLast30d(): Promise<number> { return 0; }
  async viewsLast30d(): Promise<number> { return 0; }
  async currentPostStreakDays(): Promise<number> { return 0; }
  async postsLast30d(): Promise<number> { return 0; }
  async uniqueQuantAppsLast30d(): Promise<number> { return 0; }
}

// ---------------------------------------------------------------------------
// Challenge templates
// ---------------------------------------------------------------------------

export interface ChallengeTemplate {
  readonly kind: InfluenceChallengeKind;
  readonly target: number;
  readonly rewardPoints: number;
  readonly durationHours: number;
  readonly description: string;
}

export const DEFAULT_CHALLENGE_TEMPLATES: Readonly<Record<InfluenceChallengeKind, ChallengeTemplate>> =
  Object.freeze({
    POST_STREAK: {
      kind: 'POST_STREAK',
      target: 7,
      rewardPoints: 50,
      durationHours: 24 * 7,
      description: 'Broadcast once a day for 7 days in a row.',
    },
    BIOMETRIC_WEEK: {
      kind: 'BIOMETRIC_WEEK',
      target: 5,
      rewardPoints: 50,
      durationHours: 24 * 7,
      description: 'Complete a biometric verification five days this week.',
    },
    CROSS_APP_EXPLORER: {
      kind: 'CROSS_APP_EXPLORER',
      target: 5,
      rewardPoints: 50,
      durationHours: 24 * 14,
      description: 'Use five different Quant apps within two weeks.',
    },
    QUALITY_AUTHOR: {
      kind: 'QUALITY_AUTHOR',
      target: 3,
      rewardPoints: 50,
      durationHours: 24 * 7,
      description: 'Publish three broadcasts with a quality score ≥ 80.',
    },
    COMMUNITY_UPLIFT: {
      kind: 'COMMUNITY_UPLIFT',
      target: 10,
      rewardPoints: 50,
      durationHours: 24 * 14,
      description: 'Help 10 neighbours across the network in two weeks.',
    },
  });

// ---------------------------------------------------------------------------
// Public breakdown shape (returned by the API)
// ---------------------------------------------------------------------------

export interface InfluenceBreakdown {
  readonly userId: string;
  readonly total: number;
  readonly tier: InfluenceTier;
  readonly tierMin: number;
  readonly tierMax: number;
  readonly tierAccentColor: string;
  readonly tierLabel: string;
  readonly components: InfluenceScoreSnapshot['components'];
  readonly weights: typeof INFLUENCE_COMPONENT_WEIGHTS;
  readonly activeBoostPoints: number;
  readonly activeBoosts: readonly BoostEvent[];
  readonly lastRecalculatedAt: Date;
}

export interface LeaderboardRow {
  readonly userId: string;
  readonly rank: number;
  readonly total: number;
  readonly tier: InfluenceTier;
  readonly tierLabel: string;
  readonly tierAccentColor: string;
}

export interface LeaderboardPage {
  readonly rows: readonly LeaderboardRow[];
  readonly total: number;
  readonly nextCursor: number | null;
}

// ---------------------------------------------------------------------------
// InfluenceScoreService
// ---------------------------------------------------------------------------

export class InfluenceScoreService {
  private readonly store: InfluenceStore;
  private readonly quality: QualityRatingAI;
  private readonly signals: InfluenceSignalProvider;
  private readonly now: () => Date;
  private readonly recalcIntervalMs: number;
  private readonly historyWindowDays: number;
  private readonly recalcBatchSize: number;
  private readonly maxLeaderboardPage: number;
  private readonly nearbySpread: number;
  private readonly qualitySampleSize: number;
  private recalcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: InfluenceScoreServiceOptions = {}) {
    this.store = options.store ?? new InMemoryInfluenceStore();
    this.quality = options.quality ?? new QualityRatingAI({ store: this.store });
    this.signals = options.signals ?? new NullSignalProvider();
    this.now = options.now ?? (() => new Date());
    this.recalcIntervalMs = options.recalcIntervalMs ?? 6 * 60 * 60 * 1000;
    this.historyWindowDays = clamp(
      options.historyWindowDays ?? MAX_HISTORY_DAYS,
      1,
      MAX_HISTORY_DAYS,
    );
    this.recalcBatchSize = options.recalcBatchSize ?? 200;
    this.maxLeaderboardPage = options.maxLeaderboardPage ?? 100;
    this.nearbySpread = options.nearbySpread ?? 50;
    this.qualitySampleSize = options.qualitySampleSize ?? 20;
  }

  // -------------------------------------------------------------------------
  // Score computation
  // -------------------------------------------------------------------------

  /**
   * Gather live signals + persisted signals, run them through the
   * pure math in `InfluenceScoreDomain`, persist the result + a
   * historical snapshot, and return the fresh score.
   */
  async recalculate(userId: string): Promise<InfluenceScore> {
    this.assertUserId(userId);
    const now = this.now();

    const [
      averageBroadcastQuality,
      impressions,
      views,
      postStreakDays,
      postsLast30d,
      biometricLevel,
      uniqueQuantAppsUsed,
      upheldReports,
      pendingReports,
      boostPoints,
    ] = await Promise.all([
      this.quality.averageQualityForAuthor(userId, this.qualitySampleSize),
      this.signals.impressionsLast30d(userId),
      this.signals.viewsLast30d(userId),
      this.signals.currentPostStreakDays(userId),
      this.signals.postsLast30d(userId),
      this.signals.biometricLevel(userId),
      this.signals.uniqueQuantAppsLast30d(userId),
      this.store.listUpheldReports(userId).then((r) => r.length),
      this.store.listPendingReports(userId).then((r) => r.length),
      this.store.activeBoostPointsFor(userId, now),
    ]);

    const inputs: InfluenceSignalInputs = {
      userId,
      averageBroadcastQuality,
      impressions,
      views,
      postStreakDays,
      postsLast30d,
      biometricLevel,
      uniqueQuantAppsUsed,
      upheldReports,
      pendingReports,
      activeBoostPoints: boostPoints,
    };

    const { components, total, tier } = computeScoreFromInputs(inputs);
    const score: InfluenceScore = {
      userId,
      total,
      components,
      tier,
      lastRecalculatedAt: now,
      boostPoints,
    };

    await this.store.upsertScore(score);
    await this.store.appendHistory({
      userId,
      total,
      components,
      tier,
      snapshotAt: now,
    });
    await this.pruneHistory(now);

    await this.evaluateChallengeProgress(userId, score, inputs);

    influenceLog(
      'info',
      { userId, total, tier, boostPoints },
      'Influence score recalculated',
    );

    return score;
  }

  /**
   * Variant for callers that already have complete signal inputs (e.g.
   * the cron worker that batched them). Skips the per-user signal
   * fetch but still persists + keeps history in sync.
   */
  async recalculateFromInputs(inputs: InfluenceSignalInputs): Promise<InfluenceScore> {
    this.assertUserId(inputs.userId);
    const now = this.now();
    const boostPoints =
      inputs.activeBoostPoints ?? (await this.store.activeBoostPointsFor(inputs.userId, now));
    const components = computeComponents(inputs);
    const total = weightedTotal(components, boostPoints);
    const tier = tierForTotal(total);
    const score: InfluenceScore = {
      userId: inputs.userId,
      total,
      components,
      tier,
      lastRecalculatedAt: now,
      boostPoints,
    };
    await this.store.upsertScore(score);
    await this.store.appendHistory({
      userId: inputs.userId,
      total,
      components,
      tier,
      snapshotAt: now,
    });
    await this.pruneHistory(now);
    return score;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getBreakdown(userId: string): Promise<InfluenceBreakdown> {
    this.assertUserId(userId);
    const now = this.now();
    let score = await this.store.getScore(userId);
    if (!score) {
      score = await this.recalculate(userId);
    }
    const activeBoosts = await this.store.listActiveBoosts(userId, now);
    const descriptor = tierDescriptor(score.tier);
    return {
      userId,
      total: score.total,
      tier: score.tier,
      tierMin: descriptor.min,
      tierMax: descriptor.max,
      tierAccentColor: descriptor.accentColor,
      tierLabel: descriptor.label,
      components: score.components,
      weights: INFLUENCE_COMPONENT_WEIGHTS,
      activeBoostPoints: score.boostPoints,
      activeBoosts,
      lastRecalculatedAt: score.lastRecalculatedAt,
    };
  }

  async getHistory(
    userId: string,
    days: number = DEFAULT_HISTORY_DAYS,
  ): Promise<readonly InfluenceScoreSnapshot[]> {
    this.assertUserId(userId);
    const window = clamp(days, 1, this.historyWindowDays);
    return this.store.listHistory(userId, window);
  }

  async getLeaderboard(
    page: number,
    pageSize: number = 20,
  ): Promise<LeaderboardPage> {
    if (!Number.isInteger(page) || page < 0) {
      throw new Error('getLeaderboard: page must be a non-negative integer.');
    }
    const clampedSize = clamp(pageSize, 1, this.maxLeaderboardPage);
    const total = await this.store.countScores();
    const cursor = page * clampedSize;
    const scores = await this.store.listScoresOrdered(clampedSize, cursor);
    const rows: LeaderboardRow[] = scores.map((s, i) => {
      const d = tierDescriptor(s.tier);
      return {
        userId: s.userId,
        rank: cursor + i + 1,
        total: s.total,
        tier: s.tier,
        tierLabel: d.label,
        tierAccentColor: d.accentColor,
      };
    });
    const nextCursor = cursor + scores.length < total ? page + 1 : null;
    return { rows, total, nextCursor };
  }

  async getNearby(userId: string, limit: number = 20): Promise<readonly LeaderboardRow[]> {
    this.assertUserId(userId);
    const rows = await this.store.listScoresNear(
      userId,
      this.nearbySpread,
      clamp(limit, 1, this.maxLeaderboardPage),
    );
    return rows.map((s, i) => {
      const d = tierDescriptor(s.tier);
      return {
        userId: s.userId,
        rank: i + 1,
        total: s.total,
        tier: s.tier,
        tierLabel: d.label,
        tierAccentColor: d.accentColor,
      };
    });
  }

  async rankFor(userId: string): Promise<number | null> {
    this.assertUserId(userId);
    const target = await this.store.getScore(userId);
    if (!target) return null;
    // Linear walk keeps the default in-memory impl simple; a Postgres
    // adapter should override this with a window-function query.
    let cursor = 0;
    const pageSize = 200;
    for (;;) {
      const rows = await this.store.listScoresOrdered(pageSize, cursor);
      if (rows.length === 0) return null;
      const idx = rows.findIndex((r) => r.userId === userId);
      if (idx >= 0) return cursor + idx + 1;
      if (rows.length < pageSize) return null;
      cursor += pageSize;
    }
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  async fileReport(
    reporterId: string,
    reportedId: string,
    reason: string,
  ): Promise<UserReportRecord> {
    this.assertUserId(reporterId);
    this.assertUserId(reportedId);
    if (reporterId === reportedId) {
      throw new Error('InfluenceScoreService: users cannot report themselves.');
    }
    if (!reason || reason.length < 3) {
      throw new Error('InfluenceScoreService: report reason must be at least 3 characters.');
    }
    return this.store.recordReport({ reporterId, reportedId, reason });
  }

  // -------------------------------------------------------------------------
  // Boosts + challenges
  // -------------------------------------------------------------------------

  async startChallenge(
    userId: string,
    kind: InfluenceChallengeKind,
    template?: ChallengeTemplate,
  ): Promise<InfluenceChallenge> {
    this.assertUserId(userId);
    const tpl = template ?? DEFAULT_CHALLENGE_TEMPLATES[kind];
    if (!tpl) throw new Error(`Unknown challenge kind: ${kind}`);
    const existing = await this.store.listChallenges(userId);
    const alreadyActive = existing.find((c) => c.kind === kind && c.status === 'ACTIVE');
    if (alreadyActive) return alreadyActive;

    const now = this.now();
    const expiresAt = new Date(now.getTime() + tpl.durationHours * 3_600_000);
    return this.store.createChallenge({
      ownerId: userId,
      kind,
      status: 'ACTIVE',
      progress: 0,
      target: tpl.target,
      rewardPoints: tpl.rewardPoints,
      startedAt: now,
      expiresAt,
      completedAt: null,
    });
  }

  async listChallenges(userId: string): Promise<readonly InfluenceChallenge[]> {
    this.assertUserId(userId);
    return this.store.listChallenges(userId);
  }

  async progressChallenge(
    userId: string,
    kind: InfluenceChallengeKind,
    delta: number,
  ): Promise<InfluenceChallenge | null> {
    this.assertUserId(userId);
    if (!Number.isFinite(delta) || delta <= 0) return null;
    const now = this.now();
    const challenges = await this.store.listChallenges(userId);
    const active = challenges.find((c) => c.kind === kind && c.status === 'ACTIVE');
    if (!active) return null;
    if (active.expiresAt.getTime() < now.getTime()) {
      return this.store.updateChallenge(active.id, { status: 'EXPIRED' });
    }
    const nextProgress = Math.min(active.target, active.progress + delta);
    if (nextProgress >= active.target) {
      const completed = await this.store.updateChallenge(active.id, {
        progress: active.target,
        status: 'COMPLETED',
        completedAt: now,
      });
      await this.grantBoost(userId, `challenge:${kind}`, active.rewardPoints, 24);
      return completed;
    }
    return this.store.updateChallenge(active.id, { progress: nextProgress });
  }

  async cancelChallenge(challengeId: string): Promise<InfluenceChallenge> {
    return this.store.updateChallenge(challengeId, {
      status: 'CANCELLED',
    });
  }

  /**
   * Grant a boost event worth `points` which expires in `hours`.
   * The boost is automatically added to the next recalculation.
   */
  async grantBoost(
    userId: string,
    reason: string,
    points: number,
    hours: number,
  ): Promise<BoostEvent> {
    this.assertUserId(userId);
    if (!Number.isFinite(points) || points <= 0) {
      throw new Error('InfluenceScoreService.grantBoost: points must be positive.');
    }
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error('InfluenceScoreService.grantBoost: hours must be positive.');
    }
    const now = this.now();
    const boost = await this.store.createBoost({
      userId,
      reason,
      points: Math.round(points),
      startsAt: now,
      expiresAt: new Date(now.getTime() + hours * 3_600_000),
      consumedAt: null,
    });
    influenceLog(
      'info',
      { userId, reason, points: boost.points, expiresAt: boost.expiresAt },
      'Influence boost granted',
    );
    return boost;
  }

  // -------------------------------------------------------------------------
  // Background scheduling
  // -------------------------------------------------------------------------

  /**
   * Start a recurring recalculation timer. Safe to call more than once
   * — subsequent calls are no-ops until `stop()` is invoked.
   */
  start(): void {
    if (this.recalcTimer) return;
    this.recalcTimer = setInterval(() => {
      this.tick().catch((err) => {
        influenceLog(
          'error',
          { error: (err as Error).message },
          'InfluenceScoreService tick failed',
        );
      });
    }, this.recalcIntervalMs);
    if (typeof (this.recalcTimer as { unref?: () => void }).unref === 'function') {
      (this.recalcTimer as unknown as { unref: () => void }).unref();
    }
    influenceLog('info', { intervalMs: this.recalcIntervalMs }, 'InfluenceScoreService started');
  }

  stop(): void {
    if (this.recalcTimer) {
      clearInterval(this.recalcTimer);
      this.recalcTimer = null;
      influenceLog('info', {}, 'InfluenceScoreService stopped');
    }
  }

  /**
   * Run a single recalculation tick over the batch of stalest users.
   * Exposed for tests + the cron worker.
   */
  async tick(): Promise<{ recalculated: number }> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - this.recalcIntervalMs);
    const users = await this.store.listUsersWithScoreOlderThan(cutoff, this.recalcBatchSize);
    let count = 0;
    for (const userId of users) {
      try {
        await this.recalculate(userId);
        count += 1;
      } catch (err) {
        influenceLog(
          'error',
          { userId, error: (err as Error).message },
          'InfluenceScoreService failed to recalc user',
        );
      }
    }
    await this.pruneHistory(now);
    return { recalculated: count };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async pruneHistory(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - this.historyWindowDays * 86_400_000);
    const removed = await this.store.pruneHistoryOlderThan(cutoff);
    if (removed > 0) {
      influenceLog('debug', { removed, cutoff }, 'Influence history pruned');
    }
  }

  private async evaluateChallengeProgress(
    userId: string,
    score: InfluenceScore,
    inputs: InfluenceSignalInputs,
  ): Promise<void> {
    const now = this.now();
    const challenges = await this.store.listChallenges(userId);
    for (const challenge of challenges) {
      if (challenge.status !== 'ACTIVE') continue;
      if (challenge.expiresAt.getTime() < now.getTime()) {
        await this.store.updateChallenge(challenge.id, { status: 'EXPIRED' });
        continue;
      }
      const nextProgress = this.challengeProgressFromSignals(challenge, inputs, score);
      if (nextProgress <= challenge.progress) continue;
      if (nextProgress >= challenge.target) {
        await this.store.updateChallenge(challenge.id, {
          progress: challenge.target,
          status: 'COMPLETED',
          completedAt: now,
        });
        await this.grantBoost(userId, `challenge:${challenge.kind}`, challenge.rewardPoints, 24);
      } else {
        await this.store.updateChallenge(challenge.id, { progress: nextProgress });
      }
    }
  }

  private challengeProgressFromSignals(
    challenge: InfluenceChallenge,
    inputs: InfluenceSignalInputs,
    score: InfluenceScore,
  ): number {
    switch (challenge.kind) {
      case 'POST_STREAK':
        return Math.min(challenge.target, inputs.postStreakDays);
      case 'CROSS_APP_EXPLORER':
        return Math.min(challenge.target, inputs.uniqueQuantAppsUsed);
      case 'BIOMETRIC_WEEK':
        return Math.min(challenge.target, Math.round(inputs.biometricLevel / 20));
      case 'QUALITY_AUTHOR':
        return Math.min(
          challenge.target,
          Math.max(challenge.progress, score.components.broadcastQuality >= 80 ? challenge.progress + 1 : challenge.progress),
        );
      case 'COMMUNITY_UPLIFT':
        return Math.min(
          challenge.target,
          Math.max(challenge.progress, score.components.communityStanding >= 90 ? challenge.progress + 1 : challenge.progress),
        );
      default:
        return challenge.progress;
    }
  }

  private assertUserId(userId: string): void {
    if (!userId || typeof userId !== 'string') {
      throw new Error('InfluenceScoreService: userId is required.');
    }
  }
}

// ---------------------------------------------------------------------------
// Re-exports used by the HTTP route
// ---------------------------------------------------------------------------

export {
  INFLUENCE_COMPONENT_WEIGHTS,
  INFLUENCE_TIER_THRESHOLDS,
  tierDescriptor,
  tierForTotal,
};

export type {
  InfluenceChallenge,
  InfluenceChallengeKind,
  InfluenceScore,
  InfluenceScoreSnapshot,
  InfluenceSignalInputs,
  InfluenceStore,
  InfluenceTier,
};

export default InfluenceScoreService;
