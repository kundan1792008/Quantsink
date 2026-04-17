import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import logger from './logger';

export interface WsBroadcastPayload {
  type: 'NEW_POST';
  post: Record<string, unknown>;
}

let wss: WebSocketServer | null = null;

/**
 * Attaches a WebSocket server to an existing HTTP server.
 * Clients connect on the same port via `ws://host/ws`.
 */
export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    logger.info({ ip }, 'WS: client connected');

    // Zero-Reply enforcement: the WebSocket channel is strictly read-only for
    // clients.  Any message received from a client is immediately rejected.
    socket.on('message', () => {
      socket.send(JSON.stringify({ error: 'ZERO_REPLY_VIOLATION', message: 'This channel is read-only. No client messages are accepted.' }));
    });

    socket.on('close', () => {
      logger.info({ ip }, 'WS: client disconnected');
    });

    socket.on('error', (err) => {
      logger.warn({ ip, err }, 'WS: socket error');
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'WS: server error');
  });

  logger.info('WS: server attached to HTTP server at /ws');
  return wss;
}

/**
 * Broadcasts a new-post event to all connected WebSocket clients.
 */
export function broadcastNewPost(post: Record<string, unknown>): void {
  if (!wss) return;

  const payload = JSON.stringify({ type: 'NEW_POST', post } satisfies WsBroadcastPayload);
  let sent = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent++;
    }
  });

  logger.debug({ sent }, 'WS: broadcast NEW_POST');
}
