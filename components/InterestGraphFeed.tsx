"use client";

import { useState, useRef, useCallback } from "react";
import {
  motion,
  AnimatePresence,
  useScroll,
  useVelocity,
  useMotionValueEvent,
} from "framer-motion";

interface FeedNode {
  id: string;
  category: string;
  headline: string;
  description: string;
  timestamp: string;
  engagementScore: number;
  relevanceScore: number;
  tags: string[];
}

const FEED_NODES: FeedNode[] = [
  {
    id: "1",
    category: "QUANTITATIVE",
    headline: "Adaptive Alpha Decay in High-Frequency Regime Shifts",
    description:
      "Signal half-life compression observed during cross-asset vol spikes. Mean-reversion strategies require dynamic lookback recalibration to preserve edge.",
    timestamp: "2m ago",
    engagementScore: 9841,
    relevanceScore: 97,
    tags: ["HFT", "Alpha Decay", "Regime Detection"],
  },
  {
    id: "2",
    category: "MARKET MICROSTRUCTURE",
    headline: "Order Flow Toxicity Metrics Across Dark Pool Venues",
    description:
      "VPIN divergence between lit and dark venues signals informed trader migration. Adverse selection costs spiking on mid-cap names post-close auction.",
    timestamp: "11m ago",
    engagementScore: 7203,
    relevanceScore: 91,
    tags: ["VPIN", "Dark Pools", "Adverse Selection"],
  },
  {
    id: "3",
    category: "SIGNAL PROCESSING",
    headline: "Kalman Filter Ensemble for Non-Stationary Spread Dynamics",
    description:
      "Adaptive noise covariance estimation outperforms static Kalman gains when spread volatility exhibits GARCH clustering. Real-time coefficient updates critical.",
    timestamp: "28m ago",
    engagementScore: 5617,
    relevanceScore: 88,
    tags: ["Kalman Filter", "Spread Trading", "GARCH"],
  },
  {
    id: "4",
    category: "BROADCAST ENGINEERING",
    headline: "Sub-Microsecond Timestamping via PTP Grandmaster Redundancy",
    description:
      "Dual-path IEEE 1588v2 synchronization eliminates single point of failure for co-located matching engine feeds. Boundary clock accuracy maintained at ±50ns.",
    timestamp: "1h ago",
    engagementScore: 4389,
    relevanceScore: 83,
    tags: ["PTP", "Latency", "Co-location"],
  },
  {
    id: "5",
    category: "DATA STREAMS",
    headline: "Real-Time L3 Order Book Reconstruction from Fragmented FIX Logs",
    description:
      "Gap-fill heuristics using sequence number interpolation enable near-lossless book rebuild during network partition events. Tested on 14TB historical replay.",
    timestamp: "2h ago",
    engagementScore: 3812,
    relevanceScore: 79,
    tags: ["FIX Protocol", "Order Book", "Data Recovery"],
  },
  {
    id: "6",
    category: "QUANTITATIVE FINANCE",
    headline: "Volatility Surface Arbitrage via Rough Heston Calibration",
    description:
      "Fractional Brownian motion parameterisation (H≈0.1) captures short-term vol smile dynamics inaccessible to classical Heston. Calibration runtime under 80ms.",
    timestamp: "3h ago",
    engagementScore: 6024,
    relevanceScore: 94,
    tags: ["Vol Surface", "Rough Heston", "Options"],
  },
  {
    id: "7",
    category: "ALGORITHMIC TRADING",
    headline: "Reinforcement Learning for Optimal Execution Beyond TWAP/VWAP",
    description:
      "Deep Q-Network agent trained on 5-year intraday data reduces implementation shortfall by 18bps on average versus linear schedules. Slippage-aware reward shaping key.",
    timestamp: "5h ago",
    engagementScore: 8156,
    relevanceScore: 96,
    tags: ["RL", "Optimal Execution", "Market Impact"],
  },
  {
    id: "8",
    category: "BROADCAST",
    headline: "FPGA-Accelerated Multicast Feed Normalisation at Line Rate",
    description:
      "10GbE zero-copy DMA pipeline processes 12M messages/sec with deterministic 180ns latency floor. PCIe Gen4 bandwidth headroom enables dual-venue simultaneous ingestion.",
    timestamp: "8h ago",
    engagementScore: 2974,
    relevanceScore: 75,
    tags: ["FPGA", "Multicast", "Feed Handler"],
  },
];

const categoryColors: Record<string, string> = {
  QUANTITATIVE: "#C9A96E",
  "MARKET MICROSTRUCTURE": "#7A9FC9",
  "SIGNAL PROCESSING": "#9EC97A",
  "BROADCAST ENGINEERING": "#C97A9E",
  "DATA STREAMS": "#9A7AC9",
  "QUANTITATIVE FINANCE": "#C9A96E",
  "ALGORITHMIC TRADING": "#C9C47A",
  BROADCAST: "#7AC9C4",
};

function RelevanceRing({ score }: { score: number }) {
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative flex-shrink-0 w-9 h-9 flex items-center justify-center">
      <svg width="36" height="36" className="absolute inset-0 -rotate-90">
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          stroke="#1E1E1E"
          strokeWidth="2"
        />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          stroke="#C9A96E"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[9px] font-mono font-semibold text-brand-accent z-10">
        {score}
      </span>
    </div>
  );
}

