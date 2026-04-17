import {
  NotificationPriorityAI,
  BASE_PRIORITY,
  hourInRange,
  dateInDndBlock,
  computePreferenceBoost,
} from '../services/NotificationPriorityAI';
import type {
  DndBlock,
  UserPreferenceSnapshot,
} from '../services/NotificationPriorityAI';
import type { AggregatedNotification, QuantApp } from '../services/NotificationAggregator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idSeq = 0;

function makeNotification(
  overrides: Partial<AggregatedNotification> = {},
): AggregatedNotification {
  idSeq += 1;
  return {
    id: idSeq,
    eventId: `evt-${idSeq}`,
    app: 'quantchat',
    type: 'message',
    title: 'Test',
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    read: false,
    priorityScore: 0,
    ...overrides,
  };
}

function makeAI(opts?: ConstructorParameters<typeof NotificationPriorityAI>[0]) {
  return new NotificationPriorityAI(opts);
}

// ---------------------------------------------------------------------------
// hourInRange
// ---------------------------------------------------------------------------

describe('hourInRange', () => {
  it('handles normal ranges', () => {
    expect(hourInRange(9, 9, 17)).toBe(true);
    expect(hourInRange(8, 9, 17)).toBe(false);
    expect(hourInRange(17, 9, 17)).toBe(false);
  });

  it('handles wrap-around (sleep) ranges', () => {
    expect(hourInRange(23, 23, 7)).toBe(true);
    expect(hourInRange(0, 23, 7)).toBe(true);
    expect(hourInRange(6, 23, 7)).toBe(true);
    expect(hourInRange(7, 23, 7)).toBe(false);
    expect(hourInRange(12, 23, 7)).toBe(false);
  });

  it('returns false when start equals end', () => {
    expect(hourInRange(10, 10, 10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dateInDndBlock
// ---------------------------------------------------------------------------

describe('dateInDndBlock', () => {
  it('matches a date within the block hours', () => {
    const block: DndBlock = { startHour: 22, endHour: 8 };
    const inside = new Date('2026-04-17T23:00:00');
    expect(dateInDndBlock(inside, block)).toBe(true);
  });

  it('does not match a date outside the block hours', () => {
    const block: DndBlock = { startHour: 22, endHour: 8 };
    const outside = new Date('2026-04-17T14:00:00');
    expect(dateInDndBlock(outside, block)).toBe(false);
  });

  it('respects day-of-week restriction', () => {
    // Saturday = 6, Sunday = 0
    const block: DndBlock = { startHour: 9, endHour: 17, days: [6] };
    const saturday = new Date('2026-04-18T12:00:00'); // Saturday
    const friday = new Date('2026-04-17T12:00:00'); // Friday
    expect(dateInDndBlock(saturday, block)).toBe(true);
    expect(dateInDndBlock(friday, block)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computePreferenceBoost
// ---------------------------------------------------------------------------

describe('computePreferenceBoost', () => {
  const clicks: Record<QuantApp, number> = {
    quantchat: 0, quantsink: 0, quantchill: 0, quantads: 0,
    quantedits: 0, quanttube: 0, quantmail: 0, quantneon: 0, quantbrowse: 0,
  };
  const deliveries: Record<QuantApp, number> = { ...clicks };

  it('returns 0 with no data (Laplace smoothed CTR = 0.5)', () => {
    const boost = computePreferenceBoost('quantchat', clicks, deliveries, 3);
    expect(boost).toBe(0);
  });

  it('returns positive boost for high CTR app', () => {
    const highClicks = { ...clicks, quantchat: 9 };
    const highDeliveries = { ...deliveries, quantchat: 10 };
    const boost = computePreferenceBoost('quantchat', highClicks, highDeliveries, 3);
    expect(boost).toBeGreaterThan(0);
  });

  it('clamps boost to [0, maxBoost]', () => {
    const highClicks = { ...clicks, quantsink: 1000 };
    const highDeliveries = { ...deliveries, quantsink: 1000 };
    const boost = computePreferenceBoost('quantsink', highClicks, highDeliveries, 3);
    expect(boost).toBeLessThanOrEqual(3);
    expect(boost).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// BASE_PRIORITY table
// ---------------------------------------------------------------------------

describe('BASE_PRIORITY', () => {
  it('message has the highest base priority (10)', () => {
    expect(BASE_PRIORITY.message).toBe(10);
  });
  it('match has priority 8', () => {
    expect(BASE_PRIORITY.match).toBe(8);
  });
  it('ad_performance has the lowest base priority (2)', () => {
    expect(BASE_PRIORITY.ad_performance).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// NotificationPriorityAI — scoring
// ---------------------------------------------------------------------------

describe('NotificationPriorityAI — score', () => {
  it('returns a message notification with base score 10', () => {
    const ai = makeAI({ now: () => new Date('2026-04-17T14:00:00') });
    const n = makeNotification({ app: 'quantchat', type: 'message' });
    const result = ai.score(n);
    expect(result.baseScore).toBe(10);
    expect(result.suppressed).toBe(false);
  });

  it('returns an ad_performance notification with base score 2', () => {
    const ai = makeAI({ now: () => new Date('2026-04-17T14:00:00') });
    const n = makeNotification({ app: 'quantads', type: 'ad_performance' });
    const result = ai.score(n);
    expect(result.baseScore).toBe(2);
  });

  it('clamps score to MAX_PRIORITY even with boost', () => {
    const ai = makeAI({
      now: () => new Date('2026-04-17T14:00:00'),
      maxPreferenceBoost: 5,
    });
    const n = makeNotification({ app: 'quantchat', type: 'message' });
    // Record many clicks to maximise boost.
    for (let i = 0; i < 100; i++) ai.recordClick('quantchat');
    for (let i = 0; i < 100; i++) ai.recordDelivery('quantchat');
    const result = ai.score(n);
    expect(result.clamped).toBeLessThanOrEqual(10);
  });

  it('marks notification as suppressed during sleep hours', () => {
    // 02:00 — well within default sleep window (23:00–07:00)
    const ai = makeAI({ now: () => new Date('2026-04-17T02:00:00') });
    const n = makeNotification();
    const result = ai.score(n);
    expect(result.suppressed).toBe(true);
    expect(result.suppressReason).toMatch(/sleep/i);
  });

  it('does not suppress notifications outside sleep hours', () => {
    const ai = makeAI({ now: () => new Date('2026-04-17T10:00:00') });
    const n = makeNotification();
    const result = ai.score(n);
    expect(result.suppressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NotificationPriorityAI — DND manual blocks
// ---------------------------------------------------------------------------

describe('NotificationPriorityAI — DND manual blocks', () => {
  it('suppresses during a manually added DND block', () => {
    const ai = makeAI({
      now: () => new Date('2026-04-17T15:30:00'),
      initialPreferences: { smartDndEnabled: false },
    });
    ai.addDndBlock({ startHour: 14, endHour: 17, label: 'Focus time' });
    const result = ai.shouldSuppress(new Date('2026-04-17T15:30:00'));
    expect(result.suppressed).toBe(true);
    expect(result.reason).toContain('Focus time');
  });

  it('does not suppress outside the manual block', () => {
    const ai = makeAI({
      now: () => new Date('2026-04-17T18:00:00'),
      initialPreferences: { smartDndEnabled: false },
    });
    ai.addDndBlock({ startHour: 14, endHour: 17, label: 'Focus time' });
    const result = ai.shouldSuppress(new Date('2026-04-17T18:00:00'));
    expect(result.suppressed).toBe(false);
  });

  it('removes a DND block by index', () => {
    const ai = makeAI({ initialPreferences: { smartDndEnabled: false } });
    ai.addDndBlock({ startHour: 9, endHour: 10 });
    ai.addDndBlock({ startHour: 14, endHour: 15 });
    ai.removeDndBlock(0);
    expect(ai.getDndBlocks()).toHaveLength(1);
    expect(ai.getDndBlocks()[0].startHour).toBe(14);
  });

  it('sets sleep window and validates range', () => {
    const ai = makeAI();
    ai.setSleepWindow(22, 6);
    expect(ai.getSleepWindow()).toEqual({ startHour: 22, endHour: 6 });
  });

  it('rejects invalid sleep window hours', () => {
    const ai = makeAI();
    expect(() => ai.setSleepWindow(-1, 7)).toThrow(RangeError);
    expect(() => ai.setSleepWindow(0, 25)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// NotificationPriorityAI — preference learning
// ---------------------------------------------------------------------------

describe('NotificationPriorityAI — preference learning', () => {
  it('recordClick increases preference boost for that app', () => {
    const ai = makeAI({ now: () => new Date('2026-04-17T14:00:00') });
    const before = ai.score(makeNotification({ app: 'quanttube', type: 'video_engagement' })).clamped;

    for (let i = 0; i < 30; i++) ai.recordClick('quanttube');
    for (let i = 0; i < 30; i++) ai.recordDelivery('quanttube');

    const after = ai.score(makeNotification({ app: 'quanttube', type: 'video_engagement' })).clamped;
    expect(after).toBeGreaterThan(before);
  });

  it('topPreferredApp returns null with no click data', () => {
    const ai = makeAI();
    expect(ai.topPreferredApp()).toBeNull();
  });

  it('topPreferredApp returns the most clicked app', () => {
    const ai = makeAI();
    // Record both clicks and deliveries so CTR is meaningful.
    for (let i = 0; i < 10; i++) { ai.recordClick('quantsink'); ai.recordDelivery('quantsink'); }
    for (let i = 0; i < 3; i++) { ai.recordClick('quantchat'); ai.recordDelivery('quantchat'); }
    expect(ai.topPreferredApp()).toBe('quantsink');
  });

  it('ctrReport is sorted by CTR descending', () => {
    const ai = makeAI();
    for (let i = 0; i < 5; i++) { ai.recordDelivery('quantmail'); ai.recordClick('quantmail'); }
    for (let i = 0; i < 10; i++) { ai.recordDelivery('quantchat'); ai.recordClick('quantchat'); }
    const report = ai.ctrReport();
    expect(report[0].ctr).toBeGreaterThanOrEqual(report[1].ctr);
  });
});

// ---------------------------------------------------------------------------
// NotificationPriorityAI — snapshot & restore
// ---------------------------------------------------------------------------

describe('NotificationPriorityAI — snapshot & restore', () => {
  it('round-trips preferences through snapshot/restore', () => {
    const ai = makeAI();
    for (let i = 0; i < 5; i++) ai.recordClick('quantchill');
    ai.addDndBlock({ startHour: 20, endHour: 22, label: 'Evening' });
    ai.setSleepWindow(22, 6);

    const snap = ai.snapshot();
    const ai2 = makeAI({ initialPreferences: snap });

    expect(ai2.snapshot().clicksByApp.quantchill).toBe(5);
    expect(ai2.getDndBlocks()).toHaveLength(1);
    expect(ai2.getSleepWindow()).toEqual({ startHour: 22, endHour: 6 });
  });

  it('restoreFrom replaces existing preferences', () => {
    const ai = makeAI();
    for (let i = 0; i < 10; i++) ai.recordClick('quantads');

    const snap: UserPreferenceSnapshot = {
      clicksByApp: {
        quantchat: 3, quantsink: 0, quantchill: 0, quantads: 0,
        quantedits: 0, quanttube: 0, quantmail: 0, quantneon: 0, quantbrowse: 0,
      },
      deliveryByApp: {
        quantchat: 10, quantsink: 0, quantchill: 0, quantads: 0,
        quantedits: 0, quanttube: 0, quantmail: 0, quantneon: 0, quantbrowse: 0,
      },
      dndBlocks: [],
      smartDndEnabled: false,
      sleepStartHour: 0,
      sleepEndHour: 0,
    };
    ai.restoreFrom(snap);
    expect(ai.snapshot().clicksByApp.quantads).toBe(0);
    expect(ai.snapshot().clicksByApp.quantchat).toBe(3);
  });

  it('resetPreferences wipes clicks and dnd blocks', () => {
    const ai = makeAI();
    for (let i = 0; i < 5; i++) ai.recordClick('quantneon');
    ai.addDndBlock({ startHour: 10, endHour: 12 });
    ai.resetPreferences();
    expect(ai.snapshot().clicksByApp.quantneon).toBe(0);
    expect(ai.getDndBlocks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NotificationPriorityAI — sortByPriority
// ---------------------------------------------------------------------------

describe('NotificationPriorityAI — sortByPriority', () => {
  it('sorts notifications from highest to lowest priority score', () => {
    const ai = makeAI();
    const notifications = [
      makeNotification({ priorityScore: 3 }),
      makeNotification({ priorityScore: 9 }),
      makeNotification({ priorityScore: 6 }),
    ];
    const sorted = ai.sortByPriority(notifications);
    expect(sorted.map((n) => n.priorityScore)).toEqual([9, 6, 3]);
  });

  it('does not mutate the input array', () => {
    const ai = makeAI();
    const input = [
      makeNotification({ priorityScore: 1 }),
      makeNotification({ priorityScore: 8 }),
    ];
    const original = [...input];
    ai.sortByPriority(input);
    expect(input[0].priorityScore).toBe(original[0].priorityScore);
  });
});
