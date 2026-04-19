import {
  ActivityProvider,
  ActivitySummary,
  ScoreDecayWorker,
  computeDecayAndRecovery,
  idleDaysSince,
} from '../workers/ScoreDecayWorker';
import {
  InMemoryInfluenceStore,
  InfluenceScore,
  tierForTotal,
} from '../services/InfluenceScoreDomain';

function mkScore(partial: Partial<InfluenceScore> & { userId: string; total: number }): InfluenceScore {
  return {
    components: {
      broadcastQuality: 50,
      engagementRate: 50,
      consistency: 50,
      biometricLevel: 50,
      crossAppActivity: 50,
      communityStanding: 50,
    },
    tier: tierForTotal(partial.total),
    lastRecalculatedAt: new Date('2026-04-10T00:00:00Z'),
    boostPoints: 0,
    ...partial,
  };
}

describe('ScoreDecayWorker — pure math', () => {
  it('idleDaysSince respects the grace period', () => {
    const now = new Date('2026-04-17T00:00:00Z');
    const recent = new Date(now.getTime() - 12 * 3_600_000); // 12h ago
    const week = new Date(now.getTime() - 8 * 86_400_000);
    expect(idleDaysSince(recent, now, 24)).toBe(0);
    expect(idleDaysSince(week, now, 24)).toBe(7);
  });

  it('computeDecayAndRecovery is asymmetric and clamps', () => {
    const res = computeDecayAndRecovery(500, 5, 3, 2, 1, 50, 0, 1000);
    expect(res.decayApplied).toBe(10);
    expect(res.recoveryApplied).toBe(3);
    expect(res.scoreAfter).toBe(493);

    const clamp = computeDecayAndRecovery(10, 20, 0, 2, 1, 50, 0, 1000);
    expect(clamp.scoreAfter).toBe(0);

    const ceiling = computeDecayAndRecovery(990, 0, 100, 2, 1, 50, 0, 1000);
    expect(ceiling.scoreAfter).toBe(1000);
    expect(ceiling.recoveryApplied).toBe(50);
  });
});

describe('ScoreDecayWorker — behaviour', () => {
  class FakeActivity implements ActivityProvider {
    constructor(private readonly summaries: Map<string, ActivitySummary>) {}
    async summarise(ids: readonly string[]): Promise<readonly ActivitySummary[]> {
      return ids
        .map((id) => this.summaries.get(id))
        .filter((s): s is ActivitySummary => s !== undefined);
    }
  }

  it('applies decay for idle users and records a new history row', async () => {
    const now = new Date('2026-04-17T00:00:00Z');
    const store = new InMemoryInfluenceStore();
    await store.upsertScore(
      mkScore({
        userId: 'u1',
        total: 500,
        lastRecalculatedAt: new Date(now.getTime() - 10 * 86_400_000),
      }),
    );
    const activity = new FakeActivity(
      new Map([
        [
          'u1',
          {
            userId: 'u1',
            lastActivityAt: new Date(now.getTime() - 10 * 86_400_000),
            qualityActionsSinceLastTick: 0,
          },
        ],
      ]),
    );
    const worker = new ScoreDecayWorker({
      store,
      activity,
      now: () => now,
      idleGraceHours: 24,
    });

    const report = await worker.tick();
    expect(report.processed).toBe(1);
    const r = report.reports[0];
    expect(r.idleDays).toBeGreaterThanOrEqual(9);
    expect(r.scoreAfter).toBeLessThan(r.scoreBefore);
    const fetched = await store.getScore('u1');
    expect(fetched?.total).toBe(r.scoreAfter);
    const hist = await store.listHistory('u1', 30);
    expect(hist).toHaveLength(1);
  });

  it('recovers slower than it decays', async () => {
    const now = new Date('2026-04-17T00:00:00Z');
    const store = new InMemoryInfluenceStore();
    await store.upsertScore(mkScore({ userId: 'u1', total: 500 }));
    const activity = new FakeActivity(
      new Map([
        [
          'u1',
          {
            userId: 'u1',
            lastActivityAt: new Date(now.getTime() - 5 * 86_400_000),
            qualityActionsSinceLastTick: 5, // +5 points
          },
        ],
      ]),
    );
    const worker = new ScoreDecayWorker({ store, activity, now: () => now, idleGraceHours: 0 });
    const report = await worker.tick();
    const r = report.reports[0];
    // 5 days * 2 decay = 10 points lost, 5 actions * 1 = 5 gained → net -5
    expect(r.scoreAfter).toBe(495);
  });

  it('auto-grants a boost when user completed a challenge', async () => {
    const now = new Date('2026-04-17T00:00:00Z');
    const store = new InMemoryInfluenceStore();
    await store.upsertScore(mkScore({ userId: 'u1', total: 400, lastRecalculatedAt: now }));
    const activity = new FakeActivity(
      new Map([
        [
          'u1',
          {
            userId: 'u1',
            lastActivityAt: now,
            qualityActionsSinceLastTick: 0,
            completedBoostChallenge: true,
          },
        ],
      ]),
    );
    const worker = new ScoreDecayWorker({ store, activity, now: () => now, boostPoints: 50 });
    const report = await worker.tick();
    expect(report.reports[0].grantedBoost).not.toBeNull();
    const points = await store.activeBoostPointsFor('u1', now);
    expect(points).toBe(50);
  });

  it('applyManualBoost persists a boost with the given duration', async () => {
    const store = new InMemoryInfluenceStore();
    const now = new Date('2026-04-17T00:00:00Z');
    const worker = new ScoreDecayWorker({ store, now: () => now });
    const boost = await worker.applyManualBoost('u1', 'admin', 75, 12);
    expect(boost.points).toBe(75);
    const active = await store.listActiveBoosts('u1', now);
    expect(active).toHaveLength(1);
    expect(active[0].expiresAt.getTime() - now.getTime()).toBe(12 * 3_600_000);
  });
});