function FeedCard({
  node,
  index,
  readingMode,
}: {
  node: FeedNode;
  index: number;
  readingMode: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const showActions = hovered || readingMode;
  const accentColor = categoryColors[node.category] ?? "#C9A96E";

  return (
    <motion.article
      initial={{ opacity: 0, y: 28 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: index * 0.07, ease: [0.22, 1, 0.36, 1] }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      className="relative rounded-sm border transition-colors duration-300 cursor-default"
      style={{
        backgroundColor: "#111111",
        borderColor: hovered ? "#C9A96E" : "#1E1E1E",
        boxShadow: hovered
          ? "0 0 0 1px rgba(201,169,110,0.12), 0 8px 32px rgba(0,0,0,0.5)"
          : "0 2px 12px rgba(0,0,0,0.3)",
      }}
    >
      {/* Top section */}
      <div className="p-5 pb-3">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Category pill */}
            <span
              className="text-[9px] font-bold tracking-[0.18em] px-2 py-0.5 rounded-sm uppercase"
              style={{
                color: accentColor,
                backgroundColor: `${accentColor}18`,
                border: `1px solid ${accentColor}30`,
              }}
            >
              {node.category}
            </span>
            <span className="text-[10px] text-brand-subtext font-mono">
              {node.timestamp}
            </span>
          </div>
          <RelevanceRing score={node.relevanceScore} />
        </div>

        <h2 className="text-[15px] font-semibold leading-snug text-brand-text mb-2 tracking-tight">
          {node.headline}
        </h2>
        <p className="text-[12px] leading-relaxed text-brand-subtext line-clamp-2">
          {node.description}
        </p>
      </div>

      {/* Tags + engagement row */}
      <div className="px-5 pb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {node.tags.map((tag) => (
            <span
              key={tag}
              className="text-[9px] tracking-wide text-brand-muted border border-brand-border px-1.5 py-0.5 rounded-sm uppercase font-medium"
              style={{ color: "#5A5A5A" }}
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-50">
            <path d="M5 1l1.2 2.5L9 3.8 6.9 5.8l.5 2.7L5 7.2 2.6 8.5l.5-2.7L1 3.8l2.8-.3z" fill="#C9A96E"/>
          </svg>
          <span className="text-[10px] font-mono text-brand-subtext tabular-nums">
            {node.engagementScore.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Action tray – revealed on hover or reading mode */}
      <AnimatePresence>
        {showActions && (
          <motion.div
            key="actions"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div
              className="px-5 py-3 flex items-center gap-1 border-t"
              style={{ borderColor: "#1E1E1E" }}
            >
              {[
                {
                  label: "Resonate",
                  icon: (
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                  ),
                  viewBox: "0 0 24 24",
                },
                {
                  label: "Relay",
                  icon: (
                    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z" />
                  ),
                  viewBox: "0 0 24 24",
                },
                {
                  label: "Archive",
                  icon: (
                    <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
                  ),
                  viewBox: "0 0 24 24",
                },
                {
                  label: "Expand",
                  icon: (
                    <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  ),
                  viewBox: "0 0 24 24",
                  stroke: true,
                },
              ].map((action) => (
                <button
                  key={action.label}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[10px] tracking-wide font-medium text-brand-subtext hover:text-brand-accent transition-colors duration-150 hover:bg-brand-border/30 uppercase"
                  aria-label={action.label}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox={action.viewBox}
                    fill={action.stroke ? "none" : "currentColor"}
                    stroke={action.stroke ? "currentColor" : "none"}
                  >
                    {action.icon}
                  </svg>
                  {action.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

export default function InterestGraphFeed() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollY } = useScroll();
  const scrollVelocity = useVelocity(scrollY);
  const [readingMode, setReadingMode] = useState(true);

  const VELOCITY_THRESHOLD = 180;

  useMotionValueEvent(scrollVelocity, "change", useCallback((v: number) => {
    setReadingMode(Math.abs(v) < VELOCITY_THRESHOLD);
  }, []));

  return (
    <div ref={containerRef} className="max-w-2xl mx-auto px-4 py-10">
      {/* Feed header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-[10px] tracking-[0.25em] text-brand-subtext uppercase font-medium">
            Interest Graph
          </span>
          <div className="h-px flex-1 bg-brand-border" />
          <span
            className="text-[9px] tracking-widest px-2 py-0.5 rounded-sm uppercase font-semibold transition-colors duration-300"
            style={{
              color: readingMode ? "#9EC97A" : "#7A7A7A",
              backgroundColor: readingMode ? "rgba(158,201,122,0.08)" : "transparent",
              border: `1px solid ${readingMode ? "rgba(158,201,122,0.2)" : "#1E1E1E"}`,
            }}
          >
            {readingMode ? "Reading Mode" : "Scanning"}
          </span>
        </div>
        <p className="text-[11px] text-brand-subtext">
          Actions surface when you dwell. Scroll fast to scan. Hover to engage.
        </p>
      </div>

      {/* Feed nodes */}
      <div className="flex flex-col gap-3">
        {FEED_NODES.map((node, i) => (
          <FeedCard
            key={node.id}
            node={node}
            index={i}
            readingMode={readingMode}
          />
        ))}
      </div>

      {/* Footer sentinel */}
      <div className="mt-12 flex items-center gap-3">
        <div className="h-px flex-1 bg-brand-border" />
        <span className="text-[9px] tracking-[0.2em] text-brand-muted uppercase">
          End of Signal
        </span>
        <div className="h-px flex-1 bg-brand-border" />
      </div>
    </div>
  );
}
