"use client";

/**
 * ZeroLoadFeed — instant app-open pre-rendered feed.
 *
 * When the component mounts it:
 *   1. Hydrates instantly from an optional SSR/initial payload.
 *   2. Registers the Quantsink service worker if it hasn't been yet.
 *   3. Asks the service worker for the user's cached feed.
 *   4. Listens for background QS_FEED_READY broadcasts to re-hydrate.
 *   5. Supports pull-to-refresh for a truly live fetch.
 *   6. Shows shimmer only when we genuinely have nothing to display —
 *      i.e. a brand-new user on a cold device with no network.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";

// ---------------------------------------------------------------------------
// Shared types — kept in sync with PreRenderEngine
// ---------------------------------------------------------------------------

export interface ZeroLoadCard {
  broadcastId: string;
  authorId: string;
  headline: string;
  body: string;
  tags: string[];
  postedAt: string;
  engagement: number;
  score: number;
  reasons: string[];
  followedAuthor: boolean;
  trendIds: string[];
}

export interface ZeroLoadFeedPayload {
  userId: string;
  cards: ZeroLoadCard[];
  generatedAt: string;
  expiresAt: string;
  integrityHash: string;
  topTrends: string[];
}

export interface ZeroLoadFeedProps {
  /** User to load the feed for. */
  userId: string;
  /** Optional initial payload rendered instantly on the server. */
  initialPayload?: ZeroLoadFeedPayload | null;
  /** Remote endpoint that returns a fresh feed payload. */
  liveEndpoint?: string;
  /** Optional explicit service worker URL.  Defaults to /quantsink-sw.js. */
  serviceWorkerUrl?: string;
  /** Callback fired whenever the feed payload changes. */
  onPayloadChange?: (payload: ZeroLoadFeedPayload) => void;
}

// ---------------------------------------------------------------------------
// Service worker helpers — defensive wrappers so SSR never crashes
// ---------------------------------------------------------------------------

interface ServiceWorkerMessage {
  type: string;
  userId?: string;
  payload?: ZeroLoadFeedPayload;
  urls?: string[];
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

function hasServiceWorker(): boolean {
  return isBrowser() && "serviceWorker" in navigator;
}

async function registerServiceWorker(
  url: string,
): Promise<ServiceWorkerRegistration | null> {
  if (!hasServiceWorker()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration(url);
    if (existing) return existing;
    return await navigator.serviceWorker.register(url);
  } catch (err) {
    console.warn("[ZeroLoadFeed] SW registration failed", err);
    return null;
  }
}

function postToServiceWorker(message: ServiceWorkerMessage): void {
  if (!hasServiceWorker()) return;
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage(message);
  }
}

// ---------------------------------------------------------------------------
// Visual sub-components
// ---------------------------------------------------------------------------

function FreshBadge({ fresh }: { fresh: boolean }) {
  return (
    <span
      className="text-[9px] tracking-[0.25em] font-semibold uppercase px-2 py-0.5 rounded-sm"
      style={{
        color: fresh ? "#9EC97A" : "#C9A96E",
        backgroundColor: fresh
          ? "rgba(158,201,122,0.08)"
          : "rgba(201,169,110,0.08)",
        border: `1px solid ${
          fresh ? "rgba(158,201,122,0.25)" : "rgba(201,169,110,0.25)"
        }`,
      }}
    >
      {fresh ? "Fresh" : "Pre-Cached"}
    </span>
  );
}

function TrendChipRow({ trends }: { trends: string[] }) {
  if (trends.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-6">
      <span className="text-[9px] tracking-[0.2em] text-brand-subtext uppercase font-medium">
        Predicted signals
      </span>
      <div className="h-px flex-1 bg-brand-border mx-2" />
      {trends.map((trend) => (
        <span
          key={trend}
          className="text-[9px] uppercase tracking-widest font-semibold px-2 py-0.5 rounded-sm"
          style={{
            color: "#C9A96E",
            backgroundColor: "rgba(201,169,110,0.08)",
            border: "1px solid rgba(201,169,110,0.25)",
          }}
        >
          {trend}
        </span>
      ))}
    </div>
  );
}

