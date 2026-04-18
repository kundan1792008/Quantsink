import { LiveQAService, resetLiveQAService } from '../services/LiveQAService';

beforeEach(() => {
  resetLiveQAService();
});

afterEach(() => {
  resetLiveQAService();
});

// ─── Question submission ──────────────────────────────────────────────────────

describe('LiveQAService — question submission', () => {
  it('accepts a valid question', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1',
      authorId: 'u1',
      authorDisplayName: 'Alice',
      text: 'What is alpha decay?',
    });

    expect(q.id).toBeTruthy();
    expect(q.status).toBe('pending');
    expect(q.upvotes).toBe(0);
    expect(q.pinned).toBe(false);
    expect(svc.getQuestionCount('b1')).toBe(1);
  });

  it('rejects empty question text', () => {
    const svc = new LiveQAService();
    expect(() =>
      svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: '' }),
    ).toThrow();
  });

  it('rejects questions exceeding max length', () => {
    const svc = new LiveQAService({ maxQuestionLength: 50 });
    expect(() =>
      svc.submitQuestion({
        broadcastId: 'b1',
        authorId: 'u1',
        authorDisplayName: 'A',
        text: 'x'.repeat(51),
      }),
    ).toThrow(/exceeds maximum length/i);
  });

  it('enforces per-user question cap', () => {
    const svc = new LiveQAService({ maxQuestionsPerUser: 2 });
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q1?' });
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q2?' });
    expect(() =>
      svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q3?' }),
    ).toThrow(/maximum.*questions/i);
  });

  it('allows different users to submit independently', () => {
    const svc = new LiveQAService({ maxQuestionsPerUser: 1 });
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?' });
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u2', authorDisplayName: 'B', text: 'Q?' });
    expect(svc.getQuestionCount('b1')).toBe(2);
  });

  it('enforces broadcast-level question cap', () => {
    const svc = new LiveQAService({ maxQuestionsPerBroadcast: 3, maxQuestionsPerUser: 100 });
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q1?' });
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u2', authorDisplayName: 'B', text: 'Q2?' });
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u3', authorDisplayName: 'C', text: 'Q3?' });
    expect(() =>
      svc.submitQuestion({ broadcastId: 'b1', authorId: 'u4', authorDisplayName: 'D', text: 'Q4?' }),
    ).toThrow(/maximum question limit/i);
  });
});

// ─── Upvoting ─────────────────────────────────────────────────────────────────

describe('LiveQAService — upvoting', () => {
  it('increments vote count', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?',
    });
    const result = svc.upvoteQuestion(q.id, 'voter1');
    expect(result.success).toBe(true);
    expect(result.newUpvotes).toBe(1);
  });

  it('prevents duplicate upvotes from the same user', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?',
    });
    svc.upvoteQuestion(q.id, 'voter1');
    const dup = svc.upvoteQuestion(q.id, 'voter1');
    expect(dup.success).toBe(false);
    expect(dup.reason).toMatch(/already upvoted/i);
  });

  it('returns failure for unknown question', () => {
    const svc = new LiveQAService();
    const result = svc.upvoteQuestion('nonexistent', 'voter1');
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it('rejects upvotes on dismissed questions', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?',
    });
    svc.dismissQuestion(q.id);
    const result = svc.upvoteQuestion(q.id, 'voter1');
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/dismissed/i);
  });
});

// ─── Broadcaster controls ─────────────────────────────────────────────────────

describe('LiveQAService — broadcaster controls', () => {
  it('marks a question as answered with timestamp', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?',
    });
    const answered = svc.markAnswered(q.id);
    expect(answered.status).toBe('answered');
    expect(answered.answeredAt).not.toBeNull();
  });

  it('throws when marking an already-answered question', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?',
    });
    svc.markAnswered(q.id);
    expect(() => svc.markAnswered(q.id)).toThrow(/already answered/i);
  });

  it('dismisses a question', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?',
    });
    svc.dismissQuestion(q.id);
    const retrieved = svc.getQuestion(q.id);
    expect(retrieved?.status).toBe('dismissed');
  });

  it('pins and unpins a question', () => {
    const svc = new LiveQAService();
    const q = svc.submitQuestion({
      broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?',
    });
    svc.pinQuestion(q.id);
    expect(svc.getQuestion(q.id)?.pinned).toBe(true);
    svc.unpinQuestion(q.id);
    expect(svc.getQuestion(q.id)?.pinned).toBe(false);
  });
});

