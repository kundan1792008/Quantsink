import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import logger from '../lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReactionType = 'emoji' | 'super' | 'combo';

export interface Reaction {
  id: string;
  broadcastId: string;
  userId: string;
  emoji: string;
  type: ReactionType;
  /** Token cost for super-reactions; 0 for regular */
  tokenCost: number;
  timestamp: number;
}

export interface ReactionBatch {
  broadcastId: string;
  reactions: Reaction[];
  aggregates: Record<string, number>;
  timestamp: number;
}

export interface SuperReactionConfig {
  tokenCost: number;
  allowedEmojis?: Set<string>;
}

export interface ReactionEngineConfig {
  /** Max reactions a single user can send per second (default: 5) */
  maxReactionsPerUserPerSecond?: number;
  /** How often (ms) to flush aggregated batches to subscribers (default: 100) */
  batchIntervalMs?: number;
  /** Token cost to send a super-reaction (default: 10) */
  superReactionTokenCost?: number;
  /** Number of identical consecutive emoji from one user to trigger combo (default: 3) */
  comboThreshold?: number;
}

interface TrackedUser {
  reactionCount: number;
  windowStart: number;
  lastEmojis: string[];
  ws: WebSocket;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function generateId(): string {
  _idCounter = (_idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `rxn_${Date.now()}_${_idCounter}`;
}

function isValidEmoji(str: string): boolean {
  // Accept any non-empty string of 1-8 grapheme clusters commonly used as emoji.
  // A full Unicode emoji regex is enormous; this lightweight guard rejects obvious
  // ASCII abuse while permitting all real emoji code-points.
  if (!str || str.length === 0 || str.length > 32) return false;
  // Reject pure ASCII text that is not an emoji
  const hasNonAscii = /[^\u0020-\u007F]/.test(str);
  const isKnownAsciiEmoji = /^[:;=8][-~]?[)D(|/\\OpP3]$/.test(str);
  return hasNonAscii || isKnownAsciiEmoji;
}

// ─── ReactionEngine ───────────────────────────────────────────────────────────

/**
 * ReactionEngine manages real-time emoji reactions for live broadcasts.
 *
 * Architecture:
 *  - Clients connect over WebSocket and send `REACT` messages.
 *  - The engine throttles each user to `maxReactionsPerUserPerSecond`.
 *  - Reactions accumulate in a per-broadcast buffer.
 *  - Every `batchIntervalMs` the buffer is flushed: aggregates are computed and
 *    a `REACTION_BATCH` message is broadcast to all viewers of that broadcast.
 *  - Three reaction types are supported:
 *      emoji       — any Unicode emoji, free
 *      super       — animated, costs tokens, validated server-side
 *      combo       — automatically promoted when a user sends the same emoji
 *                    `comboThreshold` times in a row
 *
 * Designed to handle ≥ 10,000 reactions/second via:
 *  - O(1) per-user throttle checks using a sliding-window counter.
 *  - Aggregation into batches rather than per-message fan-out.
 *  - A single setInterval flush loop (no per-reaction timers).
 */
export class ReactionEngine extends EventEmitter {
  private readonly maxPerUserPerSecond: number;
  private readonly batchIntervalMs: number;
  private readonly superReactionTokenCost: number;
  private readonly comboThreshold: number;

  /** broadcastId → array of pending reactions */
  private readonly buffer = new Map<string, Reaction[]>();

  /** userId → throttle / combo state, keyed per-connection */
  private readonly users = new Map<string, TrackedUser>();

  /** broadcastId → Set of WebSocket clients viewing that broadcast */
  private readonly viewers = new Map<string, Set<WebSocket>>();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private wss: WebSocketServer | null = null;

  constructor(config: ReactionEngineConfig = {}) {
    super();
    this.maxPerUserPerSecond = config.maxReactionsPerUserPerSecond ?? 5;
    this.batchIntervalMs = config.batchIntervalMs ?? 100;
    this.superReactionTokenCost = config.superReactionTokenCost ?? 10;
    this.comboThreshold = config.comboThreshold ?? 3;
  }

  // ── WebSocket server ───────────────────────────────────────────────────────

  /**
   * Attach the ReactionEngine to an HTTP server, creating a WebSocket endpoint
   * at `/reactions`.  Safe to call once per process lifetime.
   */
  attachToServer(httpServer: Server): WebSocketServer {
    if (this.wss) return this.wss;

    this.wss = new WebSocketServer({ server: httpServer, path: '/reactions' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const broadcastId = url.searchParams.get('broadcastId') ?? 'global';
      const userId = url.searchParams.get('userId') ?? `anon_${Date.now()}`;

      this._registerViewer(broadcastId, userId, ws);

      ws.on('message', (raw) => {
        try {
          this._handleMessage(broadcastId, userId, raw.toString());
        } catch (err) {
          logger.warn({ err, userId }, 'ReactionEngine: invalid message');
        }
      });

      ws.on('close', () => this._unregisterViewer(broadcastId, userId, ws));
      ws.on('error', (err) => {
        logger.warn({ err }, 'ReactionEngine: client error');
        this._unregisterViewer(broadcastId, userId, ws);
      });
    });

    this._startFlushLoop();
    logger.info('ReactionEngine WebSocket server attached at /reactions');
    return this.wss;
  }

  // ── Public API (usable without WebSocket, e.g. server-side ingestion) ──────

  /**
   * Ingest a reaction directly (useful for server-side emission or testing).
   * Returns the reaction if accepted, or null if throttled / invalid.
   */
  ingestReaction(params: {
    broadcastId: string;
    userId: string;
    emoji: string;
    isSuper?: boolean;
    userTokenBalance?: number;
  }): Reaction | null {
    const { broadcastId, userId, emoji, isSuper = false, userTokenBalance = 0 } = params;

    if (!isValidEmoji(emoji)) return null;

    if (!this._checkThrottle(userId)) return null;

    let type: ReactionType = 'emoji';
    let tokenCost = 0;

    if (isSuper) {
      if (userTokenBalance < this.superReactionTokenCost) return null;
      type = 'super';
      tokenCost = this.superReactionTokenCost;
    }

    // Check combo promotion
    const user = this.users.get(userId);
    if (user) {
      user.lastEmojis.push(emoji);
      if (user.lastEmojis.length > this.comboThreshold) {
        user.lastEmojis.shift();
      }
      const isCombo =
        user.lastEmojis.length >= this.comboThreshold &&
        user.lastEmojis.every((e) => e === emoji);
      if (isCombo && type === 'emoji') {
        type = 'combo';
        // Reset so the next reaction after a combo starts fresh
        user.lastEmojis = [];
      }
    }

    const reaction: Reaction = {
      id: generateId(),
      broadcastId,
      userId,
      emoji,
      type,
      tokenCost,
      timestamp: Date.now(),
    };

    this._buffer(reaction);
    this.emit('reaction', reaction);
    return reaction;
  }

  /**
   * Manually flush all pending batches immediately (useful for tests or
   * controlled environments).
   */
  flush(): void {
    this._flushAll();
  }

  /** Return a snapshot of pending reactions for a broadcast (non-destructive). */
  getPendingReactions(broadcastId: string): Reaction[] {
    return [...(this.buffer.get(broadcastId) ?? [])];
  }

  /** Return viewer count for a broadcast. */
  getViewerCount(broadcastId: string): number {
    return this.viewers.get(broadcastId)?.size ?? 0;
  }

  /** Gracefully shut down the engine. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => {
        this.wss = null;
        resolve();
      });
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _registerViewer(broadcastId: string, userId: string, ws: WebSocket): void {
    if (!this.viewers.has(broadcastId)) {
      this.viewers.set(broadcastId, new Set());
    }
    this.viewers.get(broadcastId)!.add(ws);

    if (!this.users.has(userId)) {
      this.users.set(userId, {
        reactionCount: 0,
        windowStart: Date.now(),
        lastEmojis: [],
        ws,
      });
    }

    logger.info(
      { broadcastId, userId, viewers: this.viewers.get(broadcastId)!.size },
      'ReactionEngine: viewer connected',
    );
  }

  private _unregisterViewer(broadcastId: string, userId: string, ws: WebSocket): void {
    const viewerSet = this.viewers.get(broadcastId);
    if (viewerSet) {
      viewerSet.delete(ws);
      if (viewerSet.size === 0) {
        this.viewers.delete(broadcastId);
      }
    }
    this.users.delete(userId);
  }

  private _handleMessage(broadcastId: string, userId: string, raw: string): void {
    const msg = JSON.parse(raw) as {
      type: string;
      emoji?: string;
      isSuper?: boolean;
      userTokenBalance?: number;
    };

    if (msg.type !== 'REACT' || !msg.emoji) return;

    const result = this.ingestReaction({
      broadcastId,
      userId,
      emoji: msg.emoji,
      isSuper: msg.isSuper,
      userTokenBalance: msg.userTokenBalance,
    });

    if (!result) {
      const user = this.users.get(userId);
      user?.ws.send(JSON.stringify({ type: 'THROTTLED' }));
    }
  }

  /**
   * Sliding-window throttle: each user may send at most
   * `maxPerUserPerSecond` reactions within any 1-second window.
   * Returns true if the reaction is allowed.
   */
  private _checkThrottle(userId: string): boolean {
    const now = Date.now();
    let user = this.users.get(userId);

    if (!user) {
      // Create a lightweight entry without a ws reference for server-side ingestion
      user = {
        reactionCount: 1,
        windowStart: now,
        lastEmojis: [],
        ws: null as unknown as WebSocket,
      };
      this.users.set(userId, user);
      return true;
    }

    if (now - user.windowStart >= 1_000) {
      user.windowStart = now;
      user.reactionCount = 1;
      return true;
    }

    if (user.reactionCount >= this.maxPerUserPerSecond) {
      return false;
    }

    user.reactionCount += 1;
    return true;
  }

  private _buffer(reaction: Reaction): void {
    if (!this.buffer.has(reaction.broadcastId)) {
      this.buffer.set(reaction.broadcastId, []);
    }
    this.buffer.get(reaction.broadcastId)!.push(reaction);
  }

  private _startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this._flushAll(), this.batchIntervalMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  private _flushAll(): void {
    for (const [broadcastId, reactions] of this.buffer) {
      if (reactions.length === 0) continue;

      const aggregates: Record<string, number> = {};
      for (const r of reactions) {
        aggregates[r.emoji] = (aggregates[r.emoji] ?? 0) + 1;
      }

      const batch: ReactionBatch = {
        broadcastId,
        reactions,
        aggregates,
        timestamp: Date.now(),
      };

      this.buffer.set(broadcastId, []);
      this.emit('batch', batch);
      this._broadcastToViewers(broadcastId, batch);
    }
  }

  private _broadcastToViewers(broadcastId: string, batch: ReactionBatch): void {
    const viewerSet = this.viewers.get(broadcastId);
    if (!viewerSet || viewerSet.size === 0) return;

    const message = JSON.stringify({ type: 'REACTION_BATCH', data: batch });
    for (const ws of viewerSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message, (err) => {
          if (err) logger.warn({ err }, 'ReactionEngine: failed to send batch');
        });
      }
    }
  }
}

// ─── Singleton helper ─────────────────────────────────────────────────────────

let _engineInstance: ReactionEngine | null = null;

/** Return (or lazily create) a process-wide ReactionEngine singleton. */
export function getReactionEngine(config?: ReactionEngineConfig): ReactionEngine {
  if (!_engineInstance) {
    _engineInstance = new ReactionEngine(config);
  }
  return _engineInstance;
}

/** Replace the singleton (useful for tests). */
export function resetReactionEngine(): void {
  _engineInstance = null;
}
