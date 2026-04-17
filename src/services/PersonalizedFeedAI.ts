/**
 * PersonalizedFeedAI
 *
 * Builds a personalised ranked feed for each user by combining:
 *
 *   1. Content-based filtering — topic similarity via cosine similarity on
 *      TF-IDF vectors derived from the user's interest profile.
 *
 *   2. Collaborative filtering — "users like you also engaged with …"
 *      signal sourced from aggregated co-engagement matrices.
 *
 *   3. Hybrid ranking — both signals are blended with time-decay weighting
 *      so recency is always a strong positive factor.
 *
 * The class is designed to be deterministic and fully unit-testable; inject
 * a `now` clock to control time in tests.
 */

import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UserInterestGraph {
  /** Unique user identifier. */
  readonly userId: string;
  /** IDs of broadcasts the user has viewed, in order of recency (newest first). */
  readonly viewHistory: readonly string[];
  /** IDs of broadcasts the user has liked. */
  readonly likeHistory: readonly string[];
  /** IDs of users this user follows. */
  readonly followedUserIds: readonly string[];
  /** Explicit topic preferences set by the user (e.g. "machine learning"). */
  readonly explicitTopics: readonly string[];
}

export interface BroadcastItem {
  /** Unique broadcast identifier. */
  readonly id: string;
  /** Raw text content. */
  readonly content: string;
  /** Author user ID. */
  readonly authorId: string;
  /** UTC epoch ms of publication. */
  readonly publishedAt: number;
  /** Cumulative engagement count. */
  readonly engagementCount: number;
  /** Optional pre-computed tags / categories. */
  readonly tags?: readonly string[];
}

export interface RankedItem {
  readonly broadcastId: string;
  /** Final hybrid score (higher = more relevant). */
  readonly score: number;
  /** Content-based similarity contribution. */
  readonly contentScore: number;
  /** Collaborative filtering contribution. */
  readonly collaborativeScore: number;
  /** Time-decay multiplier applied (0-1). */
  readonly timeDecay: number;
  /** Human-readable reason for inclusion. */
  readonly reason: string;
}

export interface PersonalizedFeedResult {
  readonly userId: string;
  readonly generatedAt: string;
  /** Ordered list of recommended broadcasts (most relevant first). */
  readonly rankedItems: readonly RankedItem[];
  /** Number of candidate items evaluated. */
  readonly candidateCount: number;
}

export interface CoEngagementEntry {
  /** User ID. */
  readonly userId: string;
  /** Broadcast IDs this user has engaged with. */
  readonly engagedBroadcasts: readonly string[];
}

export interface PersonalizedFeedAIOptions {
  /** Injected clock (epoch ms). */
  readonly now?: () => number;
  /** Weight for content-based signal in hybrid blend (0-1, default 0.5). */
  readonly contentWeight?: number;
  /** Weight for collaborative signal in hybrid blend (0-1, default 0.5). */
  readonly collaborativeWeight?: number;
  /** Half-life for time decay in milliseconds (default: 12 hours). */
  readonly timeDecayHalfLifeMs?: number;
  /** Maximum feed size to return (default: 20). */
  readonly feedSize?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers — tokenisation & TF-IDF
// ---------------------------------------------------------------------------

const STOP_WORDS_CF = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'do', 'does', 'will', 'would', 'can', 'could', 'not',
  'this', 'that', 'it', 'its', 'we', 'you', 'he', 'she', 'they', 'all',
]);

function tokeniseCF(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS_CF.has(t));
}

/** Build TF vector (term → normalised frequency) for a document. */
function buildTFVector(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const total = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const [term, c] of counts) {
    tf.set(term, c / total);
  }
  return tf;
}

/** Compute smoothed IDF over a collection of token lists. */
function buildIDF(allTokenSets: string[][]): Map<string, number> {
  const N = allTokenSets.length;
  const df = new Map<string, number>();
  for (const tokens of allTokenSets) {
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, docFreq] of df) {
    idf.set(term, Math.log((1 + N) / (1 + docFreq)) + 1);
  }
  return idf;
}

