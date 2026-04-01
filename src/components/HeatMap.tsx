"use client";

import React from "react";
import { motion } from "framer-motion";

interface HeatMapProps {
  /** Per-dimension heat values, each 0-1 */
  heatValues: number[];
  /** Overall score 0-1, drives glow intensity */
  score: number;
}

/** Maps a 0-1 heat value to an HSL colour (blue → green → red). */
function heatColor(value: number): string {
  // hue: 240 (blue) at 0 → 120 (green) at 0.5 → 0 (red) at 1
  const hue = Math.round((1 - value) * 240);
  const sat = 70 + Math.round(value * 30);
  const light = 40 + Math.round(value * 20);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

const DIMENSION_LABELS = ["Vibe", "Goals", "Lifestyle", "Values", "Energy"];

export default function HeatMap({ heatValues, score }: HeatMapProps) {
  const glowOpacity = 0.3 + score * 0.7;

  return (
    <motion.div
      className="relative w-full rounded-2xl overflow-hidden"
      style={{ perspective: 800 }}
      animate={{ rotateX: [0, 4, 0], scale: [1, 1.02, 1] }}
      transition={{ duration: 3, ease: "easeInOut", repeat: Infinity }}
    >
      {/* Glow backdrop */}
      <motion.div
        className="absolute inset-0 rounded-2xl"
        style={{
          background: `radial-gradient(ellipse at 50% 50%, hsla(${Math.round(
            (1 - score) * 240
          )}, 80%, 60%, ${glowOpacity}) 0%, transparent 70%)`,
          filter: "blur(18px)",
        }}
        animate={{ opacity: [glowOpacity * 0.7, glowOpacity, glowOpacity * 0.7] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Grid */}
      <div className="relative grid grid-cols-5 gap-1.5 p-3">
        {heatValues.map((val, i) => (
          <motion.div
            key={i}
            className="flex flex-col items-center gap-1"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08, duration: 0.4 }}
          >
            {/* Bar */}
            <div className="relative w-full h-16 rounded-lg overflow-hidden bg-white/5">
              <motion.div
                className="absolute bottom-0 w-full rounded-lg"
                style={{ backgroundColor: heatColor(val) }}
                initial={{ height: 0 }}
                animate={{
                  height: `${val * 100}%`,
                  boxShadow: `0 0 ${8 + val * 12}px ${heatColor(val)}`,
                }}
                transition={{
                  height: { duration: 0.8, ease: [0.34, 1.56, 0.64, 1] },
                  boxShadow: { duration: 1.5, repeat: Infinity, repeatType: "reverse" },
                }}
              />
            </div>
            {/* Label */}
            <span className="text-[9px] font-semibold tracking-wide text-white/60 uppercase">
              {DIMENSION_LABELS[i] ?? `D${i + 1}`}
            </span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
