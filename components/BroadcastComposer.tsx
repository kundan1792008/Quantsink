"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useRef, useState } from "react";

interface BroadcastComposerProps {
  /** Quantmail biometric JWT for the current session */
  jwt?: string;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

const MAX_CHARS = 2000;

// Banned fields enforced at the UI layer — mirrors the backend Zero-Reply guard.
const BANNED_FIELDS = ["replyTo", "quoteTo", "reactTo", "parentId"];

function CharCounter({ count, max }: { count: number; max: number }) {
  const remaining = max - count;
  const ratio      = count / max;
  const color =
    ratio > 0.95
      ? "#ef4444"
      : ratio > 0.85
        ? "#f97316"
        : "#C9A96E";

  const r            = 10;
  const circumference = 2 * Math.PI * r;
  const offset        = circumference * (1 - Math.min(ratio, 1));

  return (
    <div className="relative flex items-center justify-center w-9 h-9 flex-shrink-0">
      <svg width="36" height="36" className="-rotate-90 absolute inset-0">
        <circle cx="18" cy="18" r={r} fill="none" stroke="#1E1E1E" strokeWidth="2" />
        <motion.circle
          cx="18" cy="18" r={r} fill="none"
          stroke={color} strokeWidth="2"
          strokeDasharray={circumference}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.2 }}
          strokeLinecap="round"
        />
      </svg>
      <span
        className="text-[9px] font-mono font-semibold z-10 tabular-nums"
        style={{ color }}
      >
        {remaining > 99 ? "" : remaining}
      </span>
    </div>
  );
}

/**
 * BroadcastComposer
 *
 * A luxury, glassmorphic broadcast composition panel.
 * Enforces Zero-Reply protocol at the UI layer — any attempt to inject
 * banned fields is blocked before the request is made.
 *
 * Calls `POST /api/broadcasts` (Next.js proxy → Express backend).
 */
export default function BroadcastComposer({ jwt }: BroadcastComposerProps) {
  const [open,    setOpen]    = useState(false);
  const [content, setContent] = useState("");
  const [state,   setState]   = useState<SubmitState>("idle");
  const [error,   setError]   = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const charCount = content.length;

  const toggleOpen = useCallback(() => {
    setOpen((v) => !v);
    if (!open) {
      setTimeout(() => textareaRef.current?.focus(), 300);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (!content.trim() || charCount > MAX_CHARS) return;

    // Zero-Reply UI-layer guard
    const bodyObj: Record<string, unknown> = { content, biometricHash: "ui-preflight" };
    for (const field of BANNED_FIELDS) {
      if (field in bodyObj) {
        setError("ZERO_REPLY_VIOLATION: Interaction fields are not permitted.");
        return;
      }
    }

    setState("submitting");
    setError(null);

    try {
      const res = await fetch("/api/broadcasts", {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        },
        body: JSON.stringify(bodyObj),
      });

      if (res.ok) {
        setState("success");
        setContent("");
        setTimeout(() => {
          setState("idle");
          setOpen(false);
        }, 2000);
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Broadcast rejected.");
        setState("error");
      }
    } catch {
      setError("Network error. Please try again.");
      setState("error");
    }
  }, [content, charCount, jwt]);

  const isDisabled = state === "submitting" || charCount === 0 || charCount > MAX_CHARS;

  return (
    <>
      {/* Trigger button — fixed bottom-right */}
      <motion.button
        onClick={toggleOpen}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        className="fixed bottom-8 right-8 z-40 flex items-center gap-2.5 px-5 py-3 rounded-sm font-semibold text-[11px] tracking-[0.18em] uppercase shadow-xl"
        style={{
          backgroundColor: "#C9A96E",
          color: "#0A0A0A",
          boxShadow: "0 8px 32px rgba(201,169,110,0.25), 0 2px 8px rgba(0,0,0,0.4)",
        }}
        aria-label={open ? "Close broadcast composer" : "Compose broadcast"}
      >
        <motion.svg
          width="14" height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ duration: 0.25 }}
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </motion.svg>
        {open ? "Cancel" : "Broadcast"}
      </motion.button>

      {/* Composer drawer */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-30"
              style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />

            {/* Composer panel */}
            <motion.div
              key="panel"
              initial={{ y: 40, opacity: 0, scale: 0.97 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="fixed bottom-24 right-8 z-40 w-full max-w-lg rounded-sm shadow-2xl overflow-hidden"
              style={{
                backgroundColor: "#111111",
                border: "1px solid #252525",
                boxShadow: "0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(201,169,110,0.08)",
              }}
            >
              {/* Header */}
              <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "#1E1E1E" }}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold tracking-[0.2em] text-brand-accent uppercase">
                      Pro Broadcast
                    </span>
                    {/* Zero-Reply protocol indicator */}
                    <span className="text-[8px] tracking-widest text-emerald-400 uppercase px-1.5 py-0.5 border border-emerald-900 bg-emerald-950/40 rounded-sm font-semibold">
                      Zero-Reply Enforced
                    </span>
                  </div>
                  <p className="text-[10px] text-brand-subtext mt-0.5">
                    One-way broadcast only. No replies or interactions.
                  </p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="text-brand-subtext hover:text-brand-text transition-colors p-1.5"
                  aria-label="Close"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Textarea */}
              <div className="p-5">
                <AnimatePresence mode="wait">
                  {state === "success" ? (
                    <motion.div
                      key="success"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center justify-center py-8 gap-3"
                    >
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 300, damping: 18 }}
                        className="w-12 h-12 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)" }}
                      >
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </motion.div>
                      <span className="text-[11px] tracking-[0.15em] text-emerald-400 uppercase font-semibold">
                        Broadcast Transmitted
                      </span>
                    </motion.div>
                  ) : (
                    <motion.div key="compose" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                      <textarea
                        ref={textareaRef}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="Compose your broadcast…"
                        rows={5}
                        maxLength={MAX_CHARS + 1}
                        className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-brand-text placeholder-brand-subtext outline-none"
                        style={{ caretColor: "#C9A96E" }}
                      />

                      {/* Error state */}
                      <AnimatePresence>
                        {error && (
                          <motion.p
                            key="err"
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="text-[10px] text-red-400 mt-2 font-mono"
                          >
                            {error}
                          </motion.p>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Footer: char counter + submit */}
              {state !== "success" && (
                <div className="px-5 pb-5 flex items-center justify-between gap-3">
                  <CharCounter count={charCount} max={MAX_CHARS} />
                  <motion.button
                    onClick={handleSubmit}
                    disabled={isDisabled}
                    whileHover={isDisabled ? {} : { scale: 1.02 }}
                    whileTap={isDisabled ? {} : { scale: 0.97 }}
                    className="flex items-center gap-2 px-5 py-2 rounded-sm text-[10px] font-bold tracking-[0.18em] uppercase transition-opacity"
                    style={{
                      backgroundColor: isDisabled ? "#1E1E1E" : "#C9A96E",
                      color: isDisabled ? "#3A3A3A" : "#0A0A0A",
                      cursor: isDisabled ? "not-allowed" : "pointer",
                    }}
                  >
                    {state === "submitting" ? (
                      <>
                        <motion.span
                          animate={{ rotate: 360 }}
                          transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                          className="w-3 h-3 border border-current border-t-transparent rounded-full inline-block"
                        />
                        Transmitting…
                      </>
                    ) : (
                      <>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                        Transmit
                      </>
                    )}
                  </motion.button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
