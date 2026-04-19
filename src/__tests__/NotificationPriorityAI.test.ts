import {
  BASE_PRIORITY,
  DEFAULT_SMART_SCHEDULE,
  NotificationPriorityAI,
  PRIORITY_AI_CONSTANTS,
  specPriorityBucket,
} from '../services/NotificationPriorityAI';
import type { UnifiedNotification } from '../services/NotificationAggregator';

function makeNotification(overrides: Partial<UnifiedNotification> = {}): UnifiedNotification {
  return {
    id: 'n1',
    dedupeKey: 'k1',
    app: 'quantsink',
    kind: 'broadcast',
    title: 'Hello world',
    body: 'Body text',
    previews: [],
    actions: [],
    occurredAt: new Date(0).toISOString(),
    receivedAt: new Date(0).toISOString(),
    priority: 5,
    read: false,
    dismissed: false,
    meta: {},
    ...overrides,
  };
}

class Clock {
  constructor(public ms = 100_000) {}
  now = (): number => this.ms;
}

describe('NotificationPriorityAI — base scores', () => {
  const ai = new NotificationPriorityAI({ clock: new Clock() });

  it('maps every kind to its base priority', () => {
    for (const [kind, base] of Object.entries(BASE_PRIORITY)) {
      const n = makeNotification({
        kind: kind as UnifiedNotification['kind'],
        occurredAt: new Date(100_000).toISOString(),
      });
      const d = ai.evaluate(n);
      expect(d.base).toBe(base);
    }
  });

  it('clamps final score within 1..10', () => {
    const n = makeNotification({ kind: 'system', title: 'urgent!' });
    const s = ai.score(n);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(10);
  });

  it('specPriorityBucket returns documented spec values', () => {
    expect(specPriorityBucket('message').value).toBe(10);
    expect(specPriorityBucket('match').value).toBe(8);
    expect(specPriorityBucket('broadcast').value).toBe(5);
    expect(specPriorityBucket('ad_performance').value).toBe(2);
    expect(specPriorityBucket('system').value).toBe(1);
  });
});

describe('NotificationPriorityAI — close-friend boost', () => {
  it('promotes DM from close friend to priority 10', () => {
    const ai = new NotificationPriorityAI({
      clock: new Clock(),
      closeFriends: [{ userId: 'u-friend', affinity: 1 }],
    });
    const n = makeNotification({
      kind: 'message',
      senderId: 'u-friend',
      occurredAt: new Date(100_000).toISOString(),
    });
    expect(ai.score(n)).toBe(10);
  });

  it('leaves a DM from a stranger at base message level', () => {
    const ai = new NotificationPriorityAI({
      clock: new Clock(),
      closeFriends: [{ userId: 'u-other', affinity: 1 }],
    });
    const n = makeNotification({
      kind: 'message',
      senderId: 'stranger',
      occurredAt: new Date(100_000).toISOString(),
    });
    const d = ai.evaluate(n);
    expect(d.closeFriendBoost).toBe(0);
  });

  it('tags VIP notifications from friends', () => {
    const ai = new NotificationPriorityAI({
      clock: new Clock(),
      closeFriends: [{ userId: 'u-friend', affinity: 0.8 }],
    });
    const n = makeNotification({
      kind: 'match',
      senderId: 'u-friend',
      occurredAt: new Date(100_000).toISOString(),
    });
    expect(ai.evaluate(n).tags).toContain('vip');
  });

  it('addCloseFriend validates affinity range', () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    expect(() => ai.addCloseFriend({ userId: 'x', affinity: 2 })).toThrow();
    expect(() => ai.addCloseFriend({ userId: '', affinity: 0.5 })).toThrow();
  });

  it('removeCloseFriend returns false when missing', () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    expect(ai.removeCloseFriend('nope')).toBe(false);
  });
});

describe('NotificationPriorityAI — learned preferences', () => {
  it('click feedback raises bias, mute feedback lowers it', async () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    const before = ai.getPreferences().quantsink.bias;
    await ai.recordFeedback('quantsink', 'click');
    await ai.recordFeedback('quantsink', 'click');
    const after = ai.getPreferences().quantsink.bias;
    expect(after).toBeGreaterThan(before);
    await ai.recordFeedback('quantsink', 'mute');
    const afterMute = ai.getPreferences().quantsink.bias;
    expect(afterMute).toBeLessThan(after);
  });

  it('bias is clamped to ±2', async () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    for (let i = 0; i < 100; i += 1) await ai.recordFeedback('quantsink', 'click');
    expect(ai.getPreferences().quantsink.bias).toBeLessThanOrEqual(2);
    for (let i = 0; i < 100; i += 1) await ai.recordFeedback('quantsink', 'report');
    expect(ai.getPreferences().quantsink.bias).toBeGreaterThanOrEqual(-2);
  });

  it('rejects unknown app', async () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    // @ts-expect-error – testing runtime guard
    await expect(ai.recordFeedback('nope', 'click')).rejects.toThrow();
  });

  it('persists state through hydrate/persist', async () => {
    const shared: { state?: Record<string, unknown> } = {};
    const store = {
      load: async () => (shared.state as never) ?? undefined,
      save: async (s: Record<string, unknown>) => { shared.state = s; },
    };
    const ai = new NotificationPriorityAI({ clock: new Clock(), preferenceStore: store });
    await ai.hydrate();
    await ai.recordFeedback('quantchat', 'click');
    const ai2 = new NotificationPriorityAI({ clock: new Clock(), preferenceStore: store });
    await ai2.hydrate();
    expect(ai2.getPreferences().quantchat.bias).toBeGreaterThan(0);
  });
});

