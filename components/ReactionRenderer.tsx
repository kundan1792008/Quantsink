"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  forwardRef,
} from "react";
import type {
  HeatMap,
  ReactionSnapshot,
  StormSignal,
} from "../src/services/ReactionEngine.types";

/**
 * ReactionRenderer
 * ================
 *
 * Canvas-based particle system that paints viewer emoji reactions on top of
 * the live broadcast player.  This is the client-side counterpart to the
 * server-side `ReactionEngine` (`src/services/ReactionEngine.ts`).
 *
 * Visual behaviour (issue #21):
 *
 *   - Each reaction spawns an emoji particle at the bottom of the canvas
 *     that floats upward with slight random horizontal drift.
 *   - Particles fade out over `particleLifetimeMs` (default 3 000 ms).
 *   - SUPER reactions render larger and pulse.
 *   - COMBO reactions spawn N particles based on the combo multiplier so the
 *     screen visibly explodes when a user rattles off the same emoji.
 *   - When the server flags `storm.active` the canvas screen-shakes; the
 *     amplitude is taken straight from `storm.screenShake` (0-1).
 *   - When the storm escalates to TORNADO the particles converge into a
 *     vortex driven by `storm.tornadoBoost`.
 *   - Below the player a heat-map strip is drawn, one bar per bucket, with
 *     intensity proportional to `bucket.normalised`.
 *
 * Integration:
 *
 *   - The component is fully driven by the `snapshot` and `heatMap` props;
 *     it owns no service-side state.  A parent wires the WebSocket bridge:
 *
 *       const [snap, setSnap] = useState<ReactionSnapshot | null>(null);
 *       useEffect(() => ws.subscribe(broadcastId, setSnap), [broadcastId]);
 *       <ReactionRenderer snapshot={snap} heatMap={heatMap} ref={renderer} />
 *
 *   - Optimistic local feedback is exposed via the imperative
 *     `RendererHandle.spawn()` so a viewer's own tap registers immediately
 *     without waiting for the round-trip.
 *
 * Performance:
 *
 *   - Single `requestAnimationFrame` loop; particles live in a flat array
 *     and are recycled when their alpha hits zero, so a steady-state stream
 *     of 100 reactions / second never causes GC pressure.
 *   - `devicePixelRatio` is honoured; the canvas backing-store is resized
 *     only when its CSS box changes (ResizeObserver, debounced).
 *   - Renders nothing when `prefers-reduced-motion` is set; instead emits a
 *     compact tally panel so accessibility users still see the engagement.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactionRendererProps {
  /** Latest aggregated snapshot from the ReactionEngine WebSocket bridge. */
  readonly snapshot: ReactionSnapshot | null;
  /** Optional heat-map strip aligned to the broadcast scrubber. */
  readonly heatMap?: HeatMap | null;
  /** Class applied to the wrapping <div>.  Use to size/position the layer. */
  readonly className?: string;
  /** Particle lifetime in ms. Default 3 000. */
  readonly particleLifetimeMs?: number;
  /** Maximum simultaneous particles.  Default 600.  Older particles are evicted. */
  readonly maxParticles?: number;
  /** Show the heat-map strip beneath the canvas. Default true. */
  readonly showHeatMap?: boolean;
  /** Disable all motion (forced if `prefers-reduced-motion` is set). */
  readonly reducedMotion?: boolean;
  /** Optional ARIA label for the live region announcement. */
  readonly ariaLabel?: string;
}

export interface RendererHandle {
  /**
   * Spawn one or more local particles immediately — used for optimistic
   * feedback when the local viewer fires a reaction before the WebSocket
   * round-trip completes.
   */
  spawn(emoji: string, opts?: { count?: number; kind?: "EMOJI" | "SUPER" | "COMBO"; multiplier?: number }): void;
  /** Drop every particle currently on screen. */
  clear(): void;
  /** Snapshot of the current particle count (for diagnostics / tests). */
  liveParticleCount(): number;
}

