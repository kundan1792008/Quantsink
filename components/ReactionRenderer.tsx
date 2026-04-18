"use client";

import {
  useEffect,
  useRef,
  useCallback,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import { motion, AnimatePresence } from "framer-motion";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReactionType = "emoji" | "super" | "combo";

export interface IncomingReaction {
  id: string;
  emoji: string;
  type: ReactionType;
  /** Normalised [0,1] x-origin (relative to video width). Defaults to random. */
  originX?: number;
}

export interface ReactionBatch {
  broadcastId: string;
  reactions: IncomingReaction[];
  aggregates: Record<string, number>;
  timestamp: number;
}

export interface ReactionRendererProps {
  /** Whether the renderer is visible / a broadcast is live */
  active?: boolean;
  /** Width of the host element in px (used for heat-map overlay) */
  containerWidth?: number;
  /** Height of the host element in px */
  containerHeight?: number;
  /** Show the emoji heat-map overlay */
  showHeatMap?: boolean;
  className?: string;
}

export interface ReactionRendererHandle {
  /** Inject reactions from an external source (e.g. WebSocket message) */
  injectBatch(batch: ReactionBatch): void;
  /** Clear all active particles */
  clear(): void;
}

// ─── Particle physics constants ───────────────────────────────────────────────

const PARTICLE_LIFETIME_MS = 3_000;
const STORM_THRESHOLD = 100; // reactions per second that trigger storm mode
const STORM_DURATION_MS = 4_000;
const SUPER_SCALE = 1.9;
const COMBO_SCALE = 2.5;
const BASE_FONT_SIZE = 26;
const DRIFT_RANGE = 60; // ±px horizontal drift over particle lifetime
const RISE_SPEED = 180; // px/sec baseline vertical rise
const HEAT_CELL_SIZE = 64; // px per heat-map grid cell

interface Particle {
  id: string;
  emoji: string;
  type: ReactionType;
  x: number; // spawn x in canvas coords
  y: number; // spawn y in canvas coords
  driftX: number; // total horizontal drift over lifetime
  alpha: number; // current opacity [0,1]
  scale: number;
  spawnedAt: number;
}

// ─── Heat-map grid ────────────────────────────────────────────────────────────

function buildHeatGrid(
  reactions: IncomingReaction[],
  width: number,
  height: number,
): number[][] {
  const cols = Math.ceil(width / HEAT_CELL_SIZE);
  const rows = Math.ceil(height / HEAT_CELL_SIZE);
  const grid: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (const r of reactions) {
    const ox = r.originX ?? Math.random();
    const col = Math.floor(ox * (cols - 1));
    const row = Math.floor(Math.random() * rows); // vertical origin is random
    if (grid[row] && grid[row][col] !== undefined) {
      grid[row][col] += 1;
    }
  }
  return grid;
}

// ─── Storm overlay ────────────────────────────────────────────────────────────

function StormOverlay({ active }: { active: boolean }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="storm"
          className="pointer-events-none absolute inset-0 z-20"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Vignette pulse */}
          <motion.div
            className="absolute inset-0 rounded-sm"
            animate={{
              boxShadow: [
                "inset 0 0 60px rgba(255,140,0,0.0)",
                "inset 0 0 120px rgba(255,140,0,0.45)",
                "inset 0 0 60px rgba(255,140,0,0.0)",
              ],
            }}
            transition={{ duration: 0.5, repeat: Infinity, ease: "easeInOut" }}
          />
          {/* STORM banner */}
          <motion.div
            className="absolute left-1/2 top-6 -translate-x-1/2 z-30"
            initial={{ y: -40, opacity: 0, scale: 0.6 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -40, opacity: 0, scale: 0.6 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
          >
            <span
              className="px-4 py-1.5 rounded-sm text-xs font-bold tracking-[0.22em] uppercase"
              style={{
                background: "linear-gradient(90deg,#FF6B00,#FF0080)",
                color: "#fff",
                textShadow: "0 1px 8px rgba(0,0,0,0.5)",
                boxShadow: "0 4px 24px rgba(255,80,0,0.5)",
              }}
            >
              ⚡ Reaction Storm
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Heat-map overlay ─────────────────────────────────────────────────────────

function HeatMapOverlay({
  grid,
  width,
  height,
}: {
  grid: number[][];
  width: number;
  height: number;
}) {
  if (!grid.length || !grid[0].length) return null;

  const maxVal = Math.max(1, ...grid.flatMap((row) => row));

  return (
    <div className="pointer-events-none absolute inset-0 z-10" style={{ width, height }}>
      {grid.map((row, ri) =>
        row.map((val, ci) => {
          const opacity = (val / maxVal) * 0.55;
          if (opacity < 0.04) return null;
          return (
            <div
              key={`${ri}-${ci}`}
              className="absolute rounded-sm"
              style={{
                left: ci * HEAT_CELL_SIZE,
                top: ri * HEAT_CELL_SIZE,
                width: HEAT_CELL_SIZE,
                height: HEAT_CELL_SIZE,
                background: `rgba(255,80,0,${opacity.toFixed(3)})`,
              }}
            />
          );
        }),
      )}
    </div>
  );
}

// ─── ReactionRenderer ─────────────────────────────────────────────────────────

/**
 * ReactionRenderer — Canvas-based particle system for live broadcast reactions.
 *
 * Particles float upward with a gentle sine-wave drift, scale up for super /
 * combo reaction types, and fade out after PARTICLE_LIFETIME_MS.
 *
 * When > STORM_THRESHOLD reactions arrive within one second the component
 * enters "Reaction Storm" mode: the canvas shakes and a banner is displayed.
 *
 * Use the imperative handle (`ref.injectBatch(batch)`) to push reactions from
 * a WebSocket handler into the renderer without prop drilling.
 */
const ReactionRenderer = forwardRef<ReactionRendererHandle, ReactionRendererProps>(
  function ReactionRenderer(
    {
      active = true,
      containerWidth = 640,
      containerHeight = 360,
      showHeatMap = false,
      className = "",
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const particlesRef = useRef<Particle[]>([]);
    const rafRef = useRef<number>(0);
    const stormTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const recentCountRef = useRef<number>(0);
    const recentWindowRef = useRef<number>(Date.now());
    const [stormActive, setStormActive] = useState(false);
    const [heatGrid, setHeatGrid] = useState<number[][]>([]);
    const [allReactions, setAllReactions] = useState<IncomingReaction[]>([]);

    // Shake animation values for canvas
    const [shakeDelta, setShakeDelta] = useState({ x: 0, y: 0 });

    // ── Helpers ──────────────────────────────────────────────────────────────

    const triggerStorm = useCallback(() => {
      setStormActive(true);
      // Shake the canvas
      let ticks = 0;
      const shake = setInterval(() => {
        if (ticks >= 12) {
          clearInterval(shake);
          setShakeDelta({ x: 0, y: 0 });
          return;
        }
        setShakeDelta({
          x: (Math.random() - 0.5) * 10,
          y: (Math.random() - 0.5) * 10,
        });
        ticks++;
      }, 60);

      if (stormTimerRef.current) clearTimeout(stormTimerRef.current);
      stormTimerRef.current = setTimeout(() => {
        setStormActive(false);
      }, STORM_DURATION_MS);
    }, []);

    const spawnParticles = useCallback(
      (reactions: IncomingReaction[]) => {
        const now = Date.now();
        const canvas = canvasRef.current;
        if (!canvas) return;

        for (const r of reactions) {
          const ox = r.originX ?? Math.random();
          const scale =
            r.type === "super"
              ? SUPER_SCALE
              : r.type === "combo"
                ? COMBO_SCALE
                : 1;

          particlesRef.current.push({
            id: r.id,
            emoji: r.emoji,
            type: r.type,
            x: ox * canvas.width,
            y: canvas.height - 20,
            driftX: (Math.random() - 0.5) * DRIFT_RANGE * 2,
            alpha: 1,
            scale,
            spawnedAt: now,
          });
        }

        // Storm detection
        const windowMs = 1_000;
        if (now - recentWindowRef.current > windowMs) {
          recentWindowRef.current = now;
          recentCountRef.current = reactions.length;
        } else {
          recentCountRef.current += reactions.length;
        }

        if (recentCountRef.current >= STORM_THRESHOLD && !stormActive) {
          triggerStorm();
        }
      },
      [stormActive, triggerStorm],
    );

    // ── Imperative handle ────────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        injectBatch(batch: ReactionBatch) {
          spawnParticles(batch.reactions);
          if (showHeatMap) {
            setAllReactions((prev) => [...prev, ...batch.reactions]);
            setHeatGrid(
              buildHeatGrid(
                [...allReactions, ...batch.reactions],
                containerWidth,
                containerHeight,
              ),
            );
          }
        },
        clear() {
          particlesRef.current = [];
          setAllReactions([]);
          setHeatGrid([]);
        },
      }),
      [spawnParticles, showHeatMap, allReactions, containerWidth, containerHeight],
    );

    // ── Canvas render loop ───────────────────────────────────────────────────

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      let lastTs = performance.now();

      const frame = (ts: number) => {
        const dt = Math.min((ts - lastTs) / 1_000, 0.1); // seconds, cap at 100ms
        lastTs = ts;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const alive: Particle[] = [];
        const now = Date.now();

        for (const p of particlesRef.current) {
          const age = (now - p.spawnedAt) / PARTICLE_LIFETIME_MS;
          if (age >= 1) continue; // expired

          // Ease-out alpha: full opacity for first 70%, then fade
          p.alpha = age < 0.7 ? 1 : 1 - (age - 0.7) / 0.3;

          // Vertical rise
          p.y -= RISE_SPEED * dt;

          // Horizontal sine drift
          const progress = age;
          p.x += Math.sin(progress * Math.PI * 2.5) * p.driftX * dt * 1.2;

          const fontSize = BASE_FONT_SIZE * p.scale;
          ctx.save();
          ctx.globalAlpha = Math.max(0, p.alpha);
          ctx.font = `${fontSize}px serif`;
          ctx.textBaseline = "middle";
          ctx.textAlign = "center";

          if (p.type === "combo") {
            // Glow effect for combo reactions
            ctx.shadowColor = "rgba(255,220,50,0.9)";
            ctx.shadowBlur = 18;
          } else if (p.type === "super") {
            ctx.shadowColor = "rgba(120,80,255,0.9)";
            ctx.shadowBlur = 14;
          }

          ctx.fillText(p.emoji, p.x, p.y);
          ctx.restore();
          alive.push(p);
        }

        particlesRef.current = alive;
        rafRef.current = requestAnimationFrame(frame);
      };

      if (active) {
        rafRef.current = requestAnimationFrame(frame);
      }

      return () => {
        cancelAnimationFrame(rafRef.current);
      };
    }, [active]);

    // ── Cleanup ──────────────────────────────────────────────────────────────

    useEffect(() => {
      return () => {
        if (stormTimerRef.current) clearTimeout(stormTimerRef.current);
        cancelAnimationFrame(rafRef.current);
      };
    }, []);

    return (
      <div
        className={`pointer-events-none relative overflow-hidden ${className}`}
        style={{ width: containerWidth, height: containerHeight }}
      >
        {/* Heat-map layer */}
        {showHeatMap && (
          <HeatMapOverlay
            grid={heatGrid}
            width={containerWidth}
            height={containerHeight}
          />
        )}

        {/* Particle canvas */}
        <canvas
          ref={canvasRef}
          width={containerWidth}
          height={containerHeight}
          className="absolute inset-0"
          style={{
            transform: `translate(${shakeDelta.x}px,${shakeDelta.y}px)`,
            transition: "transform 0.05s linear",
          }}
        />

        {/* Storm overlay */}
        <StormOverlay active={stormActive} />
      </div>
    );
  },
);

