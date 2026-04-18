import {
  RewardEngine,
  resolveRarity,
  tierForStatusPoints,
  DEFAULT_REWARD_TABLE,
} from '../services/RewardEngine';

describe('RewardEngine — resolveRarity', () => {
  it('returns COMMON for low rolls', () => {
    expect(resolveRarity(0).rarity).toBe('COMMON');
    expect(resolveRarity(0.69).rarity).toBe('COMMON');
  });

  it('returns RARE for mid rolls', () => {
    expect(resolveRarity(0.7).rarity).toBe('RARE');
    expect(resolveRarity(0.9499).rarity).toBe('RARE');
  });

  it('returns LEGENDARY for high rolls', () => {
    expect(resolveRarity(0.95).rarity).toBe('LEGENDARY');
    expect(resolveRarity(0.999).rarity).toBe('LEGENDARY');
  });

  it('rejects out-of-range rolls', () => {
    expect(() => resolveRarity(1)).toThrow();
    expect(() => resolveRarity(-0.1)).toThrow();
    expect(() => resolveRarity(Number.NaN)).toThrow();
  });

  it('approximates the configured distribution over many samples', () => {
    const counts = { COMMON: 0, RARE: 0, LEGENDARY: 0 };
    const N = 20_000;
    let seed = 0x12345678;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < N; i += 1) {
      counts[resolveRarity(rand()).rarity] += 1;
    }
    expect(counts.COMMON / N).toBeGreaterThan(0.66);
    expect(counts.COMMON / N).toBeLessThan(0.74);
    expect(counts.RARE / N).toBeGreaterThan(0.22);
    expect(counts.RARE / N).toBeLessThan(0.28);
    expect(counts.LEGENDARY / N).toBeGreaterThan(0.03);
    expect(counts.LEGENDARY / N).toBeLessThan(0.07);
  });
});

describe('RewardEngine — mystery box cadence', () => {
  it('only fires a draw on every 4th view by default', () => {
    const engine = new RewardEngine({ random: () => 0 });
    expect(engine.recordView()).toBeNull();
    expect(engine.recordView()).toBeNull();
    expect(engine.recordView()).toBeNull();
    const fourth = engine.recordView();
    expect(fourth).not.toBeNull();
    expect(fourth?.triggeredByView).toBe(4);
    expect(fourth?.rarity).toBe('COMMON');
  });

  it('honours a custom cadence', () => {
    const engine = new RewardEngine({ drawEveryNthView: 2, random: () => 0.99 });
    expect(engine.recordView()).toBeNull();
    const draw = engine.recordView();
    expect(draw?.rarity).toBe('LEGENDARY');
    expect(draw?.statusPoints).toBe(500);
  });

  it('bulk records many views and returns every draw', () => {
    const engine = new RewardEngine({ random: () => 0.1 });
    const draws = engine.recordViewsBulk(100);
    expect(draws).toHaveLength(25);
    expect(engine.getViews()).toBe(100);
  });

  it('rejects invalid bulk counts', () => {
    const engine = new RewardEngine();
    expect(() => engine.recordViewsBulk(-1)).toThrow();
    expect(() => engine.recordViewsBulk(1.5)).toThrow();
  });
});

describe('RewardEngine — milestones', () => {
  it('records milestones when crossed', () => {
    const engine = new RewardEngine();
    engine.recordViewsBulk(99);
    expect(engine.snapshot().milestonesReached).toEqual([]);
    engine.recordView();
    expect(engine.snapshot().milestonesReached).toContain(100);
    engine.recordViewsBulk(400);
    expect(engine.snapshot().milestonesReached).toContain(500);
  });

  it('exposes reached milestone metadata', () => {
    const engine = new RewardEngine();
    engine.recordViewsBulk(1_000);
    const reached = engine.getAchievedMilestones();
    const names = reached.map((r) => r.milestone.badgeName);
    expect(names).toContain('Rising Voice');
  });
});

describe('RewardEngine — loss aversion', () => {
  it('surfaces a CRITICAL alert when status has already lapsed', () => {
    const fixed = new Date('2026-04-17T12:00:00Z');
    const engine = new RewardEngine({ now: () => fixed });
    const lastPost = new Date(fixed.getTime() - 1000 * 3_600_000);
    const alert = engine.computeLossAversion(lastPost);
    expect(alert.warningLevel).toBe('CRITICAL');
    expect(alert.hoursRemaining).toBeLessThanOrEqual(0);
  });

  it('returns a CALM state when freshly posted', () => {
    const fixed = new Date('2026-04-17T12:00:00Z');
    const engine = new RewardEngine({ now: () => fixed });
    const alert = engine.computeLossAversion(new Date(fixed.getTime() - 10 * 60_000));
    expect(alert.warningLevel).toBe('CALM');
  });
});

describe('RewardEngine — snapshot & restore', () => {
  it('round-trips through snapshot/restore', () => {
    const engine = new RewardEngine({ random: () => 0.01 });
    engine.recordViewsBulk(16);
    const snap = engine.snapshot();
    const next = new RewardEngine();
    next.restoreFrom(snap);
    expect(next.getViews()).toBe(engine.getViews());
    expect(next.getStatusPoints()).toBe(engine.getStatusPoints());
    expect(next.snapshot().milestonesReached).toEqual(snap.milestonesReached);
  });

  it('validates invalid reward tables', () => {
    expect(
      () =>
        new RewardEngine({
          rewardTable: [
            { ...DEFAULT_REWARD_TABLE[0], probability: 0.5 },
            { ...DEFAULT_REWARD_TABLE[1], probability: 0.2 },
            { ...DEFAULT_REWARD_TABLE[2], probability: 0.2 },
          ],
        }),
    ).toThrow(/sum to 1/);
  });
});

describe('tierForStatusPoints', () => {
  it('maps known thresholds', () => {
    expect(tierForStatusPoints(0)).toBe('BRONZE');
    expect(tierForStatusPoints(250)).toBe('SILVER');
    expect(tierForStatusPoints(1_000)).toBe('GOLD');
    expect(tierForStatusPoints(2_500)).toBe('PLATINUM');
    expect(tierForStatusPoints(5_000)).toBe('DIAMOND');
  });
});
