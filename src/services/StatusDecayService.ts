import logger from '../lib/logger';

/**
 * StatusDecayService — real, rule-based tier decay.
 *
 * Users earn and hold tiers (Bronze/Silver/Gold/Platinum) based on a
 * transparent broadcasting cadence. If they fall below the cadence their
 * tier steps down. Every threshold is published; notifications are
 * factual ("You haven't posted in 6 days. Platinum tier requires weekly
 * activity.") rather than manufactured urgency.
 */

export type Tier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';

export interface TierRule {
  tier: Tier;
  /** Maximum allowed days between broadcasts to *hold* this tier. */
  maxDaysBetweenBroadcasts: number;
  /** Human-readable cadence description. */
  cadence: string;
}

export const TIER_RULES: readonly TierRule[] = [
  { tier: 'PLATINUM', maxDaysBetweenBroadcasts: 7,  cadence: 'weekly' },
  { tier: 'GOLD',     maxDaysBetweenBroadcasts: 14, cadence: 'bi-weekly' },
  { tier: 'SILVER',   maxDaysBetweenBroadcasts: 30, cadence: 'monthly' },
  { tier: 'BRONZE',   maxDaysBetweenBroadcasts: Infinity, cadence: 'any' },
] as const;

const TIER_ORDER: Tier[] = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];

export interface TierState {
  userId: string;
  tier: Tier;
  lastBroadcastAt: Date | null;
  /** Days remaining before the current tier decays by one step. */
  daysUntilDecay: number | null;
  atRisk: boolean;
  nextDecayTier: Tier | null;
}

export interface TierNotification {
  userId: string;
  tier: Tier;
  daysSinceLastBroadcast: number;
  message: string;
}

function tierRule(tier: Tier): TierRule {
  const rule = TIER_RULES.find((r) => r.tier === tier);
  if (!rule) throw new Error(`Unknown tier: ${tier}`);
  return rule;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function stepDown(tier: Tier): Tier {
  const idx = TIER_ORDER.indexOf(tier);
  return idx <= 0 ? 'BRONZE' : TIER_ORDER[idx - 1];
}

/**
 * Compute the effective tier given a recorded tier and the time since the
 * last broadcast. Decays at most one step per evaluation — users are
 * warned before they lose a tier entirely.
 */
export function computeEffectiveTier(
  recordedTier: Tier,
  lastBroadcastAt: Date | null,
  now: Date = new Date(),
): Tier {
  if (lastBroadcastAt === null) return recordedTier;
  const rule = tierRule(recordedTier);
  const days = daysBetween(lastBroadcastAt, now);
  if (days <= rule.maxDaysBetweenBroadcasts) return recordedTier;
  return stepDown(recordedTier);
}

export function describeTierState(
  userId: string,
  recordedTier: Tier,
  lastBroadcastAt: Date | null,
  now: Date = new Date(),
): TierState {
  const rule = tierRule(recordedTier);
  const effective = computeEffectiveTier(recordedTier, lastBroadcastAt, now);
  const days = lastBroadcastAt ? daysBetween(lastBroadcastAt, now) : null;

  let daysUntilDecay: number | null = null;
  let atRisk = false;
  if (lastBroadcastAt !== null && Number.isFinite(rule.maxDaysBetweenBroadcasts)) {
    daysUntilDecay = Math.max(0, rule.maxDaysBetweenBroadcasts - (days ?? 0));
    atRisk = daysUntilDecay <= Math.ceil(rule.maxDaysBetweenBroadcasts / 3);
  }

  return {
    userId,
    tier: effective,
    lastBroadcastAt,
    daysUntilDecay,
    atRisk: atRisk && effective === recordedTier,
    nextDecayTier: effective === recordedTier ? stepDown(recordedTier) : null,
  };
}

/**
 * Build a factual notification for a tier that is either decaying or
 * already decayed. Returns `null` if no notification is warranted.
 */
export function notificationFor(state: TierState): TierNotification | null {
  if (state.lastBroadcastAt === null) return null;
  const days = daysBetween(state.lastBroadcastAt, new Date());
  const rule = tierRule(state.tier);

  if (state.atRisk && state.nextDecayTier) {
    const remaining = state.daysUntilDecay ?? 0;
    return {
      userId: state.userId,
      tier: state.tier,
      daysSinceLastBroadcast: days,
      message:
        `You haven't broadcast in ${days} day${days === 1 ? '' : 's'}. ` +
        `${state.tier} tier requires ${rule.cadence} activity. ` +
        `You have ${remaining} day${remaining === 1 ? '' : 's'} left before it steps down to ${state.nextDecayTier}.`,
    };
  }
  return null;
}

export class StatusDecayService {
  private readonly records = new Map<string, { tier: Tier; lastBroadcastAt: Date | null }>();

  setTier(userId: string, tier: Tier, lastBroadcastAt: Date | null = null): void {
    this.records.set(userId, { tier, lastBroadcastAt });
  }

  recordBroadcast(userId: string, at: Date = new Date()): TierState {
    const prior = this.records.get(userId) ?? { tier: 'BRONZE' as Tier, lastBroadcastAt: null };
    this.records.set(userId, { tier: prior.tier, lastBroadcastAt: at });
    return describeTierState(userId, prior.tier, at, at);
  }

  getState(userId: string, now: Date = new Date()): TierState | null {
    const rec = this.records.get(userId);
    if (!rec) return null;
    const state = describeTierState(userId, rec.tier, rec.lastBroadcastAt, now);
    // Persist decayed tier so it doesn't re-decay repeatedly.
    if (state.tier !== rec.tier) {
      this.records.set(userId, { tier: state.tier, lastBroadcastAt: rec.lastBroadcastAt });
      logger.info({ userId, from: rec.tier, to: state.tier }, 'tier.decayed');
    }
    return state;
  }

  getNotification(userId: string, now: Date = new Date()): TierNotification | null {
    const state = this.getState(userId, now);
    if (!state) return null;
    return notificationFor(state);
  }
}
