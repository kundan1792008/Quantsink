import logger from '../lib/logger';

export interface TelemetryFeedback {
  readonly userId: string;
  readonly contentId: string;
  readonly reason:
    | 'dwell_positive'
    | 'dwell_negative'
    | 'micro_hesitation'
    | 'rapid_exit';
  readonly previousWeight: number;
  readonly nextWeight: number;
  readonly delta: number;
  readonly feedbackLoopMs: number;
  readonly at: string;
}

export interface ScrollTelemetry {
  readonly velocityPxPerSec: number;
  readonly microHesitation: boolean;
}

export interface InteractionTelemetryOptions {
  readonly now?: () => Date;
  readonly feedbackBudgetMs?: number;
}

interface ScrollState {
  readonly y: number;
  readonly atMs: number;
  readonly velocityPxPerSec: number;
}

function monotonicNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function clampWeight(weight: number): number {
  return Math.min(4, Math.max(-2, weight));
}

export class InteractionTelemetry {
  private readonly now: () => Date;
  private readonly feedbackBudgetMs: number;
  private readonly weights = new Map<string, number>();
  private readonly dwellStarts = new Map<string, number>();
  private readonly lastScrollByUser = new Map<string, ScrollState>();
  private readonly subscribers = new Set<(feedback: TelemetryFeedback) => void>();

  constructor(options: InteractionTelemetryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.feedbackBudgetMs = options.feedbackBudgetMs ?? 50;
  }

  beginDwell(userId: string, contentId: string, at: Date = this.now()): void {
    this.dwellStarts.set(`${userId}:${contentId}`, at.getTime());
  }

  endDwell(userId: string, contentId: string, at: Date = this.now()): TelemetryFeedback {
    const key = `${userId}:${contentId}`;
    const startedAt = this.dwellStarts.get(key) ?? at.getTime();
    this.dwellStarts.delete(key);

    const dwellMs = Math.max(0, at.getTime() - startedAt);
    const positive = dwellMs >= 3_000;
    const delta = positive ? this.dwellDelta(dwellMs) : -0.15;
    return this.applyFeedback(
      userId,
      contentId,
      positive ? 'dwell_positive' : 'dwell_negative',
      delta,
    );
  }

  trackScroll(
    userId: string,
    scrollY: number,
    activeContentId?: string,
    at: Date = this.now(),
  ): ScrollTelemetry {
    const atMs = at.getTime();
    const prev = this.lastScrollByUser.get(userId);

    if (!prev) {
      this.lastScrollByUser.set(userId, {
        y: scrollY,
        atMs,
        velocityPxPerSec: 0,
      });
      return { velocityPxPerSec: 0, microHesitation: false };
    }

    const dtMs = Math.max(1, atMs - prev.atMs);
    const dy = scrollY - prev.y;
    const velocityPxPerSec = (dy / dtMs) * 1000;

    const microHesitation =
      Math.abs(prev.velocityPxPerSec) > 700 &&
      Math.abs(velocityPxPerSec) < 90 &&
      dtMs <= 220;

    this.lastScrollByUser.set(userId, {
      y: scrollY,
      atMs,
      velocityPxPerSec,
    });

    if (activeContentId && microHesitation) {
      this.applyFeedback(userId, activeContentId, 'micro_hesitation', 0.08);
    }

    return { velocityPxPerSec, microHesitation };
  }

  rapidExit(userId: string, contentId: string): TelemetryFeedback {
    this.dwellStarts.delete(`${userId}:${contentId}`);
    return this.applyFeedback(userId, contentId, 'rapid_exit', -0.25);
  }

  getWeight(contentId: string): number {
    return this.weights.get(contentId) ?? 0;
  }

  snapshotWeights(): ReadonlyMap<string, number> {
    return new Map(this.weights);
  }

  onFeedback(listener: (feedback: TelemetryFeedback) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private dwellDelta(dwellMs: number): number {
    if (dwellMs >= 12_000) return 0.4;
    if (dwellMs >= 8_000) return 0.28;
    return 0.18;
  }

  private applyFeedback(
    userId: string,
    contentId: string,
    reason: TelemetryFeedback['reason'],
    delta: number,
  ): TelemetryFeedback {
    const start = monotonicNowMs();
    const previousWeight = this.weights.get(contentId) ?? 0;
    const nextWeight = clampWeight(previousWeight + delta);
    this.weights.set(contentId, nextWeight);

    const feedbackLoopMs = Math.max(0, monotonicNowMs() - start);
    if (feedbackLoopMs > this.feedbackBudgetMs) {
      logger.warn(
        {
          userId,
          contentId,
          reason,
          feedbackLoopMs,
          budgetMs: this.feedbackBudgetMs,
        },
        'InteractionTelemetry feedback loop exceeded target budget',
      );
    }

    const feedback: TelemetryFeedback = {
      userId,
      contentId,
      reason,
      previousWeight,
      nextWeight,
      delta,
      feedbackLoopMs,
      at: this.now().toISOString(),
    };

    for (const subscriber of this.subscribers) {
      subscriber(feedback);
    }

    return feedback;
  }
}

export default InteractionTelemetry;
