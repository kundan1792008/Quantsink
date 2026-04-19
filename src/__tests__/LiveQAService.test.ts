import { LiveQAService } from '../services/LiveQAService';

class ManualClock {
  current = 5_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

let counter = 0;
const idFactory = () => `q_${++counter}`;

function createService(opts: Partial<{ clock: ManualClock; perUserPerMinute: number }> = {}) {
  counter = 0;
  const clock = opts.clock ?? new ManualClock();
  return {
    svc: new LiveQAService({
      clock,
      idFactory,
      perUserPerMinute: opts.perUserPerMinute ?? 5,
    }),
    clock,
  };
}

describe('LiveQAService.submit', () => {
  it('accepts valid questions and returns frozen entity', () => {
    const { svc, clock } = createService();
    const r = svc.submit({
      broadcastId: 'b1',
      authorId: 'u1',
      authorDisplayName: 'Alice',
      body: 'What is the meaning of life?',
    });
    expect(r.accepted).toBe(true);
    expect(r.question!.id).toBe('q_1');
    expect(r.question!.upvotes).toBe(0);
    expect(r.question!.state).toBe('OPEN');
    expect(r.question!.pinned).toBe(false);
    expect(r.question!.createdAt.getTime()).toBe(clock.now());
    expect(Object.isFrozen(r.question)).toBe(true);
  });

  it('rejects malformed input', () => {
    const { svc } = createService();
    expect(svc.submit({ broadcastId: '', authorId: 'u', authorDisplayName: 'a', body: 'hi there' }).reason).toBe('INVALID_BROADCAST');
    expect(svc.submit({ broadcastId: 'b', authorId: '', authorDisplayName: 'a', body: 'hi there' }).reason).toBe('INVALID_USER');
    expect(svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: '', body: 'hi there' }).reason).toBe('INVALID_USER');
    expect(svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: 'hi' }).reason).toBe('INVALID_BODY');
    expect(svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: 'x'.repeat(500) }).reason).toBe('INVALID_BODY');
    expect(svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: 123 as unknown as string }).reason).toBe('INVALID_BODY');
  });

  it('strips control / bidi / zero-width characters before validating', () => {
    const { svc } = createService();
    const r = svc.submit({
      broadcastId: 'b',
      authorId: 'u',
      authorDisplayName: 'Alice',
      body: 'Hello\u202E\u200B world  question?',
    });
    expect(r.accepted).toBe(true);
    expect(r.question!.body).toBe('Hello world question?');
  });

  it('throttles >5 questions/minute per user', () => {
    const { svc, clock } = createService({ perUserPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect(svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: `question number ${i}` }).accepted).toBe(true);
    }
    const r = svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: 'fourth question' });
    expect(r.reason).toBe('THROTTLED');
    clock.advance(60_001);
    expect(svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: 'after window' }).accepted).toBe(true);
  });

  it('rejects duplicate body within window', () => {
    const { svc } = createService();
    expect(svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: 'Same question?' }).accepted).toBe(true);
    const dup = svc.submit({ broadcastId: 'b', authorId: 'u', authorDisplayName: 'a', body: 'same question?' });
    expect(dup.reason).toBe('DUPLICATE');
  });
});

describe('LiveQAService.upvote', () => {
  it('records and removes upvotes; one per user; not from author', () => {
    const { svc } = createService();
    const submitted = svc.submit({
      broadcastId: 'b',
      authorId: 'author',
      authorDisplayName: 'A',
      body: 'Great question?',
    });
    const id = submitted.question!.id;

    expect(svc.upvote({ questionId: 'nope', userId: 'u' }).reason).toBe('NOT_FOUND');
    expect(svc.upvote({ questionId: id, userId: '' }).reason).toBe('INVALID_USER');
    expect(svc.upvote({ questionId: id, userId: 'author' }).reason).toBe('ALREADY_VOTED');

    const v1 = svc.upvote({ questionId: id, userId: 'u1' });
    expect(v1.accepted).toBe(true);
    expect(v1.question!.upvotes).toBe(1);
    expect(svc.upvote({ questionId: id, userId: 'u1' }).reason).toBe('ALREADY_VOTED');

    const v2 = svc.upvote({ questionId: id, userId: 'u2' });
    expect(v2.question!.upvotes).toBe(2);

    const undo = svc.removeUpvote({ questionId: id, userId: 'u2' });
    expect(undo.accepted).toBe(true);
    expect(undo.question!.upvotes).toBe(1);
    expect(svc.removeUpvote({ questionId: id, userId: 'u3' }).reason).toBe('NOT_VOTED');
  });
});

