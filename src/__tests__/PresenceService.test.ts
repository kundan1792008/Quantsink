import { PresenceService } from '../services/PresenceService';

describe('PresenceService', () => {
  it('returns real viewer count, not inflated', () => {
    const svc = new PresenceService({ heartbeatTtlMs: null });
    svc.join('b1', 'u1');
    svc.join('b1', 'u2');
    svc.join('b1', 'u3');
    const snap = svc.snapshot('b1');
    expect(snap.viewerCount).toBe(3);
    expect(snap.viewerIds.sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('deduplicates repeat joins from the same user', () => {
    const svc = new PresenceService({ heartbeatTtlMs: null });
    svc.join('b1', 'u1');
    svc.join('b1', 'u1');
    expect(svc.snapshot('b1').viewerCount).toBe(1);
  });

  it('emits viewerCountChanged only on real delta', () => {
    const svc = new PresenceService({ heartbeatTtlMs: null });
    const events: number[] = [];
    svc.on('viewerCountChanged', (d) => events.push(d.currentCount));
    svc.join('b1', 'u1');
    svc.join('b1', 'u1'); // duplicate — no delta
    svc.join('b1', 'u2');
    svc.leave('b1', 'u1');
    expect(events).toEqual([1, 2, 1]);
  });

  it('refuses to mark a non-connected user as typing', () => {
    const svc = new PresenceService();
    expect(() => svc.typing('b1', 'ghost')).toThrow(/not connected/);
  });

  it('typing reflects only real, recent keystrokes', () => {
    const svc = new PresenceService({ typingTtlMs: 1_000, heartbeatTtlMs: null });
    svc.join('b1', 'u1', 0);
    svc.typing('b1', 'u1', 0);
    expect(svc.snapshot('b1', 500).typingUserIds).toEqual(['u1']);
    expect(svc.snapshot('b1', 2_000).typingUserIds).toEqual([]);
  });

  it('stopTyping clears state', () => {
    const svc = new PresenceService({ heartbeatTtlMs: null });
    svc.join('b1', 'u1');
    svc.typing('b1', 'u1');
    svc.stopTyping('b1', 'u1');
    expect(svc.snapshot('b1').typingUserIds).toEqual([]);
  });

  it('sweep removes stale viewers past heartbeat TTL', () => {
    const svc = new PresenceService({ heartbeatTtlMs: 1_000 });
    svc.join('b1', 'u1', 0);
    svc.join('b1', 'u2', 500);
    svc.heartbeat('b1', 'u2', 1_500);
    const snap = svc.sweep('b1', 2_000);
    expect(snap.viewerIds).toEqual(['u2']);
  });

  it('typing for a user who leaves does not persist', () => {
    const svc = new PresenceService({ heartbeatTtlMs: null });
    svc.join('b1', 'u1');
    svc.typing('b1', 'u1');
    svc.leave('b1', 'u1');
    expect(svc.snapshot('b1').typingUserIds).toEqual([]);
  });
});