/** Convert TF map + IDF map into a TF-IDF vector (term → tfidf weight). */
function tfidfVector(tf: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const vec = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    vec.set(term, tfVal * (idf.get(term) ?? 1));
  }
  return vec;
}

/**
 * Cosine similarity between two sparse TF-IDF vectors.
 * Returns a value in [0, 1].
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, aVal] of a) {
    normA += aVal * aVal;
    const bVal = b.get(term);
    if (bVal !== undefined) {
      dot += aVal * bVal;
    }
  }
  for (const [, bVal] of b) {
    normB += bVal * bVal;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Exponential time-decay factor.
 * Returns 1.0 for brand-new content and approaches 0 as age → ∞.
 * Half-life: the age at which decay = 0.5.
 */
function timeDecayFactor(publishedAt: number, nowMs: number, halfLifeMs: number): number {
  const ageMs = Math.max(0, nowMs - publishedAt);
  return Math.pow(0.5, ageMs / halfLifeMs);
}

// ---------------------------------------------------------------------------
// Interest profile builder
// ---------------------------------------------------------------------------

/**
 * Aggregate user signals into a single weighted interest TF-IDF vector.
 * Like history is weighted 3×, view history 1×, explicit topics 2×.
 */
function buildInterestVector(
  user: UserInterestGraph,
  broadcastMap: Map<string, BroadcastItem>,
  idf: Map<string, number>,
): Map<string, number> {
  const weightedTerms = new Map<string, number>();

  const addTerms = (broadcastId: string, weight: number): void => {
    const item = broadcastMap.get(broadcastId);
    if (!item) return;
    const tokens = tokeniseCF(item.content + ' ' + (item.tags ?? []).join(' '));
    const tf = buildTFVector(tokens);
    for (const [term, tfVal] of tf) {
      const idfVal = idf.get(term) ?? 1;
      weightedTerms.set(term, (weightedTerms.get(term) ?? 0) + tfVal * idfVal * weight);
    }
  };

  // View history — weight 1, capped at 50 most recent
  const recentViews = user.viewHistory.slice(0, 50);
  for (const id of recentViews) addTerms(id, 1);

  // Like history — weight 3 (strong positive signal)
  for (const id of user.likeHistory) addTerms(id, 3);

  // Explicit topic preferences — injected as synthetic pseudo-documents
  if (user.explicitTopics.length > 0) {
    const syntheticContent = user.explicitTopics.join(' ');
    const tokens = tokeniseCF(syntheticContent);
    const tf = buildTFVector(tokens);
    for (const [term, tfVal] of tf) {
      const idfVal = idf.get(term) ?? 1;
      weightedTerms.set(term, (weightedTerms.get(term) ?? 0) + tfVal * idfVal * 2);
    }
  }

  return weightedTerms;
}

