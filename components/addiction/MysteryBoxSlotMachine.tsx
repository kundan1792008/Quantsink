"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  RewardEngine,
  type MysteryBoxResult,
  type RewardDefinition,
  DEFAULT_REWARD_TABLE,
} from "@/lib/rewardEngineClient";

interface MysteryBoxSlotMachineProps {
  /** How many simulated broadcast views per auto-tick. Default 1. */
  readonly viewsPerTick?: number;
  /** Auto-tick cadence in ms. Default 4500. Set to 0 to disable auto-ticking. */
  readonly tickIntervalMs?: number;
  /** Called whenever a new mystery-box result is drawn. */
  readonly onDraw?: (result: MysteryBoxResult) => void;
  /** Called whenever the engine's view counter changes. */
  readonly onViewChange?: (views: number) => void;
}

const rarityPalette: Record<
  RewardDefinition["rarity"],
  { ring: string; glow: string; chip: string; label: string }
> = {
  COMMON: {
    ring: "#6B7280",
    glow: "rgba(201,169,110,0.12)",
    chip: "rgba(201,169,110,0.25)",
    label: "#C9A96E",
  },
  RARE: {
    ring: "#7A9FC9",
    glow: "rgba(122,159,201,0.35)",
    chip: "rgba(122,159,201,0.2)",
    label: "#7A9FC9",
  },
  LEGENDARY: {
    ring: "#C9A96E",
    glow: "rgba(201,169,110,0.6)",
    chip: "rgba(201,169,110,0.3)",
    label: "#F4D58D",
  },
};

/**
 * SpinReel renders three glyph columns that settle on the final reward
 * after a short spin animation. The animation is purely cosmetic — the
 * RewardEngine has already decided the rarity.
 */
function SpinReel({
  reward,
  spinId,
}: {
  reward: RewardDefinition;
  spinId: string;
}) {
  const filler = useMemo(
    () => DEFAULT_REWARD_TABLE.map((r) => r.glyph),
    [],
  );
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((col) => (
        <div
          key={`${spinId}-${col}`}
          className="relative w-10 h-12 overflow-hidden rounded-sm"
          style={{ backgroundColor: "#0B0B0B", border: "1px solid #1E1E1E" }}
        >
          <motion.div
            initial={{ y: -48 * filler.length }}
            animate={{ y: 0 }}
            transition={{
              duration: 0.55 + col * 0.18,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="flex flex-col items-center"
          >
            {filler.map((g, i) => (
              <span
                key={`${col}-${i}`}
                className="h-12 w-10 flex items-center justify-center text-[22px]"
              >
                {g}
              </span>
            ))}
            <span className="h-12 w-10 flex items-center justify-center text-[22px]">
              {reward.glyph}
            </span>
          </motion.div>
        </div>
      ))}
    </div>
  );
}

function CrownAura() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0 rounded-sm"
      style={{
        boxShadow:
          "0 0 0 1px rgba(201,169,110,0.4), 0 0 48px 4px rgba(201,169,110,0.35)",
      }}
      aria-hidden
    />
  );
}

