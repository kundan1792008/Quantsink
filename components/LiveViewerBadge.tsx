"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "framer-motion";

export interface LiveViewerBadgeProps {
  /** Real, verified concurrent viewer count from the presence channel. */
  count: number;
  /** Optional label, defaults to "viewing". */
  label?: string;
}

/**
 * Displays the true viewer count. Pulses only when the count genuinely
 * increases — no inflation, no multiplier, no synthetic churn.
 */
export default function LiveViewerBadge({ count, label = "viewing" }: LiveViewerBadgeProps) {
  const previous = useRef(count);
  const controls = useAnimationControls();
  const [direction, setDirection] = useState<"up" | "down" | "same">("same");

  useEffect(() => {
    if (count > previous.current) {
      setDirection("up");
      controls.start({
        scale: [1, 1.12, 1],
        transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
      });
    } else if (count < previous.current) {
      setDirection("down");
    }
    previous.current = count;
  }, [count, controls]);

  const isLive = count > 0;

  return (
    <motion.div
      animate={controls}
      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-sm border"
      style={{
        backgroundColor: "#111111",
        borderColor: isLive ? "rgba(158,201,122,0.3)" : "#1E1E1E",
      }}
      aria-live="polite"
      aria-label={`${count} ${label}`}
    >
      <span className="relative flex items-center">
        <motion.span
          animate={{ opacity: isLive ? [1, 0.35, 1] : 0.3 }}
          transition={{ duration: 1.6, repeat: isLive ? Infinity : 0, ease: "easeInOut" }}
          className="absolute inline-flex h-2 w-2 rounded-full"
          style={{ backgroundColor: isLive ? "#9EC97A" : "#3A3A3A" }}
        />
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ backgroundColor: isLive ? "#9EC97A" : "#3A3A3A" }}
        />
      </span>
      <span
        className="text-[11px] font-mono font-semibold tabular-nums"
        style={{ color: isLive ? "#E8E6E1" : "#7A7A7A" }}
      >
        {count.toLocaleString()}
      </span>
      <span className="text-[9px] tracking-[0.2em] text-brand-subtext uppercase">
        {label}
      </span>
      {direction === "up" && (
        <motion.span
          key={`up-${count}`}
          initial={{ opacity: 1, y: 0 }}
          animate={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.7 }}
          className="text-[9px] font-mono"
          style={{ color: "#9EC97A" }}
          aria-hidden
        >
          ▲
        </motion.span>
      )}
    </motion.div>
  );
}
