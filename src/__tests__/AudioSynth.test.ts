import { AudioSynth, type AudioContextLike, type AudioParamLike } from '../services/AudioSynth';

class FakeAudioParam implements AudioParamLike {
  value: number;
  constructor(value = 0) {
    this.value = value;
  }
  setTargetAtTime(value: number, _startTime: number, _timeConstant: number): void {
    this.value = value;
  }
}

class FakeAudioNode {
  connections: unknown[] = [];
  connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam(1);
}

class FakeOscillatorNode extends FakeAudioNode {
  frequency = new FakeAudioParam(440);
  type: OscillatorType = 'sine';
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeAudioParam(350);
  Q = new FakeAudioParam(1);
}

function createFakeContext(): AudioContextLike & {
  oscillators: FakeOscillatorNode[];
  gains: FakeGainNode[];
  filters: FakeBiquadFilterNode[];
} {
  const oscillators: FakeOscillatorNode[] = [];
  const gains: FakeGainNode[] = [];
  const filters: FakeBiquadFilterNode[] = [];

  return {
    currentTime: 1,
    destination: {},
    oscillators,
    gains,
    filters,
    createGain() {
      const gain = new FakeGainNode();
      gains.push(gain);
      return gain;
    },
    createOscillator() {
      const osc = new FakeOscillatorNode();
      oscillators.push(osc);
      return osc;
    },
    createBiquadFilter() {
      const filter = new FakeBiquadFilterNode();
      filters.push(filter);
      return filter;
    },
  };
}

describe('AudioSynth', () => {
  test('starts core oscillators and transitions gains by cadence mode', () => {
    const context = createFakeContext();
    const synth = new AudioSynth({ audioContext: context, transitionTimeConstant: 0.3 });

    synth.start();

    expect(context.oscillators.length).toBe(3);
    expect(context.oscillators.every((osc) => osc.started)).toBe(true);

    synth.applyCadence(
      { bpm: 126, frequencyModulationHz: 1.4, rhythmDensity: 0.8 },
      'pulse',
    );

    const pulseGain = context.gains[2];
    expect(pulseGain.gain.value).toBeGreaterThan(0.15);

    synth.applyCadence(
      { bpm: 60, frequencyModulationHz: 0.2, rhythmDensity: 0.03 },
      'ambient',
    );

    expect(pulseGain.gain.value).toBe(0);
    expect(synth.snapshot().mode).toBe('ambient');
  });

  test('stops oscillators cleanly', () => {
    const context = createFakeContext();
    const synth = new AudioSynth({ audioContext: context });

    synth.start();
    synth.stop();

    expect(context.oscillators.slice(0, 3).every((osc) => osc.stopped)).toBe(true);
    expect(synth.snapshot().isStarted).toBe(false);
  });
});
