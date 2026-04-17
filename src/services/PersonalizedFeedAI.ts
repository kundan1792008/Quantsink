/**
 * PersonalizedFeedAI — Hybrid Feed Ranker
 *
 * Builds a per-user interest graph from four signals —
 *   1. View history
 *   2. Like history
 *   3. Follow graph
 *   4. Broadcast topics (TF-IDF features)
 *
 * and produces a ranked feed by combining two classical recommendation
 * strategies:
 *
 *   • **Collaborative filtering** — cosine similarity between user
 *     interaction vectors ("users like you also watched X").
 *   • **Content-based filtering** — cosine similarity between a user's
 *     aggregate topic vector and each candidate broadcast's TF-IDF vector.
 *
 * The hybrid ranker blends both scores with a configurable weighting and
 * applies a logarithmic time-decay so that fresh content is consistently
 * surfaced ahead of stale winners.
 *
 * The service is deterministic — all time primitives are injectable — and
 * is fully unit-testable without heavy data or network dependencies.
 */

import logger from '../lib/logger';
import { tokenise } from './TrendPredictor';
import type { BroadcastRecord } from './TrendPredictor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InteractionEvent {
  /** User that performed the interaction. */
  readonly userId: string;
  /** Broadcast that received the interaction. */
  readonly broadcastId: string;
  /** Kind of interaction. */
  readonly kind: 'view' | 'like' | 'reshare' | 'reply' | 'save';
  /** When the interaction occurred. */
  readonly at: Date;
  /** Optional dwell-time in milliseconds for view events. */
  readonly dwellMs?: number;
}

export interface FollowEdge {
  readonly followerId: string;
  readonly followeeId: string;
  /** Optional affinity weight, default 1. */
  readonly weight?: number;
}

export interface UserInterestProfile {
  readonly userId: string;
  /** Topic → weight (L2-normalised). */
  readonly topicVector: ReadonlyMap<string, number>;
  /** Broadcast ids the user has interacted with. */
  readonly interactedBroadcastIds: ReadonlySet<string>;
  /** Authors the user follows. */
  readonly followedAuthorIds: ReadonlySet<string>;
  /** Updated-at ISO timestamp. */
  readonly updatedAt: string;
  /** Total interactions considered during profile build. */
  readonly interactionCount: number;
}

export interface RankedBroadcast {
  readonly broadcast: BroadcastRecord;
  /** Final blended score, 0..1+. */
  readonly score: number;
  /** Content-based component. */
  readonly contentScore: number;
  /** Collaborative component. */
  readonly collaborativeScore: number;
  /** Recency weight. */
  readonly recencyWeight: number;
  /** Whether the author is followed. */
  readonly followedAuthor: boolean;
  /** Reasons surfaced to the UI (human-readable). */
  readonly reasons: readonly string[];
}

export interface FeedRankResult {
  readonly userId: string;
  readonly ranked: readonly RankedBroadcast[];
  readonly generatedAt: string;
  readonly blendWeights: {
    readonly content: number;
    readonly collaborative: number;
    readonly recency: number;
    readonly follow: number;
  };
}

export interface PersonalizedFeedAIOptions {
  readonly now?: () => Date;
  /** 0..1 share of the score attributed to content-based filtering. */
  readonly contentWeight?: number;
  /** 0..1 share attributed to collaborative filtering. */
  readonly collaborativeWeight?: number;
  /** 0..1 share attributed to recency. */
  readonly recencyWeight?: number;
  /** 0..1 share for a direct follow-graph bonus. */
  readonly followWeight?: number;
  /** Temporal half-life in hours for content recency. Default 8. */
  readonly recencyHalfLifeHours?: number;
  /** Nearest-neighbour pool size for collaborative filtering. Default 40. */
  readonly neighbourPoolSize?: number;
  /** Minimum similarity for a neighbour to qualify. Default 0.05. */
  readonly minNeighbourSimilarity?: number;
  /** How many broadcasts to return in rank(). Default 50. */
  readonly topK?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERACTION_WEIGHTS: Record<InteractionEvent['kind'], number> = {
  view: 1,
  like: 3,
  reshare: 5,
  reply: 4,
  save: 6,
};

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function dot(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  // Iterate the smaller map for efficiency.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [key, value] of small.entries()) {
    const other = large.get(key);
    if (other !== undefined) sum += value * other;
  }
  return sum;
}

