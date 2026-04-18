import { LivePollService, resetLivePollService } from '../services/LivePollService';

beforeEach(() => {
  resetLivePollService();
});

afterEach(() => {
  resetLivePollService();
});

// ─── Poll creation ────────────────────────────────────────────────────────────

describe('LivePollService — poll creation', () => {
  it('creates a poll with auto-start', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Which token moons first?',
      options: ['BTC', 'ETH'],
    });

    expect(poll.status).toBe('active');
    expect(poll.options).toHaveLength(2);
    expect(poll.totalVotes).toBe(0);
    expect(svc.getActivePollId('b1')).toBe(poll.id);
  });

  it('creates a poll in pending state when autoStart=false', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Ready?',
      options: ['Yes', 'No'],
      autoStart: false,
    });

    expect(poll.status).toBe('pending');
    expect(svc.getActivePollId('b1')).toBeNull();
  });

  it('starts a pending poll', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Ready?',
      options: ['Yes', 'No'],
      autoStart: false,
    });
    const started = svc.startPoll(poll.id);
    expect(started.status).toBe('active');
    expect(svc.getActivePollId('b1')).toBe(poll.id);
  });

  it('rejects fewer than minOptions', () => {
    const svc = new LivePollService();
    expect(() =>
      svc.createPoll({ broadcastId: 'b1', question: 'Q?', options: ['Only one'] }),
    ).toThrow();
  });

  it('rejects more than maxOptions', () => {
    const svc = new LivePollService({ maxOptions: 4 });
    expect(() =>
      svc.createPoll({
        broadcastId: 'b1',
        question: 'Q?',
        options: ['A', 'B', 'C', 'D', 'E'],
      }),
    ).toThrow();
  });

  it('rejects empty question', () => {
    const svc = new LivePollService();
    expect(() =>
      svc.createPoll({ broadcastId: 'b1', question: '  ', options: ['A', 'B'] }),
    ).toThrow();
  });

  it('rejects a second active poll for the same broadcast', () => {
    const svc = new LivePollService();
    svc.createPoll({ broadcastId: 'b1', question: 'Q1?', options: ['A', 'B'] });
    expect(() =>
      svc.createPoll({ broadcastId: 'b1', question: 'Q2?', options: ['X', 'Y'] }),
    ).toThrow(/already has an active poll/);
  });
});

// ─── Voting ───────────────────────────────────────────────────────────────────

describe('LivePollService — voting', () => {
  it('accepts a valid vote', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Best?',
      options: ['Alpha', 'Beta'],
    });
    const optId = poll.options[0].id;
    const result = svc.castVote({ pollId: poll.id, optionId: optId, userId: 'u1' });
    expect(result.success).toBe(true);
    expect(result.updatedOption?.voteCount).toBe(1);
    expect(result.poll?.totalVotes).toBe(1);
  });

  it('prevents double-voting from the same user', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Best?',
      options: ['Alpha', 'Beta'],
    });
    const optId = poll.options[0].id;
    svc.castVote({ pollId: poll.id, optionId: optId, userId: 'u1' });
    const second = svc.castVote({ pollId: poll.id, optionId: optId, userId: 'u1' });
    expect(second.success).toBe(false);
    expect(second.reason).toMatch(/already voted/i);
  });

  it('rejects votes on unknown polls', () => {
    const svc = new LivePollService();
    const result = svc.castVote({ pollId: 'ghost', optionId: 'opt1', userId: 'u1' });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it('rejects votes on non-active polls', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Q?',
      options: ['A', 'B'],
      autoStart: false,
    });
    const result = svc.castVote({
      pollId: poll.id,
      optionId: poll.options[0].id,
      userId: 'u1',
    });
    expect(result.success).toBe(false);
  });
});

// ─── Prediction mode ──────────────────────────────────────────────────────────

describe('LivePollService — prediction mode', () => {
  it('requires a token wager in prediction mode', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Win?',
      options: ['Yes', 'No'],
      predictionMode: true,
    });
    const result = svc.castVote({
      pollId: poll.id,
      optionId: poll.options[0].id,
      userId: 'u1',
      tokensBet: 0,
    });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/wager/i);
  });

  it('records token bets and computes payouts', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Win?',
      options: ['Yes', 'No'],
      predictionMode: true,
    });
    const [yes, no] = poll.options;
    svc.castVote({ pollId: poll.id, optionId: yes.id, userId: 'u1', tokensBet: 100 });
    svc.castVote({ pollId: poll.id, optionId: no.id, userId: 'u2', tokensBet: 50 });

    svc.closePoll(poll.id);
    // Poll transitions through 'revealing', give it a tick
    const snap = svc.getSnapshot(poll.id);
    expect(snap.winner).not.toBeNull();
    // Total token pool is 150
    expect(snap.tokenPayouts).not.toBeNull();
  });
});

// ─── Snapshot & history ───────────────────────────────────────────────────────

describe('LivePollService — snapshot & history', () => {
  it('computes correct percentages', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      question: 'Fav?',
      options: ['A', 'B', 'C'],
    });
    const [a, b, c] = poll.options;
    svc.castVote({ pollId: poll.id, optionId: a.id, userId: 'u1' });
    svc.castVote({ pollId: poll.id, optionId: a.id, userId: 'u2' });
    svc.castVote({ pollId: poll.id, optionId: b.id, userId: 'u3' });
    svc.castVote({ pollId: poll.id, optionId: c.id, userId: 'u4' });

    const snap = svc.getSnapshot(poll.id);
    expect(snap.percentages[a.id]).toBe(50);
    expect(snap.percentages[b.id]).toBe(25);
    expect(snap.percentages[c.id]).toBe(25);
  });

  it('surfaces history sorted newest-first', () => {
    const svc = new LivePollService();
    const p1 = svc.createPoll({ broadcastId: 'b1', question: 'Q1', options: ['A', 'B'] });
    svc.closePoll(p1.id);
    const p2 = svc.createPoll({ broadcastId: 'b1', question: 'Q2', options: ['X', 'Y'] });

    const history = svc.getPollHistory('b1');
    expect(history[0].id).toBe(p2.id);
    expect(history[1].id).toBe(p1.id);
  });

  it('deletes a poll cleanly', () => {
    const svc = new LivePollService();
    const poll = svc.createPoll({ broadcastId: 'b1', question: 'Q?', options: ['A', 'B'] });
    svc.closePoll(poll.id);
    svc.deletePoll(poll.id);
    expect(svc.getPollHistory('b1')).toHaveLength(0);
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe('LivePollService — events', () => {
  it('emits poll:created on creation', () => {
    const svc = new LivePollService();
    const events: unknown[] = [];
    svc.on('poll:created', (p) => events.push(p));
    svc.createPoll({ broadcastId: 'b1', question: 'Q?', options: ['A', 'B'] });
    expect(events).toHaveLength(1);
  });

  it('emits poll:vote on each accepted vote', () => {
    const svc = new LivePollService();
    const votes: unknown[] = [];
    svc.on('poll:vote', (v) => votes.push(v));
    const poll = svc.createPoll({ broadcastId: 'b1', question: 'Q?', options: ['A', 'B'] });
    svc.castVote({ pollId: poll.id, optionId: poll.options[0].id, userId: 'u1' });
    svc.castVote({ pollId: poll.id, optionId: poll.options[1].id, userId: 'u2' });
    expect(votes).toHaveLength(2);
  });
});
