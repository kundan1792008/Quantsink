import logger from '../lib/logger';

/**
 * LiveQAService — Crowd-Sourced Q&A Overlay for Live Broadcasts
 * =============================================================
 *
 * During a live broadcast viewers post questions; everyone else upvotes
 * the questions they want answered; the broadcaster sees a list sorted
 * by net upvotes (with pinned questions always on top) and marks
 * questions as ANSWERED once they have addressed them on-air.
 *
 * Functional requirements (issue #21):
 *
 *   - Submit questions (length-bounded, throttled per-user).
 *   - Upvote / undo upvote (one vote per user per question).
 *   - Sort by popularity for the broadcaster panel.
 *   - "Answered" state with timestamp.
 *   - Pin important questions to top.
 *
 * Implementation notes:
 *
 *   - Single in-memory store keyed by broadcastId; a real deployment
 *     would persist to Postgres but the public surface is stable so
 *     swapping the backend later is a one-file change.
 *   - All time-sensitive logic uses an injectable Clock so the service
 *     is fully deterministic under Jest.
 *   - Every mutation method returns the freshly-rendered question (or
 *     null on failure) so HTTP handlers don't have to do a follow-up
 *     read.
 *   - A snapshot listener mechanism mirrors ReactionEngine /
 *     LivePollService so the WebSocket bridge can fan out the
 *     broadcaster panel without polling.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuestionState = 'OPEN' | 'ANSWERED' | 'HIDDEN';

export interface Question {
  readonly id: string;
  readonly broadcastId: string;
  readonly authorId: string;
  readonly authorDisplayName: string;
  readonly body: string;
  readonly upvotes: number;
  readonly state: QuestionState;
  readonly pinned: boolean;
  readonly createdAt: Date;
  readonly answeredAt: Date | null;
  readonly hiddenAt: Date | null;
  readonly score: number;          // popularity score, used for sorting
}

export interface SubmitInput {
  readonly broadcastId: string;
  readonly authorId: string;
  readonly authorDisplayName: string;
  readonly body: string;
}

export interface SubmitResult {
  readonly accepted: boolean;
  readonly reason?:
    | 'OK'
    | 'INVALID_BODY'
    | 'INVALID_USER'
    | 'INVALID_BROADCAST'
    | 'THROTTLED'
    | 'DUPLICATE';
  readonly question?: Question;
}

export interface UpvoteInput {
  readonly questionId: string;
  readonly userId: string;
}

export interface UpvoteResult {
  readonly accepted: boolean;
  readonly reason?:
    | 'OK'
    | 'NOT_FOUND'
    | 'ALREADY_VOTED'
    | 'NOT_VOTED'
    | 'INVALID_USER';
  readonly question?: Question;
}

export interface QuestionListSnapshot {
  readonly broadcastId: string;
  readonly pinned: ReadonlyArray<Question>;
  readonly open: ReadonlyArray<Question>;
  readonly answered: ReadonlyArray<Question>;
  readonly totalQuestions: number;
  readonly totalUpvotes: number;
  readonly generatedAt: Date;
}

export type QASnapshotListener = (snapshot: QuestionListSnapshot) => void;

export interface LiveQAServiceOptions {
  readonly clock?: ClockApi;
  readonly idFactory?: () => string;
  readonly perUserPerMinute?: number;
  readonly maxBodyLength?: number;
  readonly minBodyLength?: number;
  readonly maxQuestionsPerBroadcast?: number;
  readonly duplicateWindowMs?: number;
}

export interface ClockApi {
  now(): number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PER_USER_PER_MINUTE = 5;
const DEFAULT_MAX_BODY_LENGTH = 280;
const DEFAULT_MIN_BODY_LENGTH = 5;
const DEFAULT_MAX_QUESTIONS_PER_BROADCAST = 5_000;
const DEFAULT_DUPLICATE_WINDOW_MS = 60_000;

const realClock: ClockApi = { now: () => Date.now() };

function defaultIdFactory(): string {
  return `qa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitiseBody(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  // Strip control chars and collapse whitespace to a single space; we
  // explicitly do NOT escape HTML — that's the renderer's job.  We do
  // refuse zero-width, BOM and bidi-override characters so screens
  // can't be tricked into rendering misleading questions.
  let cleaned = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    if (code === 0x200b || code === 0x200c || code === 0x200d) continue;
    if (code === 0xfeff) continue;
    if (code === 0x202a || code === 0x202b || code === 0x202c || code === 0x202d || code === 0x202e) continue;
    cleaned += ch;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length < min || cleaned.length > max) return null;
  return cleaned;
}

function sanitiseShortString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

// Pinned questions get a huge score boost so they always float to the
// top of the broadcaster panel; tied questions break by recency so the
// broadcaster sees the freshest popular questions first.
function computeScore(q: { upvotes: number; pinned: boolean; createdAt: Date }): number {
  const base = q.upvotes;
  const recency = Math.floor(q.createdAt.getTime() / 1_000); // seconds, for sub-vote tie-break
  const pinBonus = q.pinned ? 1_000_000 : 0;
  // Multiply upvotes by 10_000 so they always dominate the recency tie-break.
  return pinBonus + base * 10_000 + (recency % 10_000);
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface BroadcastQAState {
  readonly broadcastId: string;
  readonly questions: Map<string, Question>;
  readonly upvoteRegistry: Map<string, Set<string>>; // questionId → voterIds
  readonly userTimestamps: Map<string, number[]>;
  readonly recentBodies: Map<string, number>;        // hash → first-seen ms
  readonly listeners: Set<QASnapshotListener>;
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

export class LiveQAService {
  private readonly clock: ClockApi;
  private readonly idFactory: () => string;
  private readonly perUserPerMinute: number;
  private readonly maxBodyLength: number;
  private readonly minBodyLength: number;
  private readonly maxQuestionsPerBroadcast: number;
  private readonly duplicateWindowMs: number;

  private readonly broadcasts = new Map<string, BroadcastQAState>();

  constructor(options: LiveQAServiceOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.perUserPerMinute = options.perUserPerMinute ?? DEFAULT_PER_USER_PER_MINUTE;
    this.maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;
    this.minBodyLength = options.minBodyLength ?? DEFAULT_MIN_BODY_LENGTH;
    this.maxQuestionsPerBroadcast =
      options.maxQuestionsPerBroadcast ?? DEFAULT_MAX_QUESTIONS_PER_BROADCAST;
    this.duplicateWindowMs = options.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  submit(input: SubmitInput): SubmitResult {
    if (typeof input.broadcastId !== 'string' || input.broadcastId.length === 0) {
      return { accepted: false, reason: 'INVALID_BROADCAST' };
    }
    if (typeof input.authorId !== 'string' || input.authorId.length === 0) {
      return { accepted: false, reason: 'INVALID_USER' };
    }
    const displayName = sanitiseShortString(input.authorDisplayName, 80);
    if (displayName === null) return { accepted: false, reason: 'INVALID_USER' };

    const body = sanitiseBody(input.body, this.minBodyLength, this.maxBodyLength);
    if (body === null) return { accepted: false, reason: 'INVALID_BODY' };

    const state = this.ensureState(input.broadcastId);
    if (state.questions.size >= this.maxQuestionsPerBroadcast) {
      return { accepted: false, reason: 'THROTTLED' };
    }
    const now = this.clock.now();
    if (!this.passesUserThrottle(state, input.authorId, now)) {
      return { accepted: false, reason: 'THROTTLED' };
    }
    if (!this.passesDuplicateGuard(state, input.authorId, body, now)) {
      return { accepted: false, reason: 'DUPLICATE' };
    }

    const id = this.idFactory();
    const question: Question = Object.freeze({
      id,
      broadcastId: input.broadcastId,
      authorId: input.authorId,
      authorDisplayName: displayName,
      body,
      upvotes: 0,
      state: 'OPEN',
      pinned: false,
      createdAt: new Date(now),
      answeredAt: null,
      hiddenAt: null,
      score: computeScore({ upvotes: 0, pinned: false, createdAt: new Date(now) }),
    });
    state.questions.set(id, question);
    state.upvoteRegistry.set(id, new Set());
    this.broadcastSnapshot(state);
    return { accepted: true, reason: 'OK', question };
  }

  // -------------------------------------------------------------------------
  // Upvoting
  // -------------------------------------------------------------------------

  upvote(input: UpvoteInput): UpvoteResult {
    const { state, question } = this.lookup(input.questionId);
    if (!state || !question) return { accepted: false, reason: 'NOT_FOUND' };
    if (typeof input.userId !== 'string' || input.userId.length === 0) {
      return { accepted: false, reason: 'INVALID_USER' };
    }
    if (input.userId === question.authorId) {
      // Authors cannot upvote their own questions; treat as a duplicate
      // vote rather than an error so the UI just silently no-ops.
      return { accepted: false, reason: 'ALREADY_VOTED' };
    }
    const voters = state.upvoteRegistry.get(question.id)!;
    if (voters.has(input.userId)) return { accepted: false, reason: 'ALREADY_VOTED' };
    voters.add(input.userId);
    const updated = this.recompute(question, { upvotes: question.upvotes + 1 });
    state.questions.set(updated.id, updated);
    this.broadcastSnapshot(state);
    return { accepted: true, reason: 'OK', question: updated };
  }

  removeUpvote(input: UpvoteInput): UpvoteResult {
    const { state, question } = this.lookup(input.questionId);
    if (!state || !question) return { accepted: false, reason: 'NOT_FOUND' };
    if (typeof input.userId !== 'string' || input.userId.length === 0) {
      return { accepted: false, reason: 'INVALID_USER' };
    }
    const voters = state.upvoteRegistry.get(question.id)!;
    if (!voters.has(input.userId)) return { accepted: false, reason: 'NOT_VOTED' };
    voters.delete(input.userId);
    const updated = this.recompute(question, { upvotes: Math.max(0, question.upvotes - 1) });
    state.questions.set(updated.id, updated);
    this.broadcastSnapshot(state);
    return { accepted: true, reason: 'OK', question: updated };
  }

  // -------------------------------------------------------------------------
  // Broadcaster controls — answer / pin / hide
  // -------------------------------------------------------------------------

  markAnswered(questionId: string): Question | null {
    const { state, question } = this.lookup(questionId);
    if (!state || !question) return null;
    if (question.state === 'ANSWERED') return question;
    const updated = this.recompute(question, {
      state: 'ANSWERED',
      answeredAt: new Date(this.clock.now()),
      pinned: false, // un-pin once answered so new questions can surface
    });
    state.questions.set(updated.id, updated);
    this.broadcastSnapshot(state);
    return updated;
  }

  pin(questionId: string): Question | null {
    const { state, question } = this.lookup(questionId);
    if (!state || !question) return null;
    if (question.pinned) return question;
    const updated = this.recompute(question, { pinned: true });
    state.questions.set(updated.id, updated);
    this.broadcastSnapshot(state);
    return updated;
  }

  unpin(questionId: string): Question | null {
    const { state, question } = this.lookup(questionId);
    if (!state || !question) return null;
    if (!question.pinned) return question;
    const updated = this.recompute(question, { pinned: false });
    state.questions.set(updated.id, updated);
    this.broadcastSnapshot(state);
    return updated;
  }

  hide(questionId: string): Question | null {
    const { state, question } = this.lookup(questionId);
    if (!state || !question) return null;
    if (question.state === 'HIDDEN') return question;
    const updated = this.recompute(question, {
      state: 'HIDDEN',
      pinned: false,
      hiddenAt: new Date(this.clock.now()),
    });
    state.questions.set(updated.id, updated);
    this.broadcastSnapshot(state);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  get(questionId: string): Question | null {
    return this.lookup(questionId).question ?? null;
  }

  list(broadcastId: string): QuestionListSnapshot {
    const state = this.ensureState(broadcastId);
    return this.buildSnapshot(state);
  }

  /** Returns the broadcaster panel order (pinned first, then OPEN by score). */
  panel(broadcastId: string): Question[] {
    const snapshot = this.list(broadcastId);
    return [...snapshot.pinned, ...snapshot.open];
  }

  subscribe(broadcastId: string, listener: QASnapshotListener): () => void {
    const state = this.ensureState(broadcastId);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  closeBroadcast(broadcastId: string): void {
    const state = this.broadcasts.get(broadcastId);
    if (!state) return;
    state.listeners.clear();
    this.broadcasts.delete(broadcastId);
    logger.info({ broadcastId }, 'LiveQAService broadcast closed');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureState(broadcastId: string): BroadcastQAState {
    let state = this.broadcasts.get(broadcastId);
    if (state) return state;
    state = {
      broadcastId,
      questions: new Map(),
      upvoteRegistry: new Map(),
      userTimestamps: new Map(),
      recentBodies: new Map(),
      listeners: new Set(),
    };
    this.broadcasts.set(broadcastId, state);
    return state;
  }

  private lookup(questionId: string): { state: BroadcastQAState | null; question: Question | null } {
    if (typeof questionId !== 'string' || questionId.length === 0) {
      return { state: null, question: null };
    }
    for (const state of this.broadcasts.values()) {
      const q = state.questions.get(questionId);
      if (q) return { state, question: q };
    }
    return { state: null, question: null };
  }

  private passesUserThrottle(state: BroadcastQAState, userId: string, now: number): boolean {
    let timestamps = state.userTimestamps.get(userId);
    const cutoff = now - 60_000;
    if (!timestamps) {
      timestamps = [];
      state.userTimestamps.set(userId, timestamps);
    }
    let drop = 0;
    while (drop < timestamps.length && timestamps[drop] <= cutoff) drop++;
    if (drop > 0) timestamps.splice(0, drop);
    if (timestamps.length >= this.perUserPerMinute) return false;
    timestamps.push(now);
    return true;
  }

  private passesDuplicateGuard(
    state: BroadcastQAState,
    userId: string,
    body: string,
    now: number
  ): boolean {
    const key = `${userId}::${body.toLowerCase()}`;
    // Evict expired entries (linear scan; map size is bounded by traffic).
    const cutoff = now - this.duplicateWindowMs;
    for (const [k, ts] of state.recentBodies) {
      if (ts <= cutoff) state.recentBodies.delete(k);
    }
    if (state.recentBodies.has(key)) return false;
    state.recentBodies.set(key, now);
    return true;
  }

  private recompute(question: Question, patch: Partial<Question>): Question {
    const merged: Question = {
      id: question.id,
      broadcastId: question.broadcastId,
      authorId: question.authorId,
      authorDisplayName: question.authorDisplayName,
      body: question.body,
      upvotes: patch.upvotes ?? question.upvotes,
      state: patch.state ?? question.state,
      pinned: patch.pinned ?? question.pinned,
      createdAt: question.createdAt,
      answeredAt: patch.answeredAt !== undefined ? patch.answeredAt : question.answeredAt,
      hiddenAt: patch.hiddenAt !== undefined ? patch.hiddenAt : question.hiddenAt,
      score: 0,
    };
    merged.score = computeScore(merged);
    return Object.freeze(merged);
  }

  private buildSnapshot(state: BroadcastQAState): QuestionListSnapshot {
    const all = Array.from(state.questions.values());
    const pinned: Question[] = [];
    const open: Question[] = [];
    const answered: Question[] = [];
    let totalUpvotes = 0;
    for (const q of all) {
      totalUpvotes += q.upvotes;
      if (q.state === 'HIDDEN') continue;
      if (q.pinned && q.state === 'OPEN') pinned.push(q);
      else if (q.state === 'OPEN') open.push(q);
      else if (q.state === 'ANSWERED') answered.push(q);
    }
    pinned.sort((a, b) => b.score - a.score);
    open.sort((a, b) => b.score - a.score);
    answered.sort((a, b) => (b.answeredAt?.getTime() ?? 0) - (a.answeredAt?.getTime() ?? 0));
    return Object.freeze({
      broadcastId: state.broadcastId,
      pinned: Object.freeze(pinned),
      open: Object.freeze(open),
      answered: Object.freeze(answered),
      totalQuestions: all.length,
      totalUpvotes,
      generatedAt: new Date(this.clock.now()),
    });
  }

  private broadcastSnapshot(state: BroadcastQAState): void {
    if (state.listeners.size === 0) return;
    const snapshot = this.buildSnapshot(state);
    for (const listener of state.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        logger.warn({ err, broadcastId: state.broadcastId }, 'LiveQAService listener threw');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let singleton: LiveQAService | null = null;

export function getLiveQAService(options?: LiveQAServiceOptions): LiveQAService {
  if (!singleton) singleton = new LiveQAService(options);
  return singleton;
}

export function __resetLiveQAServiceSingleton(): void {
  singleton = null;
}
