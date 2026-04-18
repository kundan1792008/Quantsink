import { IncomingMessage, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import logger from '../lib/logger';

/** Shape broadcast over the wire to connected clients */
export interface BroadcastPayload {
  id: string;
  content: string;
  authorId: string;
  authorDisplayName: string;
  biometricVerified: boolean;
  createdAt: string;
}

interface TrackedClient {
  ws: WebSocket;
  lastPong: number;
  connectedAt: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;   // ping every 30 s
const STALE_TIMEOUT_MS      = 90_000;   // disconnect after 90 s of silence

let wss: WebSocketServer | null = null;
const clients = new Map<WebSocket, TrackedClient>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Safe to call multiple times — only the first call creates the server.
 */
export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const now = Date.now();
    clients.set(ws, { ws, lastPong: now, connectedAt: now });
    logger.info({ clientCount: clients.size }, 'WebSocket client connected');

    ws.on('pong', () => {
      const client = clients.get(ws);
      if (client) client.lastPong = Date.now();
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info({ clientCount: clients.size }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'WebSocket client error');
      clients.delete(ws);
    });
  });

  // Start heartbeat loop
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastPong > STALE_TIMEOUT_MS) {
        logger.warn('Terminating stale WebSocket client');
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Unref so the interval doesn't prevent process exit
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  logger.info('WebSocket server attached');
  return wss;
}

/**
 * Push a new broadcast to ALL connected WebSocket clients.
 * Runs asynchronously; any client errors are silently dropped.
 */
export function pushBroadcast(payload: BroadcastPayload): void {
  if (!wss || clients.size === 0) return;

  const message = JSON.stringify({ type: 'NEW_BROADCAST', data: payload });

  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message, (err) => {
        if (err) logger.warn({ err }, 'Failed to push broadcast to client');
      });
    }
  }
}

/** Returns the number of currently connected WebSocket clients. */
export function getConnectedClientCount(): number {
  return clients.size;
}

/** Gracefully shut down the WebSocket server (for tests / process exit). */
export function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (!wss) {
      resolve();
      return;
    }
    for (const [ws] of clients) {
      ws.terminate();
    }
    clients.clear();
    wss.close(() => {
      wss = null;
      resolve();
    });
  });
}
