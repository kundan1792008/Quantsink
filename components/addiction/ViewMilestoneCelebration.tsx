"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MilestoneReached, ViewMilestone } from "@/lib/rewardEngineClient";

interface ViewMilestoneCelebrationProps {
  /** Currently active milestone to celebrate (or null). */
  readonly milestone: MilestoneReached | null;
  /** Fires when the celebration overlay should be dismissed. */
  readonly onDismiss: () => void;
  /** Auto-dismiss duration in ms. Default 3400. */
  readonly dismissAfterMs?: number;
}

function Burst({ color }: { color: string }) {
  const rays = Array.from({ length: 10 });
  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden>
      {rays.map((_, i) => {
        const angle = (i / rays.length) * Math.PI * 2;
        const x = Math.cos(angle) * 120;
        const y = Math.sin(angle) * 120;
        return (
          <motion.span
            key={i}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.2 }}
            animate={{ x, y, opacity: [0, 1, 0], scale: 1 }}
            transition={{ duration: 1.1, delay: i * 0.03, ease: "easeOut" }}
            className="absolute top-1/2 left-1/2 w-1 h-1 rounded-full"
            style={{
              backgroundColor: color,
              boxShadow: `0 0 10px ${color}`,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Full-deck celebration card shown when a view milestone is crossed.
 * Contains the badge glyph, status tagline, and a decorative burst.
 */
export default function ViewMilestoneCelebration({
  milestone,
  onDismiss,
  dismissAfterMs = 3_400,
}: ViewMilestoneCelebrationProps) {
  useEffect(() => {
    if (!milestone) return undefined;
    const id = window.setTimeout(onDismiss, dismissAfterMs);
    return () => window.clearTimeout(id);
  }, [milestone, dismissAfterMs, onDismiss]);

  return (
    <AnimatePresence>
      {milestone && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-center justify-center pointer-events-auto"
          style={{ backgroundColor: "rgba(10,10,10,0.72)" }}
          onClick={onDismiss}
          role="dialog"
          aria-label={`Milestone: ${milestone.milestone.badgeName}`}
        >
          <MilestoneCard milestone={milestone.milestone} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function MilestoneCard({ milestone }: { milestone: ViewMilestone }) {
  const color = milestone.accentColor;
  return (
    <motion.div
      initial={{ scale: 0.85, y: 28, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      exit={{ scale: 0.95, y: -10, opacity: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-sm border px-8 py-7 max-w-md w-[88%] overflow-hidden"
      style={{
        backgroundColor: "#0F0F0F",
        borderColor: color,
        boxShadow: `0 0 0 1px ${color}55, 0 30px 80px rgba(0,0,0,0.7)`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <Burst color={color} />

      <div className="flex flex-col items-center text-center relative">
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.15, type: "spring", stiffness: 220, damping: 18 }}
          className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
          style={{
            backgroundColor: `${color}18`,
            border: `2px solid ${color}`,
          }}
        >
          <span className="text-[28px]">✦</span>
        </motion.div>

        <span
          className="text-[9px] tracking-[0.3em] uppercase font-semibold"
          style={{ color }}
        >
          Milestone unlocked
        </span>
        <h3
          className="mt-1 text-2xl tracking-tight font-semibold"
          style={{ color: "#F4F1EC", fontFamily: "var(--font-display)" }}
        >
          {milestone.badgeName}
        </h3>
        <p className="mt-2 text-[12px] leading-relaxed text-brand-subtext max-w-[32ch]">
          {milestone.tagline}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <span
            className="text-[9px] tracking-widest uppercase font-semibold px-2 py-0.5 rounded-sm"
            style={{
              color,
              border: `1px solid ${color}55`,
              backgroundColor: `${color}18`,
            }}
          >
            {milestone.threshold.toLocaleString()} views
          </span>
          <span className="text-[9px] tracking-widest uppercase text-brand-muted">
            tap anywhere to dismiss
          </span>
        </div>
      </div>
    </motion.div>
  );
}