// ─── Query / sorting ──────────────────────────────────────────────────────────

describe('LiveQAService — query & sorting', () => {
  it('returns questions sorted by upvotes descending', () => {
    const svc = new LiveQAService({ maxQuestionsPerUser: 10 });
    const q1 = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Low votes' });
    const q2 = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u2', authorDisplayName: 'B', text: 'High votes' });

    svc.upvoteQuestion(q2.id, 'v1');
    svc.upvoteQuestion(q2.id, 'v2');
    svc.upvoteQuestion(q1.id, 'v3');

    const list = svc.getQuestions('b1');
    expect(list[0].id).toBe(q2.id);
    expect(list[1].id).toBe(q1.id);
  });

  it('pins bubble pinned questions to the top', () => {
    const svc = new LiveQAService({ maxQuestionsPerUser: 10 });
    const q1 = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q1?' });
    const q2 = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u2', authorDisplayName: 'B', text: 'Q2 (pinned)' });

    svc.upvoteQuestion(q1.id, 'v1');
    svc.upvoteQuestion(q1.id, 'v2'); // q1 has more votes but q2 is pinned
    svc.pinQuestion(q2.id);

    const list = svc.getQuestions('b1', { pinnedFirst: true });
    expect(list[0].id).toBe(q2.id);
  });

  it('filters by status', () => {
    const svc = new LiveQAService({ maxQuestionsPerUser: 10 });
    const q1 = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q1?' });
    const q2 = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u2', authorDisplayName: 'B', text: 'Q2?' });
    svc.markAnswered(q1.id);

    const pending = svc.getQuestions('b1', { status: 'pending' });
    expect(pending.map((q) => q.id)).not.toContain(q1.id);
    expect(pending.map((q) => q.id)).toContain(q2.id);
  });

  it('honours the limit parameter', () => {
    const svc = new LiveQAService({ maxQuestionsPerUser: 10 });
    for (let i = 0; i < 10; i++) {
      svc.submitQuestion({
        broadcastId: 'b1',
        authorId: `u${i}`,
        authorDisplayName: `User ${i}`,
        text: `Question ${i}?`,
      });
    }
    const limited = svc.getQuestions('b1', { limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

// ─── Broadcast cleanup ────────────────────────────────────────────────────────

describe('LiveQAService — broadcast cleanup', () => {
  it('clears all questions for a broadcast', () => {
    const svc = new LiveQAService();
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?' });
    svc.clearBroadcast('b1');
    expect(svc.getQuestionCount('b1')).toBe(0);
  });

  it('does not affect other broadcasts', () => {
    const svc = new LiveQAService();
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?' });
    svc.submitQuestion({ broadcastId: 'b2', authorId: 'u2', authorDisplayName: 'B', text: 'Q?' });
    svc.clearBroadcast('b1');
    expect(svc.getQuestionCount('b2')).toBe(1);
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe('LiveQAService — events', () => {
  it('emits question:submitted on new question', () => {
    const svc = new LiveQAService();
    const events: unknown[] = [];
    svc.on('question:submitted', (q) => events.push(q));
    svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?' });
    expect(events).toHaveLength(1);
  });

  it('emits question:upvoted on successful upvote', () => {
    const svc = new LiveQAService();
    const events: unknown[] = [];
    svc.on('question:upvoted', (e) => events.push(e));
    const q = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?' });
    svc.upvoteQuestion(q.id, 'voter1');
    expect(events).toHaveLength(1);
  });

  it('emits question:answered when broadcaster marks answered', () => {
    const svc = new LiveQAService();
    const events: unknown[] = [];
    svc.on('question:answered', (q) => events.push(q));
    const q = svc.submitQuestion({ broadcastId: 'b1', authorId: 'u1', authorDisplayName: 'A', text: 'Q?' });
    svc.markAnswered(q.id);
    expect(events).toHaveLength(1);
  });
});
