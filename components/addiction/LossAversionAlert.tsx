"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  tierForStatusPoints,
  TIER_DECAY_HOURS,
  type LossAversionState,
} from "@/lib/rewardEngineClient";

interface LossAversionAlertProps {
  /** Status points accumulated by the broadcaster. */
  readonly statusPoints: number;
  /** When the owner last published. Used to compute tier decay. */
  readonly lastBroadcastAt?: Date;
  /** Simulation speed multiplier. Useful for demos. Default 1. */
  readonly timeScale?: number;
}

const LEVEL_PALETTE: Record<LossAversionState["warningLevel"], { color: string; border: string; bg: string; icon: string }> = {
  CALM: {
    color: "#9EC97A",
    border: "#9EC97A55",
    bg: "rgba(158,201,122,0.08)",
    icon: "◉",
  },
  NUDGE: {
    color: "#C9A96E",
    border: "#C9A96E55",
    bg: "rgba(201,169,110,0.1)",
    icon: "⏱",
  },
  URGENT: {
    color: "#E0A86D",
    border: "#E0A86D55",
    bg: "rgba(224,168,109,0.12)",
    icon: "⚠",
  },
  CRITICAL: {
    color: "#E06D6D",
    border: "#E06D6D55",
    bg: "rgba(224,109,109,0.14)",
    icon: "✖",
  },
};

function computeState(
  statusPoints: number,
  lastBroadcastAt: Date,
  now: Date,
): LossAversionState {
  const tier = tierForStatusPoints(statusPoints);
  const decayHours = TIER_DECAY_HOURS[tier] ?? 72;
  const expiresAt = new Date(
    lastBroadcastAt.getTime() + decayHours * 3_600_000,
  );
  const hoursRemaining = (expiresAt.getTime() - now.getTime()) / 3_600_000;
  let warningLevel: LossAversionState["warningLevel"];
  let message: string;
  if (hoursRemaining > decayHours * 0.5) {
    warningLevel = "CALM";
    message = `${tier} status is stable. Keep broadcasting to maintain it.`;
  } else if (hoursRemaining > decayHours * 0.25) {
    warningLevel = "NUDGE";
    message = `Your ${tier} status renews with every broadcast — stay loud.`;
  } else if (hoursRemaining > 0) {
    const hrs = Math.max(1, Math.round(hoursRemaining));
    warningLevel = "URGENT";
    message = `Your ${tier} Broadcaster status expires in ${hrs}h. Post now to maintain it.`;
  } else {
    warningLevel = "CRITICAL";
    message = `Your ${tier} status has lapsed. Broadcast immediately to reinstate it.`;
  }
  return { tier, expiresAt, hoursRemaining, warningLevel, message };
}

/**
 * LossAversionAlert renders the tier-decay nudge strip. The urgency
 * level is recomputed each second so the message naturally escalates as
 * the broadcaster's dormancy window compresses.
 */
export default function LossAversionAlert({
  statusPoints,
  lastBroadcastAt,
  timeScale = 1,
}: LossAversionAlertProps) {
  const anchor = useMemo(() => lastBroadcastAt ?? new Date(), [lastBroadcastAt]);
  const [now, setNow] = useState(() => new Date());
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      if (timeScale === 1) {
        setNow(new Date());
        return;
      }
      const elapsedReal = Date.now() - mountedAt.current;
      setNow(new Date(mountedAt.current + elapsedReal * timeScale));
    }, 1_000);
    return () => window.clearInterval(id);
  }, [timeScale]);

  const state = useMemo(
    () => computeState(statusPoints, anchor, now),
    [statusPoints, anchor, now],
  );
  const palette = LEVEL_PALETTE[state.warningLevel];

  return (
    <section
      className="rounded-sm border px-4 py-3 flex items-center gap-3"
      style={{
        backgroundColor: palette.bg,
        borderColor: palette.border,
      }}
      aria-live="polite"
      aria-label={`Loss aversion alert: ${state.warningLevel}`}
    >
      <motion.span
        animate={
          state.warningLevel === "CRITICAL"
            ? { scale: [1, 1.2, 1] }
            : { scale: 1 }
        }
        transition={
          state.warningLevel === "CRITICAL"
            ? { duration: 1.1, repeat: Infinity }
            : { duration: 0.2 }
        }
        className="w-6 h-6 flex items-center justify-center rounded-sm text-[13px]"
        style={{
          color: palette.color,
          border: `1px solid ${palette.border}`,
          backgroundColor: "#0F0F0F",
        }}
      >
        {palette.icon}
      </motion.span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[9px] tracking-[0.22em] uppercase font-semibold"
            style={{ color: palette.color }}
          >
            {state.warningLevel}
          </span>
          <span className="text-[9px] uppercase tracking-widest text-brand-muted">
            {state.tier} tier
          </span>
        </div>
        <AnimatePresence mode="wait">
          <motion.p
            key={state.message}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            className="text-[11px] text-brand-text mt-0.5 leading-snug"
          >
            {state.message}
          </motion.p>
        </AnimatePresence>
      </div>

      {state.warningLevel !== "CALM" && (
        <button
          type="button"
          className="text-[10px] tracking-widest uppercase font-semibold px-3 py-1.5 rounded-sm border flex-shrink-0"
          style={{
            color: palette.color,
            borderColor: palette.color,
            backgroundColor: "#0F0F0F",
          }}
        >
          Broadcast now
        </button>
      )}
    </section>
  );
}