describe('LiveQAService broadcaster controls', () => {
  it('markAnswered sets state, timestamp, and unpins', () => {
    const { svc, clock } = createService();
    const q = svc.submit({ broadcastId: 'b', authorId: 'a', authorDisplayName: 'a', body: 'test question?' }).question!;
    svc.pin(q.id);
    clock.advance(1_000);
    const updated = svc.markAnswered(q.id)!;
    expect(updated.state).toBe('ANSWERED');
    expect(updated.pinned).toBe(false);
    expect(updated.answeredAt!.getTime()).toBe(clock.now());
    // idempotent
    expect(svc.markAnswered(q.id)!.answeredAt!.getTime()).toBe(clock.now());
  });

  it('pin / unpin toggles correctly', () => {
    const { svc } = createService();
    const q = svc.submit({ broadcastId: 'b', authorId: 'a', authorDisplayName: 'a', body: 'pin me question?' }).question!;
    expect(svc.pin(q.id)!.pinned).toBe(true);
    expect(svc.pin(q.id)!.pinned).toBe(true);
    expect(svc.unpin(q.id)!.pinned).toBe(false);
    expect(svc.unpin('missing')).toBeNull();
  });

  it('hide moves to HIDDEN and excludes from listings', () => {
    const { svc } = createService();
    const q = svc.submit({ broadcastId: 'b', authorId: 'a', authorDisplayName: 'a', body: 'hide me question?' }).question!;
    svc.hide(q.id);
    const snap = svc.list('b');
    expect(snap.open).toHaveLength(0);
    expect(snap.pinned).toHaveLength(0);
    expect(snap.answered).toHaveLength(0);
    expect(snap.totalQuestions).toBe(1);
  });
});

describe('LiveQAService listings & subscriptions', () => {
  it('panel returns pinned first, then OPEN by score; ANSWERED separated', () => {
    const { svc } = createService();
    const a = svc.submit({ broadcastId: 'b', authorId: 'a', authorDisplayName: 'a', body: 'first question?' }).question!;
    const b = svc.submit({ broadcastId: 'b', authorId: 'b', authorDisplayName: 'b', body: 'second question?' }).question!;
    const c = svc.submit({ broadcastId: 'b', authorId: 'c', authorDisplayName: 'c', body: 'third question?' }).question!;

    svc.upvote({ questionId: a.id, userId: 'x1' });
    svc.upvote({ questionId: a.id, userId: 'x2' });
    svc.upvote({ questionId: b.id, userId: 'y1' });
    svc.pin(c.id);

    const panel = svc.panel('b');
    expect(panel[0].id).toBe(c.id);
    expect(panel[1].id).toBe(a.id);
    expect(panel[2].id).toBe(b.id);

    svc.markAnswered(a.id);
    const snap = svc.list('b');
    expect(snap.answered.map((q) => q.id)).toEqual([a.id]);
    expect(snap.open.map((q) => q.id)).toEqual([b.id]);
    expect(snap.totalUpvotes).toBe(3);
  });

  it('subscribers receive snapshots on submit/upvote and stop after closeBroadcast', () => {
    const { svc } = createService();
    const received: number[] = [];
    svc.subscribe('b', (snap) => received.push(snap.totalQuestions));
    svc.submit({ broadcastId: 'b', authorId: 'a', authorDisplayName: 'A', body: 'hello world?' });
    expect(received).toEqual([1]);

    svc.closeBroadcast('b');
    svc.submit({ broadcastId: 'b', authorId: 'a', authorDisplayName: 'A', body: 'after close?' });
    expect(received).toEqual([1]);
    expect(svc.get('q_1')).toBeNull();
  });

  it('get returns null for missing ids', () => {
    const { svc } = createService();
    expect(svc.get('')).toBeNull();
    expect(svc.get('missing')).toBeNull();
  });
});
