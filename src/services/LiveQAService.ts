import { EventEmitter } from 'events';
import logger from '../lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type QuestionStatus = 'pending' | 'answered' | 'dismissed';

export interface Question {
  id: string;
  broadcastId: string;
  authorId: string;
  authorDisplayName: string;
  text: string;
  upvotes: number;
  status: QuestionStatus;
  pinned: boolean;
  createdAt: number;
  answeredAt: number | null;
}

export interface UpvoteResult {
  success: boolean;
  reason?: string;
  newUpvotes?: number;
}

export interface QuestionListOptions {
  /** Include questions with this status (default: all) */
  status?: QuestionStatus | 'all';
  /** Include pinned questions at the top (default: true) */
  pinnedFirst?: boolean;
  /** Max results to return (default: 100) */
  limit?: number;
}

export interface LiveQAServiceConfig {
  /** Maximum character length of a question (default: 280) */
  maxQuestionLength?: number;
  /** Maximum number of questions per broadcast kept in memory (default: 1000) */
  maxQuestionsPerBroadcast?: number;
  /** Max questions a single user can submit per broadcast (default: 5) */
  maxQuestionsPerUser?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _qIdCounter = 0;

function generateQuestionId(): string {
  _qIdCounter = (_qIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `qa_${Date.now()}_${_qIdCounter}`;
}

// ─── LiveQAService ────────────────────────────────────────────────────────────

/**
 * LiveQAService manages real-time Q&A queues for live broadcasts.
 *
 * Features:
 *  - Viewers submit questions (character-limited, per-user rate cap).
 *  - Upvote system surfaces the most popular questions to the top.
 *  - Broadcaster can mark questions as answered (with timestamp) or dismissed.
 *  - Pin important questions to the top of the queue regardless of vote count.
 *  - Query API returns questions sorted by: pinned → upvotes → recency.
 *  - Full history of all questions is preserved per broadcast.
 */
export class LiveQAService extends EventEmitter {
  private readonly maxQuestionLength: number;
  private readonly maxQuestionsPerBroadcast: number;
  private readonly maxQuestionsPerUser: number;

  /** broadcastId → list of questions */
  private readonly questions = new Map<string, Question[]>();

  /** userId:broadcastId → number of questions submitted */
  private readonly submissionCounts = new Map<string, number>();

  /** userId:questionId → true (prevents double upvoting) */
  private readonly upvoteRecord = new Set<string>();

  constructor(config: LiveQAServiceConfig = {}) {
    super();
    this.maxQuestionLength = config.maxQuestionLength ?? 280;
    this.maxQuestionsPerBroadcast = config.maxQuestionsPerBroadcast ?? 1_000;
    this.maxQuestionsPerUser = config.maxQuestionsPerUser ?? 5;
  }

  // ── Viewer API ─────────────────────────────────────────────────────────────

  /**
   * Submit a new question to the Q&A queue.
   */
  submitQuestion(params: {
    broadcastId: string;
    authorId: string;
    authorDisplayName: string;
    text: string;
  }): Question {
    const { broadcastId, authorId, authorDisplayName, text } = params;

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Question text cannot be empty');
    }
    if (trimmed.length > this.maxQuestionLength) {
      throw new Error(
        `Question exceeds maximum length of ${this.maxQuestionLength} characters`,
      );
    }

    const broadcastQuestions = this.questions.get(broadcastId) ?? [];
    if (broadcastQuestions.length >= this.maxQuestionsPerBroadcast) {
      throw new Error(
        `Broadcast ${broadcastId} has reached the maximum question limit`,
      );
    }

    const countKey = `${authorId}:${broadcastId}`;
    const currentCount = this.submissionCounts.get(countKey) ?? 0;
    if (currentCount >= this.maxQuestionsPerUser) {
      throw new Error(
        `User ${authorId} has reached the maximum of ${this.maxQuestionsPerUser} questions per broadcast`,
      );
    }

    const question: Question = {
      id: generateQuestionId(),
      broadcastId,
      authorId,
      authorDisplayName: authorDisplayName.trim() || 'Anonymous',
      text: trimmed,
      upvotes: 0,
      status: 'pending',
      pinned: false,
      createdAt: Date.now(),
      answeredAt: null,
    };

    if (!this.questions.has(broadcastId)) {
      this.questions.set(broadcastId, []);
    }
    this.questions.get(broadcastId)!.push(question);
    this.submissionCounts.set(countKey, currentCount + 1);

    this.emit('question:submitted', question);
    logger.info(
      { questionId: question.id, broadcastId, authorId },
      'LiveQAService: question submitted',
    );
    return question;
  }

  /**
   * Upvote a question.  A user can only upvote each question once.
   */
  upvoteQuestion(questionId: string, userId: string): UpvoteResult {
    const upvoteKey = `${userId}:${questionId}`;
    if (this.upvoteRecord.has(upvoteKey)) {
      return { success: false, reason: 'Already upvoted this question' };
    }

    const question = this._findQuestion(questionId);
    if (!question) {
      return { success: false, reason: 'Question not found' };
    }
    if (question.status === 'dismissed') {
      return { success: false, reason: 'Question has been dismissed' };
    }

    question.upvotes += 1;
    this.upvoteRecord.add(upvoteKey);

    this.emit('question:upvoted', { questionId, userId, newUpvotes: question.upvotes });
    return { success: true, newUpvotes: question.upvotes };
  }

  // ── Broadcaster API ────────────────────────────────────────────────────────

  /**
   * Mark a question as answered.
   */
  markAnswered(questionId: string): Question {
    const question = this._getQuestion(questionId);
    if (question.status === 'answered') {
      throw new Error(`Question ${questionId} is already answered`);
    }

    question.status = 'answered';
    question.answeredAt = Date.now();

    this.emit('question:answered', question);
    logger.info({ questionId }, 'LiveQAService: question answered');
    return { ...question };
  }

  /**
   * Dismiss (soft-delete) a question.  Dismissed questions are hidden from the
   * viewer queue but remain in history for broadcaster review.
   */
  dismissQuestion(questionId: string): Question {
    const question = this._getQuestion(questionId);
    question.status = 'dismissed';

    this.emit('question:dismissed', { questionId });
    return { ...question };
  }

  /**
   * Pin a question to the top of the queue.
   */
  pinQuestion(questionId: string): Question {
    const question = this._getQuestion(questionId);
    question.pinned = true;

    this.emit('question:pinned', { questionId });
    return { ...question };
  }

  /**
   * Unpin a question.
   */
  unpinQuestion(questionId: string): Question {
    const question = this._getQuestion(questionId);
    question.pinned = false;

    this.emit('question:unpinned', { questionId });
    return { ...question };
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  /**
   * Get questions for a broadcast, sorted by:
   *   1. Pinned questions first (if pinnedFirst is true)
   *   2. Upvotes descending
   *   3. Creation time descending (newest first within same vote count)
   */
  getQuestions(
    broadcastId: string,
    options: QuestionListOptions = {},
  ): Question[] {
    const {
      status = 'all',
      pinnedFirst = true,
      limit = 100,
    } = options;

    const list = this.questions.get(broadcastId) ?? [];

    const filtered = list.filter((q) => {
      if (status !== 'all' && q.status !== status) return false;
      return true;
    });

    filtered.sort((a, b) => {
      // Pinned questions bubble to the top when requested
      if (pinnedFirst) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
      }
      // Then sort by upvotes descending
      if (b.upvotes !== a.upvotes) return b.upvotes - a.upvotes;
      // Then by recency descending
      return b.createdAt - a.createdAt;
    });

    return filtered.slice(0, limit).map((q) => ({ ...q }));
  }

  /**
   * Get a single question by id.
   */
  getQuestion(questionId: string): Question | null {
    const q = this._findQuestion(questionId);
    return q ? { ...q } : null;
  }

  /**
   * Return the top N unanswered, non-dismissed questions sorted by upvotes.
   * Convenience wrapper for broadcaster dashboards.
   */
  getTopPendingQuestions(broadcastId: string, limit = 10): Question[] {
    return this.getQuestions(broadcastId, { status: 'pending', pinnedFirst: true, limit });
  }

  /** Return the total number of questions submitted for a broadcast. */
  getQuestionCount(broadcastId: string): number {
    return this.questions.get(broadcastId)?.length ?? 0;
  }

  /** Clear all data for a broadcast (e.g., when the broadcast ends). */
  clearBroadcast(broadcastId: string): void {
    const list = this.questions.get(broadcastId) ?? [];
    for (const q of list) {
      // Remove associated upvote records
      for (const key of this.upvoteRecord) {
        if (key.endsWith(`:${q.id}`)) {
          this.upvoteRecord.delete(key);
        }
      }
    }
    this.questions.delete(broadcastId);
    // Remove submission counts for this broadcast
    for (const [key] of this.submissionCounts) {
      if (key.endsWith(`:${broadcastId}`)) {
        this.submissionCounts.delete(key);
      }
    }
    this.emit('broadcast:cleared', { broadcastId });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _findQuestion(questionId: string): Question | null {
    for (const list of this.questions.values()) {
      const q = list.find((item) => item.id === questionId);
      if (q) return q;
    }
    return null;
  }

  private _getQuestion(questionId: string): Question {
    const q = this._findQuestion(questionId);
    if (!q) throw new Error(`Question not found: ${questionId}`);
    return q;
  }
}

// ─── Singleton helper ─────────────────────────────────────────────────────────

let _qaServiceInstance: LiveQAService | null = null;

export function getLiveQAService(config?: LiveQAServiceConfig): LiveQAService {
  if (!_qaServiceInstance) {
    _qaServiceInstance = new LiveQAService(config);
  }
  return _qaServiceInstance;
}

export function resetLiveQAService(): void {
  _qaServiceInstance = null;
}
