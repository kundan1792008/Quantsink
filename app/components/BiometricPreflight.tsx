"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

type LivenessState = "idle" | "checking" | "active" | "expired";

interface BiometricPreflightProps {
  /** Quantmail biometric JWT for the current session */
  jwt: string;
  /** Rendered only when biometric session is confirmed active */
  children: React.ReactNode;
}

const LIVENESS_ENDPOINT =
  (process.env.NEXT_PUBLIC_QUANTMAIL_URL ?? "http://localhost:3008") +
  "/api/liveness/check";

/**
 * BiometricPreflight
 *
 * Pings the Quantmail liveness endpoint before rendering `children`.
 * Shows a cyberpunk scanning animation during the check.
 * Displays a red warning when the session has expired.
 */
export default function BiometricPreflight({
  jwt,
  children,
}: BiometricPreflightProps) {
  const [state, setState] = useState<LivenessState>("idle");
  const abortRef = useRef<AbortController | null>(null);

  const runCheck = useCallback(async () => {
    setState("checking");

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(LIVENESS_ENDPOINT, {
        method:  "GET",
        headers: { Authorization: `Bearer ${jwt}` },
        signal:  controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { active?: boolean };
        setState(data.active === true ? "active" : "expired");
      } else {
        setState("expired");
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setState("expired");
    }
  }, [jwt]);

  useEffect(() => {
    if (jwt) runCheck();
    return () => abortRef.current?.abort();
  }, [jwt, runCheck]);

  return (
    <AnimatePresence mode="wait">
      {state === "active" ? (
        <motion.div
          key="content"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {children}
        </motion.div>
      ) : state === "expired" ? (
        <ExpiredWarning key="expired" onRetry={runCheck} />
      ) : (
        <ScanningAnimation key="scanning" />
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

function ScanningAnimation() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.25 }}
      className="flex flex-col items-center justify-center gap-5 p-10 rounded-sm border"
      style={{
        backgroundColor: "#0A0A0A",
        borderColor: "#1E1E1E",
      }}
    >
      {/* Scan ring */}
      <div className="relative w-16 h-16 flex items-center justify-center">
        <motion.svg
          width="64"
          height="64"
          viewBox="0 0 64 64"
          className="absolute inset-0"
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        >
          <circle
            cx="32"
            cy="32"
            r="28"
            fill="none"
            stroke="#1E1E1E"
            strokeWidth="2"
          />
          <circle
            cx="32"
            cy="32"
            r="28"
            fill="none"
            stroke="#C9A96E"
            strokeWidth="2"
            strokeDasharray="40 135"
            strokeLinecap="round"
          />
        </motion.svg>
        {/* Fingerprint icon */}
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#C9A96E"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="z-10"
        >
          <path d="M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10" />
          <path d="M12 18c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6" />
          <path d="M12 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2" />
        </svg>
      </div>

      {/* Scan line animation */}
      <div
        className="w-40 h-px overflow-hidden relative"
        style={{ backgroundColor: "#1E1E1E" }}
      >
        <motion.div
          className="absolute inset-y-0 w-1/3"
          style={{
            background:
              "linear-gradient(90deg, transparent, #C9A96E, transparent)",
          }}
          animate={{ x: ["-100%", "300%"] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <div className="text-center">
        <p
          className="text-[11px] font-semibold tracking-[0.2em] uppercase"
          style={{ color: "#C9A96E" }}
        >
          Verifying Biometric Session
        </p>
        <p className="text-[10px] tracking-wide mt-1" style={{ color: "#5A5A5A" }}>
          Contacting Quantmail SSO…
        </p>
      </div>
    </motion.div>
  );
}

function ExpiredWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col items-center gap-4 p-8 rounded-sm border"
      style={{
        backgroundColor: "#0A0A0A",
        borderColor: "#7F1D1D",
      }}
    >
      {/* Warning icon */}
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center border"
        style={{ borderColor: "#991B1B", backgroundColor: "rgba(127,29,29,0.2)" }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#EF4444"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>

      <div className="text-center">
        <p
          className="text-[13px] font-semibold tracking-wide"
          style={{ color: "#EF4444" }}
        >
          Your biometric session has expired.
        </p>
        <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "#9CA3AF" }}>
          Re-verify via Quantmail to continue broadcasting.
        </p>
      </div>

      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-sm text-[10px] font-semibold tracking-[0.15em] uppercase transition-colors duration-150"
        style={{
          backgroundColor: "rgba(127,29,29,0.3)",
          border: "1px solid #991B1B",
          color: "#FCA5A5",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor =
            "rgba(153,27,27,0.5)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor =
            "rgba(127,29,29,0.3)";
        }}
      >
        Retry Verification
      </button>
    </motion.div>
  );
}
