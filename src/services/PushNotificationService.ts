/**
 * PushNotificationService — Web Push API & Service Worker Bridge
 *
 * Provides browser-side push notification capabilities for the Quant ecosystem:
 *  - Subscribes / unsubscribes from the browser Push API.
 *  - Dispatches grouped, app-aware native notifications.
 *  - Per-app sound customisation via the Web Audio API.
 *  - Bridges with the Service Worker for background notification handling.
 *  - Groups multiple notifications on mobile: "5 new messages across 3 apps."
 *
 * Designed to work in both browser and Node / Jest environments — all
 * browser-only globals are guarded with `typeof` checks so the module can
 * be imported server-side without throwing.
 */

import type { AggregatedNotification, QuantApp } from './NotificationAggregator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationSound = 'chime' | 'ping' | 'buzz' | 'silent';

export interface AppNotificationConfig {
  /** Display name used in grouped summaries. */
  readonly displayName: string;
  /** Emoji / icon character for native notification icon fallback. */
  readonly emoji: string;
  /** Sound to play when a notification arrives. */
  sound: NotificationSound;
  /** Whether native push is enabled for this app. */
  enabled: boolean;
}

export const DEFAULT_APP_CONFIGS: Readonly<Record<QuantApp, AppNotificationConfig>> = {
  quantchat:   { displayName: 'Quantchat',   emoji: '💬', sound: 'chime',  enabled: true },
  quantsink:   { displayName: 'Quantsink',   emoji: '📡', sound: 'chime',  enabled: true },
  quantchill:  { displayName: 'Quantchill',  emoji: '❤️', sound: 'ping',   enabled: true },
  quantads:    { displayName: 'Quantads',    emoji: '📊', sound: 'silent', enabled: false },
  quantedits:  { displayName: 'Quantedits',  emoji: '✂️', sound: 'ping',   enabled: true },
  quanttube:   { displayName: 'Quanttube',   emoji: '🎬', sound: 'ping',   enabled: true },
  quantmail:   { displayName: 'Quantmail',   emoji: '📧', sound: 'chime',  enabled: true },
  quantneon:   { displayName: 'Quantneon',   emoji: '🌐', sound: 'buzz',   enabled: true },
  quantbrowse: { displayName: 'Quantbrowse', emoji: '🔗', sound: 'silent', enabled: false },
};

export interface PushSubscriptionData {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export interface GroupedNotificationSummary {
  readonly totalCount: number;
  readonly appsInvolved: QuantApp[];
  readonly summary: string;
}

export interface PushServiceOptions {
  /** VAPID public key for Web Push subscription. */
  readonly vapidPublicKey?: string;
  /** Service worker script path. Default '/sw.js'. */
  readonly serviceWorkerPath?: string;
  /** Override app configs. */
  readonly appConfigs?: Partial<Record<QuantApp, Partial<AppNotificationConfig>>>;
  /** How many pending notifications to batch before showing a grouped summary. */
  readonly groupingThreshold?: number;
  /** Clock override for testing. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Audio helper (browser-only)
// ---------------------------------------------------------------------------

const SOUND_FREQUENCIES: Record<NotificationSound, number | null> = {
  chime:  880,
  ping:   1046,
  buzz:   220,
  silent: null,
};

/**
 * Play a short notification sound using the Web Audio API.
 * Silently no-ops in environments without AudioContext.
 */
export function playNotificationSound(sound: NotificationSound): void {
  if (typeof window === 'undefined') return;
  if (sound === 'silent') return;
  const freq = SOUND_FREQUENCIES[sound];
  if (!freq) return;

  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.4);

    oscillator.onended = () => ctx.close();
  } catch {
    // Audio failures are non-fatal.
  }
}

// ---------------------------------------------------------------------------
// VAPID key conversion helper
// ---------------------------------------------------------------------------

