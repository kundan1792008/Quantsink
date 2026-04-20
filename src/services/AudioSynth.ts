import type { FlowMode, MusicalParameters } from './CadenceTracker';

export interface AudioParamLike {
  value: number;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
}

export interface AudioNodeLike {
  connect(destination: unknown): unknown;
}

export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  frequency: AudioParamLike;
  type: OscillatorType;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType;
  frequency: AudioParamLike;
  Q: AudioParamLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
}

export interface AudioSynthConfig {
  readonly audioContext: AudioContextLike;
  readonly transitionTimeConstant?: number;
  readonly masterVolume?: number;
}

interface SynthNodes {
  readonly master: GainNodeLike;
  readonly padGain: GainNodeLike;
  readonly pulseGain: GainNodeLike;
  readonly padFilter: BiquadFilterNodeLike;
  readonly padOscA: OscillatorNodeLike;
  readonly padOscB: OscillatorNodeLike;
  readonly lfo: OscillatorNodeLike;
  readonly lfoDepth: GainNodeLike;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const MIN_PULSE_INTERVAL_MS = 130;
const MAX_PULSE_INTERVAL_MS = 1_600;

function safeStop(osc: OscillatorNodeLike): void {
  try {
    osc.stop();
  } catch {
    // noop: oscillator may already be stopped
  }
}

export class AudioSynth {
  private readonly context: AudioContextLike;
  private readonly transitionTimeConstant: number;
  private readonly masterVolume: number;

  private nodes: SynthNodes | null = null;
  private pulseLoop: ReturnType<typeof setInterval> | null = null;
  private isStarted = false;
  private pulseIntervalMs = 800;

  private lastMode: FlowMode = 'ambient';
  private lastParameters: MusicalParameters = {
    bpm: 68,
    frequencyModulationHz: 0.12,
    rhythmDensity: 0.05,
  };

  constructor(config: AudioSynthConfig) {
    this.context = config.audioContext;
    this.transitionTimeConstant = clamp(config.transitionTimeConstant ?? 0.65, 0.05, 3);
    this.masterVolume = clamp(config.masterVolume ?? 0.35, 0, 1);
  }

  start(): void {
    if (this.isStarted) return;

    const master = this.context.createGain();
    const padGain = this.context.createGain();
    const pulseGain = this.context.createGain();
    const padFilter = this.context.createBiquadFilter();

    const padOscA = this.context.createOscillator();
    const padOscB = this.context.createOscillator();
    const lfo = this.context.createOscillator();
    const lfoDepth = this.context.createGain();

    master.gain.value = this.masterVolume;
    padGain.gain.value = 0.16;
    pulseGain.gain.value = 0;

    padFilter.type = 'lowpass';
    padFilter.frequency.value = 420;
    padFilter.Q.value = 0.4;

    padOscA.type = 'sine';
    padOscA.frequency.value = 110;

    padOscB.type = 'triangle';
    padOscB.frequency.value = 164.81;

    lfo.type = 'sine';
    lfo.frequency.value = 0.13;
    lfoDepth.gain.value = 160;

    padOscA.connect(padFilter);
    padOscB.connect(padFilter);
    padFilter.connect(padGain);
    padGain.connect(master);
    pulseGain.connect(master);
    lfo.connect(lfoDepth);
    lfoDepth.connect(padFilter.frequency);
    master.connect(this.context.destination);

    padOscA.start();
    padOscB.start();
    lfo.start();

    this.nodes = { master, padGain, pulseGain, padFilter, padOscA, padOscB, lfo, lfoDepth };
    this.isStarted = true;
  }

  stop(): void {
    if (!this.isStarted) return;

    this.stopPulseLoop();

    if (this.nodes) {
      safeStop(this.nodes.padOscA);
      safeStop(this.nodes.padOscB);
      safeStop(this.nodes.lfo);
    }

    this.nodes = null;
    this.isStarted = false;
  }

  applyCadence(parameters: MusicalParameters, mode: FlowMode): void {
    if (!this.isStarted || !this.nodes) return;

    const p = {
      bpm: clamp(parameters.bpm, 44, 180),
      frequencyModulationHz: clamp(parameters.frequencyModulationHz, 0.03, 3),
      rhythmDensity: clamp(parameters.rhythmDensity, 0, 1),
    };

    const now = this.context.currentTime;
    const t = this.transitionTimeConstant;

    const padGainTarget = mode === 'ambient'
      ? 0.22 + (1 - p.rhythmDensity) * 0.18
      : 0.1 + (1 - p.rhythmDensity) * 0.1;

    const pulseGainTarget = mode === 'ambient'
      ? 0
      : 0.02 + p.rhythmDensity * 0.24;

    const padFilterTarget = 280 + p.frequencyModulationHz * 460 + p.rhythmDensity * 500;

    this.nodes.master.gain.setTargetAtTime(this.masterVolume, now, t);
    this.nodes.padGain.gain.setTargetAtTime(clamp(padGainTarget, 0.08, 0.42), now, t);
    this.nodes.pulseGain.gain.setTargetAtTime(clamp(pulseGainTarget, 0, 0.35), now, t);
    this.nodes.padFilter.frequency.setTargetAtTime(clamp(padFilterTarget, 180, 3_000), now, t);
    this.nodes.lfo.frequency.setTargetAtTime(p.frequencyModulationHz, now, t);

    this.lastParameters = p;
    this.lastMode = mode;

    if (mode === 'ambient' || p.rhythmDensity < 0.12) {
      this.stopPulseLoop();
    } else {
      // Use half-beat pulses to keep rhythmic detail responsive during fast scrolling.
      const interval = clamp(
        Math.round((60_000 / p.bpm) / 2),
        MIN_PULSE_INTERVAL_MS,
        MAX_PULSE_INTERVAL_MS,
      );
      if (!this.pulseLoop || interval !== this.pulseIntervalMs) {
        this.startPulseLoop(interval);
      }
    }
  }

  snapshot(): { isStarted: boolean; mode: FlowMode; parameters: MusicalParameters } {
    return {
      isStarted: this.isStarted,
      mode: this.lastMode,
      parameters: this.lastParameters,
    };
  }

  private startPulseLoop(intervalMs: number): void {
    this.stopPulseLoop();
    this.pulseIntervalMs = intervalMs;
    this.pulseLoop = setInterval(() => {
      if (!this.nodes) return;
      const osc = this.context.createOscillator();
      const gain = this.context.createGain();
      const now = this.context.currentTime;
      const density = this.lastParameters.rhythmDensity;

      osc.type = 'square';
      // Keep percussive pulses in a warm low-mid band that remains subtle under ambient pads.
      osc.frequency.value = clamp(140 + density * 240, 140, 420);

      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(this.nodes.pulseGain);

      gain.gain.setTargetAtTime(0.18 + density * 0.28, now, 0.01);
      gain.gain.setTargetAtTime(0.0001, now + 0.11, 0.045);

      osc.start(now);
      osc.stop(now + 0.2);
    }, intervalMs);
  }

  private stopPulseLoop(): void {
    if (this.pulseLoop) {
      clearInterval(this.pulseLoop);
      this.pulseLoop = null;
    }
  }
}

export function createBrowserAudioContext(): AudioContextLike | null {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };

  const Ctx = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctx) return null;

  try {
    return new Ctx();
  } catch {
    return null;
  }
}
