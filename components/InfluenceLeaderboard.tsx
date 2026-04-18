"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion";

/**
 * InfluenceLeaderboard
 * --------------------
 * Front-end surface for the Influence Score system described in issue
 * #16. Integrates three primary views:
 *
 *   1. "Global"  — paginated leaderboard of the whole network.
 *   2. "Nearby"  — peers within ±50 of the viewer's score.
 *   3. "History" — 30-day score line chart for the viewer.
 *
 * Five tiers are rendered with distinct colour themes and badges:
 *   Bronze (0–200), Silver (201–400), Gold (401–600),
 *   Platinum (601–800), Diamond (801–1000).
 *
 * The component is fully presentational. All data arrives through the
 * `dataSource` prop so the same component can be mounted in the
 * production Next.js route, in Storybook, and in automated tests.
 */

// ---------------------------------------------------------------------------
// Types (mirror the backend contract intentionally — no shared module to
// avoid dragging the Node-only runtime into the browser bundle)
// ---------------------------------------------------------------------------

export type Tier = "BRONZE" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND";

export interface InfluenceComponents {
  readonly broadcastQuality: number;
  readonly engagementRate: number;
  readonly consistency: number;
  readonly biometricLevel: number;
  readonly crossAppActivity: number;
  readonly communityStanding: number;
}

export interface LeaderboardRow {
  readonly userId: string;
  readonly rank: number;
  readonly total: number;
  readonly tier: Tier;
  readonly tierLabel: string;
  readonly tierAccentColor: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly previousRank?: number | null;
}

export interface ScoreSnapshot {
  readonly snapshotAt: string;
  readonly total: number;
  readonly tier: Tier;
  readonly components?: InfluenceComponents;
}

