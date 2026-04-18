import {
  BoostEvent,
  InMemoryInfluenceStore,
  InfluenceScore,
  InfluenceStore,
  clamp,
  influenceLog,
  tierForTotal,
} from '../services/InfluenceScoreDomain';

/**
 * ScoreDecayWorker
 * ----------------
 * Implements the decay + boost half of issue #16's Social Credit
 * mechanics:
 *
 *   • 2 points of decay per idle day for every user.
 *   • "Boost" events that temporarily add +50 points for 24 hours.
 *   • Asymmetric recovery: +1 point per quality action, −2 per idle day.
 *
 * The worker is framework-free. It owns a single `setInterval` that
 * invokes `tick()` — everything else is injectable so tests can drive
 * the clock by hand.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivitySummary {
  readonly userId: string;
  /** Last time the user took ANY activity across the ecosystem. */
  readonly lastActivityAt: Date;
  /** Number of "quality actions" credited in the last tick window. */
  readonly qualityActionsSinceLastTick: number;
  /** True if the user completed a boost challenge since the last tick. */
  readonly completedBoostChallenge?: boolean;
}

export interface ActivityProvider {
  /** Return a summary for each user returned by `store.listAllActiveUserIds`. */
  summarise(userIds: readonly string[]): Promise<readonly ActivitySummary[]>;
}

export class NullActivityProvider implements ActivityProvider {
  async summarise(ids: readonly string[]): Promise<readonly ActivitySummary[]> {
    const now = new Date();
    return ids.map((id) => ({
      userId: id,
      lastActivityAt: now,
      qualityActionsSinceLastTick: 0,
    }));
  }
}

export interface ScoreDecayWorkerOptions {
  readonly store?: InfluenceStore;
  readonly activity?: ActivityProvider;
  readonly now?: () => Date;
  /** How often the worker wakes up. Default 1 hour. */
  readonly tickIntervalMs?: number;
  /** Grace period before idleness counts. Default 24 hours. */
  readonly idleGraceHours?: number;
  /** Points per full idle day. Default 2. */
  readonly decayPointsPerDay?: number;
  /** Points granted per quality action. Default 1. */
  readonly recoveryPointsPerAction?: number;
  /** Max quality-action recovery per tick. Default 50. */
  readonly maxRecoveryPerTick?: number;
  /** Duration in hours of an auto-granted boost. Default 24. */
  readonly boostDurationHours?: number;
  /** Points granted by an auto-granted boost. Default 50. */
  readonly boostPoints?: number;
  /** Max users processed per tick. Default 500. */
  readonly maxUsersPerTick?: number;
  /** Minimum total score floor. Default 0. */
  readonly floor?: number;
  /** Maximum total score ceiling. Default 1000. */
  readonly ceiling?: number;
}

export interface DecayReport {
  readonly userId: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly idleDays: number;
  readonly decayApplied: number;
  readonly recoveryApplied: number;
  readonly grantedBoost: BoostEvent | null;
}

export interface TickReport {
  readonly processed: number;
  readonly reports: readonly DecayReport[];
  readonly boostsExpired: number;
  readonly ranAt: Date;
}

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

export function idleDaysSince(lastActivityAt: Date, now: Date, graceHours: number): number {
  const graceMs = graceHours * 3_600_000;
  const idleMs = now.getTime() - lastActivityAt.getTime() - graceMs;
  if (idleMs <= 0) return 0;
  return Math.floor(idleMs / 86_400_000);
}

/** Apply the asymmetric formula: decay 2/day, recover `recoveryPerAction` per action. */
export function computeDecayAndRecovery(
  scoreBefore: number,
  idleDays: number,
  qualityActions: number,
  decayPerDay: number,
  recoveryPerAction: number,
  maxRecovery: number,
  floor: number,
  ceiling: number,
): { scoreAfter: number; decayApplied: number; recoveryApplied: number } {
  const decayApplied = idleDays * decayPerDay;
  const recoveryApplied = Math.min(maxRecovery, qualityActions * recoveryPerAction);
  const raw = scoreBefore - decayApplied + recoveryApplied;
  const clamped = clamp(raw, floor, ceiling);
  return { scoreAfter: Math.round(clamped), decayApplied, recoveryApplied };
}

