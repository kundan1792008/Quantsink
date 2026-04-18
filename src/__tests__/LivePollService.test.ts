import {
  LivePollService,
  SchedulerApi,
  TimerHandle,
  PollTally,
  RevealPayload,
} from '../services/LivePollService';

class ManualClock {
  current = 2_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

class ManualScheduler implements SchedulerApi {
  callbacks: Array<{ fn: () => void; ms: number; id: number }> = [];
  private nextId = 1;
  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.callbacks.push({ fn, ms, id });
    return { __brand: 'pollTimer', id } as unknown as TimerHandle;
  }
  clearInterval(handle: TimerHandle): void {
    const id = (handle as unknown as { id: number }).id;
    this.callbacks = this.callbacks.filter((c) => c.id !== id);
  }
  fireAll(): void {
    for (const c of this.callbacks.slice()) c.fn();
  }
}

let idCounter = 0;
const idFactory = () => `poll_${++idCounter}`;

function createService(opts: Partial<{ clock: ManualClock; scheduler: ManualScheduler }> = {}) {
  idCounter = 0;
  const clock = opts.clock ?? new ManualClock();
  const scheduler = opts.scheduler ?? new ManualScheduler();
  const svc = new LivePollService({ clock, scheduler, idFactory });
  svc.start();
  return { svc, clock, scheduler };
}

describe('LivePollService.createPoll', () => {
  it('creates a poll with normalised options and returns it', () => {
    const { svc } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b1',
      creatorId: 'c1',
      question: 'Best framework?',
      options: [{ label: 'React' }, { label: 'Svelte' }, { label: 'Vue' }],
      durationMs: 30_000,
    });
    expect(poll.id).toBe('poll_1');
    expect(poll.options).toHaveLength(3);
    expect(poll.options[0].id).toBe('opt_1');
    expect(poll.state).toBe('OPEN');
    expect(poll.mode).toBe('STANDARD');
  });

  it('validates option count', () => {
    const { svc } = createService();
    expect(() =>
      svc.createPoll({
        broadcastId: 'b',
        creatorId: 'c',
        question: 'Q?',
        options: [{ label: 'one' }],
        durationMs: 30_000,
      })
    ).toThrow(/options must contain/);
    expect(() =>
      svc.createPoll({
        broadcastId: 'b',
        creatorId: 'c',
        question: 'Q?',
        options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })),
        durationMs: 30_000,
      })
    ).toThrow(/options must contain/);
  });

  it('validates question and duration', () => {
    const { svc } = createService();
    expect(() =>
      svc.createPoll({
        broadcastId: 'b',
        creatorId: 'c',
        question: '',
        options: [{ label: 'a' }, { label: 'b' }],
        durationMs: 30_000,
      })
    ).toThrow(/invalid question/);
    expect(() =>
      svc.createPoll({
        broadcastId: 'b',
        creatorId: 'c',
        question: 'Q?',
        options: [{ label: 'a' }, { label: 'b' }],
        durationMs: 100,
      })
    ).toThrow(/durationMs/);
  });

  it('rejects duplicate option labels', () => {
    const { svc } = createService();
    expect(() =>
      svc.createPoll({
        broadcastId: 'b',
        creatorId: 'c',
        question: 'Q?',
        options: [{ label: 'A' }, { label: 'a' }],
        durationMs: 30_000,
      })
    ).toThrow(/duplicate/);
  });
});

