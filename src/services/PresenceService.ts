import { EventEmitter } from 'events';
import logger from '../lib/logger';

/**
 * PresenceService — real concurrent viewer counts and typing indicators.
 *
 * Backed by an in-memory registry that a transport layer (WebSocket,
 * Server-Sent Events, etc.) can plug into. Every value this service returns
 * reflects an actual event produced by an actual client connection:
 *
 *  - `viewerCount` is the number of currently connected viewers.
 *  - `typingUsers` contains only users whose clients have emitted a real
 *    keystroke within the configured typing TTL.
 *
 * No multiplication, no synthetic presence, no "anonymous" phantoms.
 */

export interface PresenceSnapshot {
  broadcastId: string;
  viewerCount: number;
  viewerIds: string[];
  typingUserIds: string[];
}

export interface PresenceDelta {
  broadcastId: string;
  previousCount: number;
  currentCount: number;
  timestamp: Date;
}

export interface PresenceServiceOptions {
  /** Max age of a typing event before it is considered stale, in ms. */
  typingTtlMs?: number;
  /**
   * Max age of a connection heartbeat before the viewer is considered gone,
   * in ms. A value of `null` disables heartbeat expiry (pure join/leave).
   */
  heartbeatTtlMs?: number | null;
}

interface ViewerEntry {
  userId: string;
  joinedAt: number;
  lastSeen: number;
}

interface TypingEntry {
  userId: string;
  lastKeystroke: number;
}

interface BroadcastPresence {
  viewers: Map<string, ViewerEntry>;
  typing: Map<string, TypingEntry>;
}

const DEFAULT_TYPING_TTL_MS = 4_000;
const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

export class PresenceService extends EventEmitter {
  private readonly rooms = new Map<string, BroadcastPresence>();
  private readonly typingTtlMs: number;
  private readonly heartbeatTtlMs: number | null;

  constructor(options: PresenceServiceOptions = {}) {
    super();
    this.typingTtlMs = options.typingTtlMs ?? DEFAULT_TYPING_TTL_MS;
    this.heartbeatTtlMs =
      options.heartbeatTtlMs === undefined
        ? DEFAULT_HEARTBEAT_TTL_MS
        : options.heartbeatTtlMs;
  }

  private getRoom(broadcastId: string): BroadcastPresence {
    let room = this.rooms.get(broadcastId);
    if (!room) {
      room = { viewers: new Map(), typing: new Map() };
      this.rooms.set(broadcastId, room);
    }
    return room;
  }

  /**
   * Record that a viewer has connected to a broadcast.
   * Emits `viewerCountChanged` if the count actually moved.
   */
  join(broadcastId: string, userId: string, now: number = Date.now()): PresenceSnapshot {
    const room = this.getRoom(broadcastId);
    const previousCount = this.countActiveViewers(room, now);
    const existing = room.viewers.get(userId);
    room.viewers.set(userId, {
      userId,
      joinedAt: existing?.joinedAt ?? now,
      lastSeen: now,
    });

    const currentCount = this.countActiveViewers(room, now);
    if (currentCount !== previousCount) {
      this.emitDelta(broadcastId, previousCount, currentCount);
    }
    logger.info({ broadcastId, userId, currentCount }, 'presence.join');
    return this.snapshot(broadcastId, now);
  }

  /** Record heartbeat from a still-connected viewer. Does not change count. */
  heartbeat(broadcastId: string, userId: string, now: number = Date.now()): void {
    const room = this.rooms.get(broadcastId);
    if (!room) return;
    const entry = room.viewers.get(userId);
    if (entry) entry.lastSeen = now;
  }