// ---------------------------------------------------------------------------
// Collaborative filtering helpers
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity between two sets of broadcast IDs.
 * Range: [0, 1].
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const id of a) {
    if (b.has(id)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build a set of "recommended by similar users" broadcast IDs with scores.
 *
 * Algorithm:
 *  1. For each peer user, compute Jaccard similarity with the target user's
 *     engagement set (views + likes).
 *  2. Weight each peer's unseen broadcasts by peer similarity.
 *  3. Aggregate and normalise to [0, 1].
 */
function collaborativeScores(
  targetUser: UserInterestGraph,
  peers: readonly CoEngagementEntry[],
  seenIds: Set<string>,
): Map<string, number> {
  const targetSet = new Set([...targetUser.viewHistory, ...targetUser.likeHistory]);
  const rawScores = new Map<string, number>();

  let totalSimilarity = 0;

  for (const peer of peers) {
    if (peer.userId === targetUser.userId) continue;
    const peerSet = new Set(peer.engagedBroadcasts);
    const sim = jaccardSimilarity(targetSet, peerSet);
    if (sim === 0) continue;
    totalSimilarity += sim;
    for (const bId of peerSet) {
      if (!seenIds.has(bId)) {
        rawScores.set(bId, (rawScores.get(bId) ?? 0) + sim);
      }
    }
  }

  // Normalise by total similarity to keep scores in [0, 1]
  if (totalSimilarity === 0) return new Map();
  const normalised = new Map<string, number>();
  for (const [id, score] of rawScores) {
    normalised.set(id, score / totalSimilarity);
  }
  return normalised;
}

// ---------------------------------------------------------------------------
// PersonalizedFeedAI
// ---------------------------------------------------------------------------

export class PersonalizedFeedAI {
  private readonly now: () => number;
  private readonly contentWeight: number;
  private readonly collaborativeWeight: number;
  private readonly timeDecayHalfLifeMs: number;
  private readonly feedSize: number;

  constructor(options: PersonalizedFeedAIOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.contentWeight = options.contentWeight ?? 0.5;
    this.collaborativeWeight = options.collaborativeWeight ?? 0.5;
    this.timeDecayHalfLifeMs = options.timeDecayHalfLifeMs ?? 12 * 60 * 60 * 1_000;
    this.feedSize = options.feedSize ?? 20;

    if (Math.abs(this.contentWeight + this.collaborativeWeight - 1) > 0.001) {
      throw new Error(
        `PersonalizedFeedAI: contentWeight (${this.contentWeight}) + collaborativeWeight (${this.collaborativeWeight}) must sum to 1`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Primary API
  // -------------------------------------------------------------------------

  /**
   * Generate a personalised, ranked feed for the given user.
   *
   * @param user         The target user's interest graph.
   * @param candidates   Broadcast items to rank.
   * @param peers        Co-engagement data from similar users (for collaborative filtering).
   * @returns            Ranked feed result with up to `feedSize` items.
   */
  rankFeed(
    user: UserInterestGraph,
    candidates: readonly BroadcastItem[],
    peers: readonly CoEngagementEntry[] = [],
  ): PersonalizedFeedResult {
    const nowMs = this.now();
    const broadcastMap = new Map<string, BroadcastItem>(candidates.map((b) => [b.id, b]));

    // 1. Build corpus-wide IDF over all candidates
    const allTokenSets = candidates.map((b) =>
      tokeniseCF(b.content + ' ' + (b.tags ?? []).join(' ')),
    );
    const idf = buildIDF(allTokenSets);

    // 2. Build the user's interest vector
    const interestVec = buildInterestVector(user, broadcastMap, idf);

    // 3. Compute collaborative scores for unseen broadcasts
    const seenIds = new Set([...user.viewHistory, ...user.likeHistory]);
    const collabScores = collaborativeScores(user, peers, seenIds);

    // 4. Score every candidate
    const ranked: RankedItem[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const broadcast = candidates[i];
      const tokens = allTokenSets[i];
      const tf = buildTFVector(tokens);
      const broadcastVec = tfidfVector(tf, idf);

      const contentScore = cosineSimilarity(interestVec, broadcastVec);
      const collabScore = collabScores.get(broadcast.id) ?? 0;
      const decay = timeDecayFactor(broadcast.publishedAt, nowMs, this.timeDecayHalfLifeMs);

      const hybrid =
        (this.contentWeight * contentScore + this.collaborativeWeight * collabScore) * decay;

      const reason = this.buildReason(contentScore, collabScore, decay, seenIds.has(broadcast.id));

      ranked.push({
        broadcastId: broadcast.id,
        score: hybrid,
        contentScore,
        collaborativeScore: collabScore,
        timeDecay: decay,
        reason,
      });
    }

    ranked.sort((a, b) => b.score - a.score);

    const result: PersonalizedFeedResult = {
      userId: user.userId,
      generatedAt: new Date(nowMs).toISOString(),
      rankedItems: ranked.slice(0, this.feedSize),
      candidateCount: candidates.length,
    };

    logger.debug(
      { userId: user.userId, candidateCount: candidates.length, topScore: ranked[0]?.score ?? 0 },
      'PersonalizedFeedAI feed ranked',
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Incremental / streaming ranking
  // -------------------------------------------------------------------------

  /**
   * Re-score a single broadcast item against an existing interest vector.
   * Useful for live feed updates without rebuilding the full corpus.
   */
  scoreItem(
    interestVector: Map<string, number>,
    broadcast: BroadcastItem,
    idf: Map<string, number>,
  ): number {
    const tokens = tokeniseCF(broadcast.content + ' ' + (broadcast.tags ?? []).join(' '));
    const tf = buildTFVector(tokens);
    const broadcastVec = tfidfVector(tf, idf);
    const contentScore = cosineSimilarity(interestVector, broadcastVec);
    const decay = timeDecayFactor(broadcast.publishedAt, this.now(), this.timeDecayHalfLifeMs);
    return contentScore * decay;
  }

  /**
   * Compute and expose the IDF map for a set of candidates.
   * Needed when calling `scoreItem` incrementally.
   */
  buildCorpusIDF(candidates: readonly BroadcastItem[]): Map<string, number> {
    const tokenSets = candidates.map((b) =>
      tokeniseCF(b.content + ' ' + (b.tags ?? []).join(' ')),
    );
    return buildIDF(tokenSets);
  }

  /**
   * Build and expose the user interest vector.
   * Needed when calling `scoreItem` incrementally.
   */
  buildUserInterestVector(
    user: UserInterestGraph,
    broadcastMap: Map<string, BroadcastItem>,
    idf: Map<string, number>,
  ): Map<string, number> {
    return buildInterestVector(user, broadcastMap, idf);
  }

  // -------------------------------------------------------------------------
  // Interest graph analysis
  // -------------------------------------------------------------------------

  /**
   * Return the top-N terms from the user's interest vector.
   * Useful for debugging and for building topic labels in the UI.
   */
  topInterestTerms(
    user: UserInterestGraph,
    candidates: readonly BroadcastItem[],
    topN = 10,
  ): Array<{ term: string; weight: number }> {
    const broadcastMap = new Map<string, BroadcastItem>(candidates.map((b) => [b.id, b]));
    const allTokenSets = candidates.map((b) =>
      tokeniseCF(b.content + ' ' + (b.tags ?? []).join(' ')),
    );
    const idf = buildIDF(allTokenSets);
    const vec = buildInterestVector(user, broadcastMap, idf);

    return [...vec.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([term, weight]) => ({ term, weight }));
  }

  /**
   * Compute pairwise user similarity scores between a target user and a list
   * of peers.  Returns sorted by similarity descending.
   */
  findSimilarUsers(
    target: UserInterestGraph,
    peers: readonly CoEngagementEntry[],
  ): Array<{ userId: string; similarity: number }> {
    const targetSet = new Set([...target.viewHistory, ...target.likeHistory]);
    const results: Array<{ userId: string; similarity: number }> = [];

    for (const peer of peers) {
      if (peer.userId === target.userId) continue;
      const peerSet = new Set(peer.engagedBroadcasts);
      const sim = jaccardSimilarity(targetSet, peerSet);
      if (sim > 0) results.push({ userId: peer.userId, similarity: sim });
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildReason(
    contentScore: number,
    collabScore: number,
    decay: number,
    alreadySeen: boolean,
  ): string {
    const parts: string[] = [];
    if (alreadySeen) parts.push('revisit');
    if (contentScore > 0.3) parts.push('matches your interests');
    else if (contentScore > 0.1) parts.push('partially matches your topics');
    if (collabScore > 0.5) parts.push('highly popular with similar users');
    else if (collabScore > 0.2) parts.push('trending with similar users');
    if (decay < 0.3) parts.push('older content');
    else if (decay > 0.8) parts.push('very recent');
    return parts.length > 0 ? parts.join('; ') : 'general recommendation';
  }
}

export default PersonalizedFeedAI;