describe('NotificationPriorityAI — DND scheduling', () => {
  it('suppresses low-priority notifications during sleep', () => {
    // Sleep window default is 23:00 → 07:00 UTC with tz 0.
    const midnight = Date.UTC(2026, 0, 1, 0, 30);
    const ai = new NotificationPriorityAI({ clock: { now: () => midnight } });
    const n = makeNotification({
      kind: 'ad_performance',
      occurredAt: new Date(midnight).toISOString(),
    });
    const d = ai.evaluate(n);
    expect(d.suppress).toBe(true);
    expect(d.matchedDndRules.length).toBeGreaterThan(0);
  });

  it('does not suppress high-priority DMs during sleep', () => {
    const midnight = Date.UTC(2026, 0, 1, 0, 30);
    const ai = new NotificationPriorityAI({
      clock: { now: () => midnight },
      closeFriends: [{ userId: 'u', affinity: 1 }],
    });
    const n = makeNotification({
      kind: 'message',
      senderId: 'u',
      occurredAt: new Date(midnight).toISOString(),
    });
    expect(ai.evaluate(n).suppress).toBe(false);
  });

  it('custom DND rules are enforceable and removable', () => {
    const noon = Date.UTC(2026, 0, 5, 12, 0); // a Monday
    const ai = new NotificationPriorityAI({ clock: { now: () => noon } });
    ai.setSmartSchedule({ focusStartMinute: 0, focusEndMinute: 0 }); // disable focus
    ai.addDndRule({
      id: 'lunch',
      label: 'Lunch',
      daysOfWeek: [1, 2, 3, 4, 5],
      startMinute: 12 * 60,
      endMinute: 13 * 60,
      suppressBelowPriority: 11,
    });
    const n = makeNotification({
      kind: 'broadcast',
      occurredAt: new Date(noon).toISOString(),
    });
    expect(ai.evaluate(n).suppress).toBe(true);
    expect(ai.removeDndRule('lunch')).toBe(true);
    expect(ai.evaluate(n).suppress).toBe(false);
  });

  it('enableManualDnd expires automatically', () => {
    // 10:00 UTC on a Saturday (outside default sleep+focus windows).
    const t0 = Date.UTC(2026, 0, 3, 10, 0);
    let t = t0;
    const ai = new NotificationPriorityAI({ clock: { now: () => t } });
    ai.enableManualDnd(5000, 11);
    const n = makeNotification({ kind: 'broadcast', occurredAt: new Date(t).toISOString() });
    expect(ai.evaluate(n).suppress).toBe(true);
    t += 6000;
    expect(ai.evaluate(n).suppress).toBe(false);
  });

  it('rejects invalid rules', () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    expect(() =>
      ai.addDndRule({
        id: 'bad',
        label: 'x',
        daysOfWeek: [9],
        startMinute: 0,
        endMinute: 100,
        suppressBelowPriority: 5,
      }),
    ).toThrow();
  });
});

describe('NotificationPriorityAI — content signal', () => {
  it('urgent keywords boost score and tag', () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    const n = makeNotification({
      kind: 'email',
      title: 'URGENT: verify account',
      body: 'security alert',
      occurredAt: new Date(100_000).toISOString(),
    });
    const d = ai.evaluate(n);
    expect(d.contentBoost).toBeGreaterThan(0);
    expect(d.tags).toContain('urgent');
  });

  it('promotional keywords reduce score', () => {
    const ai = new NotificationPriorityAI({ clock: new Clock() });
    const n = makeNotification({
      kind: 'email',
      title: '50% off sale',
      body: 'limited time deal',
      occurredAt: new Date(100_000).toISOString(),
    });
    const d = ai.evaluate(n);
    expect(d.tags).toContain('promotional');
  });
});

describe('NotificationPriorityAI — diagnostics', () => {
  it('describe() returns snapshot fields', () => {
    const ai = new NotificationPriorityAI({
      clock: new Clock(),
      closeFriends: [{ userId: 'u', affinity: 0.5 }],
    });
    const d = ai.describe();
    expect(d.closeFriends).toBe(1);
    expect(d.schedule).toEqual(expect.objectContaining(DEFAULT_SMART_SCHEDULE));
    expect(Object.keys(d.biases).length).toBeGreaterThan(0);
  });

  it('exports tunables via PRIORITY_AI_CONSTANTS', () => {
    expect(PRIORITY_AI_CONSTANTS.BASE_PRIORITY).toBe(BASE_PRIORITY);
  });
});