function CardSkeleton({ index }: { index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.65 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="rounded-sm border border-brand-border p-5"
      style={{ backgroundColor: "#111111" }}
    >
      <div className="h-3 w-28 bg-brand-border rounded mb-4 animate-pulse" />
      <div className="h-4 w-full bg-brand-border rounded mb-2 animate-pulse" />
      <div className="h-4 w-5/6 bg-brand-border rounded mb-4 animate-pulse" />
      <div className="h-2 w-2/3 bg-brand-border rounded animate-pulse" />
    </motion.div>
  );
}

function ZeroLoadCardView({
  card,
  index,
  fullyRendered,
}: {
  card: ZeroLoadCard;
  index: number;
  fullyRendered: boolean;
}) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.03, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-sm border border-brand-border p-5 cursor-default"
      style={{
        backgroundColor: "#111111",
        boxShadow: fullyRendered
          ? "0 0 0 1px rgba(201,169,110,0.08), 0 4px 18px rgba(0,0,0,0.35)"
          : "0 2px 10px rgba(0,0,0,0.3)",
      }}
    >
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {card.followedAuthor && (
          <span
            className="text-[9px] tracking-widest uppercase font-semibold px-2 py-0.5 rounded-sm"
            style={{
              color: "#7A9FC9",
              backgroundColor: "rgba(122,159,201,0.08)",
              border: "1px solid rgba(122,159,201,0.25)",
            }}
          >
            Following
          </span>
        )}
        {card.reasons.slice(0, 2).map((reason) => (
          <span
            key={reason}
            className="text-[9px] tracking-wide uppercase text-brand-subtext font-medium"
          >
            {reason}
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-brand-subtext">
          score {card.score.toFixed(3)}
        </span>
      </div>

      <h3 className="text-[15px] font-semibold leading-snug text-brand-text mb-2 tracking-tight">
        {card.headline}
      </h3>
      {fullyRendered && (
        <p className="text-[12px] leading-relaxed text-brand-subtext">
          {card.body}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {card.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="text-[9px] tracking-wide uppercase font-medium"
              style={{ color: "#5A5A5A" }}
            >
              #{tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className="text-[10px] font-mono text-brand-subtext tabular-nums">
            {card.engagement.toLocaleString()}
          </span>
        </div>
      </div>
    </motion.article>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const DEFAULT_SW_URL = "/quantsink-sw.js";

export default function ZeroLoadFeed({
  userId,
  initialPayload = null,
  liveEndpoint,
  serviceWorkerUrl = DEFAULT_SW_URL,
  onPayloadChange,
}: ZeroLoadFeedProps) {
  const [payload, setPayload] = useState<ZeroLoadFeedPayload | null>(
    initialPayload,
  );
  const [fresh, setFresh] = useState<boolean>(!!initialPayload);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swStatus, setSwStatus] = useState<
    "idle" | "registering" | "ready" | "unavailable"
  >("idle");
  const touchStartY = useRef<number | null>(null);

  const resolvedEndpoint = liveEndpoint ?? `/api/feed/${encodeURIComponent(userId)}`;

  const applyPayload = useCallback(
    (next: ZeroLoadFeedPayload, markFresh: boolean) => {
      setPayload(next);
      setFresh(markFresh);
      onPayloadChange?.(next);
    },
    [onPayloadChange],
  );

  // Service worker registration + message bridge.
  useEffect(() => {
    if (!hasServiceWorker()) {
      setSwStatus("unavailable");
      return;
    }
    let cancelled = false;
    setSwStatus("registering");

    (async () => {
      const registration = await registerServiceWorker(serviceWorkerUrl);
      if (cancelled) return;
      setSwStatus(registration ? "ready" : "unavailable");
    })();

    const onMessage = (event: MessageEvent<ServiceWorkerMessage>) => {
      const data = event.data;
      if (!data || data.type !== "QS_FEED_READY") return;
      if (data.userId !== userId || !data.payload) return;
      applyPayload(data.payload, true);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [serviceWorkerUrl, userId, applyPayload]);

  // Persist any initial payload to the SW so it survives the next reload.
  useEffect(() => {
    if (!initialPayload) return;
    postToServiceWorker({
      type: "QS_STORE_FEED",
      userId,
      payload: initialPayload,
    });
  }, [initialPayload, userId]);

  // Live fetch — tolerates absent server endpoints by failing soft.
  const fetchLive = useCallback(async (): Promise<ZeroLoadFeedPayload | null> => {
    if (!isBrowser()) return null;
    try {
      const response = await fetch(resolvedEndpoint, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Feed endpoint returned ${response.status}`);
      }
      const json = (await response.json()) as ZeroLoadFeedPayload;
      return json;
    } catch (err) {
      console.warn("[ZeroLoadFeed] live fetch failed", err);
      setError((err as Error).message);
      return null;
    }
  }, [resolvedEndpoint]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const next = await fetchLive();
    setRefreshing(false);
    if (next) {
      applyPayload(next, true);
      postToServiceWorker({
        type: "QS_STORE_FEED",
        userId,
        payload: next,
      });
    }
  }, [applyPayload, fetchLive, userId]);

  // Kick off first background refresh shortly after mount so users see fresh
  // content without having to pull.
  useEffect(() => {
    if (!isBrowser()) return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  // Pull-to-refresh wiring via pointer events.
  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (window.scrollY <= 0) {
      touchStartY.current = event.touches[0]?.clientY ?? null;
    } else {
      touchStartY.current = null;
    }
  };
  const onTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartY.current;
    touchStartY.current = null;
    if (start === null) return;
    const end = event.changedTouches[0]?.clientY ?? start;
    if (end - start > 70) {
      void refresh();
    }
  };

  const cards = payload?.cards ?? [];
  const fullyRenderedCount = 5;
  const topTrends = payload?.topTrends ?? [];

  const generatedAtLabel = useMemo(() => {
    if (!payload?.generatedAt) return "awaiting first render";
    const d = new Date(payload.generatedAt);
    if (Number.isNaN(d.getTime())) return "just now";
    const age = Math.max(
      0,
      Math.round((Date.now() - d.getTime()) / 1000),
    );
    if (age < 30) return "just now";
    if (age < 120) return "1m ago";
    if (age < 3600) return `${Math.round(age / 60)}m ago`;
    if (age < 86_400) return `${Math.round(age / 3600)}h ago`;
    return `${Math.round(age / 86_400)}d ago`;
  }, [payload?.generatedAt]);

  return (
    <section
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="max-w-2xl mx-auto px-4 py-10"
      aria-label="Zero-load predictive feed"
    >
      <header className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-[10px] tracking-[0.3em] text-brand-subtext uppercase font-semibold">
            Zero-Load Feed
          </span>
          <div className="h-px flex-1 bg-brand-border" />
          <FreshBadge fresh={fresh} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-brand-subtext">
            Pre-rendered from your interest graph · {generatedAtLabel}
            {swStatus === "unavailable" && " · offline shell only"}
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="text-[10px] tracking-widest font-semibold uppercase px-3 py-1 rounded-sm transition-colors duration-150 disabled:opacity-50"
            style={{
              color: refreshing ? "#7A7A7A" : "#C9A96E",
              border: "1px solid rgba(201,169,110,0.35)",
              backgroundColor: "transparent",
            }}
          >
            {refreshing ? "Refreshing…" : "Pull · Refresh"}
          </button>
        </div>
      </header>

      <TrendChipRow trends={topTrends} />

      {error && (
        <div
          role="alert"
          className="mb-4 text-[11px] tracking-wide rounded-sm p-3"
          style={{
            color: "#C97A7A",
            backgroundColor: "rgba(201,122,122,0.05)",
            border: "1px solid rgba(201,122,122,0.2)",
          }}
        >
          Live fetch degraded: {error}. Showing pre-cached feed.
        </div>
      )}

      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {cards.length === 0
            ? Array.from({ length: 5 }).map((_, i) => (
                <CardSkeleton key={`skeleton-${i}`} index={i} />
              ))
            : cards.map((card, i) => (
                <ZeroLoadCardView
                  key={card.broadcastId}
                  card={card}
                  index={i}
                  fullyRendered={i < fullyRenderedCount}
                />
              ))}
        </AnimatePresence>
      </div>

      <footer className="mt-10 flex items-center gap-3">
        <div className="h-px flex-1 bg-brand-border" />
        <span className="text-[9px] tracking-[0.2em] text-brand-muted uppercase">
          {cards.length === 0 ? "Priming cache…" : "End of pre-cache"}
        </span>
        <div className="h-px flex-1 bg-brand-border" />
      </footer>
    </section>
  );
}