describe('LivePollService.vote', () => {
  it('records standard votes and prevents double-voting', () => {
    const { svc } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 30_000,
    });
    expect(svc.vote({ pollId: poll.id, userId: 'u1', optionId: 'opt_1' }).accepted).toBe(true);
    const dup = svc.vote({ pollId: poll.id, userId: 'u1', optionId: 'opt_2' });
    expect(dup.accepted).toBe(false);
    expect(dup.reason).toBe('ALREADY_VOTED');
  });

  it('rejects invalid options & polls', () => {
    const { svc } = createService();
    expect(svc.vote({ pollId: 'nope', userId: 'u', optionId: 'opt_1' }).reason).toBe(
      'POLL_NOT_FOUND'
    );
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 30_000,
    });
    expect(svc.vote({ pollId: poll.id, userId: 'u', optionId: 'opt_99' }).reason).toBe(
      'INVALID_OPTION'
    );
  });

  it('auto-closes the poll when its expiry has passed', () => {
    const { svc, clock } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 5_000,
    });
    clock.advance(6_000);
    const r = svc.vote({ pollId: poll.id, userId: 'u', optionId: 'opt_1' });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('POLL_CLOSED');
    expect(svc.getPoll(poll.id)!.state).toBe('CLOSED');
  });

  it('PREDICTION mode requires valid stake within bounds', () => {
    const { svc } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 30_000,
      mode: 'PREDICTION',
      minStake: 10,
      maxStake: 1_000,
    });
    expect(svc.vote({ pollId: poll.id, userId: 'u', optionId: 'opt_1' }).reason).toBe(
      'INVALID_STAKE'
    );
    expect(svc.vote({ pollId: poll.id, userId: 'u', optionId: 'opt_1', stake: 5 }).reason).toBe(
      'INVALID_STAKE'
    );
    expect(
      svc.vote({ pollId: poll.id, userId: 'u', optionId: 'opt_1', stake: 50 }).accepted
    ).toBe(true);
  });
});

describe('LivePollService snapshots and reveals', () => {
  it('emits tally snapshots on tick and stops after close', () => {
    const { svc, clock } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 30_000,
    });
    const tallies: PollTally[] = [];
    svc.subscribe(poll.id, (t) => tallies.push(t));
    svc.vote({ pollId: poll.id, userId: 'u1', optionId: 'opt_1' });
    svc.vote({ pollId: poll.id, userId: 'u2', optionId: 'opt_1' });
    svc.vote({ pollId: poll.id, userId: 'u3', optionId: 'opt_2' });
    expect(tallies.length).toBeGreaterThan(0);
    const last = tallies[tallies.length - 1];
    expect(last.totalVotes).toBe(3);
    expect(last.options[0].percent).toBeCloseTo((2 / 3) * 100);
    expect(last.options[0].leading).toBe(true);

    clock.advance(31_000);
    svc.tick();
    expect(svc.getPoll(poll.id)!.state).toBe('CLOSED');
  });

  it('reveal computes pari-mutuel payouts with house rake', () => {
    const { svc } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'YES' }, { label: 'NO' }],
      durationMs: 30_000,
      mode: 'PREDICTION',
    });
    svc.vote({ pollId: poll.id, userId: 'w1', optionId: 'opt_1', stake: 100 });
    svc.vote({ pollId: poll.id, userId: 'w2', optionId: 'opt_1', stake: 200 });
    svc.vote({ pollId: poll.id, userId: 'l1', optionId: 'opt_2', stake: 700 });

    const reveals: RevealPayload[] = [];
    svc.subscribeReveal(poll.id, (r) => reveals.push(r));
    const reveal = svc.revealPoll(poll.id, 'opt_1');
    expect(reveal.winningOptionId).toBe('opt_1');
    expect(reveal.totalPayout).toBeGreaterThan(0);
    expect(reveal.housePot).toBe(50); // 5% of 1000
    const w1 = reveal.payouts.find((p) => p.userId === 'w1')!;
    const w2 = reveal.payouts.find((p) => p.userId === 'w2')!;
    const l1 = reveal.payouts.find((p) => p.userId === 'l1')!;
    // Distributable = 950; w1 gets 100/300 = 316; w2 gets 200/300 = 633.
    expect(w1.payout).toBe(316);
    expect(w2.payout).toBe(633);
    expect(l1.payout).toBe(0);
    expect(l1.net).toBe(-700);
    expect(reveals).toHaveLength(1);
    expect(svc.getPoll(poll.id)!.state).toBe('REVEALED');
  });

  it('archives revealed polls into history', () => {
    const { svc } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 30_000,
    });
    svc.vote({ pollId: poll.id, userId: 'u1', optionId: 'opt_1' });
    svc.revealPoll(poll.id);
    const hist = svc.history_for('b');
    expect(hist).toHaveLength(1);
    expect(hist[0].reveal.winningOptionId).toBe('opt_1');
  });

  it('reveal is idempotent', () => {
    const { svc } = createService();
    const poll = svc.createPoll({
      broadcastId: 'b',
      creatorId: 'c',
      question: 'Q?',
      options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 30_000,
    });
    svc.vote({ pollId: poll.id, userId: 'u1', optionId: 'opt_1' });
    const first = svc.revealPoll(poll.id);
    const second = svc.revealPoll(poll.id);
    expect(second).toBe(first);
  });
});
