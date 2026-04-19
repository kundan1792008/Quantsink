import {
  DEFAULT_HISTORY_DAYS,
  INFLUENCE_COMPONENT_WEIGHTS,
  INFLUENCE_TIER_THRESHOLDS,
  InMemoryInfluenceStore,
  computeComponents,
  computeScoreFromInputs,
  normaliseCommunityStanding,
  normaliseConsistency,
  normaliseCrossApp,
  normaliseEngagementRate,
  tierDescriptor,
  tierForTotal,
  weightedTotal,
} from '../services/InfluenceScoreDomain';
import {
  InfluenceScoreService,
  NullSignalProvider,
} from '../services/InfluenceScoreService';
import QualityRatingAI from '../services/QualityRatingAI';

describe('InfluenceScoreDomain — math', () => {
  it('weights sum to 1', () => {
    const total = Object.values(INFLUENCE_COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('defines contiguous tiers 0 → 1000', () => {
    expect(INFLUENCE_TIER_THRESHOLDS[0].min).toBe(0);
    expect(INFLUENCE_TIER_THRESHOLDS[INFLUENCE_TIER_THRESHOLDS.length - 1].max).toBe(1000);
    for (let i = 1; i < INFLUENCE_TIER_THRESHOLDS.length; i += 1) {
      expect(INFLUENCE_TIER_THRESHOLDS[i].min).toBe(INFLUENCE_TIER_THRESHOLDS[i - 1].max + 1);
    }
  });

  it('tierForTotal maps boundaries correctly', () => {
    expect(tierForTotal(0)).toBe('BRONZE');
    expect(tierForTotal(200)).toBe('BRONZE');
    expect(tierForTotal(201)).toBe('SILVER');
    expect(tierForTotal(400)).toBe('SILVER');
    expect(tierForTotal(401)).toBe('GOLD');
    expect(tierForTotal(600)).toBe('GOLD');
    expect(tierForTotal(601)).toBe('PLATINUM');
    expect(tierForTotal(800)).toBe('PLATINUM');
    expect(tierForTotal(801)).toBe('DIAMOND');
    expect(tierForTotal(1000)).toBe('DIAMOND');
    expect(tierForTotal(-10)).toBe('BRONZE');
    expect(tierForTotal(9999)).toBe('DIAMOND');
  });

  it('normaliseEngagementRate handles zero impressions gracefully', () => {
    expect(normaliseEngagementRate(0, 0)).toBe(10);
    expect(normaliseEngagementRate(50, 100)).toBe(100); // 50% view-through caps at 100
    expect(normaliseEngagementRate(35, 100)).toBe(100); // exactly target
    expect(normaliseEngagementRate(10, 100)).toBeLessThan(40);
  });

  it('normaliseConsistency rewards streaks + volume', () => {
    expect(normaliseConsistency(0, 0)).toBe(0);
    expect(normaliseConsistency(30, 40)).toBe(100);
    expect(normaliseConsistency(7, 10)).toBeGreaterThan(normaliseConsistency(0, 10));
  });

  it('normaliseCrossApp maps 0–9 to 0–100', () => {
    expect(normaliseCrossApp(0)).toBe(0);
    expect(normaliseCrossApp(9)).toBe(100);
    expect(normaliseCrossApp(5)).toBeGreaterThan(50);
  });

  it('normaliseCommunityStanding deducts for reports', () => {
    expect(normaliseCommunityStanding(0, 0)).toBe(100);
    expect(normaliseCommunityStanding(1, 0)).toBe(85);
    expect(normaliseCommunityStanding(3, 4)).toBe(100 - 45 - 20);
    expect(normaliseCommunityStanding(10, 10)).toBe(0);
  });

  it('computeComponents + weightedTotal produce 0..1000', () => {
    const perfect = computeScoreFromInputs({
      userId: 'u1',
      averageBroadcastQuality: 100,
      impressions: 1000,
      views: 500,
      postStreakDays: 30,
      postsLast30d: 40,
      biometricLevel: 100,
      uniqueQuantAppsUsed: 9,
      upheldReports: 0,
      pendingReports: 0,
    });
    expect(perfect.total).toBe(1000);
    expect(perfect.tier).toBe('DIAMOND');

    const floor = computeScoreFromInputs({
      userId: 'u2',
      averageBroadcastQuality: 0,
      impressions: 0,
      views: 0,
      postStreakDays: 0,
      postsLast30d: 0,
      biometricLevel: 0,
      uniqueQuantAppsUsed: 0,
      upheldReports: 10,
      pendingReports: 10,
    });
    expect(floor.total).toBeLessThanOrEqual(50);
    expect(floor.tier).toBe('BRONZE');
  });

  it('weightedTotal honours active boost points and clamps at 1000', () => {
    const components = computeComponents({
      userId: 'u',
      averageBroadcastQuality: 80,
      impressions: 100,
      views: 30,
      postStreakDays: 5,
      postsLast30d: 10,
      biometricLevel: 70,
      uniqueQuantAppsUsed: 4,
      upheldReports: 0,
      pendingReports: 0,
    });
    const base = weightedTotal(components, 0);
    const boosted = weightedTotal(components, 100);
    expect(boosted - base).toBe(100);
    expect(weightedTotal(components, 10_000)).toBe(1000);
  });
});

describe('InMemoryInfluenceStore', () => {
  it('round-trips scores and history', async () => {
    const store = new InMemoryInfluenceStore();
    const now = new Date('2026-04-17T00:00:00Z');
    const components = {
      broadcastQuality: 50,
      engagementRate: 50,
      consistency: 50,
      biometricLevel: 50,
      crossAppActivity: 50,
      communityStanding: 50,
    };
    await store.upsertScore({
      userId: 'u1',
      total: 500,
      components,
      tier: 'GOLD',
      lastRecalculatedAt: now,
      boostPoints: 0,
    });
    await store.appendHistory({ userId: 'u1', total: 500, components, tier: 'GOLD', snapshotAt: now });

    const fetched = await store.getScore('u1');
    expect(fetched?.total).toBe(500);
    const hist = await store.listHistory('u1', 30);
    expect(hist).toHaveLength(1);
  });

  it('lists scores ordered by total descending', async () => {
    const store = new InMemoryInfluenceStore();
    const now = new Date();
    const make = (id: string, total: number) => ({
      userId: id,
      total,
      components: {
        broadcastQuality: 0, engagementRate: 0, consistency: 0,
        biometricLevel: 0, crossAppActivity: 0, communityStanding: 0,
      },
      tier: tierForTotal(total),
      lastRecalculatedAt: now,
      boostPoints: 0,
    });
    await store.upsertScore(make('a', 100));
    await store.upsertScore(make('b', 900));
    await store.upsertScore(make('c', 500));
    const rows = await store.listScoresOrdered(10, 0);
    expect(rows.map((r) => r.userId)).toEqual(['b', 'c', 'a']);
  });

  it('activeBoostPointsFor aggregates boosts within the window', async () => {
    const store = new InMemoryInfluenceStore();
    const now = new Date('2026-04-17T00:00:00Z');
    await store.createBoost({
      userId: 'u1',
      reason: 'challenge',
      points: 50,
      startsAt: new Date(now.getTime() - 1000),
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
    });
    await store.createBoost({
      userId: 'u1',
      reason: 'expired',
      points: 25,
      startsAt: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() - 1),
      consumedAt: null,
    });
    expect(await store.activeBoostPointsFor('u1', now)).toBe(50);
  });

  it('prunes history older than cutoff', async () => {
    const store = new InMemoryInfluenceStore();
    const now = Date.now();
    const cutoff = new Date(now - 7 * 86_400_000);
    const mk = (offsetDays: number) => ({
      userId: 'u1',
      total: 100,
      components: {
        broadcastQuality: 0, engagementRate: 0, consistency: 0,
        biometricLevel: 0, crossAppActivity: 0, communityStanding: 0,
      },
      tier: 'BRONZE' as const,
      snapshotAt: new Date(now - offsetDays * 86_400_000),
    });
    await store.appendHistory(mk(1));
    await store.appendHistory(mk(8));
    await store.appendHistory(mk(30));
    const removed = await store.pruneHistoryOlderThan(cutoff);
    expect(removed).toBe(2);
  });
});

describe('InfluenceScoreService', () => {
  function buildService() {
    const store = new InMemoryInfluenceStore();
    const now = new Date('2026-04-17T12:00:00Z');
    const service = new InfluenceScoreService({
      store,
      signals: new NullSignalProvider(),
      quality: new QualityRatingAI({ store, enablePersistence: false }),
      now: () => now,
      historyWindowDays: 30,
      recalcIntervalMs: 60_000,
    });
    return { service, store, now };
  }

  it('recalculate persists a score + history entry', async () => {
    const { service, store } = buildService();
    const score = await service.recalculate('user-1');
    expect(score.userId).toBe('user-1');
    expect(score.total).toBeGreaterThanOrEqual(0);
    const snap = store._snapshot();
    expect(snap.scores).toHaveLength(1);
    expect(snap.history).toHaveLength(1);
  });

  it('getBreakdown lazily recalculates when no score exists', async () => {
    const { service } = buildService();
    const breakdown = await service.getBreakdown('user-1');
    expect(breakdown.userId).toBe('user-1');
    expect(breakdown.tier).toBeDefined();
    expect(breakdown.weights.broadcastQuality).toBe(0.25);
  });

  it('getLeaderboard returns rows ordered by total descending with correct ranks', async () => {
    const { service, store, now } = buildService();
    const mk = (id: string, total: number) => ({
      userId: id,
      total,
      components: {
        broadcastQuality: 0, engagementRate: 0, consistency: 0,
        biometricLevel: 0, crossAppActivity: 0, communityStanding: 0,
      },
      tier: tierForTotal(total),
      lastRecalculatedAt: now,
      boostPoints: 0,
    });
    await store.upsertScore(mk('u1', 100));
    await store.upsertScore(mk('u2', 700));
    await store.upsertScore(mk('u3', 400));
    const page = await service.getLeaderboard(0, 10);
    expect(page.rows.map((r) => r.userId)).toEqual(['u2', 'u3', 'u1']);
    expect(page.rows[0].rank).toBe(1);
    expect(page.rows[0].tier).toBe('PLATINUM');
    expect(page.rows[1].tier).toBe('SILVER');
  });

  it('getNearby returns peers within ±50 of the viewer', async () => {
    const { service, store, now } = buildService();
    const mk = (id: string, total: number) => ({
      userId: id,
      total,
      components: {
        broadcastQuality: 0, engagementRate: 0, consistency: 0,
        biometricLevel: 0, crossAppActivity: 0, communityStanding: 0,
      },
      tier: tierForTotal(total),
      lastRecalculatedAt: now,
      boostPoints: 0,
    });
    await store.upsertScore(mk('me', 500));
    await store.upsertScore(mk('close', 480));
    await store.upsertScore(mk('far', 700));
    const nearby = await service.getNearby('me');
    const ids = nearby.map((r) => r.userId);
    expect(ids).toContain('close');
    expect(ids).not.toContain('far');
  });

  it('startChallenge is idempotent per kind and grants boost on completion', async () => {
    const { service } = buildService();
    const first = await service.startChallenge('user-1', 'POST_STREAK');
    const second = await service.startChallenge('user-1', 'POST_STREAK');
    expect(second.id).toBe(first.id);

    const completed = await service.progressChallenge('user-1', 'POST_STREAK', 1_000);
    expect(completed?.status).toBe('COMPLETED');
  });

  it('fileReport validates inputs', async () => {
    const { service } = buildService();
    await expect(service.fileReport('a', 'a', 'spam')).rejects.toThrow();
    await expect(service.fileReport('a', 'b', 'xx')).rejects.toThrow();
    await expect(service.fileReport('a', 'b', 'spam content')).resolves.toBeDefined();
  });

  it('tick recomputes stale scores', async () => {
    const { service, store } = buildService();
    await service.recalculate('u1');
    // Advance clock: make score stale by overriding now
    const future = new Date('2026-04-18T12:00:00Z');
    const s2 = new InfluenceScoreService({
      store,
      signals: new NullSignalProvider(),
      quality: new QualityRatingAI({ store, enablePersistence: false }),
      now: () => future,
      recalcIntervalMs: 60_000,
    });
    const report = await s2.tick();
    expect(report.recalculated).toBe(1);
  });
});

describe('tierDescriptor + DEFAULT_HISTORY_DAYS', () => {
  it('returns known metadata', () => {
    const gold = tierDescriptor('GOLD');
    expect(gold.min).toBe(401);
    expect(gold.max).toBe(600);
    expect(DEFAULT_HISTORY_DAYS).toBe(30);
  });

  it('throws on unknown tier', () => {
    expect(() => tierDescriptor('UNKNOWN' as unknown as 'GOLD')).toThrow();
  });
});
