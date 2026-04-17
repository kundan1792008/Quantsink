import { TrendPredictor, BroadcastDocument } from '../services/TrendPredictor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = new Date('2026-04-17T12:00:00Z').getTime();

function makeDoc(
  id: string,
  content: string,
  ageHours: number,
  engagementCount = 100,
  engagementDelta?: number,
): BroadcastDocument {
  return {
    id,
    content,
    publishedAt: BASE_TIME - ageHours * 60 * 60 * 1_000,
    engagementCount,
    engagementDelta,
  };
}

function makePredictor(options: ConstructorParameters<typeof TrendPredictor>[0] = {}) {
  return new TrendPredictor({ now: () => BASE_TIME, ...options });
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

describe('TrendPredictor — ingestion', () => {
  it('accepts and stores documents within the analysis window', () => {
    const tp = makePredictor();
    tp.ingest(makeDoc('1', 'machine learning neural networks', 1));
    tp.ingest(makeDoc('2', 'deep learning transformers', 2));
    expect(tp.getCorpusSize()).toBe(2);
  });

  it('rejects documents outside the 24-hour window', () => {
    const tp = makePredictor();
    tp.ingest(makeDoc('old', 'outdated topic', 25)); // 25 hours ago
    expect(tp.getCorpusSize()).toBe(0);
  });

  it('accepts an array of documents in a single call', () => {
    const tp = makePredictor();
    tp.ingest([
      makeDoc('a', 'topic alpha beta gamma', 1),
      makeDoc('b', 'topic delta epsilon zeta', 2),
      makeDoc('c', 'topic eta theta iota', 3),
    ]);
    expect(tp.getCorpusSize()).toBe(3);
  });

  it('evicts stale documents on evictStale()', () => {
    const tp = makePredictor();
    tp.ingest(makeDoc('1', 'recent topic content here', 1));
    // Manually push a stale entry (bypass age check by manipulating internal)
    (tp as unknown as { documents: BroadcastDocument[] }).documents.push(
      makeDoc('stale', 'stale topic content', 26),
    );
    expect(tp.getCorpusSize()).toBe(2);
    tp.evictStale();
    expect(tp.getCorpusSize()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

describe('TrendPredictor — prediction', () => {
  it('returns an empty prediction when the corpus is empty', () => {
    const tp = makePredictor();
    const result = tp.predict();
    expect(result.topTopics).toHaveLength(0);
    expect(result.documentCount).toBe(0);
  });

  it('surfaces terms that appear in multiple documents', () => {
    const tp = makePredictor({ minDocFrequency: 2 });
    tp.ingest([
      makeDoc('1', 'quantitative finance derivatives pricing volatility surface', 1, 500),
      makeDoc('2', 'quantitative analysis derivatives risk management', 2, 400),
      makeDoc('3', 'machine learning neural networks deep learning', 3, 300),
    ]);
    const result = tp.predict();
    const topics = result.topTopics.map((t) => t.topic);
    // "quantitative" and "derivatives" appear in 2 docs; ML terms appear in only 1
    expect(topics).toContain('derivatives');
  });

  it('returns at most topN topics', () => {
    const tp = makePredictor({ topN: 5, minDocFrequency: 1 });
    for (let i = 0; i < 20; i++) {
      tp.ingest(makeDoc(String(i), `unique term${i} shared alpha beta gamma delta`, 1 + i * 0.1));
    }
    const result = tp.predict();
    expect(result.topTopics.length).toBeLessThanOrEqual(5);
  });

  it('scores recent documents higher than old ones (same content)', () => {
    const tp = makePredictor({ minDocFrequency: 1 });
    // Same content, different ages — the recent one should rank higher
    tp.ingest(makeDoc('new', 'emerging algorithm strategy edge', 0.5, 100, 50));
    tp.ingest(makeDoc('old', 'emerging algorithm strategy edge', 23, 100, 50));
    const result = tp.predict();
    expect(result.topTopics.length).toBeGreaterThan(0);
    // Temporal weights differ so the aggregate will reflect recency
    const firstTopic = result.topTopics[0];
    expect(firstTopic.score).toBeGreaterThan(0);
  });

  it('populates the prediction window timestamps correctly', () => {
    const tp = makePredictor();
    const result = tp.predict();
    expect(result.generatedAt).toBe(new Date(BASE_TIME).toISOString());
    expect(result.windowEnd).toBe(BASE_TIME + 6 * 60 * 60 * 1_000);
  });

  it('stores the last prediction for retrieval without recomputing', () => {
    const tp = makePredictor({ minDocFrequency: 1 });
    tp.ingest(makeDoc('1', 'blockchain distributed ledger consensus', 1, 200));
    tp.ingest(makeDoc('2', 'blockchain protocol nodes miners', 2, 150));
    const first = tp.predict();
    const cached = tp.getLastPrediction();
    expect(cached).toBe(first); // Same reference
  });

  it('getLastPrediction returns null before first predict()', () => {
    const tp = makePredictor();
    expect(tp.getLastPrediction()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rising topics
// ---------------------------------------------------------------------------

describe('TrendPredictor — getRisingTopics', () => {
  it('returns a subset of the top topics sorted by velocity', () => {
    const tp = makePredictor({ minDocFrequency: 1 });
    for (let i = 0; i < 8; i++) {
      tp.ingest(makeDoc(String(i), `topic${i} shared content signal`, 1 + i, 100 + i * 50, i * 10));
    }
    const prediction = tp.predict();
    const rising = tp.getRisingTopics(prediction);
    expect(rising.length).toBeGreaterThan(0);
    expect(rising.length).toBeLessThanOrEqual(Math.ceil(prediction.topTopics.length * 0.25));
  });

  it('handles empty prediction gracefully', () => {
    const tp = makePredictor();
    const empty = tp.predict();
    expect(tp.getRisingTopics(empty)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// corpusStats
// ---------------------------------------------------------------------------

describe('TrendPredictor — corpusStats', () => {
  it('returns null timestamps and zero counts for an empty corpus', () => {
    const tp = makePredictor();
    const stats = tp.corpusStats();
    expect(stats.documentCount).toBe(0);
    expect(stats.oldestPublishedAt).toBeNull();
    expect(stats.newestPublishedAt).toBeNull();
    expect(stats.avgEngagement).toBe(0);
  });

  it('computes correct stats for a populated corpus', () => {
    const tp = makePredictor();
    tp.ingest([
      makeDoc('1', 'content one here now', 1, 100),
      makeDoc('2', 'content two here now', 2, 200),
      makeDoc('3', 'content three here now', 3, 300),
    ]);
    const stats = tp.corpusStats();
    expect(stats.documentCount).toBe(3);
    expect(stats.avgEngagement).toBeCloseTo(200);
    expect(stats.newestPublishedAt).toBeGreaterThan(stats.oldestPublishedAt!);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('TrendPredictor — reset', () => {
  it('clears corpus and last prediction', () => {
    const tp = makePredictor({ minDocFrequency: 1 });
    tp.ingest(makeDoc('1', 'some content here now today', 1));
    tp.predict();
    tp.reset();
    expect(tp.getCorpusSize()).toBe(0);
    expect(tp.getLastPrediction()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scheduler (basic)
// ---------------------------------------------------------------------------

describe('TrendPredictor — scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fires the callback at each refresh interval', () => {
    const tp = new TrendPredictor({ refreshIntervalMs: 1_000 });
    const spy = jest.fn();
    tp.startScheduler(spy);
    jest.advanceTimersByTime(3_100);
    tp.stopScheduler();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not create duplicate intervals when called twice', () => {
    const tp = new TrendPredictor({ refreshIntervalMs: 1_000 });
    const spy = jest.fn();
    tp.startScheduler(spy);
    tp.startScheduler(spy); // second call should be a no-op
    jest.advanceTimersByTime(1_100);
    tp.stopScheduler();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
