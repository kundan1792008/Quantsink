import {
  EphemeralBroadcastWorker,
  formatCountdown,
  urgencyFor,
  SchedulerApi,
  TimerHandle,
} from '../services/EphemeralBroadcastWorker';

class ManualScheduler implements SchedulerApi {
  private queue: Array<{ id: number; fn: () => void; dueAt: number }> = [];
  private clock = 0;
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.queue.push({ id, fn, dueAt: this.clock + ms });
    this.queue.sort((a, b) => a.dueAt - b.dueAt);
    return { __brand: 'timer', id } as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    const id = (handle as unknown as { id: number }).id;
    this.queue = this.queue.filter((t) => t.id !== id);
  }

  advance(ms: number): void {
    const target = this.clock + ms;
    while (this.queue.length > 0 && this.queue[0].dueAt <= target) {
      const entry = this.queue.shift()!;
      this.clock = entry.dueAt;
      entry.fn();
    }
    this.clock = target;
  }
}

describe('formatCountdown', () => {
  it('renders seconds/minutes/hours correctly', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-1)).toBe('00:00');
    expect(formatCountdown(5_000)).toBe('00:05');
    expect(formatCountdown(65_000)).toBe('01:05');
    expect(formatCountdown(3_665_000)).toBe('01:01:05');
  });
});

describe('urgencyFor', () => {
  it('maps percent thresholds', () => {
    expect(urgencyFor(1)).toBe('STEADY');
    expect(urgencyFor(0.6)).toBe('STEADY');
    expect(urgencyFor(0.4)).toBe('WARM');
    expect(urgencyFor(0.2)).toBe('HOT');
    expect(urgencyFor(0.05)).toBe('CRITICAL');
    expect(urgencyFor(0)).toBe('BURNT');
  });
});

describe('EphemeralBroadcastWorker — register & tick', () => {
  it('computes countdown snapshots that decay over time', () => {
    let now = 1_000_000;
    const worker = new EphemeralBroadcastWorker({
      now: () => new Date(now),
      tickIntervalMs: 1_000,
    });
    const bc = worker.register({
      id: 'bc-1',
      ownerId: 'user-1',
      headline: 'Test',
      ttlMs: 10_000,
    });
    now += 3_000;
    const snap = worker.snapshotFor(bc);
    expect(snap.msRemaining).toBe(7_000);
    expect(snap.percentRemaining).toBeCloseTo(0.7, 2);
    expect(snap.urgency).toBe('STEADY');
    now += 6_000;
    const snap2 = worker.snapshotFor(bc);
    expect(snap2.urgency).toBe('CRITICAL');
  });

  it('emits countdown events through onCountdown', () => {
    const scheduler = new ManualScheduler();
    let now = 0;
    const worker = new EphemeralBroadcastWorker({
      now: () => new Date(now),
      scheduler,
      tickIntervalMs: 1_000,
    });
    worker.register({ id: 'x', ownerId: 'u', headline: 'h', ttlMs: 5_000 });
    const snapshots: number[] = [];
    worker.onCountdown((s) => snapshots.push(s.msRemaining));
    worker.start();
    for (let i = 0; i < 6; i += 1) {
      now += 1_000;
      scheduler.advance(1_000);
    }
    expect(snapshots.length).toBeGreaterThanOrEqual(5);
    expect(snapshots[snapshots.length - 1]).toBe(0);
  });

  it('emits EXPIRED lifecycle when TTL elapses', () => {
    const scheduler = new ManualScheduler();
    let now = 0;
    const worker = new EphemeralBroadcastWorker({
      now: () => new Date(now),
      scheduler,
      tickIntervalMs: 500,
    });
    worker.register({ id: 'a', ownerId: 'u', headline: 'h', ttlMs: 2_000 });
    const states: string[] = [];
    worker.onLifecycle((b) => states.push(b.state));
    worker.start();
    for (let i = 0; i < 10; i += 1) {
      now += 500;
      scheduler.advance(500);
    }
    expect(states).toContain('EXPIRED');
    worker.stop();
  });

  it('prevents duplicate registration', () => {
    const worker = new EphemeralBroadcastWorker();
    worker.register({ id: 'dup', ownerId: 'u', headline: 'h' });
    expect(() => worker.register({ id: 'dup', ownerId: 'u', headline: 'h' })).toThrow();
  });

  it('destroys broadcasts cleanly', () => {
    const worker = new EphemeralBroadcastWorker();
    worker.register({ id: 'z', ownerId: 'u', headline: 'h' });
    const events: string[] = [];
    worker.onLifecycle((b) => events.push(b.state));
    expect(worker.destroy('z')).toBe(true);
    expect(events).toContain('DESTROYED');
    expect(worker.getBroadcast('z')).toBeUndefined();
    expect(worker.destroy('z')).toBe(false);
  });
});

describe('EphemeralBroadcastWorker — loss aversion', () => {
  it('classifies NUDGE for multi-day expiries', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const worker = new EphemeralBroadcastWorker({ now: () => now });
    const alert = worker.publishLossAversion({
      ownerId: 'u',
      tier: 'Platinum',
      expiresAt: new Date(now.getTime() + 3 * 24 * 3_600_000),
    });
    expect(alert.level).toBe('NUDGE');
    expect(alert.message).toMatch(/3 days/);
  });

  it('classifies URGENT for <=24h expiries', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const worker = new EphemeralBroadcastWorker({ now: () => now });
    const alert = worker.publishLossAversion({
      ownerId: 'u',
      tier: 'Gold',
      expiresAt: new Date(now.getTime() + 3 * 3_600_000),
    });
    expect(alert.level).toBe('URGENT');
    expect(alert.message).toMatch(/3h/);
  });

  it('classifies CRITICAL when already expired', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const worker = new EphemeralBroadcastWorker({ now: () => now });
    const alert = worker.publishLossAversion({
      ownerId: 'u',
      tier: 'Diamond',
      expiresAt: new Date(now.getTime() - 3_600_000),
    });
    expect(alert.level).toBe('CRITICAL');
  });
});
