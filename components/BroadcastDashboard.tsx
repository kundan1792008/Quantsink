"use client";

import { useEffect, useState } from "react";
import EphemeralCountdown from "./EphemeralCountdown";
import LiveViewerBadge from "./LiveViewerBadge";
import MilestoneCelebration from "./MilestoneCelebration";
import StreakFlame from "./StreakFlame";
import TierBadge from "./TierBadge";

// Client-side mirror of the server's RewardEngine constants. Kept in sync
// with src/services/RewardEngine.ts. Pure data — no runtime dependencies,
// so this component can live in the browser bundle without pulling in
// server-only modules like pino.
type MilestoneTier = "SPARK" | "RISING" | "APEX" | "LEGENDARY";
interface Milestone {
  threshold: number;
  tier: MilestoneTier;
  label: string;
}
const MILESTONES: readonly Milestone[] = [
  { threshold: 100,    tier: "SPARK",     label: "First Hundred" },
  { threshold: 500,    tier: "RISING",    label: "Rising Signal" },
  { threshold: 1_000,  tier: "APEX",      label: "Apex Broadcaster" },
  { threshold: 10_000, tier: "LEGENDARY", label: "Legendary Reach" },
] as const;

type ReactionKind = "FIRE" | "DIAMOND" | "CROWN";
const REACTIONS: readonly { kind: ReactionKind; emoji: string; weight: number; label: string }[] = [
  { kind: "FIRE",    emoji: "🔥", weight: 1,  label: "Fire" },
  { kind: "DIAMOND", emoji: "💎", weight: 3,  label: "Diamond" },
  { kind: "CROWN",   emoji: "👑", weight: 10, label: "Crown" },
] as const;

function milestonesCrossed(previous: number, current: number): Milestone[] {
  if (current <= previous) return [];
  return MILESTONES.filter((m) => previous < m.threshold && current >= m.threshold);
}

/**
 * BroadcastDashboard — demo surface wiring the honest engagement primitives
 * to the Quantsink Pro UI. All numbers shown are real local state; nothing
 * is multiplied or fabricated.
 */
export default function BroadcastDashboard() {
  // Simulated *real* viewer count driven by a local interval (stand-in for
  // a WebSocket presence channel). In production this is bound to
  // PresenceService events.
  const [viewers, setViewers] = useState(42);
  const [views, setViews] = useState(87);
  const [activeMilestone, setActiveMilestone] = useState<
    | {
        tier: Milestone["tier"];
        label: string;
        threshold: number;
        actualViewCount: number;
      }
    | null
  >(null);

  // Reaction counts chosen explicitly by the viewer — fully transparent.
  const [reactionCounts, setReactionCounts] = useState<Record<ReactionKind, number>>({
    FIRE: 0,
    DIAMOND: 0,
    CROWN: 0,
  });

  // Fixed expiry derived from mount time. In production this is the real
  // `expiresAt` returned by EphemeralBroadcastWorker.register().
  const [expiresAt] = useState(() => new Date(Date.now() + 2 * 60 * 60 * 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setViewers((v) => Math.max(0, v + Math.round((Math.random() - 0.45) * 6)));
      setViews((prev) => {
        const next = prev + Math.max(0, Math.round(Math.random() * 12));
        const crossed = milestonesCrossed(prev, next);
        if (crossed.length > 0) {
          const top = crossed[crossed.length - 1];
          setActiveMilestone({
            tier: top.tier,
            label: top.label,
            threshold: top.threshold,
            actualViewCount: next,
          });
        }
        return next;
      });
    }, 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <section
        className="max-w-2xl mx-auto px-4 mb-6"
        aria-label="Broadcast engagement"
      >
        <div className="flex items-center gap-3 mb-3">
          <span className="text-[10px] tracking-[0.25em] text-brand-subtext uppercase font-medium">
            Live Broadcast
          </span>
          <div className="h-px flex-1 bg-brand-border" />
          <span className="text-[9px] text-brand-subtext font-mono">
            Ephemeral · Opt-in
          </span>
        </div>

        <div
          className="rounded-sm p-5 border"
          style={{ backgroundColor: "#111111", borderColor: "#1E1E1E" }}
        >
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <LiveViewerBadge count={viewers} />
            <EphemeralCountdown expiresAt={expiresAt} />
            <StreakFlame currentStreak={12} atRisk={false} />
            <TierBadge
              tier="PLATINUM"
              daysUntilDecay={3}
              atRisk
              nextDecayTier="GOLD"
            />
          </div>

          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <p className="text-[10px] tracking-[0.25em] text-brand-subtext uppercase mb-1">
                Total Views
              </p>
              <p
                className="text-2xl font-mono font-semibold text-brand-text tabular-nums"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {views.toLocaleString()}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[10px] tracking-[0.25em] text-brand-subtext uppercase mb-1">
                Next Milestone
              </p>
              <p className="text-[12px] font-mono text-brand-accent tabular-nums">
                {(() => {
                  const next = MILESTONES.find((m) => m.threshold > views);
                  return next ? `${next.threshold.toLocaleString()} · ${next.label}` : "Maxed";
                })()}
              </p>
            </div>
          </div>

          {/* Reactions — user explicitly chooses tier; weights are published. */}
          <div className="flex items-center gap-2 pt-3 border-t" style={{ borderColor: "#1E1E1E" }}>
            <span className="text-[9px] tracking-[0.22em] text-brand-subtext uppercase mr-1">
              React
            </span>
            {REACTIONS.map((r) => (
              <button
                key={r.kind}
                type="button"
                onClick={() =>
                  setReactionCounts((c) => ({ ...c, [r.kind]: c[r.kind] + 1 }))
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm border border-brand-border hover:border-brand-accent transition-colors text-brand-text"
                aria-label={`React with ${r.label} (weight ${r.weight})`}
              >
                <span aria-hidden>{r.emoji}</span>
                <span className="text-[10px] font-mono tabular-nums text-brand-subtext">
                  ×{r.weight}
                </span>
                <span className="text-[10px] font-mono tabular-nums">
                  {reactionCounts[r.kind]}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <MilestoneCelebration
        milestone={activeMilestone}
        onDismiss={() => setActiveMilestone(null)}
      />
    </>
  );
}
