import logger from '../lib/logger';

/**
 * LivePollService — Real-Time Polls & Token-Backed Predictions
 * ============================================================
 *
 * The service powers the polls overlay shown during a Quantsink live
 * broadcast.  Broadcasters create a poll with 2-4 options; viewers vote
 * (or, in PREDICTION mode, stake tokens) until the timer expires; the
 * service publishes a tally snapshot every 250 ms via the same listener
 * pattern used by ReactionEngine; when the timer ends the broadcaster
 * (or the auto-resolver) selects the winning option and the service
 * computes the dramatic reveal payload — including token payouts when
 * the poll was a prediction.  All historical polls are kept in an
 * in-memory archive (capped per broadcast) so the UI can render the
 * "previous polls" carousel.
 *
 * Functional requirements (issue #21):
 *
 *   - 2-4 options per poll (creator-defined).
 *   - Live vote counting with snapshot fan-out (no polling on the wire).
 *   - PREDICTION mode: viewers stake tokens; payouts are pari-mutuel
 *     (winners share the entire pot proportionally to their stake).
 *   - Reveal animation payload: ranked options + payout map.
 *   - Per-broadcast history of every closed poll.
 *
 * The service is fully deterministic when fed an injectable Clock and
 * Scheduler (mirrors ReactionEngine / EphemeralBroadcastWorker).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PollMode = 'STANDARD' | 'PREDICTION';
export type PollState = 'OPEN' | 'CLOSED' | 'REVEALED';

export interface PollOptionInput {
  readonly id?: string;
  readonly label: string;
}

export interface CreatePollInput {
  readonly broadcastId: string;
  readonly creatorId: string;
  readonly question: string;
  readonly options: ReadonlyArray<PollOptionInput>;
  readonly durationMs: number;
  readonly mode?: PollMode;
  readonly minStake?: number;
  readonly maxStake?: number;
}

export interface PollOption {
  readonly id: string;
  readonly label: string;
}

export interface Poll {
  readonly id: string;
  readonly broadcastId: string;
  readonly creatorId: string;
  readonly question: string;
  readonly options: ReadonlyArray<PollOption>;
  readonly mode: PollMode;
  readonly minStake: number;
  readonly maxStake: number;
  readonly createdAt: Date;
  readonly closesAt: Date;
  readonly closedAt: Date | null;
  readonly revealedAt: Date | null;
  readonly state: PollState;
  readonly winningOptionId: string | null;
}

export interface VoteInput {
  readonly pollId: string;
  readonly userId: string;
  readonly optionId: string;
  readonly stake?: number;
}

export interface VoteResult {
  readonly accepted: boolean;
  readonly reason?:
    | 'OK'
    | 'POLL_NOT_FOUND'
    | 'POLL_CLOSED'
    | 'INVALID_OPTION'
    | 'INVALID_USER'
    | 'INVALID_STAKE'
    | 'ALREADY_VOTED';
  readonly poll?: Poll;
  readonly tally?: PollTally;
}

export interface OptionTally {
  readonly optionId: string;
  readonly label: string;
  readonly votes: number;
  readonly stake: number;
  readonly percent: number;          // 0-100, by votes
  readonly stakePercent: number;     // 0-100, by stake
  readonly barAnimationMs: number;   // suggested duration for animated bar
  readonly leading: boolean;
}

export interface PollTally {
  readonly pollId: string;
  readonly broadcastId: string;
  readonly state: PollState;
  readonly totalVotes: number;
  readonly totalStake: number;
  readonly options: ReadonlyArray<OptionTally>;
  readonly remainingMs: number;
  readonly generatedAt: Date;
}

export interface RevealPayload {
  readonly pollId: string;
  readonly winningOptionId: string;
  readonly winningLabel: string;
  readonly ranked: ReadonlyArray<OptionTally>;
  readonly mode: PollMode;
  readonly payouts: ReadonlyArray<PayoutLine>;
  readonly totalPayout: number;
  readonly housePot: number;
  readonly revealedAt: Date;
}

export interface PayoutLine {
  readonly userId: string;
  readonly stake: number;
  readonly payout: number;
  readonly net: number;
}

export interface PollHistoryEntry {
  readonly poll: Poll;
  readonly finalTally: PollTally;
  readonly reveal: RevealPayload;
}

export type PollListener = (tally: PollTally) => void;
export type RevealListener = (reveal: RevealPayload) => void;

export interface LivePollServiceOptions {
  readonly clock?: ClockApi;
  readonly scheduler?: SchedulerApi;
  readonly snapshotIntervalMs?: number;
  readonly historyPerBroadcast?: number;
  readonly maxOptions?: number;
  readonly minOptions?: number;
  readonly idFactory?: () => string;
  readonly autoCloseOnExpiry?: boolean;
}

export interface ClockApi {
  now(): number;
}

export interface TimerHandle {
  readonly __brand: 'pollTimer';
}

export interface SchedulerApi {
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SNAPSHOT_INTERVAL_MS = 250;
const DEFAULT_HISTORY_PER_BROADCAST = 50;
const DEFAULT_MAX_OPTIONS = 4;
const DEFAULT_MIN_OPTIONS = 2;
const DEFAULT_MIN_DURATION_MS = 3_000;
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
const HOUSE_RAKE = 0.05;        // 5 % of the prediction pot retained

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitiseQuestion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 240) return null;
  return trimmed;
}

function sanitiseLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  return trimmed;
}

function clampDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < DEFAULT_MIN_DURATION_MS) return null;
  if (rounded > DEFAULT_MAX_DURATION_MS) return null;
  return rounded;
}

function defaultIdFactory(): string {
  return `poll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const realClock: ClockApi = { now: () => Date.now() };
const realScheduler: SchedulerApi = {
  setInterval(fn: () => void, ms: number): TimerHandle {
    const handle = setInterval(fn, ms);
    return handle as unknown as TimerHandle;
  },
  clearInterval(handle: TimerHandle): void {
    clearInterval(handle as unknown as ReturnType<typeof setInterval>);
  },
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface PollState_Internal {
  poll: Poll;
  optionsById: Map<string, PollOption>;
  votesByOption: Map<string, number>;
  stakeByOption: Map<string, number>;
  votedUsers: Set<string>;
  stakeByUser: Map<string, { optionId: string; stake: number }>;
  listeners: Set<PollListener>;
  revealListeners: Set<RevealListener>;
  finalTally: PollTally | null;
  reveal: RevealPayload | null;
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

export class LivePollService {
  private readonly clock: ClockApi;
  private readonly scheduler: SchedulerApi;
  private readonly snapshotIntervalMs: number;
  private readonly historyPerBroadcast: number;
  private readonly maxOptions: number;
  private readonly minOptions: number;
  private readonly idFactory: () => string;
  private readonly autoCloseOnExpiry: boolean;

  private readonly polls = new Map<string, PollState_Internal>();
  private readonly history = new Map<string, PollHistoryEntry[]>();
  private timer: TimerHandle | null = null;
  private running = false;

  constructor(options: LivePollServiceOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.scheduler = options.scheduler ?? realScheduler;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.historyPerBroadcast = options.historyPerBroadcast ?? DEFAULT_HISTORY_PER_BROADCAST;
    this.maxOptions = options.maxOptions ?? DEFAULT_MAX_OPTIONS;
    this.minOptions = options.minOptions ?? DEFAULT_MIN_OPTIONS;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.autoCloseOnExpiry = options.autoCloseOnExpiry ?? true;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = this.scheduler.setInterval(() => this.tick(), this.snapshotIntervalMs);
    logger.info({ intervalMs: this.snapshotIntervalMs }, 'LivePollService started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    logger.info({ openPolls: this.polls.size }, 'LivePollService stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Poll creation
  // -------------------------------------------------------------------------

  createPoll(input: CreatePollInput): Poll {
    const question = sanitiseQuestion(input.question);
    if (question === null) throw new Error('createPoll: invalid question');

    if (typeof input.broadcastId !== 'string' || input.broadcastId.length === 0) {
      throw new Error('createPoll: invalid broadcastId');
    }
    if (typeof input.creatorId !== 'string' || input.creatorId.length === 0) {
      throw new Error('createPoll: invalid creatorId');
    }

    if (!Array.isArray(input.options)) throw new Error('createPoll: options must be an array');
    if (input.options.length < this.minOptions || input.options.length > this.maxOptions) {
      throw new Error(
        `createPoll: options must contain between ${this.minOptions} and ${this.maxOptions} entries`
      );
    }

    const optionLabels = new Set<string>();
    const options: PollOption[] = input.options.map((raw, idx) => {
      const label = sanitiseLabel(raw.label);
      if (label === null) throw new Error(`createPoll: option ${idx} has invalid label`);
      if (optionLabels.has(label.toLowerCase())) {
        throw new Error(`createPoll: duplicate option label "${label}"`);
      }
      optionLabels.add(label.toLowerCase());
      return Object.freeze({ id: raw.id ?? `opt_${idx + 1}`, label });
    });

    const optionIds = new Set<string>();
    for (const opt of options) {
      if (optionIds.has(opt.id)) throw new Error(`createPoll: duplicate option id "${opt.id}"`);
      optionIds.add(opt.id);
    }

    const duration = clampDuration(input.durationMs);
    if (duration === null) {
      throw new Error(
        `createPoll: durationMs must be between ${DEFAULT_MIN_DURATION_MS} and ${DEFAULT_MAX_DURATION_MS}`
      );
    }

    const mode: PollMode = input.mode === 'PREDICTION' ? 'PREDICTION' : 'STANDARD';
    const minStake =
      typeof input.minStake === 'number' && input.minStake > 0 ? Math.floor(input.minStake) : 1;
    const maxStake =
      typeof input.maxStake === 'number' && input.maxStake > 0
        ? Math.floor(input.maxStake)
        : 10_000;
    if (mode === 'PREDICTION' && maxStake < minStake) {
      throw new Error('createPoll: maxStake must be ≥ minStake');
    }

    const now = this.clock.now();
    const id = this.idFactory();
    const poll: Poll = Object.freeze({
      id,
      broadcastId: input.broadcastId,
      creatorId: input.creatorId,
      question,
      options: Object.freeze(options),
      mode,
      minStake,
      maxStake,
      createdAt: new Date(now),
      closesAt: new Date(now + duration),
      closedAt: null,
      revealedAt: null,
      state: 'OPEN',
      winningOptionId: null,
    });

    const state: PollState_Internal = {
      poll,
      optionsById: new Map(options.map((o) => [o.id, o])),
      votesByOption: new Map(options.map((o) => [o.id, 0])),
      stakeByOption: new Map(options.map((o) => [o.id, 0])),
      votedUsers: new Set(),
      stakeByUser: new Map(),
      listeners: new Set(),
      revealListeners: new Set(),
      finalTally: null,
      reveal: null,
    };
    this.polls.set(id, state);
    logger.info({ pollId: id, broadcastId: poll.broadcastId, mode }, 'Poll created');
    return poll;
  }

  // -------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------

  vote(input: VoteInput): VoteResult {
    const state = this.polls.get(input.pollId);
    if (!state) return { accepted: false, reason: 'POLL_NOT_FOUND' };
    const now = this.clock.now();

    if (state.poll.state !== 'OPEN' || now >= state.poll.closesAt.getTime()) {
      // Auto-close on stale tick
      if (state.poll.state === 'OPEN') this.closePoll(state, now);
      return { accepted: false, reason: 'POLL_CLOSED' };
    }

    if (typeof input.userId !== 'string' || input.userId.length === 0) {
      return { accepted: false, reason: 'INVALID_USER' };
    }
    if (!state.optionsById.has(input.optionId)) {
      return { accepted: false, reason: 'INVALID_OPTION' };
    }
    if (state.votedUsers.has(input.userId)) {
      return { accepted: false, reason: 'ALREADY_VOTED' };
    }

    let stake = 0;
    if (state.poll.mode === 'PREDICTION') {
      const raw = input.stake;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { accepted: false, reason: 'INVALID_STAKE' };
      }
      stake = Math.floor(raw);
      if (stake < state.poll.minStake || stake > state.poll.maxStake) {
        return { accepted: false, reason: 'INVALID_STAKE' };
      }
    } else if (typeof input.stake === 'number' && input.stake !== 0) {
      // Standard polls do not accept stakes — silently ignore positive
      // values rather than reject (forwards-compat with new clients).
      stake = 0;
    }

    state.votedUsers.add(input.userId);
    state.votesByOption.set(input.optionId, (state.votesByOption.get(input.optionId) ?? 0) + 1);
    if (stake > 0) {
      state.stakeByOption.set(
        input.optionId,
        (state.stakeByOption.get(input.optionId) ?? 0) + stake
      );
      state.stakeByUser.set(input.userId, { optionId: input.optionId, stake });
    }

    const tally = this.buildTally(state, now);
    return { accepted: true, reason: 'OK', poll: state.poll, tally };
  }

  // -------------------------------------------------------------------------
  // Closing & reveal
  // -------------------------------------------------------------------------

  /**
   * Close a poll without choosing a winner.  The reveal can be requested
   * later via `revealPoll`.  Idempotent.
   */
  forceClose(pollId: string): Poll {
    const state = this.polls.get(pollId);
    if (!state) throw new Error('forceClose: poll not found');
    if (state.poll.state === 'OPEN') this.closePoll(state, this.clock.now());
    return state.poll;
  }

  /**
   * Close a poll (if still open) and emit the reveal payload.  When no
   * `winningOptionId` is provided the option with the most votes wins;
   * ties are broken by stake then by option id (lexicographic) so the
   * outcome is deterministic.
   */
  revealPoll(pollId: string, winningOptionId?: string): RevealPayload {
    const state = this.polls.get(pollId);
    if (!state) throw new Error('revealPoll: poll not found');
    const now = this.clock.now();
    if (state.poll.state === 'OPEN') this.closePoll(state, now);

    if (state.reveal) return state.reveal;

    const tally = state.finalTally ?? this.buildTally(state, now);
    const ranked = tally.options
      .slice()
      .sort((a, b) => b.votes - a.votes || b.stake - a.stake || a.optionId.localeCompare(b.optionId));

    let winnerId = winningOptionId;
    if (winnerId !== undefined && !state.optionsById.has(winnerId)) {
      throw new Error('revealPoll: invalid winningOptionId');
    }
    if (!winnerId) {
      winnerId = ranked[0]?.optionId ?? state.poll.options[0].id;
    }
    const winningLabel = state.optionsById.get(winnerId)!.label;

    let payouts: PayoutLine[] = [];
    let totalPayout = 0;
    let housePot = 0;
    if (state.poll.mode === 'PREDICTION') {
      const totalStake = tally.totalStake;
      housePot = Math.floor(totalStake * HOUSE_RAKE);
      const distributable = totalStake - housePot;
      const winningStake = state.stakeByOption.get(winnerId) ?? 0;
      const lines: PayoutLine[] = [];
      for (const [userId, { optionId, stake }] of state.stakeByUser) {
        if (optionId === winnerId && winningStake > 0) {
          const payout = Math.floor((stake / winningStake) * distributable);
          totalPayout += payout;
          lines.push({ userId, stake, payout, net: payout - stake });
        } else {
          lines.push({ userId, stake, payout: 0, net: -stake });
        }
      }
      lines.sort((a, b) => b.payout - a.payout || a.userId.localeCompare(b.userId));
      payouts = lines;
    }

    const reveal: RevealPayload = Object.freeze({
      pollId,
      winningOptionId: winnerId,
      winningLabel,
      ranked: Object.freeze(ranked),
      mode: state.poll.mode,
      payouts: Object.freeze(payouts),
      totalPayout,
      housePot,
      revealedAt: new Date(now),
    });

    const updatedPoll: Poll = Object.freeze({
      ...state.poll,
      state: 'REVEALED',
      revealedAt: new Date(now),
      winningOptionId: winnerId,
    });
    state.poll = updatedPoll;
    state.reveal = reveal;
    state.finalTally = this.buildTally(state, now);

    this.archive(state);
    this.dispatchTally(state, state.finalTally);
    this.dispatchReveal(state, reveal);
    return reveal;
  }

  // -------------------------------------------------------------------------
  // Subscriptions & queries
  // -------------------------------------------------------------------------

  subscribe(pollId: string, listener: PollListener): () => void {
    const state = this.polls.get(pollId);
    if (!state) throw new Error('subscribe: poll not found');
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  subscribeReveal(pollId: string, listener: RevealListener): () => void {
    const state = this.polls.get(pollId);
    if (!state) throw new Error('subscribeReveal: poll not found');
    state.revealListeners.add(listener);
    return () => state.revealListeners.delete(listener);
  }

  getPoll(pollId: string): Poll | null {
    return this.polls.get(pollId)?.poll ?? null;
  }

  getTally(pollId: string): PollTally | null {
    const state = this.polls.get(pollId);
    if (!state) return null;
    if (state.finalTally) return state.finalTally;
    return this.buildTally(state, this.clock.now());
  }

  getReveal(pollId: string): RevealPayload | null {
    return this.polls.get(pollId)?.reveal ?? null;
  }

  listOpenPolls(broadcastId: string): Poll[] {
    const out: Poll[] = [];
    for (const state of this.polls.values()) {
      if (state.poll.broadcastId === broadcastId && state.poll.state === 'OPEN') {
        out.push(state.poll);
      }
    }
    return out;
  }

  history_for(broadcastId: string): PollHistoryEntry[] {
    return (this.history.get(broadcastId) ?? []).slice();
  }

  // -------------------------------------------------------------------------
  // Tick — drives auto-close + snapshot fan-out
  // -------------------------------------------------------------------------

  /** Exposed for tests driving a manual scheduler. */
  tick(): void {
    if (!this.running) return;
    const now = this.clock.now();
    for (const state of this.polls.values()) {
      if (state.poll.state === 'OPEN') {
        if (this.autoCloseOnExpiry && now >= state.poll.closesAt.getTime()) {
          this.closePoll(state, now);
        }
        const tally = this.buildTally(state, now);
        this.dispatchTally(state, tally);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private closePoll(state: PollState_Internal, now: number): void {
    if (state.poll.state !== 'OPEN') return;
    const closed: Poll = Object.freeze({
      ...state.poll,
      state: 'CLOSED',
      closedAt: new Date(now),
    });
    state.poll = closed;
    state.finalTally = this.buildTally(state, now);
    this.dispatchTally(state, state.finalTally);
    logger.info({ pollId: state.poll.id }, 'Poll closed');
  }

  private buildTally(state: PollState_Internal, now: number): PollTally {
    let totalVotes = 0;
    let totalStake = 0;
    for (const v of state.votesByOption.values()) totalVotes += v;
    for (const s of state.stakeByOption.values()) totalStake += s;

    let leadingId: string | null = null;
    let leadingVotes = -1;
    for (const [optionId, votes] of state.votesByOption) {
      if (votes > leadingVotes) {
        leadingId = optionId;
        leadingVotes = votes;
      }
    }

    const options: OptionTally[] = state.poll.options.map((opt) => {
      const votes = state.votesByOption.get(opt.id) ?? 0;
      const stake = state.stakeByOption.get(opt.id) ?? 0;
      const percent = totalVotes > 0 ? (votes / totalVotes) * 100 : 0;
      const stakePercent = totalStake > 0 ? (stake / totalStake) * 100 : 0;
      return Object.freeze({
        optionId: opt.id,
        label: opt.label,
        votes,
        stake,
        percent,
        stakePercent,
        barAnimationMs: Math.min(900, this.snapshotIntervalMs * 3),
        leading: opt.id === leadingId && totalVotes > 0,
      });
    });

    const remainingMs = Math.max(0, state.poll.closesAt.getTime() - now);
    return Object.freeze({
      pollId: state.poll.id,
      broadcastId: state.poll.broadcastId,
      state: state.poll.state,
      totalVotes,
      totalStake,
      options: Object.freeze(options),
      remainingMs,
      generatedAt: new Date(now),
    });
  }

  private dispatchTally(state: PollState_Internal, tally: PollTally): void {
    for (const listener of state.listeners) {
      try {
        listener(tally);
      } catch (err) {
        logger.warn({ err, pollId: state.poll.id }, 'LivePollService listener threw');
      }
    }
  }

  private dispatchReveal(state: PollState_Internal, reveal: RevealPayload): void {
    for (const listener of state.revealListeners) {
      try {
        listener(reveal);
      } catch (err) {
        logger.warn({ err, pollId: state.poll.id }, 'LivePollService reveal listener threw');
      }
    }
  }

  private archive(state: PollState_Internal): void {
    if (!state.finalTally || !state.reveal) return;
    const list = this.history.get(state.poll.broadcastId) ?? [];
    list.unshift({ poll: state.poll, finalTally: state.finalTally, reveal: state.reveal });
    while (list.length > this.historyPerBroadcast) list.pop();
    this.history.set(state.poll.broadcastId, list);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let singleton: LivePollService | null = null;

export function getLivePollService(options?: LivePollServiceOptions): LivePollService {
  if (!singleton) {
    singleton = new LivePollService(options);
    singleton.start();
  }
  return singleton;
}

export function __resetLivePollServiceSingleton(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
