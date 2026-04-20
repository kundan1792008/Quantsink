import { InteractionTelemetry } from '../services/InteractionTelemetry';

describe('InteractionTelemetry', () => {
  const base = new Date('2026-04-20T12:00:00.000Z');

  it('records positive dwell and updates weight in real time', () => {
    const telemetry = new InteractionTelemetry({ now: () => base });
    telemetry.beginDwell('u1', 'c1', base);

    const feedback = telemetry.endDwell(
      'u1',
      'c1',
      new Date(base.getTime() + 9_000),
    );

    expect(feedback.reason).toBe('dwellPositive');
    expect(feedback.nextWeight).toBeGreaterThan(feedback.previousWeight);
    expect(feedback.feedbackLoopMs).toBeLessThan(50);
    expect(telemetry.getWeight('c1')).toBe(feedback.nextWeight);
  });

  it('detects micro-hesitation from sharp scroll deceleration', () => {
    const telemetry = new InteractionTelemetry({ now: () => base });

    telemetry.trackScroll('u1', 0, 'c2', new Date(base.getTime()));
    telemetry.trackScroll('u1', 220, 'c2', new Date(base.getTime() + 100));
    const sample = telemetry.trackScroll('u1', 224, 'c2', new Date(base.getTime() + 180));

    expect(sample.microHesitation).toBe(true);
    expect(telemetry.getWeight('c2')).toBeGreaterThan(0);
  });

  it('penalizes rapid exits', () => {
    const telemetry = new InteractionTelemetry({ now: () => base });
    const before = telemetry.getWeight('c3');

    const feedback = telemetry.rapidExit('u1', 'c3');

    expect(feedback.reason).toBe('rapidExit');
    expect(feedback.nextWeight).toBeLessThan(before);
  });
});
