import PersonalizedFeedAI, {
  UserInterestGraph,
  BroadcastItem,
  CoEngagementEntry,
} from '../services/PersonalizedFeedAI';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_TIME = new Date('2026-04-17T12:00:00Z').getTime();

function hoursAgo(h: number): number {
  return BASE_TIME - h * 60 * 60 * 1_000;
}

const BROADCASTS: BroadcastItem[] = [
  {
    id: 'b1',
    content: 'machine learning neural networks deep learning transformers attention',
    authorId: 'author-1',
    publishedAt: hoursAgo(1),
    engagementCount: 500,
    tags: ['ML', 'AI', 'transformers'],
  },
  {
    id: 'b2',
    content: 'reinforcement learning reward shaping policy gradient deep learning',
    authorId: 'author-2',
    publishedAt: hoursAgo(2),
    engagementCount: 420,
    tags: ['RL', 'AI'],
  },
  {
    id: 'b3',
    content: 'quantitative finance derivatives pricing volatility surface options',
    authorId: 'author-3',
    publishedAt: hoursAgo(3),
    engagementCount: 380,
    tags: ['Quant', 'Finance'],
  },
  {
    id: 'b4',
    content: 'blockchain distributed ledger consensus protocol nodes',
    authorId: 'author-4',
    publishedAt: hoursAgo(4),
    engagementCount: 250,
    tags: ['Blockchain', 'Crypto'],
  },
  {
    id: 'b5',
    content: 'natural language processing text classification sentiment analysis bert',
    authorId: 'author-5',
    publishedAt: hoursAgo(5),
    engagementCount: 310,
    tags: ['NLP', 'AI', 'BERT'],
  },
];

const ML_USER: UserInterestGraph = {
  userId: 'user-ml',
  viewHistory: ['b1', 'b2', 'b5'],
  likeHistory: ['b1'],
  followedUserIds: ['author-1', 'author-5'],
  explicitTopics: ['machine learning', 'natural language processing'],
};

const FINANCE_USER: UserInterestGraph = {
  userId: 'user-finance',
  viewHistory: ['b3'],
  likeHistory: ['b3'],
  followedUserIds: ['author-3'],
  explicitTopics: ['quantitative finance', 'derivatives'],
};

