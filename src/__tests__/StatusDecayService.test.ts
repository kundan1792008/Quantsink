import {
  computeEffectiveTier,
  describeTierState,
  notificationFor,
  StatusDecayService,
} from '../services/StatusDecayService';

const day = (n: number) => new Date(2026, 3, n, 12, 0, 0);

describe('StatusDecayService · computeEffectiveTier', () => {
  it('never decays a user who has never broadcast', () => {
    expect(computeEffectiveTier('PLATINUM', null)).toBe('PLATINUM');
  });

  it('holds PLATINUM within 7 days', () => {
    expect(computeEffectiveTier('PLATINUM', day(1), day(7))).toBe('PLATINUM');
  });

  it('steps PLATINUM → GOLD after 8 days', () => {
    expect(computeEffectiveTier('PLATINUM', day(1), day(9))).toBe('GOLD');
  });

  it('steps GOLD → SILVER after 14-day cadence lapsed', () => {
    expect(computeEffectiveTier('GOLD', day(1), day(16))).toBe('SILVER');
  });

  it('BRONZE never decays further', () => {
    expect(computeEffectiveTier('BRONZE', day(1), day(365))).toBe('BRONZE');
  });
});

describe('StatusDecayService · describeTierState', () => {
  it('flags at-risk when inside the final third of the window', () => {
    // PLATINUM window = 7 days → at risk once ≤3 days remaining (day 4 onward).
    const early = describeTierState('u1', 'PLATINUM', day(1), day(3));
    expect(early.atRisk).toBe(false);
    const risky = describeTierState('u1', 'PLATINUM', day(1), day(5));
    expect(risky.atRisk).toBe(true);
    expect(risky.daysUntilDecay).toBe(3);
    expect(risky.nextDecayTier).toBe('GOLD');
  });

  it('daysUntilDecay is null for BRONZE (infinite cadence)', () => {
    const s = describeTierState('u1', 'BRONZE', day(1), day(90));
    expect(s.daysUntilDecay).toBeNull();
  });
});

describe('StatusDecayService · notificationFor', () => {
  it('produces a factual notification, no manufactured urgency', () => {
    const state = describeTierState('u1', 'PLATINUM', day(1), day(6));
    const note = notificationFor(state);
    expect(note).not.toBeNull();
    expect(note!.message).toMatch(/PLATINUM tier requires weekly activity/);
    expect(note!.message).toMatch(/step(s)? down to GOLD/);
    // No hyperbolic / loss-aversion language.
    expect(note!.message).not.toMatch(/lose|forever|last chance|hurry/i);
  });

  it('returns null when not at risk', () => {
    const state = describeTierState('u1', 'PLATINUM', day(1), day(2));
    expect(notificationFor(state)).toBeNull();
  });
});

describe('StatusDecayService · service integration', () => {
  it('persists decayed tier so it does not repeatedly decay', () => {
    const svc = new StatusDecayService();
    svc.setTier('u1', 'PLATINUM', day(1));
    const first = svc.getState('u1', day(9));
    expect(first?.tier).toBe('GOLD');
    const second = svc.getState('u1', day(10));
    expect(second?.tier).toBe('GOLD'); // not SILVER — one step per evaluation
  });

  it('recordBroadcast resets the clock', () => {
    const svc = new StatusDecayService();
    svc.setTier('u1', 'PLATINUM', day(1));
    svc.recordBroadcast('u1', day(6));
    const s = svc.getState('u1', day(10));
    expect(s?.tier).toBe('PLATINUM');
  });

  it('getNotification returns null for unknown user', () => {
    const svc = new StatusDecayService();
    expect(svc.getNotification('ghost')).toBeNull();
  });
});
