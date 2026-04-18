import logger from '../lib/logger';

/**
 * PhantomSocialService — Phantom Viewer Counter & Invisible Audience Anxiety
 *
 * Two primary responsibilities:
 *
 *  1. Inflated viewer counting. Given a truthy "real" concurrent viewer
 *     count we publish an inflated number that trends toward `real × 1.3`
 *     while applying a gentle random walk so the UI never appears frozen.
 *     Every time the count rises we emit a "pulse" event that the React
 *     component animates on.
 *
 *  2. Phantom typing indicators. We maintain a set of anonymous
 *     personas (e.g. "Anonymous Analyst", "Silent Observer") who
 *     periodically "start typing" and "stop typing" even when nobody is
 *     actually composing a reply. This reinforces the feeling of being
 *     watched — the key psychological lever specified in issue #13.
 *
 * All timers use injectable clock/random/timer primitives so the service
 * is 100% deterministic under test.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhantomViewerSample {
  readonly real: number;
  readonly phantom: number;
  readonly delta: number;
  readonly at: Date;
}

export type PhantomViewerListener = (sample: PhantomViewerSample) => void;

export interface PhantomTypingEvent {
  readonly personaId: string;
  readonly personaLabel: string;
  readonly state: 'START' | 'STOP';
  readonly at: Date;
}

export type PhantomTypingListener = (event: PhantomTypingEvent) => void;

export interface PhantomPersona {
  readonly id: string;
  readonly label: string;
  readonly avatarHue: number;
}

export interface PhantomSocialOptions {
  /** Multiplier applied to the real viewer count. Default 1.3. */
  readonly inflationMultiplier?: number;
  /**
   * Extra gaussian-ish noise range. The phantom count may drift within
   * `inflated ± inflationJitter` at each tick. Default 3.
   */
  readonly inflationJitter?: number;
  /** Minimum time (ms) between pulses. Default 1500. */
  readonly minPulseIntervalMs?: number;
  /** Maximum time (ms) between pulses. Default 5000. */
  readonly maxPulseIntervalMs?: number;
  /** Random generator override (must return [0, 1)). */
  readonly random?: () => number;
  /** Wall-clock override. */
  readonly now?: () => Date;
  /** setTimeout override used for tests (returns a cancel handle). */
  readonly scheduler?: SchedulerApi;
  /** Persona roster to draw phantom typists from. */
  readonly personas?: readonly PhantomPersona[];
}