const PEERS: CoEngagementEntry[] = [
  { userId: 'peer-1', engagedBroadcasts: ['b1', 'b2', 'b5'] },
  { userId: 'peer-2', engagedBroadcasts: ['b1', 'b2'] },
  { userId: 'peer-3', engagedBroadcasts: ['b3', 'b4'] },
];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('PersonalizedFeedAI — construction', () => {
  it('constructs with default options', () => {
    expect(() => new PersonalizedFeedAI()).not.toThrow();
  });

  it('throws when contentWeight + collaborativeWeight ≠ 1', () => {
    expect(
      () => new PersonalizedFeedAI({ contentWeight: 0.6, collaborativeWeight: 0.6 }),
    ).toThrow(/sum to 1/);
  });

  it('accepts custom weights that sum to 1', () => {
    expect(
      () => new PersonalizedFeedAI({ contentWeight: 0.7, collaborativeWeight: 0.3 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rankFeed — basic output shape
// ---------------------------------------------------------------------------

describe('PersonalizedFeedAI — rankFeed', () => {
  const ai = new PersonalizedFeedAI({ now: () => BASE_TIME });

  it('returns a result with the correct userId', () => {
    const result = ai.rankFeed(ML_USER, BROADCASTS, PEERS);
    expect(result.userId).toBe('user-ml');
  });

  it('respects the feedSize cap', () => {
    const smallAI = new PersonalizedFeedAI({ now: () => BASE_TIME, feedSize: 3 });
    const result = smallAI.rankFeed(ML_USER, BROADCASTS, PEERS);
    expect(result.rankedItems.length).toBeLessThanOrEqual(3);
  });

  it('returns candidateCount equal to the number of candidates supplied', () => {
    const result = ai.rankFeed(ML_USER, BROADCASTS);
    expect(result.candidateCount).toBe(BROADCASTS.length);
  });

  it('items are sorted by score descending', () => {
    const result = ai.rankFeed(ML_USER, BROADCASTS, PEERS);
    const scores = result.rankedItems.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('all scores are non-negative', () => {
    const result = ai.rankFeed(ML_USER, BROADCASTS, PEERS);
    for (const item of result.rankedItems) {
      expect(item.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('ML user ranks ML-related broadcasts higher than finance', () => {
    const result = ai.rankFeed(ML_USER, BROADCASTS, PEERS);
    const ranked = result.rankedItems;
    const mlIds = ['b1', 'b2', 'b5'];
    const financeId = 'b3';
    const mlRanks = mlIds.map((id) => ranked.findIndex((r) => r.broadcastId === id));
    const financeRank = ranked.findIndex((r) => r.broadcastId === financeId);
    // At least one ML item should rank ahead of finance
    const minMlRank = Math.min(...mlRanks.filter((r) => r >= 0));
    expect(minMlRank).toBeLessThan(financeRank);
  });

  it('finance user ranks finance broadcast higher than ML content', () => {
    const result = ai.rankFeed(FINANCE_USER, BROADCASTS);
    const ranked = result.rankedItems;
    const financeRank = ranked.findIndex((r) => r.broadcastId === 'b3');
    const mlRank = ranked.findIndex((r) => r.broadcastId === 'b1');
    expect(financeRank).toBeLessThan(mlRank);
  });

  it('includes a reason string on every ranked item', () => {
    const result = ai.rankFeed(ML_USER, BROADCASTS, PEERS);
    for (const item of result.rankedItems) {
      expect(typeof item.reason).toBe('string');
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  it('time decay is lower for older broadcasts', () => {
    const result = ai.rankFeed(ML_USER, BROADCASTS);
    const b1 = result.rankedItems.find((r) => r.broadcastId === 'b1');
    const b5 = result.rankedItems.find((r) => r.broadcastId === 'b5');
    // b1 is 1h old, b5 is 5h old — b1 should have higher time decay
    expect(b1!.timeDecay).toBeGreaterThan(b5!.timeDecay);
  });

  it('handles empty candidate list', () => {
    const result = ai.rankFeed(ML_USER, []);
    expect(result.rankedItems).toHaveLength(0);
    expect(result.candidateCount).toBe(0);
  });

  it('handles user with empty history', () => {
    const emptyUser: UserInterestGraph = {
      userId: 'empty-user',
      viewHistory: [],
      likeHistory: [],
      followedUserIds: [],
      explicitTopics: [],
    };
    const result = ai.rankFeed(emptyUser, BROADCASTS);
    expect(result.rankedItems.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// topInterestTerms
// ---------------------------------------------------------------------------

describe('PersonalizedFeedAI — topInterestTerms', () => {
  it('returns up to topN terms', () => {
    const ai = new PersonalizedFeedAI({ now: () => BASE_TIME });
    const terms = ai.topInterestTerms(ML_USER, BROADCASTS, 5);
    expect(terms.length).toBeLessThanOrEqual(5);
  });

  it('returns terms with positive weight for a user with history', () => {
    const ai = new PersonalizedFeedAI({ now: () => BASE_TIME });
    const terms = ai.topInterestTerms(ML_USER, BROADCASTS);
    expect(terms.every((t) => t.weight > 0)).toBe(true);
  });

  it('returns empty for user with no history and no explicit topics', () => {
    const ai = new PersonalizedFeedAI({ now: () => BASE_TIME });
    const emptyUser: UserInterestGraph = {
      userId: 'ghost',
      viewHistory: [],
      likeHistory: [],
      followedUserIds: [],
      explicitTopics: [],
    };
    const terms = ai.topInterestTerms(emptyUser, BROADCASTS);
    expect(terms).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findSimilarUsers
// ---------------------------------------------------------------------------

describe('PersonalizedFeedAI — findSimilarUsers', () => {
  const ai = new PersonalizedFeedAI({ now: () => BASE_TIME });

  it('returns similar users sorted by similarity descending', () => {
    const result = ai.findSimilarUsers(ML_USER, PEERS);
    const sims = result.map((r) => r.similarity);
    for (let i = 1; i < sims.length; i++) {
      expect(sims[i - 1]).toBeGreaterThanOrEqual(sims[i]);
    }
  });

  it('excludes the target user from results', () => {
    const peersWithSelf: CoEngagementEntry[] = [
      ...PEERS,
      { userId: ML_USER.userId, engagedBroadcasts: ['b1', 'b2'] },
    ];
    const result = ai.findSimilarUsers(ML_USER, peersWithSelf);
    expect(result.every((r) => r.userId !== ML_USER.userId)).toBe(true);
  });

  it('returns empty array when no overlap with any peer', () => {
    const isolated: UserInterestGraph = {
      userId: 'isolated-user',
      viewHistory: ['b999'],
      likeHistory: [],
      followedUserIds: [],
      explicitTopics: [],
    };
    const result = ai.findSimilarUsers(isolated, PEERS);
    expect(result).toHaveLength(0);
  });

  it('returns all similarities in [0, 1]', () => {
    const result = ai.findSimilarUsers(ML_USER, PEERS);
    for (const r of result) {
      expect(r.similarity).toBeGreaterThanOrEqual(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreItem / buildCorpusIDF / buildUserInterestVector
// ---------------------------------------------------------------------------

describe('PersonalizedFeedAI — incremental scoring API', () => {
  const ai = new PersonalizedFeedAI({ now: () => BASE_TIME });

  it('scoreItem returns a non-negative value', () => {
    const broadcastMap = new Map(BROADCASTS.map((b) => [b.id, b]));
    const idf = ai.buildCorpusIDF(BROADCASTS);
    const interestVec = ai.buildUserInterestVector(ML_USER, broadcastMap, idf);
    const score = ai.scoreItem(interestVec, BROADCASTS[0], idf);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('scoreItem assigns higher score to topically matched broadcast', () => {
    const broadcastMap = new Map(BROADCASTS.map((b) => [b.id, b]));
    const idf = ai.buildCorpusIDF(BROADCASTS);
    const interestVec = ai.buildUserInterestVector(ML_USER, broadcastMap, idf);
    const mlScore = ai.scoreItem(interestVec, BROADCASTS[0], idf); // b1 — ML
    const financeScore = ai.scoreItem(interestVec, BROADCASTS[2], idf); // b3 — Finance
    expect(mlScore).toBeGreaterThan(financeScore);
  });
});