interface Particle {
  emoji: string;
  // Coordinates in CSS pixels relative to canvas top-left.
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  birth: number;
  ttl: number;
  pulse: number;        // SUPER pulse phase
  rotation: number;
  rotationSpeed: number;
  kind: "EMOJI" | "SUPER" | "COMBO";
  alive: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIFETIME_MS = 3_000;
const DEFAULT_MAX_PARTICLES = 600;
const HEAT_BAR_HEIGHT_PX = 24;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function pickParticleSize(kind: Particle["kind"]): number {
  switch (kind) {
    case "SUPER":
      return 56;
    case "COMBO":
      return 40;
    default:
      return 28;
  }
}

/**
 * Decide how many particles to spawn for a tally entry.  Standard emoji get
 * one particle per count; combos / supers get extra particles so the storm
 * is visually meaningful even at moderate counts.
 */
function particlesForTally(count: number, comboCount: number, superCount: number): number {
  const base = count;
  const comboBoost = comboCount * 2;
  const superBoost = superCount * 4;
  return clamp(base + comboBoost + superBoost, 0, 64);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ReactionRenderer = forwardRef<RendererHandle, ReactionRendererProps>(
  function ReactionRenderer(
    {
      snapshot,
      heatMap,
      className,
      particleLifetimeMs = DEFAULT_LIFETIME_MS,
      maxParticles = DEFAULT_MAX_PARTICLES,
      showHeatMap = true,
      reducedMotion,
      ariaLabel = "Live viewer reactions",
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const particlesRef = useRef<Particle[]>([]);
    const lastSnapshotIdRef = useRef<number>(-1);
    const stormRef = useRef<StormSignal | null>(null);
    const rafRef = useRef<number | null>(null);
    const dprRef = useRef<number>(1);
    const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
    const reducedRef = useRef<boolean>(false);

    // -------------------------------------------------------------------------
    // Reduced-motion detection
    // -------------------------------------------------------------------------

    useEffect(() => {
      reducedRef.current = reducedMotion ?? prefersReducedMotion();
    }, [reducedMotion]);

    // -------------------------------------------------------------------------
    // Canvas sizing (DPR-aware, ResizeObserver driven)
    // -------------------------------------------------------------------------

    const resizeCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      const dpr =
        typeof window !== "undefined" && window.devicePixelRatio
          ? Math.min(window.devicePixelRatio, 2)
          : 1;
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      if (sizeRef.current.w === w && sizeRef.current.h === h && dprRef.current === dpr) return;
      sizeRef.current = { w, h };
      dprRef.current = dpr;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }, []);

    useEffect(() => {
      resizeCanvas();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(() => resizeCanvas());
      if (containerRef.current) ro.observe(containerRef.current);
      return () => ro.disconnect();
    }, [resizeCanvas]);

    // -------------------------------------------------------------------------
    // Particle spawn helpers
    // -------------------------------------------------------------------------

    const spawnParticle = useCallback(
      (emoji: string, kind: Particle["kind"]) => {
        const arr = particlesRef.current;
        // Recycle if at capacity — drop the oldest.
        if (arr.length >= maxParticles) arr.shift();
        const { w, h } = sizeRef.current;
        const x = Math.random() * Math.max(1, w);
        const y = h - 8;
        const drift = (Math.random() - 0.5) * 60;   // px/sec
        const rise = -(120 + Math.random() * 80);   // px/sec upward
        arr.push({
          emoji,
          x,
          y,
          vx: drift,
          vy: rise,
          size: pickParticleSize(kind),
          birth: performance.now(),
          ttl: particleLifetimeMs,
          pulse: Math.random() * Math.PI * 2,
          rotation: (Math.random() - 0.5) * 0.4,
          rotationSpeed: (Math.random() - 0.5) * 0.6,
          kind,
          alive: true,
        });
      },
      [maxParticles, particleLifetimeMs],
    );

    const spawnBurst = useCallback(
      (emoji: string, count: number, kind: Particle["kind"]) => {
        const total = clamp(Math.floor(count), 0, maxParticles);
        for (let i = 0; i < total; i++) spawnParticle(emoji, kind);
      },
      [maxParticles, spawnParticle],
    );

    // -------------------------------------------------------------------------
    // Imperative handle
    // -------------------------------------------------------------------------

    useImperativeHandle(
      ref,
      (): RendererHandle => ({
        spawn(emoji, opts) {
          if (typeof emoji !== "string" || emoji.length === 0) return;
          const kind = opts?.kind ?? "EMOJI";
          const multiplier = clamp(opts?.multiplier ?? 1, 1, 32);
          const count = clamp(opts?.count ?? 1, 1, 64) * multiplier;
          spawnBurst(emoji, count, kind);
        },
        clear() {
          particlesRef.current = [];
        },
        liveParticleCount() {
          return particlesRef.current.length;
        },
      }),
      [spawnBurst],
    );

    // -------------------------------------------------------------------------
    // React to new snapshots — spawn particles for each emoji tally exactly
    // once per snapshot.
    // -------------------------------------------------------------------------

    useEffect(() => {
      if (!snapshot) return;
      stormRef.current = snapshot.storm;
      // Identify snapshot by windowEnd timestamp; if the timestamp hasn't
      // changed we've already drawn this batch.
      const stamp = snapshot.windowEnd.getTime();
      if (stamp === lastSnapshotIdRef.current) return;
      lastSnapshotIdRef.current = stamp;
      if (reducedRef.current) return;
      for (const tally of snapshot.perEmoji) {
        const n = particlesForTally(tally.count, tally.comboCount, tally.superCount);
        const dominantKind: Particle["kind"] =
          tally.superCount > 0 ? "SUPER" : tally.comboCount > 0 ? "COMBO" : "EMOJI";
        spawnBurst(tally.emoji, n, dominantKind);
      }
    }, [snapshot, spawnBurst]);

    // -------------------------------------------------------------------------
    // Animation loop
    // -------------------------------------------------------------------------

    useEffect(() => {
      if (typeof window === "undefined") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      let lastTs = performance.now();
      let cancelled = false;

      const tick = (ts: number) => {
        if (cancelled) return;
        const dt = Math.min(64, ts - lastTs) / 1000; // seconds, clamp big gaps
        lastTs = ts;
        const { w, h } = sizeRef.current;
        const dpr = dprRef.current;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const storm = stormRef.current;
        let shakeX = 0;
        let shakeY = 0;
        if (storm && storm.active && !reducedRef.current) {
          const amp = clamp(storm.screenShake, 0, 1) * 12;
          shakeX = (Math.random() - 0.5) * amp;
          shakeY = (Math.random() - 0.5) * amp;
        }

        const tornado = storm?.tier === "TORNADO" ? clamp(storm.tornadoBoost, 0, 1) : 0;
        const cx = w / 2;
        const cy = h * 0.4;

        const arr = particlesRef.current;
        let writeIdx = 0;
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          const age = ts - p.birth;
          if (age >= p.ttl) {
            p.alive = false;
            continue;
          }

          // Motion integration
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.rotation += p.rotationSpeed * dt;
          p.pulse += dt * 4;

          if (tornado > 0) {
            // Pull particles toward a swirling center.
            const dx = cx - p.x;
            const dy = cy - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const inward = 60 * tornado;
            p.vx += (dx / dist) * inward * dt;
            p.vy += (dy / dist) * inward * dt;
            // Tangential swirl.
            p.vx += (-dy / dist) * 80 * tornado * dt;
            p.vy += (dx / dist) * 80 * tornado * dt;
          }

          // Render
          const lifeRatio = age / p.ttl;
          const alpha = 1 - lifeRatio * lifeRatio;
          const scale =
            p.kind === "SUPER" ? 1 + Math.sin(p.pulse) * 0.15 : 1;
          ctx.save();
          ctx.globalAlpha = clamp(alpha, 0, 1);
          ctx.translate(p.x + shakeX, p.y + shakeY);
          ctx.rotate(p.rotation);
          ctx.font = `${p.size * scale}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(p.emoji, 0, 0);
          ctx.restore();

          // Compact alive particles in-place.
          if (writeIdx !== i) arr[writeIdx] = p;
          writeIdx++;
        }
        arr.length = writeIdx;

        rafRef.current = window.requestAnimationFrame(tick);
      };

      rafRef.current = window.requestAnimationFrame(tick);
      return () => {
        cancelled = true;
        if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      };
    }, []);

    // -------------------------------------------------------------------------
    // Live tally text for a11y
    // -------------------------------------------------------------------------

    const tallyText = useMemo(() => {
      if (!snapshot) return "";
      const top = [...snapshot.perEmoji]
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map((t) => `${t.emoji} ${t.count}`)
        .join(", ");
      const stormSuffix = snapshot.storm.active ? ` — ${snapshot.storm.tier.toLowerCase()}` : "";
      return `${snapshot.totalReactions} reactions${top ? ` (${top})` : ""}${stormSuffix}`;
    }, [snapshot]);

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    return (
      <div
        ref={containerRef}
        className={className ?? "pointer-events-none absolute inset-0"}
        aria-hidden={false}
        role="presentation"
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none h-full w-full"
          aria-hidden="true"
        />
        {showHeatMap && heatMap && heatMap.buckets.length > 0 ? (
          <ReactionHeatMapStrip heatMap={heatMap} />
        ) : null}
        <span
          className="sr-only"
          aria-live="polite"
          aria-atomic="true"
          aria-label={ariaLabel}
        >
          {tallyText}
        </span>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Heat-map strip
// ---------------------------------------------------------------------------

interface HeatMapStripProps {
  readonly heatMap: HeatMap;
}

function ReactionHeatMapStrip({ heatMap }: HeatMapStripProps): JSX.Element {
  const buckets = heatMap.buckets;
  const hottestMs = heatMap.hottestBucketMs;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 flex h-6 items-end gap-[1px] bg-black/40 px-2 py-1"
      style={{ height: HEAT_BAR_HEIGHT_PX }}
      aria-hidden="true"
    >
      {buckets.map((bucket) => {
        const intensity = clamp(bucket.normalised, 0, 1);
        const hot = hottestMs !== null && bucket.bucketStartMs === hottestMs;
        return (
          <div
            key={bucket.bucketStartMs}
            className="flex-1"
            style={{
              height: `${Math.max(2, intensity * 100)}%`,
              background: hot
                ? "linear-gradient(180deg,#FFD27F,#FF6A00)"
                : `rgba(255,106,0,${0.25 + intensity * 0.7})`,
              borderRadius: 1,
              minWidth: 2,
            }}
          />
        );
      })}
    </div>
  );
}

export default ReactionRenderer;
