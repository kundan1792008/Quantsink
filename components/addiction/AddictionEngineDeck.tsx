"use client";

import { useCallback, useMemo, useState } from "react";
import MysteryBoxSlotMachine from "./MysteryBoxSlotMachine";
import PhantomViewerCounter from "./PhantomViewerCounter";
import PhantomTypingIndicators from "./PhantomTypingIndicators";
import EphemeralBroadcastTimer from "./EphemeralBroadcastTimer";
import LossAversionAlert from "./LossAversionAlert";
import ViewMilestoneCelebration from "./ViewMilestoneCelebration";
import {
  DEFAULT_MILESTONES,
  tierForStatusPoints,
  type MilestoneReached,
  type MysteryBoxResult,
  type ViewMilestone,
} from "@/lib/rewardEngineClient";

/**
 * AddictionEngineDeck — orchestrator component that binds all five
 * variable-reward sub-components together on a single broadcast card.
 * The deck is intentionally self-contained so it can be dropped into
 * any route without additional context plumbing.
 */
export default function AddictionEngineDeck() {
  const [statusPoints, setStatusPoints] = useState(0);
  const [views, setViews] = useState(0);
  const [celebrated, setCelebrated] = useState<Set<number>>(new Set());
  const [activeMilestone, setActiveMilestone] = useState<MilestoneReached | null>(null);
  const [lastBroadcastAt, setLastBroadcastAt] = useState<Date>(() => {
    // Seed with an old-ish timestamp so the loss-aversion alert is
    // visibly active on first paint.
    return new Date(Date.now() - 40 * 3_600_000);
  });

  const handleDraw = useCallback((draw: MysteryBoxResult) => {
    setStatusPoints((s) => s + draw.statusPoints);
  }, []);

  const handleViewChange = useCallback(
    (nextViews: number) => {
      setViews(nextViews);
      const newlyCrossed: ViewMilestone | undefined = DEFAULT_MILESTONES.find(
        (m) => nextViews >= m.threshold && !celebrated.has(m.threshold),
      );
      if (newlyCrossed) {
        setCelebrated((prev) => {
          const next = new Set(prev);
          next.add(newlyCrossed.threshold);
          return next;
        });
        setActiveMilestone({
          milestone: newlyCrossed,
          reachedAt: new Date(),
          viewsAtTrigger: nextViews,
        });
      }
    },
    [celebrated],
  );

  const tier = useMemo(() => tierForStatusPoints(statusPoints), [statusPoints]);

  return (
    <section className="max-w-2xl mx-auto px-4 py-8">
      <header className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-[10px] tracking-[0.25em] text-brand-subtext uppercase font-medium">
            Variable Reward Console
          </span>
          <div className="h-px flex-1 bg-brand-border" />
          <span
            className="text-[9px] tracking-widest px-2 py-0.5 rounded-sm uppercase font-semibold"
            style={{
              color: "#C9A96E",
              border: "1px solid #C9A96E55",
              backgroundColor: "rgba(201,169,110,0.1)",
            }}
          >
            {tier}
          </span>
        </div>
        <p className="text-[11px] text-brand-subtext">
          Mystery draws every 4th view · Phantom audience inflates in real time ·
          Broadcasts self-destruct in 2h.
        </p>
      </header>

      <div className="grid gap-3">
        <PhantomViewerCounter initialReal={48 + Math.floor(views / 2)} />
        <PhantomTypingIndicators />
        <EphemeralBroadcastTimer ttlMs={2 * 60 * 60 * 1_000} />
        <LossAversionAlert
          statusPoints={statusPoints}
          lastBroadcastAt={lastBroadcastAt}
        />
        <MysteryBoxSlotMachine
          viewsPerTick={1}
          tickIntervalMs={3_800}
          onDraw={handleDraw}
          onViewChange={handleViewChange}
        />
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] tracking-widest uppercase text-brand-muted">
            Broadcaster telemetry
          </span>
          <button
            type="button"
            onClick={() => setLastBroadcastAt(new Date())}
            className="text-[10px] tracking-widest uppercase font-semibold text-brand-accent"
          >
            Reset tier clock
          </button>
        </div>
      </div>

      <ViewMilestoneCelebration
        milestone={activeMilestone}
        onDismiss={() => setActiveMilestone(null)}
      />
    </section>
  );
}