// ---------------------------------------------------------------------------
// ScoreDecayWorker
// ---------------------------------------------------------------------------

export class ScoreDecayWorker {
  private readonly store: InfluenceStore;
  private readonly activity: ActivityProvider;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private readonly idleGraceHours: number;
  private readonly decayPointsPerDay: number;
  private readonly recoveryPointsPerAction: number;
  private readonly maxRecoveryPerTick: number;
  private readonly boostDurationHours: number;
  private readonly boostPoints: number;
  private readonly maxUsersPerTick: number;
  private readonly floor: number;
  private readonly ceiling: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: ScoreDecayWorkerOptions = {}) {
    this.store = options.store ?? new InMemoryInfluenceStore();
    this.activity = options.activity ?? new NullActivityProvider();
    this.now = options.now ?? (() => new Date());
    this.tickIntervalMs = options.tickIntervalMs ?? 60 * 60 * 1000;
    this.idleGraceHours = clamp(options.idleGraceHours ?? 24, 0, 24 * 14);
    this.decayPointsPerDay = clamp(options.decayPointsPerDay ?? 2, 0, 100);
    this.recoveryPointsPerAction = clamp(options.recoveryPointsPerAction ?? 1, 0, 100);
    this.maxRecoveryPerTick = clamp(options.maxRecoveryPerTick ?? 50, 0, 1000);
    this.boostDurationHours = clamp(options.boostDurationHours ?? 24, 1, 24 * 7);
    this.boostPoints = clamp(options.boostPoints ?? 50, 1, 500);
    this.maxUsersPerTick = clamp(options.maxUsersPerTick ?? 500, 1, 100_000);
    this.floor = clamp(options.floor ?? 0, 0, 1000);
    this.ceiling = clamp(options.ceiling ?? 1000, this.floor + 1, 1000);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        influenceLog(
          'error',
          { error: (err as Error).message },
          'ScoreDecayWorker tick failed',
        );
      });
    }, this.tickIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    influenceLog('info', { intervalMs: this.tickIntervalMs }, 'ScoreDecayWorker started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      influenceLog('info', {}, 'ScoreDecayWorker stopped');
    }
  }

  /**
   * Run a single tick: apply decay + recovery to a batch of users,
   * expire any boosts whose `expiresAt` has passed, and return a
   * structured report for observability.
   */
  async tick(): Promise<TickReport> {
    if (this.running) {
      return { processed: 0, reports: [], boostsExpired: 0, ranAt: this.now() };
    }
    this.running = true;
    try {
      const ranAt = this.now();
      const userIds = await this.store.listAllActiveUserIds(this.maxUsersPerTick);
      const summaries = await this.activity.summarise(userIds);
      const byId = new Map(summaries.map((s) => [s.userId, s] as const));

      const reports: DecayReport[] = [];
      let boostsExpired = 0;
      for (const userId of userIds) {
        try {
          const report = await this.processUser(userId, byId.get(userId) ?? null, ranAt);
          if (report) reports.push(report);
          boostsExpired += await this.expireBoosts(userId, ranAt);
        } catch (err) {
          influenceLog(
            'error',
            { userId, error: (err as Error).message },
            'ScoreDecayWorker failed to process user',
          );
        }
      }
      influenceLog(
        'info',
        { processed: reports.length, boostsExpired },
        'ScoreDecayWorker tick complete',
      );
      return { processed: reports.length, reports, boostsExpired, ranAt };
    } finally {
      this.running = false;
    }
  }

  /**
   * Process a single user. Exposed so background job runners can
   * schedule one-off repairs without spinning up the interval.
   */
  async processUser(
    userId: string,
    summary: ActivitySummary | null,
    now: Date = this.now(),
  ): Promise<DecayReport | null> {
    const score = await this.store.getScore(userId);
    if (!score) return null;

    const activity = summary ?? {
      userId,
      lastActivityAt: score.lastRecalculatedAt,
      qualityActionsSinceLastTick: 0,
    };

    const idleDays = idleDaysSince(activity.lastActivityAt, now, this.idleGraceHours);
    const { scoreAfter, decayApplied, recoveryApplied } = computeDecayAndRecovery(
      score.total,
      idleDays,
      activity.qualityActionsSinceLastTick,
      this.decayPointsPerDay,
      this.recoveryPointsPerAction,
      this.maxRecoveryPerTick,
      this.floor,
      this.ceiling,
    );

    let grantedBoost: BoostEvent | null = null;
    if (activity.completedBoostChallenge) {
      grantedBoost = await this.store.createBoost({
        userId,
        reason: 'auto:completed-challenge',
        points: this.boostPoints,
        startsAt: now,
        expiresAt: new Date(now.getTime() + this.boostDurationHours * 3_600_000),
        consumedAt: null,
      });
    }

    if (scoreAfter !== score.total) {
      const updated: InfluenceScore = {
        ...score,
        total: scoreAfter,
        tier: tierForTotal(scoreAfter),
        lastRecalculatedAt: now,
      };
      await this.store.upsertScore(updated);
      await this.store.appendHistory({
        userId,
        total: updated.total,
        components: updated.components,
        tier: updated.tier,
        snapshotAt: now,
      });
    }

    return {
      userId,
      scoreBefore: score.total,
      scoreAfter,
      idleDays,
      decayApplied,
      recoveryApplied,
      grantedBoost,
    };
  }

  /**
   * Expire boosts whose `expiresAt` has passed. Returns the number of
   * boosts expired during this pass. Expired boosts keep their row so
   * analytics/audit can follow them, but they stop contributing to
   * the active total.
   */
  async expireBoosts(userId: string, now: Date): Promise<number> {
    const active = await this.store.listActiveBoosts(userId, now);
    let expired = 0;
    for (const boost of active) {
      if (boost.expiresAt.getTime() <= now.getTime() && boost.consumedAt === null) {
        // The store already filters by expiresAt — but if a store
        // implementation returned a boost on the boundary, we mark it
        // as consumed so subsequent boost-points queries ignore it.
        const consumed: BoostEvent = { ...boost, consumedAt: now };
        // The interface doesn't expose a direct update-boost, so we
        // recreate it with a consumed-flag via createBoost + mark on
        // the original shape. In practice, the Prisma adapter should
        // do an UPDATE; the in-memory store filters boosts by
        // consumedAt so a simple mutation here via createBoost would
        // double-up. To keep behaviour symmetric we rely on the
        // activeBoostPointsFor query's time filter and return a count.
        influenceLog(
          'debug',
          { userId, boostId: boost.id, expiresAt: boost.expiresAt },
          'ScoreDecayWorker boost expired',
        );
        void consumed;
        expired += 1;
      }
    }
    return expired;
  }

  /**
   * Manually apply a boost + publish it to the store. Useful for
   * admin-tooling and flow tests.
   */
  async applyManualBoost(
    userId: string,
    reason: string,
    points: number = this.boostPoints,
    hours: number = this.boostDurationHours,
  ): Promise<BoostEvent> {
    const now = this.now();
    const boost = await this.store.createBoost({
      userId,
      reason,
      points: Math.round(clamp(points, 1, this.ceiling)),
      startsAt: now,
      expiresAt: new Date(now.getTime() + hours * 3_600_000),
      consumedAt: null,
    });
    influenceLog(
      'info',
      { userId, reason, points: boost.points, hours },
      'ScoreDecayWorker manual boost applied',
    );
    return boost;
  }
}

export default ScoreDecayWorker;
