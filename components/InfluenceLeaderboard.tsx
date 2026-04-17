'use client';

/**
 * InfluenceLeaderboard — Social Credit & Influence Score UI Component
 *
 * Features:
 *  - Real-time leaderboard with 5 tiers: Bronze / Silver / Gold / Platinum / Diamond
 *  - User's own position highlighted with a gold border
 *  - Rank change arrows (↑ improved, ↓ dropped, — unchanged)
 *  - "Nearby" tab: users within ±50 of your score
 *  - Score history line chart for the last 30 days (SVG, no external dep)
 *  - Tier badge displayed on each row
 *  - Framer Motion entrance animations
 *
 * Props:
 *   currentUserId  — the authenticated user's ID (used to highlight own row)
 *   authToken      — Bearer token forwarded to the influence API
 */

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InfluenceTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND';

interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  totalScore: number;
  tier: InfluenceTier;
  rankChange: number;
}

interface LeaderboardPage {
  entries: LeaderboardEntry[];
  totalUsers: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

interface ScoreHistoryPoint {
  date: string;
  score: number;
}

interface UserScore {
  totalScore: number;
  effectiveScore: number;
  tier: InfluenceTier;
  rankPosition: number | null;
  components: {
    broadcastQuality:  { score: number; weight: string };
    engagementRate:    { score: number; weight: string };
    consistency:       { score: number; weight: string };
    biometricLevel:    { score: number; weight: string };
    crossAppActivity:  { score: number; weight: string };
    communityStanding: { score: number; weight: string };
  };
}

type ActiveTab = 'global' | 'nearby' | 'history' | 'myScore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_CONFIG: Record<InfluenceTier, { label: string; color: string; bg: string; glow: string; range: string }> = {
  BRONZE:   { label: 'Bronze',   color: '#CD7F32', bg: 'rgba(205,127,50,0.12)',   glow: '0 0 12px rgba(205,127,50,0.4)',   range: '0–200'    },
  SILVER:   { label: 'Silver',   color: '#C0C0C0', bg: 'rgba(192,192,192,0.12)',  glow: '0 0 12px rgba(192,192,192,0.4)',  range: '201–400'  },
  GOLD:     { label: 'Gold',     color: '#FFD700', bg: 'rgba(255,215,0,0.12)',    glow: '0 0 12px rgba(255,215,0,0.4)',    range: '401–600'  },
  PLATINUM: { label: 'Platinum', color: '#E5E4E2', bg: 'rgba(229,228,226,0.12)', glow: '0 0 16px rgba(229,228,226,0.5)', range: '601–800'  },
  DIAMOND:  { label: 'Diamond',  color: '#B9F2FF', bg: 'rgba(185,242,255,0.12)', glow: '0 0 20px rgba(185,242,255,0.6)', range: '801–1000' },
};

