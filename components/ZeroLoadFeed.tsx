"use client";

/**
 * ZeroLoadFeed
 *
 * Instant-open feed component backed by pre-cached broadcast cards.
 * When the app opens, content is already present — either from the in-process
 * PreRenderEngine cache or from a Service Worker Cache API snapshot.
 *
 * Features:
 *  - "FRESH" vs "PRE-CACHED" badge on each card.
 *  - Pull-to-refresh gesture (pointer drag or touch) to request live content.
 *  - Skeleton shimmer shown only as a last resort when no cache is available.
 *  - Framer Motion entrance and refresh animations.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ---------------------------------------------------------------------------
// Types (mirrors BroadcastCardPayload from PreRenderEngine)
// ---------------------------------------------------------------------------

export interface ZeroLoadCardPayload {
  readonly id: string;
  readonly headline: string;
  readonly description: string;
  readonly authorId: string;
  readonly publishedAt: number;
  readonly engagementCount: number;
  readonly tags: readonly string[];
  readonly relevanceScore: number;
  readonly isFresh: boolean;
}

export interface ZeroLoadFeedProps {
  /** Pre-cached card payloads supplied by the server or SW cache. */
  readonly preloadedCards?: readonly ZeroLoadCardPayload[];
  /** Called when the user triggers a pull-to-refresh. */
  readonly onRefresh?: () => Promise<readonly ZeroLoadCardPayload[]>;
  /** Maximum cards to display (default: 20). */
  readonly maxCards?: number;
  /** Locale for number formatting (default: "en-US"). */
  readonly locale?: string;
}

// ---------------------------------------------------------------------------
// Skeleton shimmer card
// ---------------------------------------------------------------------------

function SkeletonCard({ index }: { index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06 }}
      className="rounded-sm border border-[#1E1E1E] overflow-hidden"
      style={{ backgroundColor: "#111111" }}
      aria-hidden="true"
    >
      <div className="p-5 space-y-3">
        <div className="flex gap-2 items-center">
          <div className="h-4 w-16 rounded-sm animate-pulse bg-[#1E1E1E]" />
          <div className="h-4 w-24 rounded-sm animate-pulse bg-[#1A1A1A]" />
        </div>
        <div className="space-y-2">
          <div className="h-4 w-3/4 rounded-sm animate-pulse bg-[#1E1E1E]" />
          <div className="h-4 w-full rounded-sm animate-pulse bg-[#1A1A1A]" />
          <div className="h-4 w-5/6 rounded-sm animate-pulse bg-[#1E1E1E]" />
        </div>
        <div className="flex gap-2 pt-1">
          <div className="h-3 w-12 rounded-sm animate-pulse bg-[#1A1A1A]" />
          <div className="h-3 w-14 rounded-sm animate-pulse bg-[#1E1E1E]" />
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Fresh / cached indicator badge
// ---------------------------------------------------------------------------

