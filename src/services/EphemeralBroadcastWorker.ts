import { EventEmitter } from 'events';
import logger from '../lib/logger';

/**
 * EphemeralBroadcastWorker — genuine, opt-in, server-side TTL deletion.
 *
 * A broadcast is marked ephemeral at creation time by the user. This worker
 * tracks its expiry and performs a real server-side deletion when the TTL
 * elapses. Nothing is hidden — clients can read the exact `expiresAt` and
 * render a real countdown. Scarcity is genuine, the same model Instagram
 * Stories and Snapchat use.
 */

export const DEFAULT_EPHEMERAL_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface EphemeralBroadcast {
  broadcastId: string;
  authorId: string;
  createdAt: Date;
  expiresAt: Date;
  deletedAt: Date | null;
}

export interface Deleter {
  /** Performs the actual permanent deletion. Must be idempotent. */
  (broadcastId: string): Promise<void>;
}

export interface EphemeralBroadcastWorkerOptions {
  deleter: Deleter;
  /** Interval in ms between sweeps. Default 30s. */
  sweepIntervalMs?: number;
  /** Clock override, primarily for tests. */
  now?: () => number;
}

export class EphemeralBroadcastWorker extends EventEmitter {
  private readonly broadcasts = new Map<string, EphemeralBroadcast>();
  private readonly deleter: Deleter;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: EphemeralBroadcastWorkerOptions) {
    super();
    this.deleter = options.deleter;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Register a new ephemeral broadcast. The user must have explicitly opted
   * in to ephemerality on the client — this service does not decide on
   * behalf of the user.
   */
  register(params: {
    broadcastId: string;
    authorId: string;
    ttlMs?: number;
    createdAt?: Date;
  }): EphemeralBroadcast {
    const createdAt = params.createdAt ?? new Date(this.now());
    const ttlMs = params.ttlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
    if (ttlMs <= 0) throw new Error('TTL must be positive');
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const entry: EphemeralBroadcast = {
      broadcastId: params.broadcastId,
      authorId: params.authorId,
      createdAt,
      expiresAt,
      deletedAt: null,
    };
    this.broadcasts.set(params.broadcastId, entry);
    logger.info(
      { broadcastId: params.broadcastId, authorId: params.authorId, expiresAt },
      'ephemeral.register',
    );
    return entry;
  }

  get(broadcastId: string): EphemeralBroadcast | undefined {
    return this.broadcasts.get(broadcastId);
  }

  remainingMs(broadcastId: string, now: number = this.now()): number {
    const entry = this.broadcasts.get(broadcastId);
    if (!entry || entry.deletedAt) return 0;
    return Math.max(0, entry.expiresAt.getTime() - now);
  }

  /**
   * Run one sweep: delete every broadcast whose TTL has elapsed.
   * Returns the IDs that were expired in this pass.
   */
  async sweep(now: number = this.now()): Promise<string[]> {
    const expired: string[] = [];
    for (const entry of this.broadcasts.values()) {
      if (entry.deletedAt) continue;
      if (entry.expiresAt.getTime() <= now) expired.push(entry.broadcastId);
    }
    for (const id of expired) {
      await this.delete(id, now);
    }
    return expired;
  }

  /**
   * Delete a broadcast immediately (e.g. author-initiated delete) rather than
   * waiting for the TTL.
   */
  async delete(broadcastId: string, now: number = this.now()): Promise<void> {
    const entry = this.broadcasts.get(broadcastId);
    if (!entry || entry.deletedAt) return;
    try {
      await this.deleter(broadcastId);
    } catch (err) {
      logger.error({ err, broadcastId }, 'ephemeral.delete.failed');
      throw err;
    }
    entry.deletedAt = new Date(now);
    logger.info({ broadcastId }, 'ephemeral.delete.ok');
    this.emit('expired', entry);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) =>
        logger.error({ err }, 'ephemeral.sweep.failed'),
      );
    }, this.sweepIntervalMs);
    // Don't let a stray worker keep the node process alive.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
