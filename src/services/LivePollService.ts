import { EventEmitter } from 'events';
import logger from '../lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PollStatus = 'pending' | 'active' | 'closed' | 'revealing';

export interface PollOption {
  id: string;
  text: string;
  voteCount: number;
  /** Token amount wagered on this option (prediction mode only) */
  tokensBet: number;
}

export interface Poll {
  id: string;
  broadcastId: string;
  question: string;
  options: PollOption[];
  status: PollStatus;
  durationMs: number;
  startsAt: number | null;
  endsAt: number | null;
  createdAt: number;
  closedAt: number | null;
  /** Total votes cast */
  totalVotes: number;
  /** When true, viewers can bet tokens on outcomes */
  predictionMode: boolean;
  /** Total tokens wagered across all options */
  totalTokensBet: number;
}

export interface VoteResult {
  success: boolean;
  reason?: string;
  updatedOption?: PollOption;
  poll?: Poll;
}

export interface PollSnapshot {
  poll: Poll;
  percentages: Record<string, number>;
  winner: PollOption | null;
  tokenPayouts: Record<string, number> | null;
}

export interface LivePollServiceConfig {
  /** Maximum number of options per poll (default: 4) */
  maxOptions?: number;
  /** Minimum number of options per poll (default: 2) */
  minOptions?: number;
  /** Minimum poll duration in ms (default: 5000) */
  minDurationMs?: number;
  /** Maximum poll duration in ms (default: 300_000 = 5 minutes) */
  maxDurationMs?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _pollIdCounter = 0;

function generatePollId(): string {
  _pollIdCounter = (_pollIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `poll_${Date.now()}_${_pollIdCounter}`;
}

function generateOptionId(): string {
  return `opt_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── LivePollService ──────────────────────────────────────────────────────────

/**
 * LivePollService manages real-time polls for live broadcasts.
 *
 * Features:
 *  - Broadcaster creates polls with 2-4 options.
 *  - Viewers cast votes; results update in real-time.
 *  - "Prediction" mode lets viewers wager tokens on an outcome; winnings are
 *    distributed proportionally among those who picked the winning option.
 *  - A reveal animation sequence is triggered when the poll closes.
 *  - Full history of all past polls is preserved.
 */
export class LivePollService extends EventEmitter {
  private readonly maxOptions: number;
  private readonly minOptions: number;
  private readonly minDurationMs: number;
  private readonly maxDurationMs: number;

  /** All polls ever created, keyed by poll id */
  private readonly polls = new Map<string, Poll>();

  /** Active poll per broadcast (only one active poll per broadcast at a time) */
  private readonly activePollByBroadcast = new Map<string, string>();

  /** Timer handles for auto-close */
  private readonly closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** userId → set of pollOptionIds they voted on (prevent double-voting) */
  private readonly voterRecord = new Map<string, Set<string>>();

  constructor(config: LivePollServiceConfig = {}) {
    super();
    this.maxOptions = config.maxOptions ?? 4;
    this.minOptions = config.minOptions ?? 2;
    this.minDurationMs = config.minDurationMs ?? 5_000;
    this.maxDurationMs = config.maxDurationMs ?? 300_000;
  }

  // ── Broadcaster API ────────────────────────────────────────────────────────

  /**
   * Create a new poll for a broadcast.
   * Only one poll can be active per broadcast at a time.
   */
  createPoll(params: {
    broadcastId: string;
    question: string;
    options: string[];
    durationMs?: number;
    predictionMode?: boolean;
    autoStart?: boolean;
  }): Poll {
    const {
      broadcastId,
      question,
      options: optionTexts,
      durationMs = 30_000,
      predictionMode = false,
      autoStart = true,
    } = params;

    if (optionTexts.length < this.minOptions || optionTexts.length > this.maxOptions) {
      throw new Error(
        `Poll must have between ${this.minOptions} and ${this.maxOptions} options; got ${optionTexts.length}`,
      );
    }
    if (!question.trim()) {
      throw new Error('Poll question cannot be empty');
    }
    if (durationMs < this.minDurationMs || durationMs > this.maxDurationMs) {
      throw new Error(
        `Poll duration must be between ${this.minDurationMs}ms and ${this.maxDurationMs}ms`,
      );
    }

    const existingId = this.activePollByBroadcast.get(broadcastId);
    if (existingId) {
      const existing = this.polls.get(existingId);
      if (existing && existing.status === 'active') {
        throw new Error(`Broadcast ${broadcastId} already has an active poll (id: ${existingId})`);
      }
    }

    const options: PollOption[] = optionTexts.map((text) => ({
      id: generateOptionId(),
      text: text.trim(),
      voteCount: 0,
      tokensBet: 0,
    }));

    const now = Date.now();
    const poll: Poll = {
      id: generatePollId(),
      broadcastId,
      question: question.trim(),
      options,
      status: autoStart ? 'active' : 'pending',
      durationMs,
      startsAt: autoStart ? now : null,
      endsAt: autoStart ? now + durationMs : null,
      createdAt: now,
      closedAt: null,
      totalVotes: 0,
      predictionMode,
      totalTokensBet: 0,
    };

    this.polls.set(poll.id, poll);
    if (autoStart) {
      this.activePollByBroadcast.set(broadcastId, poll.id);
      this._scheduleClose(poll.id, durationMs);
    }

    this.emit('poll:created', poll);
    logger.info({ pollId: poll.id, broadcastId }, 'LivePollService: poll created');
    return poll;
  }

  /** Start a poll that was created with autoStart=false. */
  startPoll(pollId: string): Poll {
    const poll = this._getPoll(pollId);
    if (poll.status !== 'pending') {
      throw new Error(`Poll ${pollId} is not in pending state (current: ${poll.status})`);
    }

    const now = Date.now();
    poll.status = 'active';
    poll.startsAt = now;
    poll.endsAt = now + poll.durationMs;
    this.activePollByBroadcast.set(poll.broadcastId, poll.id);
    this._scheduleClose(poll.id, poll.durationMs);

    this.emit('poll:started', poll);
    return poll;
  }

  /** Immediately close a poll (broadcaster override). */
  closePoll(pollId: string): Poll {
    const poll = this._getPoll(pollId);
    if (poll.status === 'closed' || poll.status === 'revealing') {
      throw new Error(`Poll ${pollId} is already ${poll.status}`);
    }

    const timer = this.closeTimers.get(pollId);
    if (timer) {
      clearTimeout(timer);
      this.closeTimers.delete(pollId);
    }

    this._closeAndReveal(pollId);
    return this.polls.get(pollId)!;
  }

  // ── Viewer API ─────────────────────────────────────────────────────────────

  /**
   * Cast a vote for an option.
   * In prediction mode, `tokensBet` > 0 is required.
   */
  castVote(params: {
    pollId: string;
    optionId: string;
    userId: string;
    tokensBet?: number;
  }): VoteResult {
    const { pollId, optionId, userId, tokensBet = 0 } = params;

    const poll = this.polls.get(pollId);
    if (!poll) return { success: false, reason: 'Poll not found' };
    if (poll.status !== 'active') {
      return { success: false, reason: `Poll is ${poll.status}, not accepting votes` };
    }

    const voterKey = `${userId}:${pollId}`;
    if (this.voterRecord.get(voterKey)?.size) {
      return { success: false, reason: 'Already voted in this poll' };
    }

    const option = poll.options.find((o) => o.id === optionId);
    if (!option) return { success: false, reason: 'Option not found' };

    if (poll.predictionMode && tokensBet <= 0) {
      return { success: false, reason: 'Prediction mode requires a token wager > 0' };
    }

    option.voteCount += 1;
    poll.totalVotes += 1;

    if (poll.predictionMode && tokensBet > 0) {
      option.tokensBet += tokensBet;
      poll.totalTokensBet += tokensBet;
    }

    if (!this.voterRecord.has(voterKey)) {
      this.voterRecord.set(voterKey, new Set());
    }
    this.voterRecord.get(voterKey)!.add(optionId);

    this.emit('poll:vote', { pollId, optionId, userId, tokensBet });
    return { success: true, updatedOption: { ...option }, poll: { ...poll } };
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  /** Get a live snapshot of a poll including percentages and (if closed) winner. */
  getSnapshot(pollId: string): PollSnapshot {
    const poll = this._getPoll(pollId);
    const total = poll.totalVotes;

    const percentages: Record<string, number> = {};
    for (const opt of poll.options) {
      percentages[opt.id] = total > 0 ? Math.round((opt.voteCount / total) * 100) : 0;
    }

    let winner: PollOption | null = null;
    let tokenPayouts: Record<string, number> | null = null;

    if (poll.status === 'closed' || poll.status === 'revealing') {
      winner = poll.options.reduce((a, b) => (a.voteCount >= b.voteCount ? a : b));

      if (poll.predictionMode && poll.totalTokensBet > 0) {
        tokenPayouts = this._computePayouts(poll, winner);
      }
    }

    return { poll: { ...poll }, percentages, winner, tokenPayouts };
  }

  /** Return all polls for a broadcast, newest first. */
  getPollHistory(broadcastId: string): Poll[] {
    return [...this.polls.values()]
      .filter((p) => p.broadcastId === broadcastId)
      .sort((a, b) => {
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
        // Use the numeric counter suffix as a tiebreaker (higher = newer)
        const counterA = parseInt(a.id.split('_').pop() ?? '0', 10);
        const counterB = parseInt(b.id.split('_').pop() ?? '0', 10);
        return counterB - counterA;
      });
  }

  /** Return the currently active poll id for a broadcast, or null. */
  getActivePollId(broadcastId: string): string | null {
    return this.activePollByBroadcast.get(broadcastId) ?? null;
  }

  /** Cancel and destroy a poll (removes it from history). */
  deletePoll(pollId: string): void {
    const poll = this.polls.get(pollId);
    if (!poll) throw new Error(`Poll ${pollId} not found`);

    const timer = this.closeTimers.get(pollId);
    if (timer) {
      clearTimeout(timer);
      this.closeTimers.delete(pollId);
    }

    if (this.activePollByBroadcast.get(poll.broadcastId) === pollId) {
      this.activePollByBroadcast.delete(poll.broadcastId);
    }

    this.polls.delete(pollId);
    this.emit('poll:deleted', { pollId });
  }

  /** Number of polls in memory */
  get size(): number {
    return this.polls.size;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _getPoll(pollId: string): Poll {
    const poll = this.polls.get(pollId);
    if (!poll) throw new Error(`Poll not found: ${pollId}`);
    return poll;
  }

  private _scheduleClose(pollId: string, durationMs: number): void {
    const timer = setTimeout(() => this._closeAndReveal(pollId), durationMs);
    if (timer.unref) timer.unref();
    this.closeTimers.set(pollId, timer);
  }

  private _closeAndReveal(pollId: string): void {
    const poll = this.polls.get(pollId);
    if (!poll || poll.status === 'closed') return;

    poll.status = 'revealing';
    poll.closedAt = Date.now();

    if (this.activePollByBroadcast.get(poll.broadcastId) === poll.id) {
      this.activePollByBroadcast.delete(poll.broadcastId);
    }

    this.emit('poll:revealing', this.getSnapshot(poll.id));
    this.closeTimers.delete(pollId);

    // After a short dramatic reveal window, mark as fully closed
    const revealTimer = setTimeout(() => {
      poll.status = 'closed';
      this.emit('poll:closed', this.getSnapshot(poll.id));
      logger.info({ pollId, totalVotes: poll.totalVotes }, 'LivePollService: poll closed');
    }, 3_000);
    if (revealTimer.unref) revealTimer.unref();
  }

  /**
   * Distribute the token pool proportionally to voters who picked the winner.
   * Returns a map of userId → payout amount (fractional tokens).
   *
   * Note: In a real deployment voter identity would be looked up from the
   * voterRecord; here we return per-option totals for the client to distribute.
   */
  private _computePayouts(poll: Poll, winner: PollOption): Record<string, number> {
    const payouts: Record<string, number> = {};
    const pool = poll.totalTokensBet;

    for (const opt of poll.options) {
      if (opt.id === winner.id) {
        payouts[opt.id] = pool; // winners share the full pool
      } else {
        payouts[opt.id] = 0;
      }
    }

    return payouts;
  }
}

// ─── Singleton helper ─────────────────────────────────────────────────────────

let _serviceInstance: LivePollService | null = null;

export function getLivePollService(config?: LivePollServiceConfig): LivePollService {
  if (!_serviceInstance) {
    _serviceInstance = new LivePollService(config);
  }
  return _serviceInstance;
}

export function resetLivePollService(): void {
  _serviceInstance = null;
}
