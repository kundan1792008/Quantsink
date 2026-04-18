import {
  ReactionEngine,
  isValidEmoji,
  comboMultiplierFor,
  classifyStorm,
  SchedulerApi,
  TimerHandle,
  ReactionSnapshot,
} from '../services/ReactionEngine';

class ManualClock {
  current = 1_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

class ManualScheduler implements SchedulerApi {
  callbacks: Array<{ fn: () => void; ms: number; id: number }> = [];
  private nextId = 1;
  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.callbacks.push({ fn, ms, id });
    return { __brand: 'reactionTimer', id } as unknown as TimerHandle;
  }
  clearInterval(handle: TimerHandle): void {
    const id = (handle as unknown as { id: number }).id;
    this.callbacks = this.callbacks.filter((c) => c.id !== id);
  }
  fireAll(): void {
    for (const c of this.callbacks.slice()) c.fn();
  }
}

describe('isValidEmoji', () => {
  it('accepts simple emoji-like strings', () => {
    expect(isValidEmoji('🔥')).toBe(true);
    expect(isValidEmoji('❤️')).toBe(true);
    expect(isValidEmoji('👍')).toBe(true);
  });
  it('rejects empty, too long, and control characters', () => {
    expect(isValidEmoji('')).toBe(false);
    expect(isValidEmoji('a'.repeat(33))).toBe(false);
    expect(isValidEmoji('a\u0000b')).toBe(false);
    expect(isValidEmoji('  ')).toBe(false);
    expect(isValidEmoji('<script>')).toBe(false);
    expect(isValidEmoji(123 as unknown as string)).toBe(false);
  });
});

describe('comboMultiplierFor', () => {
  it('returns 1 for streak < 3', () => {
    expect(comboMultiplierFor(1)).toBe(1);
    expect(comboMultiplierFor(2)).toBe(1);
  });
  it('returns escalating multipliers and caps', () => {
    expect(comboMultiplierFor(3)).toBe(3);
    expect(comboMultiplierFor(4)).toBe(5);
    expect(comboMultiplierFor(5)).toBe(8);
    expect(comboMultiplierFor(50)).toBe(21);
  });
});

describe('classifyStorm', () => {
  it('maps thresholds to tiers', () => {
    expect(classifyStorm(0, 100, 400)).toBe('CALM');
    expect(classifyStorm(25, 100, 400)).toBe('BUBBLY');
    expect(classifyStorm(150, 100, 400)).toBe('STORM');
    expect(classifyStorm(500, 100, 400)).toBe('TORNADO');
  });
});

describe('ReactionEngine.ingest', () => {
  let clock: ManualClock;
  let scheduler: ManualScheduler;
  let engine: ReactionEngine;

  beforeEach(() => {
    clock = new ManualClock();
    scheduler = new ManualScheduler();
    engine = new ReactionEngine({
      clock,
      scheduler,
      random: () => 0.5,
      perUserPerSecond: 5,
      stormThreshold: 100,
      tornadoThreshold: 400,
    });
    engine.start();
  });

  afterEach(() => engine.stop());

  it('rejects when the engine is stopped', () => {
    engine.stop();
    const r = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('ENGINE_STOPPED');
  });

  it('rejects invalid input', () => {
    expect(engine.ingest({ broadcastId: '', userId: 'u', emoji: '🔥' }).reason).toBe(
      'INVALID_BROADCAST'
    );
    expect(engine.ingest({ broadcastId: 'b', userId: '', emoji: '🔥' }).reason).toBe(
      'INVALID_USER'
    );
    expect(engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '' }).reason).toBe(
      'INVALID_EMOJI'
    );
  });

  it('throttles users at 5 reactions per second', () => {
    for (let i = 0; i < 5; i++) {
      expect(engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' }).accepted).toBe(true);
    }
    const sixth = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    expect(sixth.accepted).toBe(false);
    expect(sixth.reason).toBe('THROTTLED');

    clock.advance(1_001);
    const after = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    expect(after.accepted).toBe(true);
  });

  it('promotes the third identical emoji into a COMBO with multiplier 3', () => {
    const a = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    const b = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    const c = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    expect(a.promotedToCombo).toBe(false);
    expect(b.promotedToCombo).toBe(false);
    expect(c.promotedToCombo).toBe(true);
    expect(c.comboMultiplier).toBe(3);
    expect(c.reaction!.kind).toBe('COMBO');
    expect(c.reaction!.weight).toBe(3);
  });

  it('does not combo across different emoji', () => {
    engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '❤️' });
    const third = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    expect(third.promotedToCombo).toBe(false);
  });

  it('SUPER reactions get weight 25', () => {
    const r = engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '⭐', kind: 'SUPER' });
    expect(r.accepted).toBe(true);
    expect(r.reaction!.kind).toBe('SUPER');
    expect(r.reaction!.weight).toBe(25);
  });
});

