"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  memo,
} from "react";
import {
  motion,
  AnimatePresence,
  useScroll,
  useVelocity,
  useMotionValueEvent,
} from "framer-motion";
import { useWebSocketFeed } from "@/hooks/useWebSocketFeed";
import { CadenceTracker } from "@/src/services/CadenceTracker";
import { AudioSynth, createBrowserAudioContext } from "@/src/services/AudioSynth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VELOCITY_THRESHOLD = 180;

/** Estimated rendered height per card in pixels (used for virtual windowing). */
const CARD_HEIGHT_EST = 148;

/** Number of cards to render above/below the visible window. */
const OVERSCAN = 4;

// ---------------------------------------------------------------------------
// Seed data — 10,000 cards generated from a compact template list.
// ---------------------------------------------------------------------------

const CATEGORY_TEMPLATES: Array<{
  category: string;
  headlines: string[];
  tags: string[][];
}> = [
  {
    category: "QUANTITATIVE",
    headlines: [
      "Adaptive Alpha Decay in High-Frequency Regime Shifts",
      "Cross-Asset Momentum Decay Under Liquidity Stress",
      "Bayesian Signal Combination for Multi-Factor Portfolios",
    ],
    tags: [["HFT", "Alpha Decay", "Regime Detection"], ["Momentum", "Liquidity"], ["Bayesian", "Multi-Factor"]],
  },
  {
    category: "MARKET MICROSTRUCTURE",
    headlines: [
      "Order Flow Toxicity Metrics Across Dark Pool Venues",
      "Limit Order Book Imbalance as a Short-Horizon Predictor",
      "Queue Priority Dynamics in Fast Markets",
    ],
    tags: [["VPIN", "Dark Pools"], ["LOB", "Imbalance"], ["Queue", "Priority"]],
  },
  {
    category: "SIGNAL PROCESSING",
    headlines: [
      "Kalman Filter Ensemble for Non-Stationary Spread Dynamics",
      "Wavelet Decomposition of Intraday Vol Cycles",
      "Empirical Mode Decomposition in Tick Data",
    ],
    tags: [["Kalman Filter", "GARCH"], ["Wavelet", "Vol"], ["EMD", "Tick"]],
  },
  {
    category: "BROADCAST ENGINEERING",
    headlines: [
      "Sub-Microsecond Timestamping via PTP Grandmaster Redundancy",
      "Kernel Bypass Networking for Ultra-Low-Latency Feeds",
      "Lock-Free Ring Buffer Design for Market Data Pipelines",
    ],
    tags: [["PTP", "Latency"], ["DPDK", "Bypass"], ["Ring Buffer", "Lock-Free"]],
  },
  {
    category: "DATA STREAMS",
    headlines: [
      "Real-Time L3 Order Book Reconstruction from Fragmented FIX Logs",
      "Streaming Aggregation of Cross-Venue Quote Data at Scale",
      "Delta Compression for Market Data Snapshot Transmission",
    ],
    tags: [["FIX Protocol", "Order Book"], ["Streaming", "Aggregation"], ["Delta", "Compression"]],
  },
  {
    category: "ALGORITHMIC TRADING",
    headlines: [
      "Reinforcement Learning for Optimal Execution Beyond TWAP/VWAP",
      "Adaptive Market Impact Models via Online Learning",
      "Deep Hedging with Recurrent Neural Networks",
    ],
    tags: [["RL", "Optimal Execution"], ["Market Impact", "Online ML"], ["Deep Hedging", "RNN"]],
  },
  {
    category: "BROADCAST",
    headlines: [
      "FPGA-Accelerated Multicast Feed Normalisation at Line Rate",
      "Hardware Timestamping with Sub-10ns Jitter on Mellanox ConnectX",
      "Tick-to-Trade Latency Benchmarking Across Co-Location Venues",
    ],
    tags: [["FPGA", "Multicast"], ["Hardware", "Timestamping"], ["Latency", "Co-Location"]],
  },
];

function makeNode(i: number): FeedNode {
  const t = CATEGORY_TEMPLATES[i % CATEGORY_TEMPLATES.length];
  const hi = i % t.headlines.length;
  const mins = i % 60 === 0 ? `${Math.floor(i / 60) + 1}h ago` : `${(i % 60) + 1}m ago`;
  return {
    id: String(i + 1),
    category: t.category,
    headline: t.headlines[hi],
    description:
      "Signal half-life compression observed during cross-asset vol spikes. Dynamic lookback recalibration required to preserve edge across regime transitions.",
    timestamp: mins,
    engagementScore: 9999 - i,
    relevanceScore: Math.max(10, 100 - (i % 90)),
    tags: t.tags[hi % t.tags.length],
  };
}

