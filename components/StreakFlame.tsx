"use client";

import { motion } from "framer-motion";

export interface StreakFlameProps {
  /** Real consecutive-day broadcast streak. */
  currentStreak: number;
  /** Whether the streak will reset if the user does not broadcast today. */
  atRisk?: boolean;
}

/**
 * Real consecutive-day broadcast streak — Duolingo / GitHub style.
 * Nothing is fudged: zero means zero.
 */
export default function StreakFlame({ currentStreak, atRisk = false }: StreakFlameProps) {
  const isActive = currentStreak > 0;
  const flameColor = atRisk ? "#C97A7A" : isActive ? "#C9A96E" : "#3A3A3A";

  return (
    <div
      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-sm border"
      style={{
        backgroundColor: "#111111",
        borderColor: `${flameColor}40`,
      }}
      aria-label={`Broadcast streak: ${currentStreak} day${currentStreak === 1 ? "" : "s"}${
        atRisk ? ", at risk today" : ""
      }`}
    >
      <motion.svg
        width="14"
        height="16"
        viewBox="0 0 14 16"
        animate={
          isActive
            ? { scale: [1, 1.08, 1], rotate: atRisk ? [0, -4, 4, 0] : 0 }
            : { scale: 1 }
        }
        transition={{
          duration: atRisk ? 1.2 : 2.4,
          repeat: isActive ? Infinity : 0,
          ease: "easeInOut",
        }}
        aria-hidden
      >
        <path
          d="M7 1 C8.5 4 11 5 11 9 C11 12 9 14.5 7 14.5 C5 14.5 3 12 3 9 C3 7 4 6 5 5 C5 7 6 7.5 7 7 C7 5 6 3.5 7 1 Z"
          fill={flameColor}
          stroke={flameColor}
          strokeLinejoin="round"
          strokeWidth="0.5"
        />
      </motion.svg>
      <span
        className="text-[12px] font-mono font-semibold tabular-nums"
        style={{ color: isActive ? "#E8E6E1" : "#7A7A7A" }}
      >
        {currentStreak}
      </span>
      <span className="text-[9px] tracking-[0.2em] text-brand-subtext uppercase">
        day{currentStreak === 1 ? "" : "s"}
      </span>
      {atRisk && (
        <span
          className="text-[9px] tracking-widest uppercase font-semibold"
          style={{ color: "#C97A7A" }}
        >
          At Risk
        </span>
      )}
    </div>
  );
}
