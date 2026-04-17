"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface BroadcastItem {
  id: string;
  content: string;
  authorId: string;
  authorDisplayName: string;
  biometricVerified: boolean;
  createdAt: string;
}

interface RealtimeBroadcastsState {
  broadcasts: BroadcastItem[];
  isConnected: boolean;
  connectionAttempts: number;
}

interface WsMessage {
  type: string;
  data: BroadcastItem;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS  = 30_000;
const MAX_BROADCASTS  = 200;   // cap in-memory list to avoid runaway growth

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const backendHost =
    process.env.NEXT_PUBLIC_WS_HOST ??
    window.location.hostname + ':3001';
  return `${wsProto}://${backendHost}/ws`;
}

/**
 * Custom hook that maintains a live WebSocket connection to the
 * Quantsink broadcast stream.
 *
 * - Auto-reconnects with exponential back-off (1s → 2s → 4s … max 30s).
 * - Prepends incoming broadcasts to the local list.
 * - Returns `{ broadcasts, isConnected, connectionAttempts }`.
 */
export function useRealtimeBroadcasts(): RealtimeBroadcastsState {
  const [broadcasts, setBroadcasts] = useState<BroadcastItem[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionAttempts, setConnectionAttempts] = useState(0);

  const wsRef          = useRef<WebSocket | null>(null);
  const attemptsRef    = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef   = useRef(false);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const url = getWsUrl();
    if (!url) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current) { ws.close(); return; }
      attemptsRef.current = 0;
      setIsConnected(true);
      setConnectionAttempts(0);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (unmountedRef.current) return;
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        if (msg.type === 'NEW_BROADCAST' && msg.data) {
          setBroadcasts((prev) => {
            const next = [msg.data, ...prev];
            return next.length > MAX_BROADCASTS ? next.slice(0, MAX_BROADCASTS) : next;
          });
        }
      } catch {
        // Silently ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      setIsConnected(false);
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires immediately after; no additional action needed
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    attemptsRef.current += 1;
    setConnectionAttempts(attemptsRef.current);

    const delay = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, attemptsRef.current - 1),
      MAX_BACKOFF_MS,
    );

    reconnectTimer.current = setTimeout(() => {
      if (!unmountedRef.current) connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  return { broadcasts, isConnected, connectionAttempts };
}