function FreshnessBadge({ isFresh }: { isFresh: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[8px] font-bold tracking-[0.2em] uppercase px-2 py-0.5 rounded-sm"
      style={
        isFresh
          ? {
              color: "#9EC97A",
              backgroundColor: "rgba(158,201,122,0.10)",
              border: "1px solid rgba(158,201,122,0.25)",
            }
          : {
              color: "#5A5A5A",
              backgroundColor: "rgba(90,90,90,0.08)",
              border: "1px solid rgba(90,90,90,0.18)",
            }
      }
      aria-label={isFresh ? "Fresh content" : "Pre-cached content"}
    >
      {isFresh ? (
        <>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-[#9EC97A]"
            style={{ boxShadow: "0 0 4px rgba(158,201,122,0.6)" }}
          />
          FRESH
        </>
      ) : (
        <>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
            <path
              d="M4 1v3l2 1"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="4" cy="4" r="3" stroke="currentColor" strokeWidth="1" />
          </svg>
          CACHED
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Relevance ring (SVG arc)
// ---------------------------------------------------------------------------

function RelevanceRing({ score }: { score: number }) {
  const radius = 13;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div
      className="relative flex-shrink-0 w-8 h-8 flex items-center justify-center"
      aria-label={`Relevance score: ${score}%`}
    >
      <svg width="32" height="32" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="16" cy="16" r={radius} fill="none" stroke="#1E1E1E" strokeWidth="2" />
        <circle
          cx="16"
          cy="16"
          r={radius}
          fill="none"
          stroke="#C9A96E"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[8px] font-mono font-semibold text-[#C9A96E] z-10">
        {score}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Broadcast card
// ---------------------------------------------------------------------------

function ZeroLoadCard({
  card,
  index,
}: {
  card: ZeroLoadCardPayload;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const relativeTime = useRelativeTime(card.publishedAt);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.4, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-sm border cursor-default"
      style={{
        backgroundColor: "#111111",
        borderColor: "#1E1E1E",
      }}
      data-broadcast-id={card.id}
      data-rank={index}
    >
      <div className="p-5 pb-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <FreshnessBadge isFresh={card.isFresh} />
            <span className="text-[9px] text-[#3A3A3A] font-mono">{relativeTime}</span>
          </div>
          <RelevanceRing score={card.relevanceScore} />
        </div>

        {/* Headline */}
        <h2 className="text-[14px] font-semibold leading-snug text-[#E0E0E0] mb-2 tracking-tight">
          {card.headline}
        </h2>

        {/* Description */}
        <p
          className="text-[12px] leading-relaxed text-[#6A6A6A] transition-all duration-300"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: expanded ? undefined : 2,
            WebkitBoxOrient: "vertical",
            overflow: expanded ? "visible" : "hidden",
          }}
        >
          {card.description}
        </p>

        {card.description.length > 140 && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="mt-1 text-[10px] text-[#C9A96E] hover:text-[#E0C070] transition-colors font-medium"
            aria-label={expanded ? "Collapse description" : "Expand description"}
          >
            {expanded ? "Show less" : "Read more"}
          </button>
        )}
      </div>

      {/* Tags + engagement */}
      <div className="px-5 pb-4 flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {card.tags.map((tag) => (
            <span
              key={tag}
              className="text-[8px] tracking-wide font-medium uppercase px-1.5 py-0.5 rounded-sm"
              style={{
                color: "#444",
                border: "1px solid #2A2A2A",
              }}
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M5 1l1.2 2.5L9 3.8 6.9 5.8l.5 2.7L5 7.2 2.6 8.5l.5-2.7L1 3.8l2.8-.3z"
              fill="#C9A96E"
            />
          </svg>
          <span className="text-[10px] font-mono text-[#5A5A5A] tabular-nums">
            {card.engagementCount.toLocaleString("en-US")}
          </span>
        </div>
      </div>
    </motion.article>
  );
}

// ---------------------------------------------------------------------------
// Pull-to-refresh indicator
// ---------------------------------------------------------------------------

function PullIndicator({ pullDistance, threshold }: { pullDistance: number; threshold: number }) {
  const progress = Math.min(pullDistance / threshold, 1);
  const opacity = Math.min(progress * 2, 1);
  const ready = progress >= 1;

  return (
    <motion.div
      style={{ height: Math.min(pullDistance * 0.5, 56), opacity }}
      className="flex items-center justify-center overflow-hidden"
      aria-live="polite"
      aria-label={ready ? "Release to refresh" : "Pull to refresh"}
    >
      <div className="flex items-center gap-2">
        <motion.div
          animate={{ rotate: ready ? 180 : 0 }}
          transition={{ duration: 0.25 }}
          className="w-4 h-4 flex items-center justify-center"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 2v4M7 2L5 4M7 2l2 2M3 7a4 4 0 108 0"
              stroke={ready ? "#C9A96E" : "#3A3A3A"}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.div>
        <span
          className="text-[10px] font-medium tracking-wide uppercase"
          style={{ color: ready ? "#C9A96E" : "#3A3A3A" }}
        >
          {ready ? "Release to refresh" : "Pull to refresh"}
        </span>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Custom hook — relative time formatting
// ---------------------------------------------------------------------------

function useRelativeTime(epochMs: number): string {
  const [label, setLabel] = useState(() => formatRelativeTime(epochMs));

  useEffect(() => {
    const interval = setInterval(() => {
      setLabel(formatRelativeTime(epochMs));
    }, 30_000);
    return () => clearInterval(interval);
  }, [epochMs]);

  return label;
}

function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1_000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// Pull-to-refresh hook
// ---------------------------------------------------------------------------

const PULL_THRESHOLD = 72;

function usePullToRefresh(onRefresh?: () => Promise<readonly ZeroLoadCardPayload[]>) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const container = containerRef.current;
    if (!container || container.scrollTop > 0) return;
    startY.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (startY.current === null) return;
    const delta = e.touches[0].clientY - startY.current;
    if (delta > 0) {
      setPullDistance(Math.min(delta, PULL_THRESHOLD * 1.5));
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (pullDistance >= PULL_THRESHOLD && onRefresh && !refreshing) {
      setRefreshing(true);
      setPullDistance(0);
      startY.current = null;
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    } else {
      setPullDistance(0);
      startY.current = null;
    }
  }, [pullDistance, onRefresh, refreshing]);

  return {
    containerRef,
    pullDistance,
    refreshing,
    handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd },
  };
}

// ---------------------------------------------------------------------------
// ZeroLoadFeed — main component
// ---------------------------------------------------------------------------

export default function ZeroLoadFeed({
  preloadedCards,
  onRefresh,
  maxCards = 20,
  locale: _locale = "en-US",
}: ZeroLoadFeedProps) {
  const [cards, setCards] = useState<readonly ZeroLoadCardPayload[]>(
    preloadedCards?.slice(0, maxCards) ?? [],
  );
  const [isLoading, setIsLoading] = useState(!preloadedCards || preloadedCards.length === 0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(
    preloadedCards && preloadedCards.length > 0 ? Date.now() : null,
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const { containerRef, pullDistance, refreshing, handlers } = usePullToRefresh(
    onRefresh
      ? async () => {
          setRefreshError(null);
          try {
            const fresh = await onRefresh();
            setCards(fresh.slice(0, maxCards));
            setLastRefreshedAt(Date.now());
          } catch {
            setRefreshError("Could not refresh. Please try again.");
          }
        }
      : undefined,
  );

  // If no preloaded cards arrive, show skeletons then simulate a fetch
  useEffect(() => {
    if (preloadedCards && preloadedCards.length > 0) {
      setCards(preloadedCards.slice(0, maxCards));
      setIsLoading(false);
      return;
    }

    if (!onRefresh) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    onRefresh()
      .then((fresh) => {
        if (cancelled) return;
        setCards(fresh.slice(0, maxCards));
        setLastRefreshedAt(Date.now());
      })
      .catch(() => {
        if (cancelled) return;
        setRefreshError("Failed to load content.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [preloadedCards, onRefresh, maxCards]);

  const freshCount = cards.filter((c) => c.isFresh).length;
  const cachedCount = cards.length - freshCount;

  return (
    <div
      ref={containerRef}
      className="max-w-2xl mx-auto px-4 py-10 overscroll-y-contain"
      {...handlers}
    >
      {/* Pull-to-refresh indicator */}
      <AnimatePresence>
        {pullDistance > 0 && (
          <motion.div
            key="pull-indicator"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <PullIndicator pullDistance={pullDistance} threshold={PULL_THRESHOLD} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Refreshing spinner */}
      <AnimatePresence>
        {refreshing && (
          <motion.div
            key="refreshing"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 40 }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center justify-center"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
              className="w-4 h-4 rounded-full border-t-2 border-[#C9A96E] border-r-2 border-r-transparent"
              aria-label="Refreshing…"
            />
            <span className="ml-2 text-[10px] text-[#5A5A5A] uppercase tracking-wide">
              Refreshing…
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Feed header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-[10px] tracking-[0.25em] text-[#4A4A4A] uppercase font-medium">
            Zero-Load Feed
          </span>
          <div className="h-px flex-1 bg-[#1E1E1E]" />
          {lastRefreshedAt && (
            <span className="text-[9px] font-mono text-[#3A3A3A]">
              Updated {formatRelativeTime(lastRefreshedAt)}
            </span>
          )}
        </div>

        {/* Cache composition summary */}
        {cards.length > 0 && (
          <div className="flex items-center gap-3 mt-1">
            {freshCount > 0 && (
              <span className="flex items-center gap-1 text-[9px] text-[#6A6A6A]">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-[#9EC97A]"
                  aria-hidden="true"
                />
                {freshCount} fresh
              </span>
            )}
            {cachedCount > 0 && (
              <span className="flex items-center gap-1 text-[9px] text-[#4A4A4A]">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-[#3A3A3A]"
                  aria-hidden="true"
                />
                {cachedCount} pre-cached
              </span>
            )}
          </div>
        )}

        <p className="text-[11px] text-[#3A3A3A] mt-1">
          {isLoading
            ? "Loading personalised content…"
            : cards.length === 0
            ? "No content available."
            : "Content pre-loaded for instant reading. Pull down to refresh."}
        </p>
      </div>

      {/* Error state */}
      <AnimatePresence>
        {refreshError && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-4 px-4 py-3 rounded-sm border border-[#3A1A1A] bg-[#1A0A0A] text-[11px] text-[#C97A7A]"
            role="alert"
          >
            {refreshError}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content area */}
      <div className="flex flex-col gap-3">
        {isLoading ? (
          // Skeleton shimmer — last resort while awaiting cache
          Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} index={i} />
          ))
        ) : cards.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="py-16 text-center"
          >
            <p className="text-[12px] text-[#3A3A3A]">
              No broadcasts found.{" "}
              {onRefresh && (
                <button
                  onClick={async () => {
                    setRefreshError(null);
                    try {
                      const fresh = await onRefresh();
                      setCards(fresh.slice(0, maxCards));
                      setLastRefreshedAt(Date.now());
                    } catch {
                      setRefreshError("Refresh failed.");
                    }
                  }}
                  className="text-[#C9A96E] hover:underline"
                >
                  Try refreshing.
                </button>
              )}
            </p>
          </motion.div>
        ) : (
          <AnimatePresence mode="popLayout">
            {cards.map((card, i) => (
              <ZeroLoadCard key={card.id} card={card} index={i} />
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Footer sentinel */}
      {!isLoading && cards.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mt-12 flex items-center gap-3"
        >
          <div className="h-px flex-1 bg-[#1A1A1A]" />
          <span className="text-[9px] tracking-[0.2em] text-[#2A2A2A] uppercase">
            End of pre-cache
          </span>
          <div className="h-px flex-1 bg-[#1A1A1A]" />
        </motion.div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-export payload type for consumers
// ---------------------------------------------------------------------------

export type { ZeroLoadCardPayload as CardPayload };