const ALL_NODES: FeedNode[] = Array.from({ length: 10_000 }, (_, i) => makeNode(i));

// ---------------------------------------------------------------------------
// Category colour map
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RelevanceRing({ score }: { score: number }) {
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative flex-shrink-0 w-9 h-9 flex items-center justify-center">
      <svg width="36" height="36" className="absolute inset-0 -rotate-90">
        <circle cx="18" cy="18" r={radius} fill="none" stroke="#1E1E1E" strokeWidth="2" />
        <circle
          cx="18" cy="18" r={radius} fill="none"
          stroke="#C9A96E" strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[9px] font-mono font-semibold text-brand-accent z-10">{score}</span>
    </div>
  );
}

const FeedCard = memo(function FeedCard({
  node,
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
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
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
            <span className="text-[10px] text-brand-subtext font-mono">{node.timestamp}</span>
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
            <path d="M5 1l1.2 2.5L9 3.8 6.9 5.8l.5 2.7L5 7.2 2.6 8.5l.5-2.7L1 3.8l2.8-.3z" fill="#C9A96E" />
          </svg>
          <span className="text-[10px] font-mono text-brand-subtext tabular-nums">
            {node.engagementScore.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Action tray — revealed on hover or reading mode */}
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
            <div className="px-5 py-3 flex items-center gap-1 border-t" style={{ borderColor: "#1E1E1E" }}>
              {[
                {
                  label: "Resonate",
                  icon: <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />,
                  viewBox: "0 0 24 24",
                },
                {
                  label: "Relay",
                  icon: <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z" />,
                  viewBox: "0 0 24 24",
                },
                {
                  label: "Archive",
                  icon: <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />,
                  viewBox: "0 0 24 24",
                },
                {
                  label: "Expand",
                  icon: <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
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
                    width="12" height="12"
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
});

// ---------------------------------------------------------------------------
// LiveBadge — shown briefly when a WebSocket push is received
// ---------------------------------------------------------------------------

function LiveBadge({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          key="live-badge"
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85 }}
          transition={{ duration: 0.2 }}
          className="text-[9px] font-bold tracking-[0.2em] uppercase px-2 py-0.5 rounded-sm border border-red-900 bg-red-950/40 text-red-400 ml-2"
        >
          NEW SIGNAL
        </motion.span>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Main feed component — virtual window rendering
// ---------------------------------------------------------------------------

export default function InterestGraphFeed() {
  const containerRef  = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const cadenceTrackerRef = useRef<CadenceTracker | null>(null);
  const audioSynthRef = useRef<AudioSynth | null>(null);

  const { scrollY } = useScroll();
  const scrollVelocity = useVelocity(scrollY);
  const [readingMode, setReadingMode] = useState(true);
  const [flowMode, setFlowMode] = useState<"ambient" | "pulse" | "off">("off");

  // Live-push state: prepend new nodes from WebSocket
  const [liveNodes, setLiveNodes]         = useState<FeedNode[]>([]);
  const [showLiveBadge, setShowLiveBadge] = useState(false);
  const liveBadgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Virtualization state
  const [scrollTop,       setScrollTop]       = useState(0);
  const [containerHeight, setContainerHeight] = useState(800);

  // Merged node list: live-pushed nodes at the top, then seed data
  const allNodes = useMemo(() => [...liveNodes, ...ALL_NODES], [liveNodes]);

  // ---- WebSocket live-push handler ----
  const handleNewPost = useCallback((post: Record<string, unknown>) => {
    const node: FeedNode = {
      id:              `live-${Date.now()}`,
      category:        String(post.category ?? "BROADCAST"),
      headline:        String(post.title ?? post.content ?? "New Broadcast"),
      description:     String(post.summary ?? post.content ?? ""),
      timestamp:       "just now",
      engagementScore: 0,
      relevanceScore:  100,
      tags:            Array.isArray(post.tags) ? (post.tags as string[]) : [],
    };
    setLiveNodes((prev) => [node, ...prev]);
    setShowLiveBadge(true);
    if (liveBadgeTimer.current) clearTimeout(liveBadgeTimer.current);
    liveBadgeTimer.current = setTimeout(() => setShowLiveBadge(false), 4000);
  }, []);

  useWebSocketFeed(handleNewPost);

  // ---- Velocity → reading-mode toggle ----
  useMotionValueEvent(scrollVelocity, "change", useCallback((v: number) => {
    const cadence = cadenceTrackerRef.current;
    if (cadence) {
      cadence.recordScrollVelocity(v);
      const state = cadence.getState();
      audioSynthRef.current?.applyCadence(state.parameters, state.mode);
      setFlowMode(state.mode);
    }
    setReadingMode(Math.abs(v) < VELOCITY_THRESHOLD);
  }, []));

  // ---- Ambient generative audio engine ----
  useEffect(() => {
    const audioContext = createBrowserAudioContext();
    if (!audioContext) {
      setFlowMode("off");
      return;
    }

    const cadence = new CadenceTracker();
    const synth = new AudioSynth({ audioContext });
    cadenceTrackerRef.current = cadence;
    audioSynthRef.current = synth;

    let activated = false;
    const activate = () => {
      if (activated) return;
      activated = true;
      synth.start();
      cadence.recordInteraction();
      const state = cadence.getState();
      synth.applyCadence(state.parameters, state.mode);
      setFlowMode(state.mode);
    };

    const pulseTimer = setInterval(() => {
      if (!activated) return;
      const state = cadence.getState();
      synth.applyCadence(state.parameters, state.mode);
      setFlowMode(state.mode);
    }, 700);

    window.addEventListener("pointerdown", activate, { passive: true });
    window.addEventListener("keydown", activate);

    return () => {
      clearInterval(pulseTimer);
      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
      synth.stop();
      cadenceTrackerRef.current = null;
      audioSynthRef.current = null;
    };
  }, []);

  // ---- Measure scroll area height ----
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- Track scroll position ----
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    let ticking = false;
    const onScroll = () => {
      cadenceTrackerRef.current?.recordInteraction();
      if (!ticking) {
        requestAnimationFrame(() => {
          setScrollTop(el.scrollTop);
          ticking = false;
        });
        ticking = true;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ---- Virtual window maths ----
  const totalHeight   = allNodes.length * CARD_HEIGHT_EST;
  const startIndex    = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT_EST) - OVERSCAN);
  const visibleCount  = Math.ceil(containerHeight / CARD_HEIGHT_EST) + OVERSCAN * 2;
  const endIndex      = Math.min(allNodes.length - 1, startIndex + visibleCount);
  const paddingTop    = startIndex * CARD_HEIGHT_EST;
  const paddingBottom = Math.max(0, (allNodes.length - endIndex - 1) * CARD_HEIGHT_EST);

  const visibleNodes = useMemo(
    () => allNodes.slice(startIndex, endIndex + 1),
    [allNodes, startIndex, endIndex],
  );

  return (
    <div
      ref={containerRef}
      className="max-w-2xl mx-auto px-4 py-10 flex flex-col"
      style={{ height: "calc(100vh - 72px)" }}
    >
      {/* Feed header */}
      <div className="mb-8 flex-shrink-0">
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
          <span
            className="text-[9px] tracking-widest px-2 py-0.5 rounded-sm uppercase font-semibold transition-colors duration-300"
            style={{
              color: flowMode === "off" ? "#7A7A7A" : flowMode === "ambient" ? "#89B6FF" : "#D8A2FF",
              backgroundColor: flowMode === "off"
                ? "transparent"
                : flowMode === "ambient"
                  ? "rgba(137,182,255,0.08)"
                  : "rgba(216,162,255,0.08)",
              border: `1px solid ${flowMode === "off" ? "#1E1E1E" : flowMode === "ambient" ? "rgba(137,182,255,0.24)" : "rgba(216,162,255,0.24)"}`,
            }}
          >
            {flowMode === "off" ? "Audio Off" : flowMode === "ambient" ? "Ambient Pad" : "Pulse Cadence"}
          </span>
          <LiveBadge visible={showLiveBadge} />
        </div>
        <p className="text-[11px] text-brand-subtext">
          Actions surface when you dwell. Scroll fast to scan. Hover to engage.{" "}
          <span className="text-brand-muted font-mono">{allNodes.length.toLocaleString()} signals</span>
        </p>
      </div>

      {/* Virtualized scroll area */}
      <div
        ref={scrollAreaRef}
        className="flex-1 overflow-y-auto"
        style={{ contain: "strict" }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <div style={{ position: "absolute", top: paddingTop, left: 0, right: 0 }}>
            <div className="flex flex-col gap-3" style={{ paddingBottom }}>
              {visibleNodes.map((node, i) => (
                <FeedCard
                  key={node.id}
                  node={node}
                  index={startIndex + i}
                  readingMode={readingMode}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
