"use client";

import { motion } from "framer-motion";

export interface EngagementMilestonesProps {
  readonly currentInteractions: number;
  readonly dailyGoal?: number;
}

const MILESTONES = [
  { label: "Warm-up", ratio: 0.25 },
  { label: "Momentum", ratio: 0.5 },
  { label: "Locked In", ratio: 0.75 },
  { label: "Daily Goal", ratio: 1 },
] as const;

export default function EngagementMilestones({
  currentInteractions,
  dailyGoal = 120,
}: EngagementMilestonesProps) {
  const clamped = Math.max(0, currentInteractions);
  const ratio = Math.min(1, clamped / Math.max(1, dailyGoal));

  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ratio);

  return (
    <section
      className="max-w-2xl mx-auto px-4 pb-8"
      aria-label="Engagement milestones"
      style={{ fontFamily: '"Inter", "Geist", system-ui, sans-serif' }}
    >
      <div className="rounded-sm border border-brand-border bg-[#0A0A0A] p-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2
            className="text-[12px] tracking-[0.2em] uppercase text-brand-subtext font-semibold"
            style={{ fontFamily: '"Austin Roman", "Times New Roman", "Georgia", serif' }}
          >
            Engagement Milestones
          </h2>
          <span className="text-[11px] text-brand-subtext tabular-nums">
            {clamped.toLocaleString()} / {dailyGoal.toLocaleString()}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative h-20 w-20 shrink-0">
            <svg viewBox="0 0 100 100" className="h-20 w-20 -rotate-90">
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke="rgba(255,255,255,0.1)"
                strokeWidth="8"
              />
              <motion.circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke="#C9A96E"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                animate={{ strokeDashoffset: offset }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-brand-text">
              {Math.round(ratio * 100)}%
            </span>
          </div>

          <ul className="flex-1 grid grid-cols-2 gap-2">
            {MILESTONES.map((milestone) => {
              const unlocked = ratio >= milestone.ratio;
              return (
                <motion.li
                  key={milestone.label}
                  initial={false}
                  animate={{ opacity: unlocked ? 1 : 0.5, scale: unlocked ? 1 : 0.98 }}
                  className="rounded-sm border px-2 py-1.5"
                  style={{
                    borderColor: unlocked
                      ? "rgba(201,169,110,0.45)"
                      : "rgba(255,255,255,0.12)",
                    backgroundColor: unlocked
                      ? "rgba(201,169,110,0.08)"
                      : "rgba(255,255,255,0.02)",
                  }}
                >
                  <div className="text-[10px] tracking-wide uppercase text-brand-subtext">
                    {milestone.label}
                  </div>
                  <div className="text-[11px] font-medium text-brand-text">
                    {Math.round(milestone.ratio * dailyGoal)} interactions
                  </div>
                </motion.li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
