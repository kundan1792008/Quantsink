import { CadenceTracker } from '../services/CadenceTracker';

describe('CadenceTracker', () => {
  test('maps rapid scrolling to higher BPM and rhythm density', () => {
    const tracker = new CadenceTracker({ smoothingFactor: 1 });
    const t0 = 1_000;

    tracker.recordInteraction(t0);
    tracker.recordScrollVelocity(220, t0 + 10);
    const calm = tracker.getState(t0 + 20);

    tracker.recordInteraction(t0 + 100);
    tracker.recordScrollVelocity(2_200, t0 + 120);
    tracker.recordScrollVelocity(2_000, t0 + 140);
    tracker.recordInteraction(t0 + 150);
    const rapid = tracker.getState(t0 + 180);

    expect(rapid.parameters.bpm).toBeGreaterThan(calm.parameters.bpm);
    expect(rapid.parameters.rhythmDensity).toBeGreaterThan(calm.parameters.rhythmDensity);
    expect(rapid.mode).toBe('pulse');
  });

  test('drops into ambient mode after long pause', () => {
    const tracker = new CadenceTracker({ smoothingFactor: 1, ambientPauseThresholdMs: 2_000 });
    const t0 = 10_000;

    tracker.recordInteraction(t0);
    tracker.recordScrollVelocity(300, t0 + 100);

    const paused = tracker.getState(t0 + 7_000);

    expect(paused.mode).toBe('ambient');
    expect(paused.metrics.pauseDurationMs).toBeGreaterThanOrEqual(6_800);
    expect(paused.parameters.rhythmDensity).toBeLessThan(0.2);
  });

  test('smoothes abrupt transitions when smoothing is enabled', () => {
    const tracker = new CadenceTracker({ smoothingFactor: 0.25 });
    const t0 = 5_000;

    tracker.recordInteraction(t0);
    tracker.recordScrollVelocity(100, t0 + 20);
    const baseline = tracker.getState(t0 + 40);

    tracker.recordInteraction(t0 + 100);
    tracker.recordScrollVelocity(3_400, t0 + 120);
    const immediate = tracker.getState(t0 + 130);

    expect(immediate.parameters.bpm - baseline.parameters.bpm).toBeLessThan(30);
  });
});
