"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface PhantomTyper {
  readonly id: string;
  readonly label: string;
  readonly hue: number;
}

const PHANTOMS: readonly PhantomTyper[] = Object.freeze([
  { id: "ghost-01", label: "Anonymous Analyst", hue: 12 },
  { id: "ghost-02", label: "Silent Observer", hue: 205 },
  { id: "ghost-03", label: "Incognito Quant", hue: 280 },
  { id: "ghost-04", label: "Private Subscriber", hue: 48 },
  { id: "ghost-05", label: "Stealth Trader", hue: 150 },
  { id: "ghost-06", label: "Veiled Whale", hue: 330 },
]);

function Dot({ delay }: { delay: number }) {
  return (
    <motion.span
      animate={{ opacity: [0.2, 1, 0.2], y: [0, -2, 0] }}
      transition={{ duration: 1.1, repeat: Infinity, delay, ease: "easeInOut" }}
      className="w-1 h-1 rounded-full bg-brand-subtext inline-block"
    />
  );
}

/**
 * PhantomTypingIndicators cycles anonymous personas in and out of a
 * "typing" state to keep the audience-anxiety loop running even when
 * the broadcast is quiet. Pure client-side simulation — no network.
 */
export default function PhantomTypingIndicators() {
  const [active, setActive] = useState<readonly PhantomTyper[]>([]);

  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const delay = 2_000 + Math.random() * 5_000;
      window.setTimeout(() => {
        if (cancelled) return;
        const candidate = PHANTOMS[Math.floor(Math.random() * PHANTOMS.length)];
        setActive((prev) => {
          if (prev.some((p) => p.id === candidate.id)) return prev;
          return [...prev, candidate].slice(-3);
        });
        const linger = 1_500 + Math.random() * 3_500;
        window.setTimeout(() => {
          if (cancelled) return;
          setActive((prev) => prev.filter((p) => p.id !== candidate.id));
        }, linger);
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      className="rounded-sm border px-4 py-2.5 flex items-center gap-3 min-h-[44px]"
      style={{ backgroundColor: "#111111", borderColor: "#1E1E1E" }}
      aria-label="Phantom audience typing indicators"
    >
      <span className="text-[9px] tracking-[0.24em] uppercase text-brand-muted flex-shrink-0">
        Audience
      </span>
      <AnimatePresence initial={false}>
        {active.length === 0 ? (
          <motion.span
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-[10px] tracking-wide text-brand-subtext"
          >
            Silent observers watching…
          </motion.span>
        ) : (
          <motion.div
            key="typists"
            className="flex items-center gap-3 flex-wrap"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {active.map((p) => (
              <motion.div
                key={p.id}
                layout
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.25 }}
                className="flex items-center gap-1.5"
              >
                <span
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-semibold text-black"
                  style={{ backgroundColor: `hsl(${p.hue} 45% 68%)` }}
                >
                  {p.label[0]}
                </span>
                <span className="text-[10px] tracking-wide text-brand-text">
                  {p.label}
                </span>
                <span className="flex items-center gap-0.5 ml-0.5">
                  <Dot delay={0} />
                  <Dot delay={0.15} />
                  <Dot delay={0.3} />
                </span>
                <span className="text-[9px] uppercase tracking-widest text-brand-muted">
                  typing
                </span>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
