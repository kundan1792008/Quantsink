"use client";

import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MatchScore } from "@/lib/HiveMindAlgorithm";
import SwipeCard from "./SwipeCard";

interface ObserverFeedProps {
  matches: MatchScore[];
}

export default function ObserverFeed({ matches: initialMatches }: ObserverFeedProps) {
  const [stack, setStack] = useState<MatchScore[]>(initialMatches);
  const [history, setHistory] = useState<{ direction: "left" | "right"; match: MatchScore }[]>([]);

  function handleSwipe(direction: "left" | "right", id: string) {
    const swiped = stack.find((m) => m.profileId === id);
    if (!swiped) return;
    setHistory((h) => [...h, { direction, match: swiped }]);
    setStack((s) => s.filter((m) => m.profileId !== id));
  }

  const top = stack[stack.length - 1];
  const second = stack[stack.length - 2];

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-sm mx-auto">
      {/* Observer label */}
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-violet-500" />
        </span>
        <span className="text-xs font-semibold tracking-widest text-white/60 uppercase">
          Observer — HiveMind Active
        </span>
      </div>

      {/* Card stack */}
      <div className="relative w-full" style={{ height: 400 }}>
        {stack.length === 0 ? (
          <EmptyState
            onRestart={() => {
              setStack(initialMatches);
              setHistory([]);
            }}
          />
        ) : (
          <AnimatePresence>
            {/* Background card (subtle scale) */}
            {second && (
              <motion.div
                key={second.profileId + "-bg"}
                className="absolute inset-0 rounded-3xl"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  backdropFilter: "blur(20px)",
                  WebkitBackdropFilter: "blur(20px)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  transform: "scale(0.94) translateY(12px)",
                }}
              />
            )}

            {/* Top card */}
            <SwipeCard key={top.profileId} match={top} onSwipe={handleSwipe} />
          </AnimatePresence>
        )}
      </div>

      {/* Swipe hint */}
      {stack.length > 0 && (
        <p className="text-xs text-white/30 tracking-wide">
          ← Drag to pass &nbsp;·&nbsp; Drag to connect →
        </p>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="w-full">
          <p className="text-[10px] uppercase tracking-widest text-white/30 mb-2">Swipe history</p>
          <div className="flex flex-wrap gap-2">
            {history.map(({ direction, match }, i) => (
              <span
                key={i}
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  direction === "right"
                    ? "bg-green-500/20 text-green-300"
                    : "bg-red-500/20 text-red-300"
                }`}
              >
                {direction === "right" ? "✓" : "✗"} {match.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onRestart }: { onRestart: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="absolute inset-0 flex flex-col items-center justify-center rounded-3xl gap-4 text-center px-6"
      style={{
        background: "rgba(255,255,255,0.06)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        border: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <span className="text-4xl">🎉</span>
      <p className="text-white font-semibold text-lg">You've seen everyone!</p>
      <p className="text-white/40 text-sm">HiveMind is scanning for new matches…</p>
      <button
        onClick={onRestart}
        className="mt-2 px-5 py-2 rounded-full text-sm font-semibold text-white"
        style={{
          background: "linear-gradient(135deg, #6366f1, #a855f7, #ec4899)",
        }}
      >
        Restart Observer Feed
      </button>
    </motion.div>
  );
}
