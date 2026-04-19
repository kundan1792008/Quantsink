"use client";

import { motion } from "framer-motion";

export type TierName = "BRONZE" | "SILVER" | "GOLD" | "PLATINUM";

export interface TierBadgeProps {
  tier: TierName;
  /** Real days remaining before decay step-down (null if not applicable). */
  daysUntilDecay?: number | null;
  /** Factual warning flag from StatusDecayService. */
  atRisk?: boolean;
  /** Optional next tier the user would decay to. */
  nextDecayTier?: TierName | null;
}

const TIER_META: Record<TierName, { color: string; cadence: string }> = {
  BRONZE:   { color: "#B08457", cadence: "any cadence" },
  SILVER:   { color: "#B8B8B8", cadence: "monthly cadence" },
  GOLD:     { color: "#C9A96E", cadence: "bi-weekly cadence" },
  PLATINUM: { color: "#E8E6E1", cadence: "weekly cadence" },
};

export default function TierBadge({
  tier,
  daysUntilDecay,
  atRisk = false,
  nextDecayTier,
}: TierBadgeProps) {
  const meta = TIER_META[tier];

  return (
    <div className="inline-flex flex-col gap-1">
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-sm border"
        style={{
          backgroundColor: "#111111",
          borderColor: atRisk ? "rgba(201,122,122,0.35)" : `${meta.color}40`,
        }}
        aria-label={`${tier} tier${atRisk ? ", at risk" : ""}`}
      >
        <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
          <path
            d="M5 0 L9 2.5 L9 7 L5 12 L1 7 L1 2.5 Z"
            fill={meta.color}
            stroke={meta.color}
            strokeWidth="0.5"
            strokeLinejoin="round"
          />
        </svg>
        <span
          className="text-[10px] font-bold tracking-[0.22em] uppercase"
          style={{ color: meta.color }}
        >
          {tier}
        </span>
        {atRisk && (
          <span
            className="text-[9px] tracking-widest uppercase font-semibold"
            style={{ color: "#C97A7A" }}
          >
            At Risk
          </span>
        )}
      </motion.div>
      {atRisk && typeof daysUntilDecay === "number" && nextDecayTier && (
        <p className="text-[10px] leading-tight text-brand-subtext max-w-[260px]">
          {daysUntilDecay === 0
            ? `Broadcast today to hold ${tier}. `
            : `${daysUntilDecay} day${daysUntilDecay === 1 ? "" : "s"} left before ${tier} steps down to ${nextDecayTier}. `}
          {tier} requires {meta.cadence}.
        </p>
      )}
    </div>
  );
}
