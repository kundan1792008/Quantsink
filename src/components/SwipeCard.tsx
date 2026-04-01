"use client";

import React, { useState } from "react";
import { motion, useMotionValue, useTransform, AnimatePresence } from "framer-motion";
import { MatchScore } from "@/lib/HiveMindAlgorithm";
import HeatMap from "./HeatMap";

interface SwipeCardProps {
  match: MatchScore;
  onSwipe: (direction: "left" | "right", id: string) => void;
}

/** Cubic bezier that creates a "hold then snap" feel */
const ANTICIPATION_EASE: [number, number, number, number] = [0.22, 1.4, 0.36, 1];

export default function SwipeCard({ match, onSwipe }: SwipeCardProps) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-220, 0, 220], [-18, 0, 18]);
  const opacity = useTransform(x, [-200, -60, 0, 60, 200], [0, 1, 1, 1, 0]);
  const likeOpacity = useTransform(x, [30, 120], [0, 1]);
  const nopeOpacity = useTransform(x, [-120, -30], [1, 0]);

  const scorePercent = Math.round(match.score * 100);
  const scoreColor =
    match.score >= 0.7 ? "#4ade80" : match.score >= 0.45 ? "#facc15" : "#f87171";

  function handleDragEnd(_: unknown, info: { offset: { x: number } }) {
    if (info.offset.x > 120) {
      onSwipe("right", match.profileId);
    } else if (info.offset.x < -120) {
      onSwipe("left", match.profileId);
    }
  }

  return (
    <motion.div
      className="absolute inset-0 cursor-grab active:cursor-grabbing select-none"
      style={{ x, rotate, opacity }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.15}
      onDragEnd={handleDragEnd}
      whileTap={{ scale: 0.97 }}
    >
      {/* Glassmorphism card */}
      <div
        className="relative w-full h-full rounded-3xl overflow-hidden"
        style={{
          background: "rgba(255,255,255,0.08)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
          border: "1px solid rgba(255,255,255,0.15)",
          boxShadow: "0 8px 48px rgba(0,0,0,0.45)",
        }}
      >
        {/* Score ring */}
        <div className="absolute top-5 right-5 flex items-center justify-center w-14 h-14 rounded-full"
          style={{
            background: `conic-gradient(${scoreColor} ${scorePercent * 3.6}deg, rgba(255,255,255,0.1) 0)`,
            padding: "3px",
          }}
        >
          <div className="w-full h-full rounded-full bg-black/60 flex items-center justify-center">
            <span className="text-sm font-bold text-white">{scorePercent}%</span>
          </div>
        </div>

        {/* Name */}
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-2xl font-bold text-white tracking-tight">{match.name}</h3>
          <p className="text-xs text-white/50 mt-0.5 uppercase tracking-widest">HiveMind Match</p>
        </div>

        {/* Heat map */}
        <div className="px-4 pb-2">
          <HeatMap heatValues={match.heatValues} score={match.score} />
        </div>

        {/* Anticipation bar — pulses before user can swipe */}
        <AnticipationBar score={match.score} />

        {/* LIKE / NOPE stamps */}
        <motion.div
          className="absolute top-8 left-6 border-2 border-green-400 text-green-400 text-lg font-extrabold uppercase px-3 py-1 rounded-lg -rotate-12"
          style={{ opacity: likeOpacity }}
        >
          Like
        </motion.div>
        <motion.div
          className="absolute top-8 right-16 border-2 border-red-400 text-red-400 text-lg font-extrabold uppercase px-3 py-1 rounded-lg rotate-12"
          style={{ opacity: nopeOpacity }}
        >
          Nope
        </motion.div>
      </div>
    </motion.div>
  );
}

/** Animated progress bar that "loads" before the swipe is enabled */
function AnticipationBar({ score }: { score: number }) {
  return (
    <div className="px-6 pb-5">
      <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1.5">
        Compatibility Loading…
      </p>
      <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{
            background: `linear-gradient(90deg, #6366f1, #a855f7, #ec4899)`,
          }}
          initial={{ width: "0%" }}
          animate={{ width: `${score * 100}%` }}
          transition={{ duration: 1.8, ease: ANTICIPATION_EASE, delay: 0.3 }}
        />
      </div>
    </div>
  );
}
