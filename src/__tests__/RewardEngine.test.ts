import {
  RewardEngine,
  milestonesCrossed,
  applyBroadcastToStreak,
  isStreakAtRisk,
  EMPTY_STREAK,
  REACTIONS,
  getReactionDefinition,
} from '../services/RewardEngine';

describe('RewardEngine · milestones', () => {
  it('returns milestones newly crossed between two view counts', () => {
    expect(milestonesCrossed(0, 50)).toEqual([]);
    expect(milestonesCrossed(0, 100).map((m) => m.threshold)).toEqual([100]);
    expect(milestonesCrossed(99, 501).map((m) => m.threshold)).toEqual([100, 500]);
    expect(milestonesCrossed(500, 500)).toEqual([]);
    expect(milestonesCrossed(1_000, 10_000).map((m) => m.threshold)).toEqual([10_000]);
  });

  it('engine emits each milestone only once', () => {
    const eng = new RewardEngine();
    const first = eng.recordViews('b1', 101);
    expect(first).toHaveLength(1);
    expect(first[0].milestone.threshold).toBe(100);

    const second = eng.recordViews('b1', 150);
    expect(second).toHaveLength(0);

    const third = eng.recordViews('b1', 600);
    expect(third).toHaveLength(1);
    expect(third[0].milestone.threshold).toBe(500);
  });

  it('ignores non-monotonic view count regressions', () => {
    const eng = new RewardEngine();
    eng.recordViews('b1', 200);
    const regressed = eng.recordViews('b1', 150);
    expect(regressed).toEqual([]);
    expect(eng.getViews('b1')).toBe(200);
  });

  it('rejects negative totals', () => {
    const eng = new RewardEngine();
    expect(() => eng.recordViews('b1', -1)).toThrow();
  });
});

describe('RewardEngine · reactions', () => {
  it('has fixed, publicly known weights', () => {
    expect(getReactionDefinition('FIRE').weight).toBe(1);
    expect(getReactionDefinition('DIAMOND').weight).toBe(3);
    expect(getReactionDefinition('CROWN').weight).toBe(10);
  });

  it('records the chosen reaction with its defined weight', () => {
    const eng = new RewardEngine();
    const ev = eng.react('b1', 'viewer1', 'CROWN');
    expect(ev.kind).toBe('CROWN');
    expect(ev.weight).toBe(10);
    expect(ev.broadcastId).toBe('b1');
    expect(ev.viewerId).toBe('viewer1');
  });

  it('rejects unknown reaction kinds', () => {
    // @ts-expect-error exercise runtime guard
    expect(() => getReactionDefinition('LUCKY')).toThrow();
  });

  it('exposes exactly three reaction tiers', () => {
    expect(REACTIONS).toHaveLength(3);
  });
});

describe('RewardEngine · streak', () => {
  const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it('first broadcast starts a streak of 1', () => {
    const next = applyBroadcastToStreak(EMPTY_STREAK, d('2026-04-01'));
    expect(next.currentStreak).toBe(1);
    expect(next.longestStreak).toBe(1);
    expect(next.lastBroadcastDate).toBe('2026-04-01');
  });

  it('same-day broadcast does not increment', () => {
    let s = applyBroadcastToStreak(EMPTY_STREAK, d('2026-04-01'));
    s = applyBroadcastToStreak(s, d('2026-04-01'));
    expect(s.currentStreak).toBe(1);
  });

  it('consecutive-day broadcast increments', () => {
    let s = applyBroadcastToStreak(EMPTY_STREAK, d('2026-04-01'));
    s = applyBroadcastToStreak(s, d('2026-04-02'));
    s = applyBroadcastToStreak(s, d('2026-04-03'));
    expect(s.currentStreak).toBe(3);
    expect(s.longestStreak).toBe(3);
  });

  it('gap resets the streak but preserves the longest', () => {
    let s = applyBroadcastToStreak(EMPTY_STREAK, d('2026-04-01'));
    s = applyBroadcastToStreak(s, d('2026-04-02'));
    s = applyBroadcastToStreak(s, d('2026-04-03'));
    s = applyBroadcastToStreak(s, d('2026-04-10')); // 7-day gap
    expect(s.currentStreak).toBe(1);
    expect(s.longestStreak).toBe(3);
  });

  it('flags a streak at risk exactly one day after last broadcast', () => {
    let s = applyBroadcastToStreak(EMPTY_STREAK, d('2026-04-01'));
    expect(isStreakAtRisk(s, d('2026-04-01'))).toBe(false);
    expect(isStreakAtRisk(s, d('2026-04-02'))).toBe(true);
    expect(isStreakAtRisk(s, d('2026-04-03'))).toBe(false); // already broken
    s = applyBroadcastToStreak(s, d('2026-04-02'));
    expect(isStreakAtRisk(s, d('2026-04-03'))).toBe(true);
  });

  it('recordBroadcast updates per-user state', () => {
    const eng = new RewardEngine();
    eng.recordBroadcast('u1', d('2026-04-01'));
    eng.recordBroadcast('u1', d('2026-04-02'));
    expect(eng.getStreak('u1').currentStreak).toBe(2);
    expect(eng.getStreak('u2')).toEqual(EMPTY_STREAK);
  });
});
