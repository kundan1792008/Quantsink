"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

export interface EphemeralCountdownProps {
  /** Real server-side expiry time for this broadcast. */
  expiresAt: Date | string;
  /** Callback fired once the countdown reaches zero. */
  onExpire?: () => void;
}

function fmt(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Ephemeral broadcast countdown.
 *
 * Scarcity is genuine — backed by a real server-side TTL. The urgency styling
 * mirrors what the server will actually do at T=0.
 */
export default function EphemeralCountdown({ expiresAt, onExpire }: EphemeralCountdownProps) {
  const expiryMs =
    typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = Math.max(0, expiryMs - now);

  useEffect(() => {
    if (remaining === 0 && onExpire) onExpire();
  }, [remaining, onExpire]);

  // Urgency stages based on real remaining time.
  const isCritical = remaining > 0 && remaining < 5 * 60_000;       // <5 min
  const isWarning = !isCritical && remaining > 0 && remaining < 30 * 60_000; // <30 min
  const color = remaining === 0
    ? "#7A7A7A"
    : isCritical
    ? "#C97A7A"
    : isWarning
    ? "#C9A96E"
    : "#9EC97A";

  return (
    <div
      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-sm border"
      style={{
        backgroundColor: "#111111",
        borderColor: `${color}40`,
      }}
      role="timer"
      aria-live={isCritical ? "assertive" : "polite"}
      aria-label={`Broadcast self-destructs in ${fmt(remaining)}`}
    >
      <motion.svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        animate={isCritical ? { rotate: [0, -6, 6, 0] } : { rotate: 0 }}
        transition={{ duration: 0.6, repeat: isCritical ? Infinity : 0 }}
        aria-hidden
      >
        <circle cx="5" cy="5" r="3.5" fill="none" stroke={color} strokeWidth="1" />
        <line x1="5" y1="5" x2="5" y2="2.5" stroke={color} strokeWidth="1" strokeLinecap="round" />
        <line x1="5" y1="5" x2="7" y2="5" stroke={color} strokeWidth="1" strokeLinecap="round" />
      </motion.svg>
      <span
        className="text-[11px] font-mono font-semibold tabular-nums"
        style={{ color }}
      >
        {fmt(remaining)}
      </span>
      <span
        className="text-[9px] tracking-[0.2em] uppercase"
        style={{ color: "#7A7A7A" }}
      >
        {remaining === 0 ? "Expired" : "Self-Destruct"}
      </span>
    </div>
  );
}
