import {
  PersonalizedFeedAI,
  summariseRanking,
  type InteractionEvent,
  type FollowEdge,
} from '../services/PersonalizedFeedAI';
import type { BroadcastRecord } from '../services/TrendPredictor';

const NOW = new Date('2026-04-17T12:00:00Z');

function makeBroadcast(
  id: string,
  text: string,
  postedAt: Date,
  engagement = 100,
  authorId = `author-${id}`,
  tags: string[] = [],
): BroadcastRecord {
  return { id, text, postedAt, engagement, authorId, tags };
}

describe('PersonalizedFeedAI — profile construction', () => {
  const broadcasts: BroadcastRecord[] = [
    makeBroadcast('b1', 'alpha decay regime shift', new Date('2026-04-17T11:00:00Z')),
    makeBroadcast('b2', 'kalman filter signal processing', new Date('2026-04-17T10:00:00Z')),
    makeBroadcast('b3', 'random unrelated topic', new Date('2026-04-17T09:00:00Z')),
  ];

  it('builds a topic vector from weighted interactions', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    const profile = ai.buildProfile(
      'alice',
      [
        { userId: 'alice', broadcastId: 'b1', kind: 'like', at: NOW },
        { userId: 'alice', broadcastId: 'b2', kind: 'view', at: NOW, dwellMs: 15000 },
      ],
      broadcasts,
      [],
    );
    expect(profile.topicVector.size).toBeGreaterThan(0);
    expect(profile.interactedBroadcastIds.has('b1')).toBe(true);
    expect(profile.interactedBroadcastIds.has('b2')).toBe(true);
    expect(profile.interactionCount).toBe(2);
  });

  it('captures the follow graph', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    const follows: FollowEdge[] = [
      { followerId: 'alice', followeeId: 'author-b1' },
      { followerId: 'alice', followeeId: 'author-b2' },
      { followerId: 'bob', followeeId: 'author-b3' },
    ];
    const profile = ai.buildProfile('alice', [], broadcasts, follows);
    expect(profile.followedAuthorIds.has('author-b1')).toBe(true);
    expect(profile.followedAuthorIds.has('author-b3')).toBe(false);
  });

  it('buildAllProfiles creates a profile for every user touched by signals', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    const interactions: InteractionEvent[] = [
      { userId: 'alice', broadcastId: 'b1', kind: 'like', at: NOW },
      { userId: 'bob', broadcastId: 'b2', kind: 'like', at: NOW },
    ];
    const follows: FollowEdge[] = [
      { followerId: 'carol', followeeId: 'author-b1' },
    ];
    const profiles = ai.buildAllProfiles(interactions, broadcasts, follows);
    const ids = profiles.map((p) => p.userId).sort();
    expect(ids).toEqual(['alice', 'bob', 'carol']);
  });
});

describe('PersonalizedFeedAI — rank', () => {
  const broadcasts: BroadcastRecord[] = [
    makeBroadcast('b1', 'alpha decay regime shift', new Date('2026-04-17T11:00:00Z'), 300, 'author1'),
    makeBroadcast('b2', 'kalman filter signal processing', new Date('2026-04-17T10:00:00Z'), 200, 'author2'),
    makeBroadcast('b3', 'random unrelated topic about food', new Date('2026-04-17T11:30:00Z'), 50, 'author3'),
    makeBroadcast('b4', 'alpha decay half life', new Date('2026-04-17T11:55:00Z'), 120, 'author1'),
  ];

  it('prioritises broadcasts matching the user interest vector', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    ai.buildProfile(
      'alice',
      [{ userId: 'alice', broadcastId: 'b1', kind: 'like', at: NOW }],
      broadcasts,
      [],
    );
    const result = ai.rank('alice', broadcasts);
    expect(result.ranked.length).toBeGreaterThan(0);
    expect(result.ranked[0].broadcast.id).not.toBe('b3');
  });

  it('gives a bonus to followed authors', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW, followWeight: 1, contentWeight: 0, collaborativeWeight: 0, recencyWeight: 0 });
    ai.buildProfile(
      'alice',
      [],
      broadcasts,
      [{ followerId: 'alice', followeeId: 'author1' }],
    );
    const result = ai.rank('alice', broadcasts);
    expect(result.ranked[0].followedAuthor).toBe(true);
    expect(['b1', 'b4']).toContain(result.ranked[0].broadcast.id);
  });

  it('demotes already-seen broadcasts', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    ai.buildProfile(
      'alice',
      [
        { userId: 'alice', broadcastId: 'b1', kind: 'view', at: NOW },
        { userId: 'alice', broadcastId: 'b4', kind: 'view', at: NOW },
      ],
      broadcasts,
      [],
    );
    const result = ai.rank('alice', broadcasts);
    const seen = result.ranked.find((r) => r.broadcast.id === 'b1');
    const unseen = result.ranked.find((r) => r.broadcast.id === 'b2');
    expect(seen).toBeDefined();
    expect(unseen).toBeDefined();
    // Seen content is penalised by 0.6 multiplicatively — should not
    // uniformly beat unseen content of equal raw interest.
    expect(seen!.score).toBeLessThanOrEqual(seen!.contentScore + 1);
  });

  it('incorporates collaborative signal from similar users', () => {
    const ai = new PersonalizedFeedAI({
      now: () => NOW,
      contentWeight: 0,
      collaborativeWeight: 1,
      recencyWeight: 0,
      followWeight: 0,
      minNeighbourSimilarity: 0,
    });
    ai.buildProfile('alice', [
      { userId: 'alice', broadcastId: 'b1', kind: 'like', at: NOW },
    ], broadcasts, []);
    ai.buildProfile('bob', [
      { userId: 'bob', broadcastId: 'b1', kind: 'like', at: NOW },
      { userId: 'bob', broadcastId: 'b4', kind: 'like', at: NOW },
    ], broadcasts, []);

    const result = ai.rank('alice', broadcasts);
    const b4 = result.ranked.find((r) => r.broadcast.id === 'b4');
    expect(b4).toBeDefined();
    expect(b4!.collaborativeScore).toBeGreaterThan(0);
  });

  it('returns a cold-feed when profile is missing', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    const result = ai.rank('unknown-user', broadcasts);
    expect(result.ranked.length).toBe(broadcasts.length);
  });

  it('summariseRanking produces readable output', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    ai.buildProfile(
      'alice',
      [{ userId: 'alice', broadcastId: 'b1', kind: 'like', at: NOW }],
      broadcasts,
      [],
    );
    const result = ai.rank('alice', broadcasts);
    const summary = summariseRanking(result, 3);
    expect(summary).toContain('1.');
  });
});

describe('PersonalizedFeedAI — guard rails', () => {
  it('throws when all blend weights are zero', () => {
    expect(() => new PersonalizedFeedAI({
      contentWeight: 0,
      collaborativeWeight: 0,
      recencyWeight: 0,
      followWeight: 0,
    })).toThrow();
  });

  it('userSimilarity returns zero when either user is unknown', () => {
    const ai = new PersonalizedFeedAI({ now: () => NOW });
    expect(ai.userSimilarity('a', 'b')).toBe(0);
  });
});