export interface InfluenceBreakdownPayload {
  readonly userId: string;
  readonly total: number;
  readonly tier: Tier;
  readonly tierLabel: string;
  readonly tierMin: number;
  readonly tierMax: number;
  readonly tierAccentColor: string;
  readonly components: InfluenceComponents;
  readonly weights: InfluenceComponents;
  readonly activeBoostPoints: number;
  readonly lastRecalculatedAt: string;
  readonly rank: number | null;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface LeaderboardDataSource {
  fetchBreakdown(): Promise<InfluenceBreakdownPayload>;
  fetchLeaderboard(page: number, pageSize: number, tier?: Tier | "ALL"): Promise<{
    rows: readonly LeaderboardRow[];
    total: number;
    nextCursor: number | null;
  }>;
  fetchNearby(limit: number): Promise<readonly LeaderboardRow[]>;
  fetchHistory(days: number): Promise<readonly ScoreSnapshot[]>;
}

export interface InfluenceLeaderboardProps {
  readonly dataSource: LeaderboardDataSource;
  readonly pageSize?: number;
  readonly historyDays?: number;
  readonly className?: string;
  readonly onRowClick?: (row: LeaderboardRow) => void;
}

// ---------------------------------------------------------------------------
// Tier metadata (in sync with the backend but intentionally duplicated so
// the component is self-contained even when the API is unreachable).
// ---------------------------------------------------------------------------

const TIER_META: ReadonlyArray<{
  tier: Tier;
  label: string;
  min: number;
  max: number;
  accent: string;
  glyph: string;
}> = [
  { tier: "BRONZE",   label: "Bronze Broadcaster", min: 0,   max: 200,  accent: "#A97142", glyph: "⬡" },
  { tier: "SILVER",   label: "Silver Signal",      min: 201, max: 400,  accent: "#B0B0B0", glyph: "◇" },
  { tier: "GOLD",     label: "Gold Voice",         min: 401, max: 600,  accent: "#C9A96E", glyph: "✦" },
  { tier: "PLATINUM", label: "Platinum Influence", min: 601, max: 800,  accent: "#CFD8DC", glyph: "☼" },
  { tier: "DIAMOND",  label: "Diamond Apex",       min: 801, max: 1000, accent: "#7FDBFF", glyph: "◉" },
];

function tierFor(total: number): Tier {
  const clamped = Math.max(0, Math.min(1000, total));
  for (const t of TIER_META) {
    if (clamped >= t.min && clamped <= t.max) return t.tier;
  }
  return "BRONZE";
}

function tierAccent(tier: Tier): string {
  return TIER_META.find((t) => t.tier === tier)?.accent ?? "#C9A96E";
}

function tierGlyph(tier: Tier): string {
  return TIER_META.find((t) => t.tier === tier)?.glyph ?? "⬡";
}

// ---------------------------------------------------------------------------
// Component building blocks
// ---------------------------------------------------------------------------

function formatDelta(current: number, previous: number | null | undefined): {
  symbol: "↑" | "↓" | "—";
  delta: number;
} {
  if (previous === null || previous === undefined || previous === current) {
    return { symbol: "—", delta: 0 };
  }
  // "Rank" deltas are inverted — lower rank number = higher position.
  if (current < previous) return { symbol: "↑", delta: previous - current };
  return { symbol: "↓", delta: current - previous };
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

interface TierBadgeProps {
  tier: Tier;
  total?: number;
  compact?: boolean;
}

export function TierBadge({ tier, total, compact }: TierBadgeProps) {
  const accent = tierAccent(tier);
  const glyph = tierGlyph(tier);
  const label = TIER_META.find((t) => t.tier === tier)?.label ?? "Bronze Broadcaster";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-body text-[10px] uppercase tracking-[0.22em] ${
        compact ? "h-5" : "h-6"
      }`}
      style={{
        color: accent,
        borderColor: `${accent}55`,
        backgroundColor: `${accent}12`,
      }}
      aria-label={`Tier ${label}`}
    >
      <span aria-hidden="true" style={{ color: accent }}>
        {glyph}
      </span>
      <span>{tier}</span>
      {typeof total === "number" && !compact ? (
        <span style={{ color: "#7A7A7A" }}>· {total}</span>
      ) : null}
    </span>
  );
}

interface RankArrowProps {
  rank: number;
  previousRank?: number | null;
}

function RankArrow({ rank, previousRank }: RankArrowProps) {
  const { symbol, delta } = formatDelta(rank, previousRank);
  const color = symbol === "↑" ? "#9EC97A" : symbol === "↓" ? "#C97A7A" : "#7A7A7A";
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[11px] tracking-widest font-body"
      style={{ color }}
      aria-label={`Rank change ${symbol === "—" ? "unchanged" : symbol + " " + delta}`}
    >
      <span aria-hidden="true">{symbol}</span>
      {symbol !== "—" ? <span>{delta}</span> : null}
    </span>
  );
}

interface ProgressBarProps {
  value: number;    // 0..100
  max?: number;
  accent?: string;
  label?: string;
}

function ProgressBar({ value, max = 100, accent = "#C9A96E", label }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex w-full items-center gap-3">
      {label ? (
        <span className="w-32 shrink-0 text-[10px] uppercase tracking-[0.22em] text-brand-subtext font-body">
          {label}
        </span>
      ) : null}
      <div
        className="h-1 flex-1 overflow-hidden rounded-full"
        style={{ backgroundColor: "#1E1E1E" }}
        aria-hidden="true"
      >
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: accent }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      <span className="w-10 shrink-0 text-right text-[11px] font-body text-brand-text">
        {Math.round(value)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History chart (SVG, no external deps)
// ---------------------------------------------------------------------------

interface HistoryChartProps {
  snapshots: readonly ScoreSnapshot[];
  accent?: string;
}

function HistoryChart({ snapshots, accent = "#C9A96E" }: HistoryChartProps) {
  const reduceMotion = useReducedMotion();
  const W = 720;
  const H = 200;
  const PAD_X = 32;
  const PAD_Y = 24;

  if (snapshots.length === 0) {
    return (
      <div
        className="flex h-[200px] items-center justify-center rounded-xl border"
        style={{ borderColor: "#1E1E1E", backgroundColor: "#111111" }}
      >
        <span className="font-body text-xs uppercase tracking-[0.22em] text-brand-subtext">
          No history yet — keep broadcasting.
        </span>
      </div>
    );
  }

  const points = snapshots.map((s, i) => ({
    x: snapshots.length === 1
      ? W / 2
      : PAD_X + ((W - PAD_X * 2) * i) / (snapshots.length - 1),
    y: PAD_Y + (H - PAD_Y * 2) * (1 - Math.max(0, Math.min(1000, s.total)) / 1000),
    snapshot: s,
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");
  const areaD =
    `${pathD} L ${points[points.length - 1].x.toFixed(2)} ${(H - PAD_Y).toFixed(2)}` +
    ` L ${points[0].x.toFixed(2)} ${(H - PAD_Y).toFixed(2)} Z`;

  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "#1E1E1E", backgroundColor: "#111111" }}>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext">
          Score history · last {snapshots.length} snapshots
        </span>
        <span className="font-body text-[11px] text-brand-text">
          {snapshots[0] ? formatDate(snapshots[0].snapshotAt) : ""}
          {" → "}
          {snapshots[snapshots.length - 1]
            ? formatDate(snapshots[snapshots.length - 1].snapshotAt)
            : ""}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[200px] w-full"
        role="img"
        aria-label="Influence score history"
      >
        {/* Grid lines for tier thresholds */}
        {TIER_META.map((t) => {
          const y = PAD_Y + (H - PAD_Y * 2) * (1 - t.min / 1000);
          return (
            <g key={t.tier}>
              <line
                x1={PAD_X}
                x2={W - PAD_X}
                y1={y}
                y2={y}
                stroke={t.accent}
                strokeOpacity={0.15}
                strokeDasharray="2 4"
              />
              <text
                x={W - PAD_X + 4}
                y={y + 3}
                fontSize={9}
                fill={t.accent}
                fillOpacity={0.8}
                fontFamily="var(--font-body), sans-serif"
              >
                {t.tier[0]}
              </text>
            </g>
          );
        })}

        <motion.path
          d={areaD}
          fill={accent}
          fillOpacity={0.1}
          initial={reduceMotion ? undefined : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
        />
        <motion.path
          d={pathD}
          fill="none"
          stroke={accent}
          strokeWidth={1.5}
          initial={reduceMotion ? undefined : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        />

        {points.map((p) => (
          <circle
            key={p.snapshot.snapshotAt + "::" + p.snapshot.total}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill={accent}
          />
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  row: LeaderboardRow;
  highlighted?: boolean;
  onClick?: (row: LeaderboardRow) => void;
}

function LeaderboardRowItem({ row, highlighted, onClick }: RowProps) {
  const accent = row.tierAccentColor || tierAccent(row.tier);
  return (
    <motion.button
      type="button"
      onClick={() => onClick?.(row)}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ scale: 1.005 }}
      className={`grid w-full grid-cols-[48px_1fr_160px_80px_56px] items-center gap-3 rounded-md border px-3 py-2.5 text-left font-body text-xs text-brand-text transition-colors ${
        highlighted ? "ring-1 ring-offset-0" : ""
      }`}
      style={{
        borderColor: highlighted ? accent : "#1E1E1E",
        backgroundColor: highlighted ? `${accent}10` : "#0F0F0F",
      }}
      aria-label={`Rank ${row.rank} · ${row.displayName ?? row.userId} · ${row.total} points`}
    >
      <span className="text-[11px] uppercase tracking-[0.22em] text-brand-subtext">
        #{row.rank.toString().padStart(3, "0")}
      </span>
      <span className="flex items-center gap-2 truncate">
        {row.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.avatarUrl}
            alt=""
            className="h-6 w-6 rounded-full border"
            style={{ borderColor: accent }}
          />
        ) : (
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full border text-[10px]"
            style={{ borderColor: accent, color: accent }}
          >
            {(row.displayName ?? row.userId).slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="truncate text-brand-text">{row.displayName ?? row.userId}</span>
      </span>
      <TierBadge tier={row.tier} compact />
      <span className="text-right tabular-nums text-brand-text">{formatNumber(row.total)}</span>
      <span className="text-right">
        <RankArrow rank={row.rank} previousRank={row.previousRank ?? null} />
      </span>
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

type LeaderboardTab = "GLOBAL" | "NEARBY" | "HISTORY";

interface TabBarProps {
  tab: LeaderboardTab;
  onChange: (tab: LeaderboardTab) => void;
}

function TabBar({ tab, onChange }: TabBarProps) {
  const tabs: LeaderboardTab[] = ["GLOBAL", "NEARBY", "HISTORY"];
  return (
    <div className="flex items-center gap-1 rounded-full border p-1"
      style={{ borderColor: "#1E1E1E", backgroundColor: "#0F0F0F" }}
      role="tablist"
    >
      {tabs.map((t) => {
        const active = tab === t;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t)}
            className={`rounded-full px-3 py-1 font-body text-[10px] uppercase tracking-[0.22em] transition-colors ${
              active ? "text-brand-bg" : "text-brand-subtext hover:text-brand-text"
            }`}
            style={{
              backgroundColor: active ? "#C9A96E" : "transparent",
            }}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tier filter
// ---------------------------------------------------------------------------

interface TierFilterProps {
  value: Tier | "ALL";
  onChange: (value: Tier | "ALL") => void;
}

function TierFilter({ value, onChange }: TierFilterProps) {
  const entries: Array<Tier | "ALL"> = ["ALL", "BRONZE", "SILVER", "GOLD", "PLATINUM", "DIAMOND"];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {entries.map((t) => {
        const meta = t === "ALL" ? null : TIER_META.find((m) => m.tier === t);
        const active = value === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className="rounded-full border px-2.5 py-1 font-body text-[10px] uppercase tracking-[0.22em] transition-colors"
            style={{
              borderColor: active ? meta?.accent ?? "#C9A96E" : "#1E1E1E",
              color: active ? meta?.accent ?? "#C9A96E" : "#7A7A7A",
              backgroundColor: active ? `${meta?.accent ?? "#C9A96E"}10` : "transparent",
            }}
            aria-pressed={active}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-breakdown card
// ---------------------------------------------------------------------------

interface BreakdownCardProps {
  breakdown: InfluenceBreakdownPayload | null;
  onRecalculate?: () => void;
}

function BreakdownCard({ breakdown, onRecalculate }: BreakdownCardProps) {
  if (!breakdown) {
    return (
      <div
        className="h-[232px] animate-pulse rounded-2xl border"
        style={{ borderColor: "#1E1E1E", backgroundColor: "#111111" }}
        aria-busy="true"
      />
    );
  }
  const accent = breakdown.tierAccentColor || tierAccent(breakdown.tier);
  const pctWithinTier =
    ((breakdown.total - breakdown.tierMin) /
      Math.max(1, breakdown.tierMax - breakdown.tierMin)) *
    100;

  const componentRows: Array<{ key: keyof InfluenceComponents; label: string }> = [
    { key: "broadcastQuality", label: "Broadcast Quality" },
    { key: "engagementRate", label: "Engagement" },
    { key: "consistency", label: "Consistency" },
    { key: "biometricLevel", label: "Biometric" },
    { key: "crossAppActivity", label: "Cross-App" },
    { key: "communityStanding", label: "Community" },
  ];

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-2xl border p-6"
      style={{ borderColor: "#1E1E1E", backgroundColor: "#111111" }}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl border text-xl"
            style={{ borderColor: accent, color: accent }}
            aria-hidden="true"
          >
            {tierGlyph(breakdown.tier)}
          </span>
          <div>
            <div className="font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext">
              Your Influence
            </div>
            <div
              className="font-display text-3xl tracking-tight"
              style={{ color: accent, fontFamily: "var(--font-display)" }}
            >
              {formatNumber(breakdown.total)}{" "}
              <span className="text-brand-subtext text-base">/ 1000</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <TierBadge tier={breakdown.tier} compact />
              {breakdown.rank !== null ? (
                <span className="font-body text-[11px] text-brand-subtext">
                  Rank #{formatNumber(breakdown.rank)}
                </span>
              ) : null}
              {breakdown.activeBoostPoints > 0 ? (
                <span
                  className="rounded-full px-2 py-0.5 font-body text-[10px] uppercase tracking-[0.22em]"
                  style={{ backgroundColor: "#9EC97A22", color: "#9EC97A" }}
                >
                  +{breakdown.activeBoostPoints} Boost
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {onRecalculate ? (
          <button
            type="button"
            onClick={onRecalculate}
            className="rounded-full border px-3 py-1.5 font-body text-[10px] uppercase tracking-[0.22em] text-brand-text transition-colors hover:text-brand-accent"
            style={{ borderColor: "#1E1E1E" }}
          >
            Recalculate
          </button>
        ) : null}
      </header>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext">
          <span>{breakdown.tierMin}</span>
          <span>
            Progress to next tier: {Math.max(0, Math.round(pctWithinTier))}%
          </span>
          <span>{breakdown.tierMax}</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full"
          style={{ backgroundColor: "#1E1E1E" }}
        >
          <motion.div
            className="h-full"
            style={{ backgroundColor: accent }}
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(0, Math.min(100, pctWithinTier))}%` }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      </div>

      <div className="mt-5 grid gap-2.5">
        {componentRows.map((row) => (
          <ProgressBar
            key={row.key}
            label={row.label}
            value={breakdown.components[row.key]}
            accent={accent}
          />
        ))}
      </div>

      <footer className="mt-4 flex items-center justify-between font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext">
        <span>Last recalculated {formatDate(breakdown.lastRecalculatedAt)}</span>
        <span>6-component weighted score</span>
      </footer>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function InfluenceLeaderboard({
  dataSource,
  pageSize = 20,
  historyDays = 30,
  className,
  onRowClick,
}: InfluenceLeaderboardProps) {
  const [tab, setTab] = useState<LeaderboardTab>("GLOBAL");
  const [tier, setTier] = useState<Tier | "ALL">("ALL");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<readonly LeaderboardRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [nearby, setNearby] = useState<readonly LeaderboardRow[]>([]);
  const [history, setHistory] = useState<readonly ScoreSnapshot[]>([]);
  const [breakdown, setBreakdown] = useState<InfluenceBreakdownPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadBreakdown = useCallback(async () => {
    try {
      const b = await dataSource.fetchBreakdown();
      if (!mountedRef.current) return;
      setBreakdown(b);
    } catch (err) {
      if (!mountedRef.current) return;
      setError((err as Error).message);
    }
  }, [dataSource]);

  const loadLeaderboard = useCallback(async () => {
    setLoading(true);
    try {
      const response = await dataSource.fetchLeaderboard(
        page,
        pageSize,
        tier === "ALL" ? undefined : tier,
      );
      if (!mountedRef.current) return;
      setRows(response.rows);
      setTotal(response.total);
      setNextCursor(response.nextCursor);
    } catch (err) {
      if (!mountedRef.current) return;
      setError((err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [dataSource, page, pageSize, tier]);

  const loadNearby = useCallback(async () => {
    setLoading(true);
    try {
      const response = await dataSource.fetchNearby(Math.max(10, pageSize));
      if (!mountedRef.current) return;
      setNearby(response);
    } catch (err) {
      if (!mountedRef.current) return;
      setError((err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [dataSource, pageSize]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const response = await dataSource.fetchHistory(historyDays);
      if (!mountedRef.current) return;
      setHistory(response);
    } catch (err) {
      if (!mountedRef.current) return;
      setError((err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [dataSource, historyDays]);

  useEffect(() => {
    void loadBreakdown();
  }, [loadBreakdown]);

  useEffect(() => {
    setError(null);
    if (tab === "GLOBAL") void loadLeaderboard();
    else if (tab === "NEARBY") void loadNearby();
    else void loadHistory();
  }, [tab, loadLeaderboard, loadNearby, loadHistory]);

  const activeRows = tab === "GLOBAL" ? rows : tab === "NEARBY" ? nearby : [];
  const activeAccent = breakdown ? breakdown.tierAccentColor : "#C9A96E";

  const tierDistribution = useMemo(() => {
    const counts = new Map<Tier, number>();
    for (const row of rows) counts.set(row.tier, (counts.get(row.tier) ?? 0) + 1);
    return TIER_META.map((t) => ({
      tier: t.tier,
      accent: t.accent,
      count: counts.get(t.tier) ?? 0,
    }));
  }, [rows]);

  const handlePrev = useCallback(() => {
    setPage((p) => Math.max(0, p - 1));
  }, []);

  const handleNext = useCallback(() => {
    if (nextCursor !== null) setPage((p) => p + 1);
  }, [nextCursor]);

  return (
    <section
      className={`flex w-full flex-col gap-6 ${className ?? ""}`}
      aria-label="Influence leaderboard"
    >
      <BreakdownCard
        breakdown={breakdown}
        onRecalculate={() => {
          void loadBreakdown();
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabBar tab={tab} onChange={setTab} />
        {tab === "GLOBAL" ? <TierFilter value={tier} onChange={setTier} /> : null}
      </div>

      {tab === "GLOBAL" ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border p-3 font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext"
          style={{ borderColor: "#1E1E1E", backgroundColor: "#0F0F0F" }}
        >
          <span>Tier distribution</span>
          {tierDistribution.map((t) => (
            <span
              key={t.tier}
              className="rounded-full border px-2 py-0.5"
              style={{ borderColor: `${t.accent}55`, color: t.accent }}
            >
              {t.tier} · {t.count}
            </span>
          ))}
          <span className="ml-auto text-brand-text">
            {formatNumber(total)} members ranked
          </span>
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-xl border px-3 py-2 font-body text-xs"
          role="alert"
          style={{ borderColor: "#C97A7A44", color: "#C97A7A", backgroundColor: "#C97A7A10" }}
        >
          {error}
        </div>
      ) : null}

      <AnimatePresence mode="wait">
        {tab === "HISTORY" ? (
          <motion.div
            key="history"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <HistoryChart snapshots={history} accent={activeAccent} />
          </motion.div>
        ) : (
          <motion.div
            key={tab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-1.5"
          >
            {loading && activeRows.length === 0 ? (
              <div
                className="flex h-24 items-center justify-center rounded-xl border"
                style={{ borderColor: "#1E1E1E", backgroundColor: "#111111" }}
              >
                <span className="font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext">
                  Loading leaderboard…
                </span>
              </div>
            ) : activeRows.length === 0 ? (
              <div
                className="flex h-24 items-center justify-center rounded-xl border"
                style={{ borderColor: "#1E1E1E", backgroundColor: "#111111" }}
              >
                <span className="font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext">
                  No peers yet.
                </span>
              </div>
            ) : (
              activeRows.map((row) => (
                <LeaderboardRowItem
                  key={row.userId}
                  row={row}
                  highlighted={breakdown?.userId === row.userId}
                  onClick={onRowClick}
                />
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {tab === "GLOBAL" ? (
        <footer className="flex items-center justify-between font-body text-[10px] uppercase tracking-[0.22em] text-brand-subtext">
          <button
            type="button"
            onClick={handlePrev}
            disabled={page === 0}
            className="rounded-full border px-3 py-1 transition-colors disabled:opacity-40"
            style={{ borderColor: "#1E1E1E" }}
          >
            ← Prev
          </button>
          <span>
            Page {page + 1} of {Math.max(1, Math.ceil(total / pageSize))}
          </span>
          <button
            type="button"
            onClick={handleNext}
            disabled={nextCursor === null}
            className="rounded-full border px-3 py-1 transition-colors disabled:opacity-40"
            style={{ borderColor: "#1E1E1E" }}
          >
            Next →
          </button>
        </footer>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers for consumers that want to build their own live integration.
// ---------------------------------------------------------------------------

/**
 * Tier metadata that mirrors the backend contract so consumers can
 * render badges consistently across the ecosystem (profiles, DMs, …).
 */
export const INFLUENCE_TIERS = TIER_META;

/**
 * Convenience helper: pick the correct tier + accent colour for any
 * total score without importing the backend module.
 */
export function tierForScore(total: number): { tier: Tier; accent: string } {
  const tier = tierFor(total);
  return { tier, accent: tierAccent(tier) };
}

/**
 * A minimal live HTTP data-source that talks to `/api/influence/*`.
 * Exported so pages can wire it up in a single line. `authToken` is
 * the Quantmail bearer token; pass `fetch` explicitly if you need a
 * custom timeout/retry wrapper.
 */
export function createHttpDataSource({
  authToken,
  baseUrl = "",
  fetcher = fetch,
}: {
  authToken: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}): LeaderboardDataSource {
  const headers = (): HeadersInit => ({
    Accept: "application/json",
    Authorization: `Bearer ${authToken}`,
  });

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetcher(`${baseUrl}${path}`, { headers: headers() });
    if (!res.ok) {
      throw new Error(`Influence API ${res.status}: ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  return {
    async fetchBreakdown() {
      const body = await getJson<{
        score: Omit<InfluenceBreakdownPayload, "rank">;
        rank: number | null;
      }>("/api/influence/score");
      return { ...body.score, rank: body.rank };
    },
    async fetchLeaderboard(page, pageSize, tier) {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (tier && tier !== "ALL") params.set("tier", tier);
      const body = await getJson<{
        leaderboard: readonly LeaderboardRow[];
        total: number;
        nextCursor: number | null;
      }>(`/api/influence/leaderboard?${params.toString()}`);
      return {
        rows: body.leaderboard,
        total: body.total,
        nextCursor: body.nextCursor,
      };
    },
    async fetchNearby(limit) {
      const body = await getJson<{ nearby: readonly LeaderboardRow[] }>(
        `/api/influence/nearby?limit=${limit}`,
      );
      return body.nearby;
    },
    async fetchHistory(days) {
      const body = await getJson<{ history: readonly ScoreSnapshot[] }>(
        `/api/influence/history?days=${days}`,
      );
      return body.history;
    },
  };
}