const TIER_EMOJI: Record<InfluenceTier, string> = {
  BRONZE: '🥉', SILVER: '🥈', GOLD: '🥇', PLATINUM: '💿', DIAMOND: '💎',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TierBadge({ tier, size = 'sm' }: { tier: InfluenceTier; size?: 'sm' | 'md' | 'lg' }) {
  const cfg = TIER_CONFIG[tier];
  const px = size === 'lg' ? 'px-3 py-1 text-sm' : size === 'md' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold ${px}`}
      style={{ color: cfg.color, background: cfg.bg, boxShadow: cfg.glow, border: `1px solid ${cfg.color}40` }}
    >
      <span aria-hidden="true">{TIER_EMOJI[tier]}</span>
      {cfg.label}
    </span>
  );
}

function RankArrow({ change }: { change: number }) {
  if (change > 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-emerald-400 text-sm font-bold">
        ↑<span className="text-xs">{change}</span>
      </span>
    );
  }
  if (change < 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-400 text-sm font-bold">
        ↓<span className="text-xs">{Math.abs(change)}</span>
      </span>
    );
  }
  return <span className="text-zinc-600 text-sm">—</span>;
}

function Avatar({ url, name }: { url: string | null; name: string }) {
  const initials = name
    .split(' ')
    .map((p) => p[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('');
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={name} className="w-8 h-8 rounded-full object-cover" />
  ) : (
    <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-300">
      {initials}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score History Chart (pure SVG — no external charting library)
// ---------------------------------------------------------------------------

function ScoreHistoryChart({ history }: { history: ScoreHistoryPoint[] }) {
  if (history.length < 2) {
    return (
      <div className="flex items-center justify-center h-40 text-zinc-600 text-sm">
        Not enough data yet — keep broadcasting to build your history.
      </div>
    );
  }

  const W = 640;
  const H = 160;
  const PAD = { top: 16, right: 16, bottom: 28, left: 44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const scores = history.map((p) => p.score);
  const minScore = Math.max(0, Math.min(...scores) - 20);
  const maxScore = Math.min(1000, Math.max(...scores) + 20);
  const range = maxScore - minScore || 1;

  const toX = (i: number) => PAD.left + (i / (history.length - 1)) * innerW;
  const toY = (s: number) => PAD.top + innerH - ((s - minScore) / range) * innerH;

  const points = history.map((p, i) => `${toX(i)},${toY(p.score)}`).join(' ');
  const areaPoints = [
    `${toX(0)},${PAD.top + innerH}`,
    ...history.map((p, i) => `${toX(i)},${toY(p.score)}`),
    `${toX(history.length - 1)},${PAD.top + innerH}`,
  ].join(' ');

  // Y axis ticks
  const yTicks = [0, 250, 500, 750, 1000].filter((v) => v >= minScore - 50 && v <= maxScore + 50);

  // X axis: show first, last, and mid date
  const xLabels = [0, Math.floor(history.length / 2), history.length - 1]
    .filter((i, idx, arr) => arr.indexOf(i) === idx)
    .map((i) => ({ x: toX(i), label: history[i].date.slice(5) })); // MM-DD

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="Score history chart">
        {/* Grid lines */}
        {yTicks.map((v) => (
          <line
            key={v}
            x1={PAD.left}
            y1={toY(v)}
            x2={PAD.left + innerW}
            y2={toY(v)}
            stroke="#27272a"
            strokeWidth="1"
          />
        ))}
        {/* Area fill */}
        <polygon points={areaPoints} fill="url(#scoreGrad)" opacity="0.3" />
        {/* Line */}
        <polyline points={points} fill="none" stroke="#B9F2FF" strokeWidth="2" strokeLinejoin="round" />
        {/* Dots */}
        {history.map((p, i) => (
          <circle key={i} cx={toX(i)} cy={toY(p.score)} r="3" fill="#B9F2FF" />
        ))}
        {/* Y labels */}
        {yTicks.map((v) => (
          <text key={v} x={PAD.left - 6} y={toY(v) + 4} textAnchor="end" fontSize="10" fill="#71717a">
            {v}
          </text>
        ))}
        {/* X labels */}
        {xLabels.map(({ x, label }) => (
          <text key={label} x={x} y={H - 4} textAnchor="middle" fontSize="10" fill="#71717a">
            {label}
          </text>
        ))}
        {/* Gradient def */}
        <defs>
          <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#B9F2FF" />
            <stop offset="100%" stopColor="#B9F2FF" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component sections breakdown bar
// ---------------------------------------------------------------------------

function ComponentBar({ label, score, weight }: { label: string; score: number; weight: string }) {
  const pct = Math.round(score);
  const color =
    pct >= 75 ? '#4ade80' : pct >= 50 ? '#facc15' : pct >= 25 ? '#fb923c' : '#ef4444';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>{label} <span className="text-zinc-600">({weight})</span></span>
        <span style={{ color }}>{pct}/100</span>
      </div>
      <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main leaderboard row
// ---------------------------------------------------------------------------

function LeaderboardRow({
  entry,
  isMe,
  index,
}: {
  entry: LeaderboardEntry;
  isMe: boolean;
  index: number;
}) {
  const cfg = TIER_CONFIG[entry.tier];
  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04, duration: 0.3 }}
      className="flex items-center gap-3 px-4 py-3 rounded-xl transition-colors"
      style={{
        background: isMe ? 'rgba(255,215,0,0.06)' : 'transparent',
        border: isMe ? '1px solid rgba(255,215,0,0.3)' : '1px solid transparent',
        boxShadow: isMe ? cfg.glow : 'none',
      }}
    >
      {/* Rank */}
      <div className="w-8 text-center text-zinc-500 font-mono text-sm font-bold">
        {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : `#${entry.rank}`}
      </div>

      {/* Avatar */}
      <Avatar url={entry.avatarUrl} name={entry.displayName} />

      {/* Name + tier */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-zinc-100 truncate">
            {entry.displayName}
            {isMe && <span className="ml-1 text-xs text-yellow-400 font-normal">(you)</span>}
          </span>
          <TierBadge tier={entry.tier} />
        </div>
      </div>

      {/* Score */}
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-sm font-bold tabular-nums" style={{ color: cfg.color }}>
          {entry.totalScore.toLocaleString()}
        </span>
        <RankArrow change={entry.rankChange} />
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main InfluenceLeaderboard component
// ---------------------------------------------------------------------------

interface InfluenceLeaderboardProps {
  currentUserId: string;
  authToken: string;
}

export default function InfluenceLeaderboard({
  currentUserId,
  authToken,
}: InfluenceLeaderboardProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('global');
  const [page, setPage] = useState(1);

  const [globalBoard, setGlobalBoard]     = useState<LeaderboardPage | null>(null);
  const [nearbyEntries, setNearbyEntries] = useState<LeaderboardEntry[] | null>(null);
  const [history, setHistory]             = useState<ScoreHistoryPoint[] | null>(null);
  const [myScore, setMyScore]             = useState<UserScore | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const headers = { Authorization: `Bearer ${authToken}` };

  const fetchGlobal = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/influence/leaderboard?page=${p}&pageSize=25`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: LeaderboardPage = await res.json();
      setGlobalBoard(data);
    } catch (e) {
      setError('Failed to load leaderboard. Please try again.');
      console.error(e);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  const fetchNearby = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/influence/leaderboard?nearby=true', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { entries: LeaderboardEntry[] } = await res.json();
      setNearbyEntries(data.entries);
    } catch (e) {
      setError('Failed to load nearby users.');
      console.error(e);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/influence/history?days=30', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { history: ScoreHistoryPoint[] } = await res.json();
      setHistory(data.history);
    } catch (e) {
      setError('Failed to load score history.');
      console.error(e);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  const fetchMyScore = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/influence/score', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: UserScore = await res.json();
      setMyScore(data);
    } catch (e) {
      setError('Failed to load your score.');
      console.error(e);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  // Initial + tab-switch fetches
  useEffect(() => {
    if (activeTab === 'global')  fetchGlobal(page);
    if (activeTab === 'nearby')  fetchNearby();
    if (activeTab === 'history') fetchHistory();
    if (activeTab === 'myScore') fetchMyScore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, page]);

  // ---------------------------------------------------------------------------
  // Tab bar
  // ---------------------------------------------------------------------------
  const TABS: { key: ActiveTab; label: string }[] = [
    { key: 'global',  label: '🏆 Global'  },
    { key: 'nearby',  label: '📍 Nearby'  },
    { key: 'history', label: '📈 History' },
    { key: 'myScore', label: '⚡ My Score' },
  ];

  return (
    <div
      className="w-full max-w-2xl mx-auto rounded-2xl overflow-hidden"
      style={{ background: '#0A0A0A', border: '1px solid #27272a' }}
    >
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800">
        <h2 className="text-xl font-semibold text-zinc-100 tracking-tight">
          Influence Leaderboard
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Score 0–1000 · Updated every 6 hours · Decay −2 pts/day idle
        </p>

        {/* Tier legend */}
        <div className="flex flex-wrap gap-2 mt-3">
          {(Object.keys(TIER_CONFIG) as InfluenceTier[]).map((tier) => (
            <div key={tier} className="flex items-center gap-1">
              <TierBadge tier={tier} size="sm" />
              <span className="text-zinc-600 text-xs">{TIER_CONFIG[tier].range}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-zinc-800">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => { setActiveTab(key); if (key === 'global') setPage(1); }}
            className="flex-1 py-3 text-sm font-medium transition-colors"
            style={{
              color:       activeTab === key ? '#B9F2FF' : '#71717a',
              borderBottom: activeTab === key ? '2px solid #B9F2FF' : '2px solid transparent',
              background:  'transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4 min-h-[320px]">
        {error && (
          <div className="text-red-400 text-sm text-center py-8">{error}</div>
        )}

        {loading && !error && (
          <div className="flex items-center justify-center py-16">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              className="w-6 h-6 border-2 border-zinc-700 border-t-cyan-400 rounded-full"
            />
          </div>
        )}

        {!loading && !error && (
          <AnimatePresence mode="wait">
            {/* Global leaderboard */}
            {activeTab === 'global' && globalBoard && (
              <motion.div
                key="global"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-1"
              >
                {globalBoard.entries.map((entry, idx) => (
                  <LeaderboardRow
                    key={entry.userId}
                    entry={entry}
                    isMe={entry.userId === currentUserId}
                    index={idx}
                  />
                ))}

                {/* Pagination */}
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-zinc-800">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 disabled:opacity-30 hover:bg-zinc-700 transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-xs text-zinc-500">
                    Page {page} · {globalBoard.totalUsers.toLocaleString()} users total
                  </span>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!globalBoard.hasNextPage}
                    className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 disabled:opacity-30 hover:bg-zinc-700 transition-colors"
                  >
                    Next →
                  </button>
                </div>
              </motion.div>
            )}

            {/* Nearby leaderboard */}
            {activeTab === 'nearby' && nearbyEntries && (
              <motion.div
                key="nearby"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-1"
              >
                <p className="text-xs text-zinc-500 mb-3">
                  Users within ±50 of your score
                </p>
                {nearbyEntries.length === 0 && (
                  <p className="text-center text-zinc-600 py-10 text-sm">
                    No nearby users found yet.
                  </p>
                )}
                {nearbyEntries.map((entry, idx) => (
                  <LeaderboardRow
                    key={entry.userId}
                    entry={entry}
                    isMe={entry.userId === currentUserId}
                    index={idx}
                  />
                ))}
              </motion.div>
            )}

            {/* Score history chart */}
            {activeTab === 'history' && history && (
              <motion.div
                key="history"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <p className="text-xs text-zinc-500 mb-4">Last 30 days · daily snapshots</p>
                <ScoreHistoryChart history={history} />
                {history.length > 0 && (
                  <div className="mt-4 flex justify-between text-xs text-zinc-500">
                    <span>
                      Min: <span className="text-zinc-300">{Math.min(...history.map((p) => p.score))}</span>
                    </span>
                    <span>
                      Max: <span className="text-zinc-300">{Math.max(...history.map((p) => p.score))}</span>
                    </span>
                    <span>
                      Latest: <span className="text-zinc-300">{history[history.length - 1]?.score ?? '—'}</span>
                    </span>
                  </div>
                )}
              </motion.div>
            )}

            {/* My score breakdown */}
            {activeTab === 'myScore' && myScore && (
              <motion.div
                key="myScore"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-5"
              >
                {/* Score display */}
                <div className="flex items-center justify-between">
                  <div>
                    <div
                      className="text-5xl font-bold tabular-nums"
                      style={{ color: TIER_CONFIG[myScore.tier].color }}
                    >
                      {myScore.effectiveScore.toLocaleString()}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      base {myScore.totalScore} · rank #{myScore.rankPosition ?? '—'}
                    </div>
                  </div>
                  <TierBadge tier={myScore.tier} size="lg" />
                </div>

                {/* Component bars */}
                <div className="flex flex-col gap-3">
                  <ComponentBar label="Broadcast Quality"   score={myScore.components.broadcastQuality.score}   weight={myScore.components.broadcastQuality.weight}   />
                  <ComponentBar label="Engagement Rate"     score={myScore.components.engagementRate.score}     weight={myScore.components.engagementRate.weight}     />
                  <ComponentBar label="Consistency"         score={myScore.components.consistency.score}        weight={myScore.components.consistency.weight}        />
                  <ComponentBar label="Biometric Level"     score={myScore.components.biometricLevel.score}     weight={myScore.components.biometricLevel.weight}     />
                  <ComponentBar label="Cross-App Activity"  score={myScore.components.crossAppActivity.score}   weight={myScore.components.crossAppActivity.weight}   />
                  <ComponentBar label="Community Standing"  score={myScore.components.communityStanding.score}  weight={myScore.components.communityStanding.weight}  />
                </div>

                {/* Recalculate nudge */}
                <p className="text-xs text-zinc-600 text-center">
                  Score recalculates automatically every 6 hours.
                  Idle days reduce your score by 2 pts; quality actions earn +1 pt each.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
