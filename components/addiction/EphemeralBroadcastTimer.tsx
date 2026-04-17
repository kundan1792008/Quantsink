"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

interface EphemeralBroadcastTimerProps {
  /** Total broadcast TTL in milliseconds. Default 2h. */
  readonly ttlMs?: number;
  /** Optional explicit creation date. Defaults to "now" on mount. */
  readonly createdAt?: Date;
  /** Fires when the timer elapses. */
  readonly onExpire?: () => void;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1_000);
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function urgencyFor(percent: number): {
  color: string;
  label: string;
  barColor: string;
} {
  if (percent <= 0) {
    return { color: "#C97A7A", label: "Destroyed", barColor: "#C97A7A" };
  }
  if (percent <= 0.1) {
    return { color: "#E06D6D", label: "Critical", barColor: "#E06D6D" };
  }
  if (percent <= 0.25) {
    return { color: "#E0A86D", label: "Hot", barColor: "#E0A86D" };
  }
  if (percent <= 0.5) {
    return { color: "#C9A96E", label: "Warming", barColor: "#C9A96E" };
  }
  return { color: "#9EC97A", label: "Steady", barColor: "#9EC97A" };
}

/**
 * EphemeralBroadcastTimer renders the "this broadcast self-destructs in
 * X" FOMO clock. A progress bar drains from 100% to 0% and the urgency
 * label ramps up as the remaining time compresses.
 */
export default function EphemeralBroadcastTimer({
  ttlMs = 2 * 60 * 60 * 1_000,
  createdAt,
  onExpire,
}: EphemeralBroadcastTimerProps) {
  const startedAt = useMemo(() => createdAt ?? new Date(), [createdAt]);
  const expiresAt = useMemo(
    () => new Date(startedAt.getTime() + ttlMs),
    [startedAt, ttlMs],
  );
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = now.getTime() - startedAt.getTime();
  const msRemaining = Math.max(0, ttlMs - elapsed);
  const percent = ttlMs === 0 ? 0 : msRemaining / ttlMs;
  const urgency = urgencyFor(percent);

  useEffect(() => {
    if (msRemaining <= 0) onExpire?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msRemaining <= 0]);

  const isCritical = percent <= 0.1 && percent > 0;

  return (
    <section
      className="rounded-sm border px-4 py-3 flex flex-col gap-2"
      style={{ backgroundColor: "#111111", borderColor: "#1E1E1E" }}
      aria-label="Ephemeral broadcast timer"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] tracking-[0.22em] uppercase font-semibold"
            style={{ color: urgency.color }}
          >
            Self-Destruct
          </span>
          <span
            className="text-[9px] tracking-widest px-2 py-0.5 rounded-sm uppercase font-semibold"
            style={{
              color: urgency.color,
              border: `1px solid ${urgency.color}55`,
              backgroundColor: `${urgency.color}18`,
            }}
          >
            {urgency.label}
          </span>
        </div>
        <motion.span
          animate={
            isCritical ? { opacity: [1, 0.5, 1] } : { opacity: 1 }
          }
          transition={
            isCritical
              ? { duration: 0.8, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
          className="text-[16px] font-mono tabular-nums font-semibold"
          style={{ color: urgency.color }}
        >
          {formatRemaining(msRemaining)}
        </motion.span>
      </div>

      <div
        className="relative h-[6px] w-full rounded-sm overflow-hidden"
        style={{ backgroundColor: "#0B0B0B", border: "1px solid #1E1E1E" }}
      >
        <motion.div
          initial={false}
          animate={{ width: `${(percent * 100).toFixed(2)}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="absolute inset-y-0 left-0"
          style={{
            backgroundColor: urgency.barColor,
            boxShadow: isCritical
              ? `0 0 12px ${urgency.barColor}`
              : undefined,
          }}
        />
      </div>

      <div className="flex items-center justify-between text-[9px] tracking-widest uppercase text-brand-muted">
        <span>
          Launched {startedAt.toISOString().slice(11, 19)} UTC
        </span>
        <span>
          Expires {expiresAt.toISOString().slice(11, 19)} UTC
        </span>
      </div>
    </section>
  );
}