  /** Record that a viewer has disconnected. Emits delta if count moved. */
  leave(broadcastId: string, userId: string, now: number = Date.now()): PresenceSnapshot {
    const room = this.getRoom(broadcastId);
    const previousCount = this.countActiveViewers(room, now);
    room.viewers.delete(userId);
    room.typing.delete(userId);
    const currentCount = this.countActiveViewers(room, now);
    if (currentCount !== previousCount) {
      this.emitDelta(broadcastId, previousCount, currentCount);
    }
    logger.info({ broadcastId, userId, currentCount }, 'presence.leave');
    return this.snapshot(broadcastId, now);
  }

  /**
   * Record a real typing keystroke from a connected viewer.
   * Throws if the viewer is not actually connected — we refuse to fabricate
   * typing signals for non-existent users.
   */
  typing(broadcastId: string, userId: string, now: number = Date.now()): void {
    const room = this.getRoom(broadcastId);
    if (!room.viewers.has(userId)) {
      throw new Error(
        `Cannot mark user ${userId} as typing in ${broadcastId}: user is not connected`,
      );
    }
    room.typing.set(userId, { userId, lastKeystroke: now });
    this.emit('typingChanged', this.snapshot(broadcastId, now));
  }

  /** Explicitly clear typing state (e.g. on send or blur). */
  stopTyping(broadcastId: string, userId: string, now: number = Date.now()): void {
    const room = this.rooms.get(broadcastId);
    if (!room) return;
    if (room.typing.delete(userId)) {
      this.emit('typingChanged', this.snapshot(broadcastId, now));
    }
  }

  snapshot(broadcastId: string, now: number = Date.now()): PresenceSnapshot {
    const room = this.getRoom(broadcastId);
    const viewerIds = this.activeViewers(room, now);
    const typingUserIds = this.activeTyping(room, now);
    return {
      broadcastId,
      viewerCount: viewerIds.length,
      viewerIds,
      typingUserIds,
    };
  }

  /**
   * Sweep stale viewers and typing entries. Returns the updated snapshot.
   * Call this on a scheduled interval from the transport layer.
   */
  sweep(broadcastId: string, now: number = Date.now()): PresenceSnapshot {
    const room = this.getRoom(broadcastId);
    const previousCount = room.viewers.size;
    if (this.heartbeatTtlMs !== null) {
      const cutoff = now - this.heartbeatTtlMs;
      for (const [id, entry] of room.viewers) {
        if (entry.lastSeen < cutoff) {
          room.viewers.delete(id);
          room.typing.delete(id);
        }
      }
    }
    const typingCutoff = now - this.typingTtlMs;
    for (const [id, entry] of room.typing) {
      if (entry.lastKeystroke < typingCutoff) room.typing.delete(id);
    }
    const snapshot = this.snapshot(broadcastId, now);
    if (snapshot.viewerCount !== previousCount) {
      this.emitDelta(broadcastId, previousCount, snapshot.viewerCount);
    }
    return snapshot;
  }

  private activeViewers(room: BroadcastPresence, now: number): string[] {
    if (this.heartbeatTtlMs === null) {
      return Array.from(room.viewers.keys());
    }
    const cutoff = now - this.heartbeatTtlMs;
    const ids: string[] = [];
    for (const entry of room.viewers.values()) {
      if (entry.lastSeen >= cutoff) ids.push(entry.userId);
    }
    return ids;
  }

  private countActiveViewers(room: BroadcastPresence, now: number): number {
    return this.activeViewers(room, now).length;
  }

  private activeTyping(room: BroadcastPresence, now: number): string[] {
    const cutoff = now - this.typingTtlMs;
    const ids: string[] = [];
    for (const entry of room.typing.values()) {
      if (entry.lastKeystroke >= cutoff && room.viewers.has(entry.userId)) {
        ids.push(entry.userId);
      }
    }
    return ids;
  }

  private emitDelta(broadcastId: string, previous: number, current: number) {
    const delta: PresenceDelta = {
      broadcastId,
      previousCount: previous,
      currentCount: current,
      timestamp: new Date(),
    };
    this.emit('viewerCountChanged', delta);
  }
}