/** Minimal scheduling surface so we can deterministically test. */
export interface SchedulerApi {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = { readonly __brand: 'timer' } | ReturnType<typeof setTimeout>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PERSONAS: readonly PhantomPersona[] = Object.freeze([
  Object.freeze({ id: 'ghost-01', label: 'Anonymous Analyst', avatarHue: 12 }),
  Object.freeze({ id: 'ghost-02', label: 'Silent Observer', avatarHue: 205 }),
  Object.freeze({ id: 'ghost-03', label: 'Incognito Quant', avatarHue: 280 }),
  Object.freeze({ id: 'ghost-04', label: 'Private Subscriber', avatarHue: 48 }),
  Object.freeze({ id: 'ghost-05', label: 'Stealth Trader', avatarHue: 150 }),
  Object.freeze({ id: 'ghost-06', label: 'Veiled Whale', avatarHue: 330 }),
  Object.freeze({ id: 'ghost-07', label: 'Hidden Strategist', avatarHue: 95 }),
  Object.freeze({ id: 'ghost-08', label: 'Shadow Researcher', avatarHue: 255 }),
]);

const defaultScheduler: SchedulerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PhantomSocialService {
  private readonly inflationMultiplier: number;
  private readonly inflationJitter: number;
  private readonly minPulseIntervalMs: number;
  private readonly maxPulseIntervalMs: number;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly scheduler: SchedulerApi;
  private readonly personas: readonly PhantomPersona[];

  private realViewers = 0;
  private phantomViewers = 0;
  private started = false;
  private pulseTimer: TimerHandle | null = null;
  private typingTimers: Map<string, TimerHandle> = new Map();
  private typingActive: Set<string> = new Set();
  private viewerListeners: Set<PhantomViewerListener> = new Set();
  private typingListeners: Set<PhantomTypingListener> = new Set();

  constructor(options: PhantomSocialOptions = {}) {
    this.inflationMultiplier = options.inflationMultiplier ?? 1.3;
    this.inflationJitter = options.inflationJitter ?? 3;
    this.minPulseIntervalMs = options.minPulseIntervalMs ?? 1_500;
    this.maxPulseIntervalMs = options.maxPulseIntervalMs ?? 5_000;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.personas = options.personas ?? DEFAULT_PERSONAS;

    if (this.inflationMultiplier < 1) {
      throw new Error(
        `inflationMultiplier must be >= 1 (got ${this.inflationMultiplier}).`,
      );
    }
    if (this.minPulseIntervalMs <= 0 || this.maxPulseIntervalMs <= 0) {
      throw new Error('Pulse intervals must be positive.');
    }
    if (this.minPulseIntervalMs > this.maxPulseIntervalMs) {
      throw new Error('minPulseIntervalMs must be <= maxPulseIntervalMs.');
    }
    if (this.personas.length === 0) {
      throw new Error('PhantomSocialService requires at least one persona.');
    }
  }

  // -------------------------------------------------------------------------
  // Viewer counting
  // -------------------------------------------------------------------------

  /**
   * Pure helper: given a real count, return the inflated phantom value.
   * The inflation is monotonic and capped; small positive jitter is
   * added so the UI pulses naturally without artificial periodicity.
   */
  inflateViewerCount(real: number): number {
    if (!Number.isFinite(real) || real < 0) {
      throw new Error(`inflateViewerCount: real must be a non-negative number (got ${real}).`);
    }
    const base = real * this.inflationMultiplier;
    const noise = (this.random() * 2 - 1) * this.inflationJitter;
    const inflated = Math.max(real, Math.round(base + noise));
    return inflated;
  }

  /**
   * Update the real viewer count. Returns the new phantom count. If the
   * phantom count rises, all viewer listeners are notified with a
   * "pulse" sample so the UI can animate the change.
   */
  updateRealViewers(real: number): PhantomViewerSample {
    this.realViewers = Math.max(0, Math.floor(real));
    const next = this.inflateViewerCount(this.realViewers);
    const delta = next - this.phantomViewers;
    this.phantomViewers = next;
    const sample: PhantomViewerSample = {
      real: this.realViewers,
      phantom: next,
      delta,
      at: this.now(),
    };
    if (delta !== 0) {
      this.emitViewerSample(sample);
    }
    return sample;
  }

  /** Returns the most recent phantom sample without triggering updates. */
  currentSample(): PhantomViewerSample {
    return {
      real: this.realViewers,
      phantom: this.phantomViewers,
      delta: 0,
      at: this.now(),
    };
  }

  onViewerChange(listener: PhantomViewerListener): () => void {
    this.viewerListeners.add(listener);
    return () => {
      this.viewerListeners.delete(listener);
    };
  }

  private emitViewerSample(sample: PhantomViewerSample): void {
    this.viewerListeners.forEach((l) => {
      try {
        l(sample);
      } catch (err) {
        logger.warn({ err }, 'PhantomSocialService viewer listener threw');
      }
    });
  }

  // -------------------------------------------------------------------------
  // Phantom typing indicators
  // -------------------------------------------------------------------------

  onTyping(listener: PhantomTypingListener): () => void {
    this.typingListeners.add(listener);
    return () => {
      this.typingListeners.delete(listener);
    };
  }

  /**
   * Begin the phantom social loop. Idempotent. Once started, the
   * service will periodically:
   *
   *  - nudge the phantom viewer count up by a small random amount so
   *    the counter always feels alive;
   *  - start/stop phantom typing indicators on random personas;
   *
   * Call `stop()` to cancel all timers — essential on component
   * unmount to prevent leaks.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedulePulse();
    this.schedulePersonaTypingFor(this.pickPersona());
  }

  /**
   * Cancel all outstanding timers and clear listener state. Safe to
   * call repeatedly.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.pulseTimer) {
      this.scheduler.clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.typingTimers.forEach((handle) => this.scheduler.clearTimeout(handle));
    this.typingTimers.clear();
    // Flush any typing state so listeners can tear down indicators.
    const now = this.now();
    this.typingActive.forEach((id) => {
      const persona = this.personas.find((p) => p.id === id);
      if (!persona) return;
      this.emitTyping({ personaId: persona.id, personaLabel: persona.label, state: 'STOP', at: now });
    });
    this.typingActive.clear();
  }

  private schedulePulse(): void {
    if (!this.started) return;
    const interval = this.randomInterval(this.minPulseIntervalMs, this.maxPulseIntervalMs);
    this.pulseTimer = this.scheduler.setTimeout(() => {
      this.pulse();
      this.schedulePulse();
    }, interval);
  }

  private pulse(): void {
    // Occasionally bump the phantom count by ±1 without changing the
    // real viewer count. This creates the illusion of continuous
    // audience churn.
    const drift = this.random() < 0.7 ? 1 : -1;
    const candidate = Math.max(this.realViewers, this.phantomViewers + drift);
    if (candidate === this.phantomViewers) return;
    const delta = candidate - this.phantomViewers;
    this.phantomViewers = candidate;
    this.emitViewerSample({
      real: this.realViewers,
      phantom: candidate,
      delta,
      at: this.now(),
    });
  }

  private schedulePersonaTypingFor(persona: PhantomPersona): void {
    if (!this.started) return;
    const delay = this.randomInterval(2_000, 8_000);
    const handle = this.scheduler.setTimeout(() => {
      this.startTyping(persona);
      const typingDuration = this.randomInterval(1_500, 4_500);
      const stopHandle = this.scheduler.setTimeout(() => {
        this.stopTyping(persona);
        // Schedule the next phantom typist — a different persona —
        // to keep the audience feeling diverse.
        const next = this.pickPersona(persona.id);
        this.schedulePersonaTypingFor(next);
      }, typingDuration);
      this.typingTimers.set(`${persona.id}:stop`, stopHandle);
    }, delay);
    this.typingTimers.set(`${persona.id}:start`, handle);
  }

  private startTyping(persona: PhantomPersona): void {
    if (this.typingActive.has(persona.id)) return;
    this.typingActive.add(persona.id);
    this.emitTyping({
      personaId: persona.id,
      personaLabel: persona.label,
      state: 'START',
      at: this.now(),
    });
  }

  private stopTyping(persona: PhantomPersona): void {
    if (!this.typingActive.delete(persona.id)) return;
    this.emitTyping({
      personaId: persona.id,
      personaLabel: persona.label,
      state: 'STOP',
      at: this.now(),
    });
  }

  private emitTyping(event: PhantomTypingEvent): void {
    this.typingListeners.forEach((l) => {
      try {
        l(event);
      } catch (err) {
        logger.warn({ err }, 'PhantomSocialService typing listener threw');
      }
    });
  }

  private pickPersona(excludeId?: string): PhantomPersona {
    const pool =
      excludeId !== undefined
        ? this.personas.filter((p) => p.id !== excludeId)
        : this.personas;
    const idx = Math.floor(this.random() * pool.length);
    return pool[Math.min(idx, pool.length - 1)];
  }

  private randomInterval(min: number, max: number): number {
    return Math.floor(min + this.random() * (max - min));
  }

  // -------------------------------------------------------------------------
  // Introspection (mostly for tests)
  // -------------------------------------------------------------------------

  isStarted(): boolean {
    return this.started;
  }

  getActiveTypists(): readonly string[] {
    return Array.from(this.typingActive);
  }

  getPersonas(): readonly PhantomPersona[] {
    return this.personas;
  }

  /** Force a pulse synchronously — useful for tests. */
  forcePulse(): PhantomViewerSample {
    this.pulse();
    return this.currentSample();
  }

  /** Force a persona to start typing — useful for tests. */
  forceStartTyping(personaId: string): PhantomTypingEvent | null {
    const persona = this.personas.find((p) => p.id === personaId);
    if (!persona) return null;
    this.startTyping(persona);
    return {
      personaId: persona.id,
      personaLabel: persona.label,
      state: 'START',
      at: this.now(),
    };
  }

  /** Force a persona to stop typing — useful for tests. */
  forceStopTyping(personaId: string): PhantomTypingEvent | null {
    const persona = this.personas.find((p) => p.id === personaId);
    if (!persona) return null;
    this.stopTyping(persona);
    return {
      personaId: persona.id,
      personaLabel: persona.label,
      state: 'STOP',
      at: this.now(),
    };
  }
}

export default PhantomSocialService;