describe('ReactionEngine.flush', () => {
  let clock: ManualClock;
  let scheduler: ManualScheduler;
  let engine: ReactionEngine;
  let received: ReactionSnapshot[];

  beforeEach(() => {
    clock = new ManualClock();
    scheduler = new ManualScheduler();
    received = [];
    engine = new ReactionEngine({
      clock,
      scheduler,
      random: () => 0.5,
      perUserPerSecond: 100,
      stormThreshold: 5,
      tornadoThreshold: 20,
    });
    engine.start();
    engine.subscribe('b', (s) => received.push(s));
  });

  afterEach(() => engine.stop());

  it('aggregates per-emoji counts and dispatches snapshots', () => {
    engine.ingest({ broadcastId: 'b', userId: 'u1', emoji: '🔥' });
    engine.ingest({ broadcastId: 'b', userId: 'u2', emoji: '🔥' });
    engine.ingest({ broadcastId: 'b', userId: 'u3', emoji: '❤️' });

    const out = engine.flush();
    expect(out).toHaveLength(1);
    expect(received).toHaveLength(1);
    const snap = received[0];
    expect(snap.totalReactions).toBe(3);
    expect(snap.uniqueUsers).toBe(3);
    expect(snap.perEmoji.find((e) => e.emoji === '🔥')!.count).toBe(2);
    expect(snap.perEmoji.find((e) => e.emoji === '❤️')!.count).toBe(1);
    expect(snap.cumulativeTotal).toBe(3);
  });

  it('emits empty result when no pending reactions', () => {
    const out = engine.flush();
    expect(out).toEqual([]);
    expect(received).toEqual([]);
  });

  it('flags STORM and TORNADO based on rolling 1s window', () => {
    for (let i = 0; i < 6; i++) {
      engine.ingest({ broadcastId: 'b', userId: `u${i}`, emoji: '🔥' });
    }
    let snap = engine.flush()[0];
    expect(snap.storm.tier).toBe('STORM');
    expect(snap.storm.active).toBe(true);
    expect(snap.storm.screenShake).toBeGreaterThan(0);

    for (let i = 0; i < 25; i++) {
      engine.ingest({ broadcastId: 'b', userId: `tu${i}`, emoji: '🌪' });
    }
    snap = engine.flush()[0];
    expect(snap.storm.tier).toBe('TORNADO');
  });

  it('storm signal decays after the window passes', () => {
    for (let i = 0; i < 10; i++) {
      engine.ingest({ broadcastId: 'b', userId: `u${i}`, emoji: '🔥' });
    }
    expect(engine.flush()[0].storm.tier).toBe('STORM');
    clock.advance(2_000);
    // No new reactions; flush returns no snapshot but storm history is evicted
    engine.flush();
    const view = engine.getSnapshot('b');
    expect(view!.storm.tier).toBe('CALM');
  });
});

describe('ReactionEngine.getHeatMap', () => {
  it('buckets by playback time and normalises', () => {
    const clock = new ManualClock();
    const scheduler = new ManualScheduler();
    const engine = new ReactionEngine({
      clock,
      scheduler,
      perUserPerSecond: 100,
      heatBucketSizeMs: 1_000,
    });
    engine.start();
    engine.ingest({ broadcastId: 'b', userId: 'u1', emoji: '🔥', videoTimeMs: 500 });
    engine.ingest({ broadcastId: 'b', userId: 'u2', emoji: '🔥', videoTimeMs: 700 });
    engine.ingest({ broadcastId: 'b', userId: 'u3', emoji: '🔥', videoTimeMs: 4_200 });

    const map = engine.getHeatMap('b')!;
    expect(map.bucketSizeMs).toBe(1_000);
    expect(map.totalSamples).toBe(3);
    const hot = map.buckets.find((b) => b.bucketStartMs === 0)!;
    const cold = map.buckets.find((b) => b.bucketStartMs === 4_000)!;
    expect(hot.count).toBe(2);
    expect(hot.normalised).toBe(1);
    expect(cold.normalised).toBe(0.5);
    engine.stop();
  });
});

describe('ReactionEngine subscriptions & lifecycle', () => {
  it('unsubscribe stops further deliveries', () => {
    const clock = new ManualClock();
    const engine = new ReactionEngine({
      clock,
      scheduler: new ManualScheduler(),
      perUserPerSecond: 100,
    });
    engine.start();
    const got: ReactionSnapshot[] = [];
    const unsub = engine.subscribe('b', (s) => got.push(s));
    engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    engine.flush();
    expect(got).toHaveLength(1);
    unsub();
    engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    engine.flush();
    expect(got).toHaveLength(1);
    engine.stop();
  });

  it('closeBroadcast drops state', () => {
    const engine = new ReactionEngine({
      clock: new ManualClock(),
      scheduler: new ManualScheduler(),
    });
    engine.start();
    engine.ingest({ broadcastId: 'b', userId: 'u', emoji: '🔥' });
    expect(engine.trackedBroadcastCount()).toBe(1);
    engine.closeBroadcast('b');
    expect(engine.trackedBroadcastCount()).toBe(0);
    expect(engine.getSnapshot('b')).toBeNull();
    engine.stop();
  });
});