function magnitude(vec: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const v of vec.values()) sum += v * v;
  return Math.sqrt(sum);
}

function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot(a, b) / (magA * magB);
}

function normalise(vec: Map<string, number>): Map<string, number> {
  const mag = magnitude(vec);
  if (mag === 0) return vec;
  for (const [key, value] of vec.entries()) {
    vec.set(key, value / mag);
  }
  return vec;
}

function addScaled(
  target: Map<string, number>,
  source: ReadonlyMap<string, number>,
  scale: number,
): void {
  for (const [key, value] of source.entries()) {
    target.set(key, (target.get(key) ?? 0) + value * scale);
  }
}

function computeRecencyWeight(
  postedAt: Date,
  now: Date,
  halfLifeHours: number,
): number {
  const ageHours = Math.max(0, (now.getTime() - postedAt.getTime()) / 3_600_000);
  return Math.pow(0.5, ageHours / Math.max(0.25, halfLifeHours));
}

function broadcastVector(broadcast: BroadcastRecord): Map<string, number> {
  const tokens = tokenise(broadcast.text);
  const vec = new Map<string, number>();
  for (const t of tokens) {
    vec.set(t, (vec.get(t) ?? 0) + 1);
  }
  for (const tag of broadcast.tags ?? []) {
    const clean = tag.toLowerCase().trim();
    if (clean) vec.set(clean, (vec.get(clean) ?? 0) + 2);
  }
  return vec;
}

// ---------------------------------------------------------------------------
// PersonalizedFeedAI class
// ---------------------------------------------------------------------------

export class PersonalizedFeedAI {
  private readonly now: () => Date;
  private readonly contentWeight: number;
  private readonly collaborativeWeight: number;
  private readonly recencyWeight: number;
  private readonly followWeight: number;
  private readonly recencyHalfLifeHours: number;
  private readonly neighbourPoolSize: number;
  private readonly minNeighbourSimilarity: number;
  private readonly topK: number;

  /** Cached user profiles, keyed by userId. */
  private readonly profiles: Map<string, UserInterestProfile> = new Map();
  /**
   * Cached user interaction vectors (per user → map of broadcastId → weight)
   * used for collaborative filtering neighbour lookups.
   */
  private readonly userInteractionVectors: Map<string, Map<string, number>> =
    new Map();

  constructor(options: PersonalizedFeedAIOptions = {}) {
    this.now = options.now ?? (() => new Date());

    // Normalise blend weights to sum 1.
    const c = options.contentWeight ?? 0.45;
    const co = options.collaborativeWeight ?? 0.3;
    const r = options.recencyWeight ?? 0.15;
    const f = options.followWeight ?? 0.1;
    const total = c + co + r + f;
    if (total <= 0) {
      throw new Error('Blend weights must sum to a positive number');
    }
    this.contentWeight = c / total;
    this.collaborativeWeight = co / total;
    this.recencyWeight = r / total;
    this.followWeight = f / total;

    this.recencyHalfLifeHours = options.recencyHalfLifeHours ?? 8;
    this.neighbourPoolSize = options.neighbourPoolSize ?? 40;
    this.minNeighbourSimilarity = options.minNeighbourSimilarity ?? 0.05;
    this.topK = options.topK ?? 50;
  }

