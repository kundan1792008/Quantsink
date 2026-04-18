import {
  FACTOR_WEIGHTS,
  GemmaCompletionRequest,
  GemmaCompletionResponse,
  GemmaModelClient,
  QualityRatingAI,
  aggregateFactors,
  buildPrompt,
  extractJsonBlock,
  heuristicRating,
  parseGemmaResponse,
  scoreClarity,
  scoreGrammar,
  scoreMediaQuality,
  scoreOriginality,
  scoreRelevance,
} from '../services/QualityRatingAI';
import { InMemoryInfluenceStore } from '../services/InfluenceScoreDomain';

describe('QualityRatingAI — pure factor scorers', () => {
  it('originality rewards vocabulary + penalises clichés', () => {
    const fresh = scoreOriginality(
      'Empirical volatility clusters across macro regimes suggest heteroscedastic priors strengthen the posterior.',
    );
    const cliche = scoreOriginality(
      'Just dropped! Game changer paradigm shift synergy going viral hustle grind.',
    );
    expect(fresh).toBeGreaterThan(cliche);
  });

  it('scoreOriginality handles empty input', () => {
    expect(scoreOriginality('')).toBe(0);
    expect(scoreOriginality('   ')).toBe(0);
  });

  it('clarity penalises shouting and long sentences', () => {
    const clean = scoreClarity(
      'Signal decay accelerates when cross-asset volatility spikes. Adaptive look-backs preserve alpha.',
    );
    const shouty = scoreClarity('THIS IS AMAZING!!!!! LOOK AT THIS NOW!!!! WE ARE SO BACK!!!!');
    expect(clean).toBeGreaterThan(shouty);
  });

  it('clarity handles single short sentence gracefully', () => {
    expect(scoreClarity('Hi.')).toBeLessThanOrEqual(70);
  });

  it('relevance rewards topical alignment', () => {
    expect(scoreRelevance('Quant volatility clustering.', ['quant', 'volatility'])).toBeGreaterThan(
      scoreRelevance('Breakfast burrito recipe.', ['quant', 'volatility']),
    );
    // No topics → neutral 60
    expect(scoreRelevance('Anything here.', [])).toBe(60);
    expect(scoreRelevance('Anything here.', undefined)).toBe(60);
  });

  it('mediaQuality rewards attachments but punishes over-clutter', () => {
    const plain = scoreMediaQuality([], 'Short text.');
    const withImage = scoreMediaQuality(['https://x/y.png'], 'Short text.');
    const cluttered = scoreMediaQuality(
      new Array(12).fill('https://x/y.png'),
      'Short text.',
    );
    expect(withImage).toBeGreaterThan(plain);
    expect(cluttered).toBeLessThan(withImage);
  });

  it('grammar penalises known misspellings + duplicated punctuation', () => {
    const clean = scoreGrammar('The market closed higher today, led by semis.');
    const sloppy = scoreGrammar('teh market closed higher  today ! ! ! recieve signal.');
    expect(clean).toBeGreaterThan(sloppy);
  });

  it('aggregateFactors applies the configured weights', () => {
    const allHundred = aggregateFactors({
      originality: 100,
      clarity: 100,
      relevance: 100,
      mediaQuality: 100,
      grammar: 100,
    });
    expect(allHundred).toBe(100);
    const weightsSum = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(weightsSum).toBeCloseTo(1, 6);
  });
});

describe('QualityRatingAI — prompt + parser', () => {
  it('buildPrompt includes content, topics, and media', () => {
    const req = buildPrompt({
      broadcastId: 'bc1',
      authorId: 'u1',
      content: 'Hello world',
      mediaUrls: ['https://cdn/img.png'],
      topics: ['markets'],
    });
    expect(req.messages).toHaveLength(2);
    expect(req.messages[1].content).toContain('Hello world');
    expect(req.messages[1].content).toContain('#markets');
    expect(req.messages[1].content).toContain('https://cdn/img.png');
    expect(req.temperature).toBeLessThan(0.5);
  });

  it('extractJsonBlock finds balanced object even with chatter', () => {
    const text = 'Sure, here is the JSON:\n{"a":1,"b":{"c":2}} thanks';
    expect(extractJsonBlock(text)).toBe('{"a":1,"b":{"c":2}}');
    expect(extractJsonBlock('no json here')).toBeNull();
  });

  it('parseGemmaResponse clamps and validates', () => {
    const parsed = parseGemmaResponse(
      '{"originality":150,"clarity":50,"relevance":-5,"mediaQuality":80,"grammar":75,"explanation":"ok"}',
    );
    expect(parsed.originality).toBe(100);
    expect(parsed.relevance).toBe(0);
    expect(parsed.explanation).toBe('ok');
  });

  it('parseGemmaResponse throws on missing fields', () => {
    expect(() => parseGemmaResponse('{"originality":50}')).toThrow();
    expect(() => parseGemmaResponse('not json at all')).toThrow();
  });
});

