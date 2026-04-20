import {
  SeamlessDelivery,
  interleaveHighEngagementContent,
} from '../services/SeamlessDelivery';
import type { BroadcastRecord } from '../services/TrendPredictor';

const NOW = new Date('2026-04-20T12:00:00.000Z');

function makeBroadcast(i: number): BroadcastRecord {
  return {
    id: `b-${i}`,
    authorId: `a-${i % 6}`,
    text: `alpha signal ${i}`,
    postedAt: new Date(NOW.getTime() - i * 60_000),
    engagement: 1000 - i,
    tags: i % 2 === 0 ? ['alpha'] : ['beta'],
  };
}

describe('SeamlessDelivery', () => {
  const corpus = Array.from({ length: 70 }, (_, i) => makeBroadcast(i + 1));

  it('primes up to 50 prefetched items', () => {
    const delivery = new SeamlessDelivery(corpus, { now: () => NOW });
    const queue = delivery.prime('u1', new Map([['alpha', 1.5]]));

    expect(queue.length).toBe(50);
    expect(delivery.getQueuedCount('u1')).toBe(50);
  });

  it('serves instant batches and keeps queue hot', () => {
    const delivery = new SeamlessDelivery(corpus, { now: () => NOW, instantBatchSize: 10 });

    const batch = delivery.getInstantBatch('u1', new Map([['alpha', 2]]));

    expect(batch.items.length).toBe(10);
    expect(batch.fromPrefetch).toBe(true);
    expect(batch.renderLatencyMs).toBeLessThan(50);
    expect(delivery.getQueuedCount('u1')).toBeGreaterThan(0);
  });

  it('inserts a high engagement card when attention dip is predicted', () => {
    const items = [
      { ...makeBroadcast(90), engagement: 10 },
      { ...makeBroadcast(91), engagement: 20 },
      { ...makeBroadcast(92), engagement: 30 },
      { ...makeBroadcast(93), engagement: 2_000 },
    ];

    const interleaved = interleaveHighEngagementContent(items, true);

    expect(interleaved[0].id).not.toBe(items[3].id);
    expect(interleaved.some((item) => item.id === items[3].id)).toBe(true);
  });
});