  /**
   * Rebuild (or create) a user's interest profile from the supplied signals.
   * Call this any time the user interacts meaningfully with the feed.
   */
  buildProfile(
    userId: string,
    interactions: readonly InteractionEvent[],
    broadcasts: readonly BroadcastRecord[],
    follows: readonly FollowEdge[],
  ): UserInterestProfile {
    const broadcastMap = new Map(broadcasts.map((b) => [b.id, b]));

    const topicAcc = new Map<string, number>();
    const interactedBroadcastIds = new Set<string>();
    const interactionVec = new Map<string, number>();

    const nowDate = this.now();
    let interactionCount = 0;

    for (const event of interactions) {
      if (event.userId !== userId) continue;
      interactionCount += 1;
      interactedBroadcastIds.add(event.broadcastId);

      const weightBase = INTERACTION_WEIGHTS[event.kind] ?? 1;
      const dwellBonus = event.dwellMs
        ? Math.min(3, Math.log1p(event.dwellMs / 1000))
        : 0;
      const recency = computeRecencyWeight(event.at, nowDate, 48);
      const weight = (weightBase + dwellBonus) * recency;

      interactionVec.set(
        event.broadcastId,
        (interactionVec.get(event.broadcastId) ?? 0) + weight,
      );

      const broadcast = broadcastMap.get(event.broadcastId);
      if (broadcast) {
        const bVec = broadcastVector(broadcast);
        addScaled(topicAcc, bVec, weight);
      }
    }

    const topicVector = normalise(topicAcc);

    const followedAuthorIds = new Set<string>();
    for (const edge of follows) {
      if (edge.followerId === userId) {
        followedAuthorIds.add(edge.followeeId);
      }
    }

    const profile: UserInterestProfile = {
      userId,
      topicVector,
      interactedBroadcastIds,
      followedAuthorIds,
      updatedAt: nowDate.toISOString(),
      interactionCount,
    };

    this.profiles.set(userId, profile);
    this.userInteractionVectors.set(userId, interactionVec);

    logger.debug(
      {
        userId,
        topicVectorSize: topicVector.size,
        followedAuthors: followedAuthorIds.size,
        interactions: interactionCount,
      },
      'PersonalizedFeedAI profile rebuilt',
    );

    return profile;
  }

  /** Rebuild every profile contained within the supplied signals. */
  buildAllProfiles(
    interactions: readonly InteractionEvent[],
    broadcasts: readonly BroadcastRecord[],
    follows: readonly FollowEdge[],
  ): UserInterestProfile[] {
    const userIds = new Set<string>();
    for (const e of interactions) userIds.add(e.userId);
    for (const edge of follows) userIds.add(edge.followerId);
    const profiles: UserInterestProfile[] = [];
    for (const userId of userIds) {
      profiles.push(this.buildProfile(userId, interactions, broadcasts, follows));
    }
    return profiles;
  }

  /** Read-only accessor for a profile. */
  getProfile(userId: string): UserInterestProfile | null {
    return this.profiles.get(userId) ?? null;
  }

