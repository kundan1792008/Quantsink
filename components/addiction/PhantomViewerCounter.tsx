"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface PhantomViewerCounterProps {
  /** Starting real viewer count. Default 42. */
  readonly initialReal?: number;
  /** Multiplier applied to the real viewer count. Default 1.3. */
  readonly inflationMultiplier?: number;
  /** Minimum interval between phantom drifts in ms. Default 1600. */
  readonly minDriftMs?: number;
  /** Maximum interval between phantom drifts in ms. Default 3800. */
  readonly maxDriftMs?: number;
}

const randInt = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

/**
 * PhantomViewerCounter renders the "X people are viewing right now"
 * bar. The real viewer count is simulated here — in production the
 * component would be wired to a presence API. The phantom count is
 * always >= real × inflationMultiplier and pulses whenever it rises.
 */
export default function PhantomViewerCounter({
  initialReal = 42,
  inflationMultiplier = 1.3,
  minDriftMs = 1_600,
  maxDriftMs = 3_800,
}: PhantomViewerCounterProps) {
  const [real, setReal] = useState(initialReal);
  const [phantom, setPhantom] = useState(() =>
    Math.round(initialReal * inflationMultiplier),
  );
  const [pulseKey, setPulseKey] = useState(0);
  const [lastDelta, setLastDelta] = useState(0);
  const prevPhantom = useRef(phantom);

  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const delay = randInt(minDriftMs, maxDriftMs);
      window.setTimeout(() => {
        if (cancelled) return;
        setReal((r) => Math.max(0, r + randInt(-1, 3)));
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
    };
  }, [minDriftMs, maxDriftMs]);

  useEffect(() => {
    const target = Math.round(real * inflationMultiplier + randInt(-2, 4));
    const next = Math.max(real, target);
    if (next !== prevPhantom.current) {
      setLastDelta(next - prevPhantom.current);
      setPulseKey((k) => k + 1);
      prevPhantom.current = next;
      setPhantom(next);
    }
  }, [real, inflationMultiplier]);

  const trendColor = lastDelta >= 0 ? "#9EC97A" : "#C97A7A";
  const trendGlyph = lastDelta >= 0 ? "▲" : "▼";

  return (
    <section
      className="rounded-sm border px-4 py-3 flex items-center gap-4"
      style={{ backgroundColor: "#111111", borderColor: "#1E1E1E" }}
      aria-label="Phantom viewer counter"
    >
      <div className="flex items-center gap-2">
        <div className="relative flex items-center">
          <motion.span
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.4, repeat: Infinity }}
            className="absolute inline-flex h-2 w-2 rounded-full bg-red-500 opacity-75"
          />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
        </div>
        <span className="text-[10px] tracking-[0.22em] uppercase font-semibold text-brand-subtext">
          Live audience
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <AnimatePresence mode="wait">
          <motion.span
            key={pulseKey}
            initial={{ scale: 1.25, color: "#C9A96E" }}
            animate={{ scale: 1, color: "#E8E6E1" }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="text-[20px] font-semibold tabular-nums font-mono leading-none"
          >
            {phantom.toLocaleString()}
          </motion.span>
        </AnimatePresence>
        <span className="text-[10px] uppercase tracking-widest text-brand-subtext">
          people are watching
        </span>
        {lastDelta !== 0 && (
          <motion.span
            key={`delta-${pulseKey}`}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-[10px] font-mono tabular-nums"
            style={{ color: trendColor }}
          >
            {trendGlyph}
            {Math.abs(lastDelta)}
          </motion.span>
        )}
      </div>
      <div className="ml-auto text-[9px] tracking-widest uppercase text-brand-muted">
        real {real.toLocaleString()}
      </div>
    </section>
  );
}
