import { PhantomSocialService, SchedulerApi, TimerHandle } from '../services/PhantomSocialService';

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

  size(): number {
    return this.queue.length;
  }
}

describe('PhantomSocialService — viewer inflation', () => {
  it('inflates by the configured multiplier', () => {
    const svc = new PhantomSocialService({ random: () => 0.5, inflationJitter: 0 });
    expect(svc.inflateViewerCount(100)).toBe(130);
    expect(svc.inflateViewerCount(0)).toBe(0);
  });

  it('never returns a value lower than the real count', () => {
    const svc = new PhantomSocialService({ random: () => 0, inflationJitter: 10 });
    expect(svc.inflateViewerCount(50)).toBeGreaterThanOrEqual(50);
  });

  it('emits a sample with delta when the viewer count changes', () => {
    const svc = new PhantomSocialService({ random: () => 0.5, inflationJitter: 0 });
    const events: number[] = [];
    svc.onViewerChange((s) => events.push(s.phantom));
    svc.updateRealViewers(10); // phantom ≈ 13
    svc.updateRealViewers(20); // phantom ≈ 26
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[events.length - 1]).toBeGreaterThan(events[0]);
  });

  it('rejects negative real values', () => {
    const svc = new PhantomSocialService();
    expect(() => svc.inflateViewerCount(-5)).toThrow();
  });
});

describe('PhantomSocialService — typing lifecycle', () => {
  it('schedules typing indicators deterministically', () => {
    const scheduler = new ManualScheduler();
    const svc = new PhantomSocialService({
      random: () => 0.1,
      scheduler,
      minPulseIntervalMs: 1_000,
      maxPulseIntervalMs: 1_500,
    });
    const events: string[] = [];
    svc.onTyping((e) => events.push(`${e.state}:${e.personaId}`));
    svc.start();
    scheduler.advance(20_000);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.startsWith('START:'))).toBe(true);
    svc.stop();
    expect(svc.isStarted()).toBe(false);
  });

  it('stops cleanly and clears active typists', () => {
    const scheduler = new ManualScheduler();
    const svc = new PhantomSocialService({ random: () => 0.1, scheduler });
    svc.start();
    svc.forceStartTyping('ghost-01');
    expect(svc.getActiveTypists()).toContain('ghost-01');
    svc.stop();
    expect(svc.getActiveTypists()).toHaveLength(0);
  });

  it('forceStart/forceStop no-op on unknown personas', () => {
    const svc = new PhantomSocialService();
    expect(svc.forceStartTyping('does-not-exist')).toBeNull();
    expect(svc.forceStopTyping('does-not-exist')).toBeNull();
  });
});
