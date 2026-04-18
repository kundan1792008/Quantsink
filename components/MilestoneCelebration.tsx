"use client";

import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";

export interface MilestoneCelebrationProps {
  /** Null when no milestone is active. Set to show the celebration. */
  milestone: {
    tier: "SPARK" | "RISING" | "APEX" | "LEGENDARY";
    label: string;
    threshold: number;
    actualViewCount: number;
  } | null;
  /** Called when the celebration animation finishes. */
  onDismiss?: () => void;
  /** Total display time in ms. Defaults to 4500ms. */
  durationMs?: number;
}

const TIER_COLORS: Record<"SPARK" | "RISING" | "APEX" | "LEGENDARY", string> = {
  SPARK: "#C9A96E",
  RISING: "#C9C47A",
  APEX: "#7AC9C4",
  LEGENDARY: "#E8C97A",
};

const PARTICLE_COUNT = 18;

export default function MilestoneCelebration({
  milestone,
  onDismiss,
  durationMs = 4500,
}: MilestoneCelebrationProps) {
  useEffect(() => {
    if (!milestone || !onDismiss) return;
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [milestone, onDismiss, durationMs]);

  const particles = useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
        id: i,
        angle: (i / PARTICLE_COUNT) * Math.PI * 2,
        distance: 120 + Math.random() * 80,
        delay: Math.random() * 0.2,
      })),
    // Regenerate per milestone so each celebration has fresh particle motion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [milestone?.tier, milestone?.threshold],
  );

  const color = milestone ? TIER_COLORS[milestone.tier] : "#C9A96E";

  return (
    <AnimatePresence>
      {milestone && (
        <motion.div
          key={`${milestone.tier}-${milestone.threshold}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none"
          style={{ backgroundColor: "rgba(10,10,10,0.6)", backdropFilter: "blur(8px)" }}
          role="status"
          aria-live="polite"
        >
          {/* Particles */}
          {particles.map((p) => (
            <motion.span
              key={p.id}
              initial={{ opacity: 0, x: 0, y: 0, scale: 0.3 }}
              animate={{
                opacity: [0, 1, 0],
                x: Math.cos(p.angle) * p.distance,
                y: Math.sin(p.angle) * p.distance,
                scale: [0.3, 1, 0.6],
              }}
              transition={{ duration: 1.8, delay: p.delay, ease: [0.22, 1, 0.36, 1] }}
              className="absolute w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
            />
          ))}

          {/* Crown + copy */}
          <motion.div
            initial={{ scale: 0.6, y: 20, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex flex-col items-center gap-3 px-10 py-8 rounded-sm"
            style={{
              backgroundColor: "#111111",
              border: `1px solid ${color}40`,
              boxShadow: `0 0 40px ${color}25, 0 20px 60px rgba(0,0,0,0.6)`,
            }}
          >
            <motion.svg
              width="56"
              height="44"
              viewBox="0 0 56 44"
              fill="none"
              initial={{ rotate: -12, y: -6 }}
              animate={{ rotate: [0, -6, 6, 0], y: 0 }}
              transition={{ duration: 1.6, ease: "easeInOut" }}
              aria-hidden
            >
              <path
                d="M4 14 L14 30 L20 10 L28 32 L36 10 L42 30 L52 14 L48 38 L8 38 Z"
                fill={color}
                stroke={color}
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <circle cx="4" cy="14" r="2.5" fill={color} />
              <circle cx="28" cy="6" r="3" fill={color} />
              <circle cx="52" cy="14" r="2.5" fill={color} />
            </motion.svg>

            <span
              className="text-[10px] tracking-[0.3em] uppercase font-semibold"
              style={{ color }}
            >
              {milestone.tier} TIER UNLOCKED
            </span>
            <h2
              className="text-2xl font-semibold tracking-tight text-brand-text text-center"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {milestone.label}
            </h2>
            <p className="text-[11px] text-brand-subtext font-mono tabular-nums">
              {milestone.actualViewCount.toLocaleString()} real views ·{" "}
              {milestone.threshold.toLocaleString()}+ threshold
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
