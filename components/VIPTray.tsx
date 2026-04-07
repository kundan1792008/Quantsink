"use client";

import { motion } from "framer-motion";

const metrics = [
  { label: "LATENCY", value: "0.00ms" },
  { label: "UPTIME", value: "99.99%" },
  { label: "CHANNELS", value: "247" },
];

export default function VIPTray() {
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
        {/* Badge */}
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
        </div>

        {/* Metrics */}
        <div className="hidden md:flex items-center gap-5">
          {metrics.map((m) => (
            <div key={m.label} className="flex items-center gap-1.5">
              <span className="text-[9px] tracking-widest text-brand-subtext uppercase">
                {m.label}:
              </span>
              <span className="text-[11px] font-mono font-semibold text-brand-text tabular-nums">
                {m.value}
              </span>
            </div>
          ))}
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
