/**
 * Public type surface for ReactionEngine, broken out so client-side code
 * (Next.js, target ES5) can consume the types without dragging the
 * implementation file — which uses Map/Set iteration and targets ES2020 —
 * into the client TypeScript program.
 */

export type ReactionKind = 'EMOJI' | 'SUPER' | 'COMBO';

export interface ReactionInput {
  readonly broadcastId: string;
  readonly userId: string;
  readonly emoji: string;
  readonly kind?: ReactionKind;
  readonly videoTimeMs?: number;
  readonly tokenCost?: number;
}

export interface AcceptedReaction {
  readonly broadcastId: string;
  readonly userId: string;
  readonly emoji: string;
  readonly kind: ReactionKind;
  readonly weight: number;
  readonly comboMultiplier: number;
  readonly tokenCost: number;
  readonly videoTimeMs: number | null;
  readonly receivedAt: Date;
}

export interface IngestResult {
  readonly accepted: boolean;
  readonly reason?:
    | 'OK'
    | 'INVALID_EMOJI'
    | 'INVALID_BROADCAST'
    | 'INVALID_USER'
    | 'THROTTLED'
    | 'ENGINE_STOPPED';
  readonly promotedToCombo?: boolean;
  readonly comboMultiplier?: number;
  readonly reaction?: AcceptedReaction;
}

export interface EmojiTally {
  readonly emoji: string;
  readonly count: number;
  readonly weighted: number;
  readonly superCount: number;
  readonly comboCount: number;
}

export interface StormSignal {
  readonly active: boolean;
  readonly intensity: number;
  readonly tier: 'CALM' | 'BUBBLY' | 'STORM' | 'TORNADO';
  readonly oneSecondTotal: number;
  readonly screenShake: number;
  readonly tornadoBoost: number;
}

export interface ReactionSnapshot {
  readonly broadcastId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly windowMs: number;
  readonly totalReactions: number;
  readonly weightedTotal: number;
  readonly perEmoji: ReadonlyArray<EmojiTally>;
  readonly superCount: number;
  readonly comboCount: number;
  readonly uniqueUsers: number;
  readonly storm: StormSignal;
  readonly cumulativeTotal: number;
  readonly cumulativeWeighted: number;
}

export interface HeatMapBucket {
  readonly bucketStartMs: number;
  readonly bucketEndMs: number;
  readonly count: number;
  readonly weighted: number;
  readonly normalised: number;
}

export interface HeatMap {
  readonly broadcastId: string;
  readonly bucketSizeMs: number;
  readonly buckets: ReadonlyArray<HeatMapBucket>;
  readonly hottestBucketMs: number | null;
  readonly totalSamples: number;
  readonly generatedAt: Date;
}
