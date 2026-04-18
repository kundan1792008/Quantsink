"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// Live WebSocket client counter
// ---------------------------------------------------------------------------

function useLiveClientCount(pollMs = 8000) {
  const [count, setCount] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/ws/stats");
      if (res.ok) {
        const data = (await res.json()) as { connectedClients?: number };
        setCount(data.connectedClients ?? 0);
      }
    } catch {
      // silent — WS stats are best-effort
    }
  }, []);

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, pollMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll, pollMs]);

  return count;
}

// ---------------------------------------------------------------------------
// Animated odometer digit
// ---------------------------------------------------------------------------

function OdometerDigit({ digit }: { digit: string }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={digit}
        initial={{ y: -12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 12, opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="inline-block"
      >
        {digit}
      </motion.span>
    </AnimatePresence>
  );
}

function LiveCounter({ count }: { count: number | null }) {
  const display = count === null ? "—" : count.toLocaleString();
  return (
    <span className="text-[11px] font-mono font-semibold text-brand-text tabular-nums inline-flex overflow-hidden">
      {display.split("").map((ch, i) => (
        <OdometerDigit key={i} digit={ch} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Zero-Reply violation flash indicator
// ---------------------------------------------------------------------------

function ZeroReplyPulse() {
  const [flash, setFlash] = useState(false);
  const prevRef = useRef(false);

  // SSE-style: listen to a custom DOM event that zeroReplyGuard could dispatch.
  // Falls back gracefully if no violations occur.
  useEffect(() => {
    const handle = () => {
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
    };
    window.addEventListener("quantsink:zero-reply-blocked", handle);
    return () => window.removeEventListener("quantsink:zero-reply-blocked", handle);
  }, []);

  // Clean up lint warning about prevRef
  void prevRef;

  return (
    <AnimatePresence>
      {flash && (
        <motion.span
          key="flash"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.15 }}
          className="text-[9px] font-bold tracking-[0.15em] px-2 py-0.5 rounded-sm uppercase border border-red-800 bg-red-900/50 text-red-300"
        >
          BLOCKED
        </motion.span>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Main VIPTray component
// ---------------------------------------------------------------------------

export default function VIPTray() {
  const clientCount = useLiveClientCount();

  const staticMetrics = [
    { label: "LATENCY", value: "0.00ms" },
    { label: "UPTIME", value: "99.99%" },
  ];

  return (
    <motion.header
      initial={{ y: -72, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="fixed top-0 left-0 right-0 z-50 h-[72px] flex items-center px-6 gap-6"
      style={{
        backgroundColor: "#111111",
        borderBottom: "1px solid #1E1E1E",
      }}
    >
      {/* Logo */}
      <div className="flex-shrink-0 flex flex-col justify-center">
        <div className="flex items-center gap-1.5">
          <span
            className="text-xl font-display font-bold tracking-[0.18em] text-brand-text"
            style={{ fontFamily: "var(--font-display)" }}
          >
            QUANTSINK
          </span>
          <span
            className="w-1.5 h-1.5 rounded-full bg-brand-accent"
            aria-hidden="true"
          />
        </div>
        <span className="text-[9px] tracking-[0.22em] text-brand-subtext font-body uppercase mt-0.5">
          Pro Broadcast Zone
        </span>
      </div>

      {/* Divider */}
      <div className="h-8 w-px bg-brand-border flex-shrink-0" />

      {/* Center: Protocol block */}
      <div className="flex-1 flex items-center justify-center gap-6 min-w-0">
        {/* Zero-Reply badge */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="relative flex items-center">
            <motion.span
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              className="absolute inline-flex h-2 w-2 rounded-full bg-emerald-500 opacity-75"
            />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </div>
          <span className="text-[10px] font-semibold tracking-[0.2em] text-brand-accent uppercase">
            Absolute Zero-Reply Protocol
          </span>
          <span className="text-[9px] tracking-widest text-emerald-400 font-semibold uppercase border border-emerald-900 bg-emerald-950/40 px-2 py-0.5 rounded-sm">
            ACTIVE
          </span>
          <ZeroReplyPulse />
        </div>

        {/* Metrics: static + live WS clients */}
        <div className="hidden md:flex items-center gap-5">
          {staticMetrics.map((m) => (
            <div key={m.label} className="flex items-center gap-1.5">
              <span className="text-[9px] tracking-widest text-brand-subtext uppercase">
                {m.label}:
              </span>
              <span className="text-[11px] font-mono font-semibold text-brand-text tabular-nums">
                {m.value}
              </span>
            </div>
          ))}

          {/* Live connected clients — animated odometer */}
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] tracking-widest text-brand-subtext uppercase">
              CLIENTS:
            </span>
            <LiveCounter count={clientCount} />
            <motion.span
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
              className="w-1 h-1 rounded-full bg-brand-accent inline-block"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="h-8 w-px bg-brand-border flex-shrink-0" />

      {/* Right: User + Live */}
      <div className="flex-shrink-0 flex items-center gap-3">
        {/* LIVE badge */}
        <div className="flex items-center gap-1.5 border border-red-900 bg-red-950/40 px-2.5 py-1 rounded-sm">
          <motion.span
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block"
          />
          <span className="text-[9px] font-bold tracking-[0.2em] text-red-400 uppercase">
            LIVE
          </span>
        </div>

        {/* Notification dot + Avatar */}
        <div className="relative">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold tracking-wider text-brand-bg"
            style={{ backgroundColor: "#C9A96E" }}
          >
            QP
          </div>
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand-accent border-2 border-brand-surface" />
        </div>
      </div>
    </motion.header>
  );
}