describe('QualityRatingAI — service integration', () => {
  it('falls back to heuristics when the model fails', async () => {
    const store = new InMemoryInfluenceStore();
    const brokenModel: GemmaModelClient = {
      name: 'broken',
      isReady: () => true,
      complete: async () => {
        throw new Error('model offline');
      },
    };
    const ai = new QualityRatingAI({ model: brokenModel, store });
    const rating = await ai.rateBroadcast({
      broadcastId: 'bc-1',
      authorId: 'user-1',
      content: 'Signal decay accelerates when cross-asset volatility spikes.',
    });
    expect(rating.modelName).toContain('heuristic');
    expect(rating.score).toBeGreaterThanOrEqual(0);
    expect(rating.score).toBeLessThanOrEqual(100);

    const stored = await store.listBroadcastQualityRatings('user-1', 5);
    expect(stored).toHaveLength(1);
  });

  it('uses the model when it returns valid JSON', async () => {
    const store = new InMemoryInfluenceStore();
    const fakeModel: GemmaModelClient = {
      name: 'gemma-nano',
      isReady: () => true,
      complete: async (_req: GemmaCompletionRequest): Promise<GemmaCompletionResponse> => ({
        modelName: 'gemma-nano',
        text: '{"originality":80,"clarity":70,"relevance":90,"mediaQuality":60,"grammar":85,"explanation":"Crisp."}',
      }),
    };
    const ai = new QualityRatingAI({ model: fakeModel, store });
    const rating = await ai.rateBroadcast({
      broadcastId: 'bc-2',
      authorId: 'user-2',
      content: 'Topical broadcast.',
    });
    expect(rating.modelName).toBe('gemma-nano');
    expect(rating.originality).toBe(80);
    expect(rating.score).toBe(aggregateFactors(rating));
  });

  it('averageQualityForAuthor computes a rounded mean', async () => {
    const store = new InMemoryInfluenceStore();
    const ai = new QualityRatingAI({ store });
    const base = {
      authorId: 'author',
      score: 0,
      originality: 0, clarity: 0, relevance: 0, mediaQuality: 0, grammar: 0,
      explanation: 'x',
      modelName: 'heuristic',
    };
    await store.upsertBroadcastQualityRating({ ...base, broadcastId: 'b1', score: 80 });
    await store.upsertBroadcastQualityRating({ ...base, broadcastId: 'b2', score: 70 });
    await store.upsertBroadcastQualityRating({ ...base, broadcastId: 'b3', score: 90 });
    expect(await ai.averageQualityForAuthor('author')).toBe(80);
    expect(await ai.averageQualityForAuthor('unknown')).toBe(0);
  });

  it('rejects oversized content', async () => {
    const ai = new QualityRatingAI();
    await expect(
      ai.rateBroadcast({
        broadcastId: 'big',
        authorId: 'u',
        content: 'x'.repeat(6000),
      }),
    ).rejects.toThrow();
  });

  it('rejects missing ids', async () => {
    const ai = new QualityRatingAI();
    await expect(
      ai.rateBroadcast({ broadcastId: '', authorId: 'u', content: 'hi' }),
    ).rejects.toThrow();
  });

  it('heuristicRating always stays within 0–100', () => {
    const result = heuristicRating({
      broadcastId: 'b',
      authorId: 'a',
      content: '!!!!!!!',
      topics: ['quant'],
    });
    for (const key of Object.keys(result) as Array<keyof typeof result>) {
      expect(result[key]).toBeGreaterThanOrEqual(0);
      expect(result[key]).toBeLessThanOrEqual(100);
    }
  });
});
