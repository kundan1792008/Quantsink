"use client";

import {
  motion,
  AnimatePresence,
  useScroll,
  useVelocity,
  useMotionValueEvent,
} from "framer-motion";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { BroadcastItem } from "../hooks/useRealtimeBroadcasts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface VirtualizedFeedProps {
  /** Full list of broadcast items to render */
  items: BroadcastItem[];
  /** Called when the user scrolls near the bottom — fetch the next page */
  onLoadMore?: () => void;
  /** True while the next page is being fetched */
  isLoadingMore?: boolean;
  /** True when all pages have been loaded */
  hasMore?: boolean;
}

interface RowMeasurement {
  top: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ESTIMATED_CARD_HEIGHT = 160;   // px — initial estimate before measurement
const OVERSCAN               = 4;    // render this many extra items above/below viewport
const VELOCITY_THRESHOLD     = 180;  // px/s — below this = reading mode

// ---------------------------------------------------------------------------
// Hook: virtualised window over the item list
// ---------------------------------------------------------------------------
function useVirtualWindow(
  itemCount: number,
  measurements: React.MutableRefObject<Map<number, RowMeasurement>>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  scrollY: number,
  viewportHeight: number,
) {
  const getTop = useCallback(
    (index: number) => {
      let t = 0;
      for (let i = 0; i < index; i++) {
        t += measurements.current.get(i)?.height ?? ESTIMATED_CARD_HEIGHT;
      }
      return t;
    },
    [measurements],
  );

  const totalHeight = Array.from({ length: itemCount }, (_, i) =>
    measurements.current.get(i)?.height ?? ESTIMATED_CARD_HEIGHT,
  ).reduce((a, b) => a + b, 0);

  let startIndex = 0;
  let accumulated = 0;
  while (startIndex < itemCount - 1) {
    const h = measurements.current.get(startIndex)?.height ?? ESTIMATED_CARD_HEIGHT;
    if (accumulated + h > scrollY) break;
    accumulated += h;
    startIndex++;
  }

  let endIndex = startIndex;
  accumulated = getTop(startIndex);
  while (endIndex < itemCount - 1) {
    accumulated += measurements.current.get(endIndex)?.height ?? ESTIMATED_CARD_HEIGHT;
    if (accumulated > scrollY + viewportHeight) break;
    endIndex++;
  }

  const visibleStart = Math.max(0, startIndex - OVERSCAN);
  const visibleEnd   = Math.min(itemCount - 1, endIndex + OVERSCAN);

  return { visibleStart, visibleEnd, totalHeight, getTop };
}

// ---------------------------------------------------------------------------
// BroadcastCard
// ---------------------------------------------------------------------------
function BroadcastCard({
  item,
  index,
  readingMode,
  onMeasure,
}: {
  item: BroadcastItem;
  index: number;
  readingMode: boolean;
  onMeasure: (index: number, height: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const showActions = hovered || readingMode;

  // Report measured height back to the virtualiser
  useLayoutEffect(() => {
    if (!rowRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      onMeasure(index, entry.contentRect.height);
    });
    ro.observe(rowRef.current);
    return () => ro.disconnect();
  }, [index, onMeasure]);

  const relativeTime = useCallback((iso: string) => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffS  = Math.floor(diffMs / 1000);
    if (diffS < 60)    return `${diffS}s ago`;
    if (diffS < 3600)  return `${Math.floor(diffS / 60)}m ago`;
    if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
    return `${Math.floor(diffS / 86400)}d ago`;
  }, []);

  return (
    <div ref={rowRef}>
      <motion.article
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        className="relative rounded-sm border transition-colors duration-300 cursor-default backdrop-blur-xl"
        style={{
          backgroundColor:  "rgba(255,255,255,0.03)",
          borderColor:      hovered ? "#C9A96E" : "rgba(255,255,255,0.10)",
          boxShadow:        hovered
            ? "0 0 0 1px rgba(201,169,110,0.12), 0 8px 32px rgba(0,0,0,0.5)"
            : "0 2px 12px rgba(0,0,0,0.3)",
        }}
      >
        {/* Header */}
        <div className="p-4 pb-2">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              {/* Avatar */}
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                style={{ backgroundColor: "#C9A96E", color: "#0A0A0A" }}
              >
                {item.authorDisplayName.slice(0, 2).toUpperCase()}
              </div>
              <span className="text-[12px] font-medium text-brand-text">
                {item.authorDisplayName}
              </span>
              {item.biometricVerified && (
                <span
                  className="text-[8px] font-bold tracking-[0.15em] px-1.5 py-0.5 rounded-sm uppercase"
                  style={{
                    color:           "#C9A96E",
                    backgroundColor: "rgba(201,169,110,0.12)",
                    border:          "1px solid rgba(201,169,110,0.25)",
                  }}
                >
                  Verified
                </span>
              )}
            </div>
            <span className="text-[10px] font-mono text-brand-subtext flex-shrink-0">
              {relativeTime(item.createdAt)}
            </span>
          </div>

          <p className="text-[13px] leading-relaxed text-brand-text">
            {item.content}
          </p>
        </div>

        {/* Action tray — progressive disclosure on hover / reading mode */}
        <AnimatePresence>
          {showActions && (
            <motion.div
              key="actions"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div
                className="px-4 py-2 flex items-center gap-1 border-t"
                style={{ borderColor: "rgba(255,255,255,0.06)" }}
              >
                {[
                  { label: "Resonate", emoji: "◈" },
                  { label: "Relay",    emoji: "↗" },
                  { label: "Archive",  emoji: "⊞" },
                ].map((a) => (
                  <button
                    key={a.label}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-sm text-[9px] tracking-wide font-medium text-brand-subtext hover:text-brand-accent transition-colors duration-150 hover:bg-white/5 uppercase"
                    aria-label={a.label}
                  >
                    <span className="text-[11px]">{a.emoji}</span>
                    {a.label}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.article>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VirtualizedFeed
// ---------------------------------------------------------------------------
export default function VirtualizedFeed({
  items,
  onLoadMore,
  isLoadingMore = false,
  hasMore = false,
}: VirtualizedFeedProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const sentinelRef    = useRef<HTMLDivElement>(null);
  const measurements   = useRef<Map<number, RowMeasurement>>(new Map());
  const [scrollY, setScrollY]             = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);
  const [readingMode, setReadingMode]     = useState(true);

  // Track scroll position manually for the virtualiser
  useEffect(() => {
    const onScroll = () => setScrollY(window.scrollY);
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    setViewportHeight(window.innerHeight);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // Framer Motion scroll velocity → reading mode toggle
  const { scrollY: motionScrollY } = useScroll();
  const scrollVelocity = useVelocity(motionScrollY);
  useMotionValueEvent(
    scrollVelocity,
    "change",
    useCallback((v: number) => {
      setReadingMode(Math.abs(v) < VELOCITY_THRESHOLD);
    }, []),
  );

  // IntersectionObserver on the bottom sentinel for infinite loading
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !onLoadMore || !hasMore) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isLoadingMore) onLoadMore();
      },
      { rootMargin: '400px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [onLoadMore, hasMore, isLoadingMore]);

  // Height measurement callback for each card
  const handleMeasure = useCallback((index: number, height: number) => {
    measurements.current.set(index, {
      top:    0,          // re-calculated by the virtualiser
      height,
    });
  }, []);

  const { visibleStart, visibleEnd, totalHeight, getTop } = useVirtualWindow(
    items.length,
    measurements,
    containerRef,
    scrollY,
    viewportHeight,
  );

  const visibleItems = [];
  for (let i = visibleStart; i <= visibleEnd; i++) {
    visibleItems.push(
      <div
        key={items[i].id}
        style={{
          position:  'absolute',
          top:       getTop(i),
          left:      0,
          right:     0,
        }}
      >
        <div className="pb-3">
          <BroadcastCard
            item={items[i]}
            index={i}
            readingMode={readingMode}
            onMeasure={handleMeasure}
          />
        </div>
      </div>,
    );
  }

  return (
    <div ref={containerRef} className="max-w-2xl mx-auto px-4">
      {/* Feed header */}
      <div className="mb-6 py-4">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-[10px] tracking-[0.25em] text-brand-subtext uppercase font-medium">
            Live Broadcast Feed
          </span>
          <div className="h-px flex-1 bg-brand-border" />
          <span
            className="text-[9px] tracking-widest px-2 py-0.5 rounded-sm uppercase font-semibold transition-colors duration-300"
            style={{
              color:           readingMode ? "#9EC97A" : "#7A7A7A",
              backgroundColor: readingMode ? "rgba(158,201,122,0.08)" : "transparent",
              border:          `1px solid ${readingMode ? "rgba(158,201,122,0.2)" : "#1E1E1E"}`,
            }}
          >
            {readingMode ? "Reading Mode" : "Scanning"}
          </span>
        </div>
        <p className="text-[11px] text-brand-subtext">
          {items.length.toLocaleString()} broadcasts · Actions surface on hover
        </p>
      </div>

      {/* Virtualised scroll container */}
      {items.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-[12px] text-brand-subtext tracking-wide">
            No broadcasts yet. Be the first to broadcast.
          </p>
        </div>
      ) : (
        <div style={{ position: 'relative', height: totalHeight }}>
          {visibleItems}
        </div>
      )}

      {/* Load-more sentinel */}
      <div ref={sentinelRef} className="h-px" />

      {/* Loading indicator */}
      {isLoadingMore && (
        <div className="py-6 flex justify-center">
          <motion.div
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            className="text-[10px] tracking-[0.2em] text-brand-subtext uppercase"
          >
            Loading more…
          </motion.div>
        </div>
      )}

      {!hasMore && items.length > 0 && (
        <div className="py-10 flex items-center gap-3">
          <div className="h-px flex-1 bg-brand-border" />
          <span className="text-[9px] tracking-[0.2em] text-brand-muted uppercase">
            End of Broadcast Feed
          </span>
          <div className="h-px flex-1 bg-brand-border" />
        </div>
      )}
    </div>
  );
}
