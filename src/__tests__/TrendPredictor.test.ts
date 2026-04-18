import {
  TrendPredictor,
  tokenise,
  bigrams,
  startScheduledPredictor,
  type BroadcastRecord,
  type TrendSchedulerApi,
} from '../services/TrendPredictor';

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

describe('TrendPredictor — tokenisation', () => {
  it('lowercases, strips punctuation and stopwords', () => {
    expect(tokenise("It's the Alpha, bro — ALPHA!")).toEqual(["it's", 'alpha', 'bro', 'alpha']);
  });

  it('filters tokens under three characters', () => {
    expect(tokenise('to be or not to be')).toEqual([]);
  });

  it('produces bi-grams from ordered token list', () => {
    expect(bigrams(['alpha', 'decay', 'signal'])).toEqual([
      'alpha decay',
      'decay signal',
    ]);
  });
});

describe('TrendPredictor — prediction pipeline', () => {
  const nowDate = new Date('2026-04-17T12:00:00Z');
  const predictor = new TrendPredictor({
    now: () => nowDate,
    analysisWindowHours: 24,
    forecastHorizonHours: 6,
    topK: 5,
    minDocumentFrequency: 2,
    velocityBuckets: 6,
    temporalHalfLifeHours: 4,
  });

  const sample: BroadcastRecord[] = [
    makeBroadcast('b1', 'alpha decay regime shift observed', new Date('2026-04-17T11:50:00Z'), 500),
    makeBroadcast('b2', 'alpha decay accelerating in volatile regime', new Date('2026-04-17T11:55:00Z'), 700),
    makeBroadcast('b3', 'order flow toxicity at dark pool venues', new Date('2026-04-17T11:00:00Z'), 200),
    makeBroadcast('b4', 'order flow toxicity spiking on close', new Date('2026-04-17T11:30:00Z'), 220),
    makeBroadcast('b5', 'random unrelated note about lunch', new Date('2026-04-16T14:00:00Z'), 10),
  ];

  it('returns predictions sorted by composite score', () => {
    const set = predictor.predict(sample);
    expect(set.sampleSize).toBe(5);
    expect(set.predictions.length).toBeGreaterThan(0);
    const scores = set.predictions.map((p) => p.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  it('flags accelerating trends as rising', () => {
    const set = predictor.predict(sample);
    const alpha = set.predictions.find((p) => p.term === 'alpha' || p.term === 'decay');
    expect(alpha).toBeDefined();
    expect(alpha!.rising).toBe(true);
  });

  it('ignores broadcasts outside the analysis window', () => {
    const old = makeBroadcast('old', 'alpha decay historical', new Date('2026-04-10T00:00:00Z'), 9999);
    const set = predictor.predict([...sample, old]);
    expect(set.sampleSize).toBe(5);
  });

  it('returns an empty envelope when no broadcasts are in-window', () => {
    const set = predictor.predict([
      makeBroadcast('x', 'ancient broadcast', new Date('2020-01-01T00:00:00Z')),
    ]);
    expect(set.predictions).toHaveLength(0);
    expect(set.vocabularySize).toBe(0);
  });

  it('caches the last prediction for getLastPrediction', () => {
    predictor.predict(sample);
    const cached = predictor.getLastPrediction();
    expect(cached).not.toBeNull();
    expect(cached!.predictions.length).toBeGreaterThan(0);
  });

  it('classifyText finds the best matching trend from last prediction', () => {
    predictor.predict(sample);
    const match = predictor.classifyText('latest alpha decay update');
    expect(match).not.toBeNull();
    expect(['alpha', 'decay', 'alpha decay']).toContain(match!.term);
  });

  it('classifyText returns null when no predictions exist', () => {
    const p = new TrendPredictor({ now: () => nowDate });
    expect(p.classifyText('some text')).toBeNull();
  });

  it('throws when given invalid options', () => {
    expect(() => new TrendPredictor({ analysisWindowHours: 0 })).toThrow();
    expect(() => new TrendPredictor({ velocityBuckets: 1 })).toThrow();
  });
});

describe('TrendPredictor — startScheduledPredictor', () => {
  it('invokes an eager first prediction and then on interval', async () => {
    let currentTime = Date.parse('2026-04-17T12:00:00Z');
    const predictor = new TrendPredictor({
      now: () => new Date(currentTime),
      analysisWindowHours: 24,
      minDocumentFrequency: 1,
    });
    const intervals: Array<() => void> = [];
    const scheduler: TrendSchedulerApi = {
      setInterval: (fn) => {
        intervals.push(fn);
        return { id: intervals.length };
      },
      clearInterval: () => {
        /* no-op for test */
      },
    };
    const corpus = [
      makeBroadcast('b', 'signal processing alpha', new Date(currentTime - 1000), 300),
      makeBroadcast('b2', 'signal processing kalman', new Date(currentTime - 2000), 300),
    ];
    let cycles = 0;
    const dispose = startScheduledPredictor(predictor, {
      scheduler,
      refreshIntervalHours: 0.5,
      fetchBroadcasts: () => corpus,
      onPrediction: () => {
        cycles += 1;
      },
    });

    await new Promise((r) => setImmediate(r));
    expect(cycles).toBe(1);

    currentTime += 30 * 60 * 1000;
    intervals[0]?.();
    await new Promise((r) => setImmediate(r));
    expect(cycles).toBe(2);

    dispose();
  });

  it('surfaces fetch errors via onError', async () => {
    const predictor = new TrendPredictor();
    const errors: unknown[] = [];
    const dispose = startScheduledPredictor(predictor, {
      scheduler: {
        setInterval: () => ({ id: 1 }),
        clearInterval: () => undefined,
      },
      fetchBroadcasts: () => {
        throw new Error('boom');
      },
      onError: (err) => errors.push(err),
    });
    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBe(1);
    dispose();
  });
});
