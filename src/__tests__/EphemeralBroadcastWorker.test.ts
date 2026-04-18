import { EphemeralBroadcastWorker, DEFAULT_EPHEMERAL_TTL_MS } from '../services/EphemeralBroadcastWorker';

describe('EphemeralBroadcastWorker', () => {
  it('registers with a real expiry computed from createdAt + ttl', () => {
    const worker = new EphemeralBroadcastWorker({ deleter: jest.fn() });
    const createdAt = new Date('2026-04-17T00:00:00Z');
    const entry = worker.register({
      broadcastId: 'b1',
      authorId: 'u1',
      createdAt,
    });
    expect(entry.expiresAt.getTime() - createdAt.getTime()).toBe(DEFAULT_EPHEMERAL_TTL_MS);
    expect(entry.deletedAt).toBeNull();
  });

  it('rejects non-positive TTL', () => {
    const worker = new EphemeralBroadcastWorker({ deleter: jest.fn() });
    expect(() =>
      worker.register({ broadcastId: 'b1', authorId: 'u1', ttlMs: 0 }),
    ).toThrow();
  });

  it('sweep deletes broadcasts whose TTL has elapsed and leaves live ones alone', async () => {
    const deleter = jest.fn().mockResolvedValue(undefined);
    const worker = new EphemeralBroadcastWorker({ deleter });
    const createdAt = new Date(1_000_000);
    worker.register({ broadcastId: 'expired', authorId: 'u1', ttlMs: 1_000, createdAt });
    worker.register({ broadcastId: 'alive',   authorId: 'u2', ttlMs: 60_000, createdAt });

    const expiredNow = createdAt.getTime() + 2_000;
    const expired = await worker.sweep(expiredNow);
    expect(expired).toEqual(['expired']);
    expect(deleter).toHaveBeenCalledTimes(1);
    expect(deleter).toHaveBeenCalledWith('expired');
    expect(worker.get('expired')?.deletedAt).not.toBeNull();
    expect(worker.get('alive')?.deletedAt).toBeNull();
  });

  it('reports real remaining milliseconds, never negative', () => {
    const worker = new EphemeralBroadcastWorker({ deleter: jest.fn() });
    const createdAt = new Date(0);
    worker.register({ broadcastId: 'b1', authorId: 'u1', ttlMs: 5_000, createdAt });
    expect(worker.remainingMs('b1', 1_000)).toBe(4_000);
    expect(worker.remainingMs('b1', 10_000)).toBe(0);
    expect(worker.remainingMs('unknown')).toBe(0);
  });

  it('emits expired event on deletion', async () => {
    const worker = new EphemeralBroadcastWorker({
      deleter: jest.fn().mockResolvedValue(undefined),
    });
    const createdAt = new Date(0);
    worker.register({ broadcastId: 'b1', authorId: 'u1', ttlMs: 1_000, createdAt });
    const events: string[] = [];
    worker.on('expired', (e) => events.push(e.broadcastId));
    await worker.sweep(2_000);
    expect(events).toEqual(['b1']);
  });

  it('delete is idempotent', async () => {
    const deleter = jest.fn().mockResolvedValue(undefined);
    const worker = new EphemeralBroadcastWorker({ deleter });
    worker.register({ broadcastId: 'b1', authorId: 'u1' });
    await worker.delete('b1');
    await worker.delete('b1');
    expect(deleter).toHaveBeenCalledTimes(1);
  });

  it('surfaces deleter errors so callers can retry', async () => {
    const deleter = jest.fn().mockRejectedValue(new Error('db down'));
    const worker = new EphemeralBroadcastWorker({ deleter });
    worker.register({ broadcastId: 'b1', authorId: 'u1' });
    await expect(worker.delete('b1')).rejects.toThrow('db down');
    expect(worker.get('b1')?.deletedAt).toBeNull();
  });
});