/**
 * Convert a base64url-encoded VAPID public key to a Uint8Array suitable
 * for the Web Push subscription API.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ---------------------------------------------------------------------------
// PushNotificationService
// ---------------------------------------------------------------------------

export class PushNotificationService {
  private readonly vapidPublicKey: string;
  private readonly serviceWorkerPath: string;
  private readonly groupingThreshold: number;
  private readonly now: () => number;

  private readonly appConfigs: Record<QuantApp, AppNotificationConfig>;

  /** Buffered notifications waiting to be dispatched or grouped. */
  private pending: AggregatedNotification[] = [];

  /** SW registration reference (browser only). */
  private swRegistration: ServiceWorkerRegistration | null = null;

  constructor(options: PushServiceOptions = {}) {
    this.vapidPublicKey = options.vapidPublicKey ?? '';
    this.serviceWorkerPath = options.serviceWorkerPath ?? '/sw.js';
    this.groupingThreshold = options.groupingThreshold ?? 5;
    this.now = options.now ?? Date.now.bind(Date);

    // Deep merge per-app overrides.
    const merged: Record<string, AppNotificationConfig> = {};
    for (const [app, defaults] of Object.entries(DEFAULT_APP_CONFIGS)) {
      merged[app] = {
        ...defaults,
        ...(options.appConfigs?.[app as QuantApp] ?? {}),
      };
    }
    this.appConfigs = merged as Record<QuantApp, AppNotificationConfig>;
  }

  // -------------------------------------------------------------------------
  // Service Worker registration
  // -------------------------------------------------------------------------

  /**
   * Register the service worker and cache the registration.
   * Resolves immediately in non-browser environments.
   */
  async registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return null;
    }
    try {
      this.swRegistration = await navigator.serviceWorker.register(
        this.serviceWorkerPath,
        { scope: '/' },
      );
      return this.swRegistration;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Web Push subscription
  // -------------------------------------------------------------------------

  /**
   * Request notification permission and subscribe to Web Push.
   * Returns the subscription data to be sent to the server for VAPID delivery.
   * Returns null if permission is denied or the environment does not support push.
   */
  async subscribe(): Promise<PushSubscriptionData | null> {
    if (typeof window === 'undefined') return null;
    if (!('Notification' in window) || !('PushManager' in window)) return null;

    // Request permission.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return null;

    // Ensure SW is registered.
    let reg = this.swRegistration;
    if (!reg) {
      reg = await this.registerServiceWorker();
    }
    if (!reg) return null;

    try {
      let subscribeOptions: PushSubscriptionOptionsInit = { userVisibleOnly: true };
      if (this.vapidPublicKey) {
        subscribeOptions = {
          ...subscribeOptions,
          applicationServerKey: urlBase64ToUint8Array(this.vapidPublicKey),
        };
      }
      const subscription = await reg.pushManager.subscribe(subscribeOptions);
      const json = subscription.toJSON();
      const keys = json.keys as { p256dh: string; auth: string } | undefined;

      if (!json.endpoint || !keys?.p256dh || !keys?.auth) return null;

      return {
        endpoint: json.endpoint,
        keys: {
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Unsubscribe from Web Push.
   */
  async unsubscribe(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const reg = this.swRegistration ?? (await this.registerServiceWorker());
    if (!reg) return false;
    try {
      const subscription = await reg.pushManager.getSubscription();
      if (!subscription) return true;
      return subscription.unsubscribe();
    } catch {
      return false;
    }
  }

  /**
   * Check if the user is currently subscribed to Web Push.
   */
  async isSubscribed(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const reg = this.swRegistration ?? (await this.registerServiceWorker());
    if (!reg) return false;
    try {
      const subscription = await reg.pushManager.getSubscription();
      return subscription !== null;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Native notification dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch a single native browser notification for `notification`.
   * Respects per-app enabled flag and plays the configured sound.
   */
  dispatch(notification: AggregatedNotification): void {
    const config = this.appConfigs[notification.app];
    if (!config.enabled) return;

    this.pending.push(notification);

    if (this.pending.length >= this.groupingThreshold) {
      this.flushGrouped();
      return;
    }

    this.showSingle(notification, config);
    playNotificationSound(config.sound);
  }

  private showSingle(
    notification: AggregatedNotification,
    config: AppNotificationConfig,
  ): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const body = notification.body ?? notification.title;
    const title = `${config.emoji} ${config.displayName}`;

    try {
      new Notification(title, {
        body,
        tag: `quant-${notification.app}-${notification.id}`,
        icon: `/icons/${notification.app}.png`,
        data: { notificationId: notification.id, app: notification.app },
      });
    } catch {
      // Notification construction failures are non-fatal.
    }
  }

  /**
   * Flush pending notifications as a single grouped summary notification.
   */
  flushGrouped(): void {
    if (this.pending.length === 0) return;

    const summary = this.buildGroupedSummary(this.pending);
    this.pending = [];

    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    try {
      new Notification('Quant Notifications', {
        body: summary.summary,
        tag: `quant-grouped-${this.now()}`,
        icon: '/icons/quant-unified.png',
        data: { grouped: true, appsInvolved: summary.appsInvolved },
      });
    } catch {
      // Non-fatal.
    }

    playNotificationSound('chime');
  }

  /**
   * Build a human-readable grouped summary string.
   * e.g. "5 new notifications across 3 apps: Quantchat, Quantsink, Quantchill."
   */
  buildGroupedSummary(notifications: AggregatedNotification[]): GroupedNotificationSummary {
    const appSet = new Set<QuantApp>(notifications.map((n) => n.app));
    const appsInvolved = Array.from(appSet);
    const appNames = appsInvolved
      .map((a) => this.appConfigs[a]?.displayName ?? a)
      .join(', ');

    const summary =
      `${notifications.length} new notification${notifications.length !== 1 ? 's' : ''} ` +
      `across ${appsInvolved.length} app${appsInvolved.length !== 1 ? 's' : ''}: ${appNames}.`;

    return {
      totalCount: notifications.length,
      appsInvolved,
      summary,
    };
  }

  // -------------------------------------------------------------------------
  // Per-app configuration
  // -------------------------------------------------------------------------

  setAppSound(app: QuantApp, sound: NotificationSound): void {
    this.appConfigs[app] = { ...this.appConfigs[app], sound };
  }

  setAppEnabled(app: QuantApp, enabled: boolean): void {
    this.appConfigs[app] = { ...this.appConfigs[app], enabled };
  }

  getAppConfig(app: QuantApp): AppNotificationConfig {
    return { ...this.appConfigs[app] };
  }

  getAllAppConfigs(): Record<QuantApp, AppNotificationConfig> {
    const out: Partial<Record<QuantApp, AppNotificationConfig>> = {};
    for (const app of Object.keys(this.appConfigs) as QuantApp[]) {
      out[app] = { ...this.appConfigs[app] };
    }
    return out as Record<QuantApp, AppNotificationConfig>;
  }

  // -------------------------------------------------------------------------
  // Pending buffer management
  // -------------------------------------------------------------------------

  pendingCount(): number {
    return this.pending.length;
  }

  clearPending(): void {
    this.pending = [];
  }
}

export default PushNotificationService;