export default function MysteryBoxSlotMachine({
  viewsPerTick = 1,
  tickIntervalMs = 4_500,
  onDraw,
  onViewChange,
}: MysteryBoxSlotMachineProps) {
  const engineRef = useRef<RewardEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new RewardEngine();
  }
  const engine = engineRef.current;

  const [views, setViews] = useState(0);
  const [lastDraw, setLastDraw] = useState<MysteryBoxResult | null>(null);
  const [totalPoints, setTotalPoints] = useState(0);
  const [drawHistory, setDrawHistory] = useState<readonly MysteryBoxResult[]>([]);
  const [spinning, setSpinning] = useState(false);

  const handleTick = () => {
    if (!engine) return;
    for (let i = 0; i < viewsPerTick; i += 1) {
      const { draw } = engine.recordView();
      if (draw) {
        setSpinning(true);
        setLastDraw(draw);
        setDrawHistory((h) => [draw, ...h].slice(0, 8));
        setTotalPoints(engine.getStatusPoints());
        onDraw?.(draw);
        window.setTimeout(() => setSpinning(false), 900);
      }
    }
    setViews(engine.getViews());
    onViewChange?.(engine.getViews());
  };

  useEffect(() => {
    if (tickIntervalMs <= 0) return undefined;
    const id = window.setInterval(handleTick, tickIntervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickIntervalMs, viewsPerTick]);

  const manualSpin = () => {
    if (!engine) return;
    const draw = engine.drawMysteryBox();
    setSpinning(true);
    setLastDraw(draw);
    setDrawHistory((h) => [draw, ...h].slice(0, 8));
    setTotalPoints(engine.getStatusPoints());
    onDraw?.(draw);
    window.setTimeout(() => setSpinning(false), 900);
  };

  const rarity = lastDraw?.rarity ?? "COMMON";
  const palette = rarityPalette[rarity];

  return (
    <section
      className="relative rounded-sm border overflow-hidden"
      style={{ backgroundColor: "#111111", borderColor: "#1E1E1E" }}
      aria-label="Mystery Box Slot Machine"
    >
      <AnimatePresence>
        {lastDraw?.rarity === "LEGENDARY" && spinning && <CrownAura />}
      </AnimatePresence>

      <header className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "#1E1E1E" }}>
        <div className="flex items-center gap-3">
          <span
            className="text-[10px] tracking-[0.22em] uppercase font-semibold"
            style={{ color: palette.label }}
          >
            Mystery Box
          </span>
          <span className="text-[9px] tracking-widest text-brand-subtext uppercase">
            Every 4th view
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[9px] tracking-widest text-brand-subtext uppercase">
            Views
          </span>
          <motion.span
            key={views}
            initial={{ scale: 1.15, color: "#C9A96E" }}
            animate={{ scale: 1, color: "#E8E6E1" }}
            transition={{ duration: 0.22 }}
            className="text-[12px] font-mono tabular-nums"
          >
            {views.toLocaleString()}
          </motion.span>
        </div>
      </header>

      <div className="grid grid-cols-[auto_1fr] gap-6 p-5 items-center">
        <div className="relative">
          <SpinReel
            reward={lastDraw?.reward ?? DEFAULT_REWARD_TABLE[0]}
            spinId={lastDraw?.id ?? "initial"}
          />
        </div>

        <div className="flex flex-col gap-2">
          <AnimatePresence mode="wait">
            {lastDraw ? (
              <motion.div
                key={lastDraw.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.28 }}
                className="flex flex-col gap-1"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-[9px] tracking-[0.22em] font-bold uppercase px-2 py-0.5 rounded-sm"
                    style={{
                      color: palette.label,
                      backgroundColor: palette.chip,
                      border: `1px solid ${palette.ring}55`,
                    }}
                  >
                    {lastDraw.rarity}
                  </span>
                  <span className="text-[11px] font-semibold tracking-wide text-brand-text">
                    {lastDraw.reward.label}
                  </span>
                </div>
                <span className="text-[11px] text-brand-subtext">
                  +{lastDraw.statusPoints} status points on view #
                  {lastDraw.triggeredByView}
                </span>
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[11px] text-brand-subtext"
              >
                Waiting for the first mystery draw…
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center gap-3 mt-2">
            <button
              type="button"
              onClick={manualSpin}
              className="text-[10px] tracking-widest uppercase font-semibold px-3 py-1.5 rounded-sm border transition-colors"
              style={{
                borderColor: palette.ring,
                color: palette.label,
                backgroundColor: palette.chip,
              }}
            >
              Free Spin
            </button>
            <span className="text-[10px] text-brand-subtext tracking-wide uppercase">
              Total: {totalPoints.toLocaleString()} pts
            </span>
          </div>
        </div>
      </div>

      <footer className="px-5 pb-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          {drawHistory.map((d) => {
            const p = rarityPalette[d.rarity];
            return (
              <motion.span
                key={d.id}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="w-6 h-6 flex items-center justify-center rounded-sm text-[14px]"
                style={{ backgroundColor: p.chip, border: `1px solid ${p.ring}55` }}
                title={`${d.rarity} — ${d.reward.label}`}
              >
                {d.reward.glyph}
              </motion.span>
            );
          })}
          {drawHistory.length === 0 && (
            <span className="text-[9px] tracking-widest uppercase text-brand-muted">
              Pull history appears here
            </span>
          )}
        </div>
      </footer>
    </section>
  );
}