ReactionRenderer.displayName = "ReactionRenderer";

export default ReactionRenderer;

// ─── Demo helper ─────────────────────────────────────────────────────────────

/**
 * useReactionWebSocket — lightweight hook that connects to the Quantsink
 * reaction WebSocket endpoint and forwards batches to a ReactionRenderer ref.
 *
 * Usage:
 *   const rendererRef = useRef<ReactionRendererHandle>(null);
 *   useReactionWebSocket({ broadcastId: 'abc', userId: 'me', rendererRef });
 */
export function useReactionWebSocket(params: {
  broadcastId: string;
  userId: string;
  rendererRef: React.RefObject<ReactionRendererHandle | null>;
  enabled?: boolean;
}): { isConnected: boolean; sendReaction: (emoji: string, isSuper?: boolean) => void } {
  const { broadcastId, userId, rendererRef, enabled = true } = params;
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);

  const connect = useCallback(() => {
    if (typeof window === "undefined" || !enabled) return;

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host =
      process.env.NEXT_PUBLIC_WS_HOST ?? `${window.location.hostname}:3001`;
    const url = `${proto}://${host}/reactions?broadcastId=${encodeURIComponent(
      broadcastId,
    )}&userId=${encodeURIComponent(userId)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      attemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          data: ReactionBatch;
        };
        if (msg.type === "REACTION_BATCH" && rendererRef.current) {
          rendererRef.current.injectBatch(msg.data);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (!enabled) return;
      const backoff = Math.min(1_000 * 2 ** attemptsRef.current, 30_000);
      attemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, backoff);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [broadcastId, userId, rendererRef, enabled]);

  useEffect(() => {
    if (enabled) connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect, enabled]);

  const sendReaction = useCallback(
    (emoji: string, isSuper = false) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "REACT", emoji, isSuper }));
      }
    },
    [],
  );

  return { isConnected, sendReaction };
}