  /**
   * Rank a pool of candidate broadcasts for the given user.  Candidates
   * already interacted with are demoted (not strictly removed) so they can
   * still surface when nothing else is relevant.
   */
  rank(
    userId: string,
    candidates: readonly BroadcastRecord[],
    options: { topK?: number } = {},
  ): FeedRankResult {
    const nowDate = this.now();
    const profile = this.profiles.get(userId);
    const userVec = this.userInteractionVectors.get(userId) ?? new Map();

    const topK = options.topK ?? this.topK;
    const neighbours = this.findNeighbours(userId, userVec);

    const ranked: RankedBroadcast[] = candidates.map((broadcast) => {
      const reasons: string[] = [];
      const bVec = broadcastVector(broadcast);

      const contentScore = profile
        ? cosine(profile.topicVector, bVec)
        : 0;
      if (contentScore > 0.2) {
        reasons.push('Matches your interest graph');
      }

      let collabNumer = 0;
      let collabDenom = 0;
      for (const [neighbourId, similarity] of neighbours) {
        const vec = this.userInteractionVectors.get(neighbourId);
        const interactionWeight = vec?.get(broadcast.id) ?? 0;
        if (interactionWeight <= 0) continue;
        collabNumer += similarity * interactionWeight;
        collabDenom += similarity;
      }
      const rawCollab =
        collabDenom > 0 ? collabNumer / collabDenom : 0;
      const collaborativeScore = Math.min(1, rawCollab / 10);
      if (collaborativeScore > 0.1) {
        reasons.push('Users with taste like yours are engaging');
      }

      const recency = computeRecencyWeight(
        new Date(broadcast.postedAt),
        nowDate,
        this.recencyHalfLifeHours,
      );

      const followed =
        profile?.followedAuthorIds.has(broadcast.authorId) ?? false;
      if (followed) reasons.push('From someone you follow');

      // Demote already-consumed content.
      const alreadySeen =
        profile?.interactedBroadcastIds.has(broadcast.id) ?? false;
      const seenPenalty = alreadySeen ? 0.4 : 1;

      const score =
        (this.contentWeight * contentScore +
          this.collaborativeWeight * collaborativeScore +
          this.recencyWeight * recency +
          this.followWeight * (followed ? 1 : 0)) *
        seenPenalty;

      return {
        broadcast,
        score: Math.round(score * 10_000) / 10_000,
        contentScore: Math.round(contentScore * 10_000) / 10_000,
        collaborativeScore: Math.round(collaborativeScore * 10_000) / 10_000,
        recencyWeight: Math.round(recency * 10_000) / 10_000,
        followedAuthor: followed,
        reasons,
      };
    });

    ranked.sort((a, b) => b.score - a.score);

    const result: FeedRankResult = {
      userId,
      ranked: ranked.slice(0, topK),
      generatedAt: nowDate.toISOString(),
      blendWeights: {
        content: this.contentWeight,
        collaborative: this.collaborativeWeight,
        recency: this.recencyWeight,
        follow: this.followWeight,
      },
    };

    logger.debug(
      {
        userId,
        candidates: candidates.length,
        returned: result.ranked.length,
        topScore: result.ranked[0]?.score ?? 0,
      },
      'PersonalizedFeedAI ranked feed',
    );

    return result;
  }

  /**
   * Compute cosine similarity between two users' interaction vectors.
   * Exposed for testing and analytics.
   */
  userSimilarity(userA: string, userB: string): number {
    const a = this.userInteractionVectors.get(userA);
    const b = this.userInteractionVectors.get(userB);
    if (!a || !b) return 0;
    return cosine(a, b);
  }

  private findNeighbours(
    userId: string,
    userVec: ReadonlyMap<string, number>,
  ): Array<[string, number]> {
    if (userVec.size === 0) return [];
    const results: Array<[string, number]> = [];
    for (const [candidateId, candidateVec] of this.userInteractionVectors) {
      if (candidateId === userId) continue;
      const sim = cosine(userVec, candidateVec);
      if (sim >= this.minNeighbourSimilarity) {
        results.push([candidateId, sim]);
      }
    }
    results.sort((a, b) => b[1] - a[1]);
    return results.slice(0, this.neighbourPoolSize);
  }
}

// ---------------------------------------------------------------------------
// Summary helpers — useful when exposing the feed to clients
// ---------------------------------------------------------------------------

export function summariseRanking(result: FeedRankResult, limit = 5): string {
  const top = result.ranked.slice(0, limit);
  if (top.length === 0) return 'No content ranked for this user.';
  const parts = top.map((r, i) => {
    const tags = r.reasons.length > 0 ? ` [${r.reasons.join(' · ')}]` : '';
    return `${i + 1}. ${r.broadcast.id} score=${r.score}${tags}`;
  });
  return parts.join('\n');
}

export default PersonalizedFeedAI;
