"use client";

import { useEffect, useRef, useCallback } from "react";

export interface WsNewBroadcastEvent {
  type: "NEW_BROADCAST";
  data: Record<string, unknown>;
}

export interface WsNewPostEvent {
  type: "NEW_POST";
  post: Record<string, unknown>;
}

type WsMessage = WsNewBroadcastEvent | WsNewPostEvent;

/**
 * useWebSocketFeed
 *
 * Opens a persistent WebSocket connection to the Quantsink broadcast server
 * and calls `onNewPost` whenever the server pushes a NEW_BROADCAST or
 * NEW_POST event.
 *
 * The hook automatically reconnects with exponential back-off when the
 * connection drops, ensuring the real-time feed remains live.
 *
 * @param onNewPost  Callback invoked with every new broadcast.
 * @param url        WebSocket URL (defaults to NEXT_PUBLIC_WS_URL or auto-
 *                   detected relative URL so the app works in any environment).
 */
export function useWebSocketFeed(
  onNewPost: (post: Record<string, unknown>) => void,
  url?: string,
) {
  const onNewPostRef = useRef(onNewPost);
  useEffect(() => { onNewPostRef.current = onNewPost; }, [onNewPost]);

  const wsRef        = useRef<WebSocket | null>(null);
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay   = useRef(1000); // ms, doubles on each failure up to 30 s

  const connect = useCallback(() => {
    const wsUrl =
      url ??
      process.env.NEXT_PUBLIC_WS_URL ??
      (() => {
        const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
        const host     = typeof window !== "undefined" ? window.location.host : "localhost:3001";
        return `${protocol}//${host}/ws`;
      })();

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      retryDelay.current = 1000; // reset back-off on successful connection
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as WsMessage;
        // Support both the advanced BroadcastWebSocket (NEW_BROADCAST) and the
        // legacy wsServer (NEW_POST) event shapes.
        if (data.type === "NEW_BROADCAST") {
          onNewPostRef.current(data.data);
        } else if (data.type === "NEW_POST") {
          onNewPostRef.current(data.post);
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Exponential back-off reconnect
      retryTimeout.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, 30_000);
        connect();
      }, retryDelay.current);
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      if (retryTimeout.current) clearTimeout(retryTimeout.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
