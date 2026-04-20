export interface CadenceSample {
  readonly timestampMs: number;
  readonly scrollVelocityPxPerSec: number;
}

export interface CadenceMetrics {
  readonly scrollVelocityPxPerSec: number;
  readonly pauseDurationMs: number;
  readonly interactionFrequencyHz: number;
}

export interface MusicalParameters {
  readonly bpm: number;
  readonly frequencyModulationHz: number;
  readonly rhythmDensity: number;
}

export type FlowMode = 'ambient' | 'pulse';

export interface CadenceState {
  readonly metrics: CadenceMetrics;
  readonly parameters: MusicalParameters;
  readonly mode: FlowMode;
}

export interface CadenceTrackerConfig {
  readonly velocityWindowMs?: number;
  readonly interactionWindowMs?: number;
  readonly ambientPauseThresholdMs?: number;
  readonly smoothingFactor?: number;
}

const DEFAULT_CONFIG: Required<CadenceTrackerConfig> = {
  // Keep short-term scroll texture while smoothing out micro-jitter.
  velocityWindowMs: 4_500,
  // Capture broader interaction cadence across reading/scanning cycles.
  interactionWindowMs: 12_000,
  // Pause >3s is treated as deep-read ambient intent.
  ambientPauseThresholdMs: 3_000,
  // Gentle smoothing so transitions remain fluid instead of abrupt.
  smoothingFactor: 0.24,
};

const MIN_BPM = 52;
const MAX_BPM = 136;
const MIN_FM_HZ = 0.06;
const MAX_FM_HZ = 1.8;
const MAX_SCROLL_VELOCITY_NORM_PX_PER_SEC = 2_200;
const MAX_INTERACTION_FREQUENCY_NORM_HZ = 2.2;
const MAX_PAUSE_NORM_MS = 6_000;
const VELOCITY_WEIGHT = 0.68;
const FREQUENCY_WEIGHT = 0.42;
const PAUSE_PENALTY_WEIGHT = 0.38;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(min: number, max: number, progress: number): number {
  return min + (max - min) * progress;
}

export class CadenceTracker {
  private readonly config: Required<CadenceTrackerConfig>;
  private readonly velocitySamples: CadenceSample[] = [];
  private readonly interactions: number[] = [];
  private lastInteractionAtMs = 0;
  private smoothed: MusicalParameters = {
    bpm: 68,
    frequencyModulationHz: 0.12,
    rhythmDensity: 0.08,
  };

  constructor(config: CadenceTrackerConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      smoothingFactor: clamp(config.smoothingFactor ?? DEFAULT_CONFIG.smoothingFactor, 0.01, 1),
    };
  }

  recordScrollVelocity(scrollVelocityPxPerSec: number, timestampMs = Date.now()): void {
    const velocity = Number.isFinite(scrollVelocityPxPerSec) ? Math.abs(scrollVelocityPxPerSec) : 0;
    this.velocitySamples.push({ timestampMs, scrollVelocityPxPerSec: velocity });
    this.lastInteractionAtMs = timestampMs;
    this.prune(timestampMs);
  }

  recordInteraction(timestampMs = Date.now()): void {
    this.interactions.push(timestampMs);
    this.lastInteractionAtMs = timestampMs;
    this.prune(timestampMs);
  }

  getState(timestampMs = Date.now()): CadenceState {
    this.prune(timestampMs);

    const metrics = this.measureMetrics(timestampMs);
    const target = this.mapMetricsToMusic(metrics);

    this.smoothed = {
      bpm: this.smooth(this.smoothed.bpm, target.bpm),
      frequencyModulationHz: this.smooth(this.smoothed.frequencyModulationHz, target.frequencyModulationHz),
      rhythmDensity: this.smooth(this.smoothed.rhythmDensity, target.rhythmDensity),
    };

    const mode: FlowMode =
      metrics.pauseDurationMs >= this.config.ambientPauseThresholdMs && metrics.scrollVelocityPxPerSec < 120
        ? 'ambient'
        : 'pulse';

    return {
      metrics,
      parameters: this.smoothed,
      mode,
    };
  }

  reset(): void {
    this.velocitySamples.length = 0;
    this.interactions.length = 0;
    this.lastInteractionAtMs = 0;
    this.smoothed = {
      bpm: 68,
      frequencyModulationHz: 0.12,
      rhythmDensity: 0.08,
    };
  }

  private smooth(previous: number, target: number): number {
    const alpha = this.config.smoothingFactor;
    return previous + (target - previous) * alpha;
  }

  private prune(nowMs: number): void {
    const velocityCutoff = nowMs - this.config.velocityWindowMs;
    while (this.velocitySamples.length > 0 && this.velocitySamples[0].timestampMs < velocityCutoff) {
      this.velocitySamples.shift();
    }

    const interactionCutoff = nowMs - this.config.interactionWindowMs;
    while (this.interactions.length > 0 && this.interactions[0] < interactionCutoff) {
      this.interactions.shift();
    }
  }

  private measureMetrics(nowMs: number): CadenceMetrics {
    const weightedVelocity = this.measureWeightedVelocity(nowMs);

    const pauseDurationMs = this.lastInteractionAtMs > 0
      ? Math.max(0, nowMs - this.lastInteractionAtMs)
      : this.config.ambientPauseThresholdMs * 2;

    const interactionFrequencyHz = this.interactions.length / (this.config.interactionWindowMs / 1_000);

    return {
      scrollVelocityPxPerSec: weightedVelocity,
      pauseDurationMs,
      interactionFrequencyHz,
    };
  }

  private measureWeightedVelocity(nowMs: number): number {
    if (this.velocitySamples.length === 0) return 0;

    let numerator = 0;
    let denominator = 0;

    for (const sample of this.velocitySamples) {
      const age = Math.max(0, nowMs - sample.timestampMs);
      const freshness = clamp(1 - (age / this.config.velocityWindowMs), 0, 1);
      const weight = freshness * freshness;
      numerator += sample.scrollVelocityPxPerSec * weight;
      denominator += weight;
    }

    return denominator > 0 ? numerator / denominator : 0;
  }

  private mapMetricsToMusic(metrics: CadenceMetrics): MusicalParameters {
    const velocityNorm = clamp(metrics.scrollVelocityPxPerSec / MAX_SCROLL_VELOCITY_NORM_PX_PER_SEC, 0, 1);
    const frequencyNorm = clamp(metrics.interactionFrequencyHz / MAX_INTERACTION_FREQUENCY_NORM_HZ, 0, 1);
    const pauseNorm = clamp(metrics.pauseDurationMs / MAX_PAUSE_NORM_MS, 0, 1);

    const pulseIntensity = clamp(
      velocityNorm * VELOCITY_WEIGHT +
      frequencyNorm * FREQUENCY_WEIGHT -
      pauseNorm * PAUSE_PENALTY_WEIGHT,
      0,
      1,
    );

    const bpm = lerp(MIN_BPM, MAX_BPM, clamp(velocityNorm * 0.8 + frequencyNorm * 0.2, 0, 1));
    const frequencyModulationHz = lerp(
      MIN_FM_HZ,
      MAX_FM_HZ,
      clamp(velocityNorm * 0.64 + frequencyNorm * 0.26 + (1 - pauseNorm) * 0.1, 0, 1),
    );

    return {
      bpm,
      frequencyModulationHz,
      rhythmDensity: pulseIntensity,
    };
  }
}
