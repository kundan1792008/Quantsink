"use client";

import React, { useMemo } from "react";
import { motion } from "framer-motion";
import { computeMatchScores, DEMO_CANDIDATES, VIEWER_PROFILE } from "@/lib/HiveMindAlgorithm";
import ObserverFeed from "@/components/ObserverFeed";

export default function Home() {
  const matches = useMemo(
    () => computeMatchScores(VIEWER_PROFILE, DEMO_CANDIDATES),
    []
  );

  return (
    <main className="relative min-h-screen overflow-hidden flex flex-col items-center justify-start py-10 px-4">
      {/* Ambient background orbs */}
      <motion.div
        className="absolute top-[-20%] left-[-15%] w-[70vw] h-[70vw] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(99,102,241,0.25) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
        animate={{ scale: [1, 1.12, 1], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-[-15%] right-[-10%] w-[55vw] h-[55vw] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(236,72,153,0.2) 0%, transparent 70%)",
          filter: "blur(50px)",
        }}
        animate={{ scale: [1, 1.08, 1], opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut", delay: 2 }}
      />

      {/* Header */}
      <motion.header
        className="relative z-10 text-center mb-8"
        initial={{ opacity: 0, y: -24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        <h1 className="text-3xl font-extrabold text-white tracking-tight">
          Quant<span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-pink-400">sink</span>
        </h1>
        <p className="text-sm text-white/40 mt-1 tracking-widest uppercase">
          Quantchill · MatchMaker · VIP
        </p>
      </motion.header>

      {/* Observer Feed */}
      <motion.div
        className="relative z-10 w-full"
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
      >
        <ObserverFeed matches={matches} />
      </motion.div>
    </main>
  );
}
