import { ReactionEngine, resetReactionEngine } from '../services/ReactionEngine';

beforeEach(() => {
  resetReactionEngine();
});

afterEach(() => {
  resetReactionEngine();
});

// ─── Basic ingestion ──────────────────────────────────────────────────────────

describe('ReactionEngine — basic ingestion', () => {
  it('accepts a valid emoji reaction', () => {
    const engine = new ReactionEngine();
    const result = engine.ingestReaction({
      broadcastId: 'b1',
      userId: 'u1',
      emoji: '🔥',
    });
    expect(result).not.toBeNull();
    expect(result?.emoji).toBe('🔥');
    expect(result?.type).toBe('emoji');
    expect(result?.tokenCost).toBe(0);
  });

  it('returns null for empty emoji', () => {
    const engine = new ReactionEngine();
    const result = engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '' });
    expect(result).toBeNull();
  });

  it('returns null for overly long emoji string', () => {
    const engine = new ReactionEngine();
    const result = engine.ingestReaction({
      broadcastId: 'b1',
      userId: 'u1',
      emoji: '🔥'.repeat(20),
    });
    expect(result).toBeNull();
  });

  it('buffers accepted reactions', () => {
    const engine = new ReactionEngine();
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '😂' });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u2', emoji: '🚀' });
    const pending = engine.getPendingReactions('b1');
    expect(pending).toHaveLength(2);
  });

  it('does not persist reactions across flush', () => {
    const engine = new ReactionEngine();
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '😂' });
    engine.flush();
    expect(engine.getPendingReactions('b1')).toHaveLength(0);
  });
});

// ─── Throttle ─────────────────────────────────────────────────────────────────

describe('ReactionEngine — per-user throttle', () => {
  it('allows exactly maxReactionsPerUserPerSecond reactions', () => {
    const engine = new ReactionEngine({ maxReactionsPerUserPerSecond: 3 });
    const results = [
      engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' }),
      engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' }),
      engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' }),
    ];
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it('rejects reactions beyond the per-second limit', () => {
    const engine = new ReactionEngine({ maxReactionsPerUserPerSecond: 3 });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' });
    const rejected = engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' });
    expect(rejected).toBeNull();
  });

  it('does not throttle different users', () => {
    const engine = new ReactionEngine({ maxReactionsPerUserPerSecond: 1 });
    const r1 = engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🔥' });
    const r2 = engine.ingestReaction({ broadcastId: 'b1', userId: 'u2', emoji: '🔥' });
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });
});

// ─── Super-reaction ───────────────────────────────────────────────────────────

describe('ReactionEngine — super-reactions', () => {
  it('promotes to super type when token balance is sufficient', () => {
    const engine = new ReactionEngine({ superReactionTokenCost: 10 });
    const result = engine.ingestReaction({
      broadcastId: 'b1',
      userId: 'u1',
      emoji: '💎',
      isSuper: true,
      userTokenBalance: 50,
    });
    expect(result?.type).toBe('super');
    expect(result?.tokenCost).toBe(10);
  });

  it('rejects super-reaction when balance is insufficient', () => {
    const engine = new ReactionEngine({ superReactionTokenCost: 10 });
    const result = engine.ingestReaction({
      broadcastId: 'b1',
      userId: 'u1',
      emoji: '💎',
      isSuper: true,
      userTokenBalance: 5,
    });
    expect(result).toBeNull();
  });
});

// ─── Combo detection ──────────────────────────────────────────────────────────

describe('ReactionEngine — combo detection', () => {
  it('promotes to combo after threshold consecutive identical emoji', () => {
    const engine = new ReactionEngine({
      comboThreshold: 3,
      maxReactionsPerUserPerSecond: 10,
    });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🚀' });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🚀' });
    const combo = engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🚀' });
    expect(combo?.type).toBe('combo');
  });

  it('does not promote when emoji sequence is broken', () => {
    const engine = new ReactionEngine({
      comboThreshold: 3,
      maxReactionsPerUserPerSecond: 10,
    });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🚀' });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🔥' }); // break
    const notCombo = engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🚀' });
    expect(notCombo?.type).toBe('emoji');
  });
});

// ─── Batch flush ──────────────────────────────────────────────────────────────

describe('ReactionEngine — batch flush', () => {
  it('emits a batch event with correct aggregates', () => {
    const engine = new ReactionEngine({ maxReactionsPerUserPerSecond: 20 });
    const batches: unknown[] = [];
    engine.on('batch', (b) => batches.push(b));

    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🔥' });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u2', emoji: '🔥' });
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u3', emoji: '😂' });
    engine.flush();

    expect(batches).toHaveLength(1);
    const batch = batches[0] as { aggregates: Record<string, number> };
    expect(batch.aggregates['🔥']).toBe(2);
    expect(batch.aggregates['😂']).toBe(1);
  });

  it('clears the buffer after flush', () => {
    const engine = new ReactionEngine();
    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🎉' });
    engine.flush();
    expect(engine.getPendingReactions('b1')).toHaveLength(0);
  });

  it('handles multiple broadcasts in a single flush', () => {
    const engine = new ReactionEngine({ maxReactionsPerUserPerSecond: 10 });
    const batches: unknown[] = [];
    engine.on('batch', (b) => batches.push(b));

    engine.ingestReaction({ broadcastId: 'b1', userId: 'u1', emoji: '🔥' });
    engine.ingestReaction({ broadcastId: 'b2', userId: 'u2', emoji: '❤️' });
    engine.flush();

    expect(batches).toHaveLength(2);
  });
});

// ─── High-throughput ──────────────────────────────────────────────────────────

describe('ReactionEngine — high-throughput', () => {
  it('ingests 10 000 reactions from distinct users without error', () => {
    const engine = new ReactionEngine({ maxReactionsPerUserPerSecond: 10 });
    const N = 10_000;
    let accepted = 0;

    for (let i = 0; i < N; i++) {
      const r = engine.ingestReaction({
        broadcastId: 'stress',
        userId: `user_${i}`, // distinct users to avoid throttle
        emoji: '🔥',
      });
      if (r) accepted++;
    }

    expect(accepted).toBe(N);
    expect(engine.getPendingReactions('stress')).toHaveLength(N);
  });
});
