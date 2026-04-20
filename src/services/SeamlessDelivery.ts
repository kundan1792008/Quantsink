import type { BroadcastRecord } from './TrendPredictor';

export interface SeamlessDeliveryOptions {
  readonly now?: () => Date;
  readonly prefetchCount?: number;
  readonly instantBatchSize?: number;
}

export interface AttentionSignal {
  readonly predictedDip: boolean;
}

export interface InstantRenderBatch {
  readonly items: readonly BroadcastRecord[];
  readonly fromPrefetch: boolean;
  readonly renderLatencyMs: number;
}

interface UserPipelineState {
  queue: BroadcastRecord[];
  consumed: Set<string>;
}

function monotonicNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function scoreByPredictiveWeight(
  item: BroadcastRecord,
  predictiveWeights: ReadonlyMap<string, number>,
  now: Date,
): number {
  const direct = predictiveWeights.get(item.id) ?? 0;
  const tagScore = (item.tags ?? []).reduce(
    (sum, tag) => sum + (predictiveWeights.get(tag.toLowerCase()) ?? 0),
    0,
  );
  const ageMs = Math.max(0, now.getTime() - new Date(item.postedAt).getTime());
  const recency = Math.pow(0.5, ageMs / (6 * 3_600_000));
  const engagement = Math.log1p(Math.max(0, item.engagement));
  return direct * 3 + tagScore + recency + engagement;
}

export function interleaveHighEngagementContent(
  items: readonly BroadcastRecord[],
  predictedDip: boolean,
): BroadcastRecord[] {
  if (!predictedDip || items.length < 4) {
    return [...items];
  }

  const enriched = [...items].sort((a, b) => b.engagement - a.engagement);
  const hero = enriched[0];
  const rest = items.filter((item) => item.id !== hero.id);
  const midpoint = Math.floor(rest.length / 2);

  return [...rest.slice(0, midpoint), hero, ...rest.slice(midpoint)];
}

export class SeamlessDelivery {
  private readonly now: () => Date;
  private readonly prefetchCount: number;
  private readonly instantBatchSize: number;
  private readonly state = new Map<string, UserPipelineState>();

  constructor(
    private readonly corpus: readonly BroadcastRecord[],
    options: SeamlessDeliveryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.prefetchCount = options.prefetchCount ?? 50;
    this.instantBatchSize = options.instantBatchSize ?? 8;
  }

  prime(
    userId: string,
    predictiveWeights: ReadonlyMap<string, number>,
  ): readonly BroadcastRecord[] {
    const userState = this.ensureState(userId);
    const queuedIds = new Set(userState.queue.map((item) => item.id));

    const ranked = this.corpus
      .filter((item) => !userState.consumed.has(item.id) && !queuedIds.has(item.id))
      .map((item) => ({
        item,
        score: scoreByPredictiveWeight(item, predictiveWeights, this.now()),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.prefetchCount - userState.queue.length)
      .map((entry) => entry.item);

    userState.queue.push(...ranked);
    return [...userState.queue];
  }

  getInstantBatch(
    userId: string,
    predictiveWeights: ReadonlyMap<string, number>,
    attentionSignal: AttentionSignal = { predictedDip: false },
  ): InstantRenderBatch {
    const start = monotonicNowMs();
    const userState = this.ensureState(userId);

    if (userState.queue.length === 0) {
      this.prime(userId, predictiveWeights);
    }

    const batchSize = Math.min(this.instantBatchSize, userState.queue.length);
    const raw = userState.queue.splice(0, batchSize);
    for (const item of raw) {
      userState.consumed.add(item.id);
    }

    this.prime(userId, predictiveWeights);

    return {
      items: interleaveHighEngagementContent(raw, attentionSignal.predictedDip),
      fromPrefetch: raw.length > 0,
      renderLatencyMs: Math.max(0, monotonicNowMs() - start),
    };
  }

  getQueuedCount(userId: string): number {
    return this.ensureState(userId).queue.length;
  }

  private ensureState(userId: string): UserPipelineState {
    const existing = this.state.get(userId);
    if (existing) return existing;
    const created: UserPipelineState = {
      queue: [],
      consumed: new Set<string>(),
    };
    this.state.set(userId, created);
    return created;
  }
}

export default SeamlessDelivery;
