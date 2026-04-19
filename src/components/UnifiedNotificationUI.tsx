"use client";

/**
 * UnifiedNotificationUI — Cross-App Notification Center
 *
 * A full-featured notification inbox that aggregates and displays
 * notifications from all 9 Quant applications in a single panel.
 *
 * Features:
 *  - Grouped by app with individually collapsible sections.
 *  - Quick actions: reply to message, like broadcast, accept match —
 *    without leaving the notification center.
 *  - "Mark all read" per app and globally.
 *  - Filter bar: show only specific app notifications.
 *  - Rich previews: inline image, video thumbnail, message preview.
 *  - Badge count per app.
 *  - Animated entrance / exit powered by Framer Motion.
 *  - Muted-dark theme consistent with the Quantsink design language.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  motion,
  AnimatePresence,
  useReducedMotion,
} from "framer-motion";

// ---------------------------------------------------------------------------
// Local types (mirrors NotificationAggregator without importing the service
// on the client bundle — avoids WS / IndexedDB side-effects at import time).
// ---------------------------------------------------------------------------

export type QuantApp =
  | "quantchat"
  | "quantsink"
  | "quantchill"
  | "quantads"
  | "quantedits"
  | "quanttube"
  | "quantmail"
  | "quantneon"
  | "quantbrowse";

export type NotificationEventType =
  | "message"
  | "broadcast"
  | "match"
  | "ad_performance"
  | "edit_share"
  | "video_engagement"
  | "email"
  | "metaverse_event"
  | "web_clip";

export interface UINotification {
  id: number;
  app: QuantApp;
  type: NotificationEventType;
  title: string;
  body?: string;
  mediaUrl?: string;
  occurredAt: string;
  receivedAt: string;
  senderName?: string;
  read: boolean;
  priorityScore: number;
}

// ---------------------------------------------------------------------------
// App metadata
// ---------------------------------------------------------------------------

interface AppMeta {
  label: string;
  emoji: string;
  accentColor: string;
}

const APP_META: Record<QuantApp, AppMeta> = {
  quantchat:   { label: "Quantchat",   emoji: "💬", accentColor: "#7A9FC9" },
  quantsink:   { label: "Quantsink",   emoji: "📡", accentColor: "#C9A96E" },
  quantchill:  { label: "Quantchill",  emoji: "❤️", accentColor: "#C97A9E" },
  quantads:    { label: "Quantads",    emoji: "📊", accentColor: "#9A7AC9" },
  quantedits:  { label: "Quantedits",  emoji: "✂️", accentColor: "#9EC97A" },
  quanttube:   { label: "Quanttube",   emoji: "🎬", accentColor: "#C9C47A" },
  quantmail:   { label: "Quantmail",   emoji: "📧", accentColor: "#7AC9C4" },
  quantneon:   { label: "Quantneon",   emoji: "🌐", accentColor: "#C97AA0" },
  quantbrowse: { label: "Quantbrowse", emoji: "🔗", accentColor: "#7AC97A" },
};

const ALL_APPS = Object.keys(APP_META) as QuantApp[];

// ---------------------------------------------------------------------------
// Quick-action definitions per event type
// ---------------------------------------------------------------------------

interface QuickAction {
  id: string;
  label: string;
  icon: React.ReactNode;
}

function getQuickActions(type: NotificationEventType): QuickAction[] {
  const replyIcon = (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
    </svg>
  );
  const likeIcon = (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
  const checkIcon = (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
    </svg>
  );
  const openIcon = (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
    </svg>
  );

  switch (type) {
    case "message":
      return [
        { id: "reply",   label: "Reply",   icon: replyIcon },
        { id: "like",    label: "Like",    icon: likeIcon  },
        { id: "open",    label: "Open",    icon: openIcon  },
      ];
    case "broadcast":
      return [
        { id: "like",    label: "Resonate", icon: likeIcon  },
        { id: "reply",   label: "Reply",    icon: replyIcon },
        { id: "open",    label: "Open",     icon: openIcon  },
      ];
    case "match":
      return [
        { id: "accept",  label: "Accept",  icon: checkIcon },
        { id: "open",    label: "View",    icon: openIcon  },
      ];
    case "email":
      return [
        { id: "reply",   label: "Reply",   icon: replyIcon },
        { id: "open",    label: "Open",    icon: openIcon  },
      ];
    case "video_engagement":
      return [
        { id: "like",    label: "Like",    icon: likeIcon  },
        { id: "open",    label: "Watch",   icon: openIcon  },
      ];
    default:
      return [
        { id: "open",    label: "Open",    icon: openIcon  },
      ];
  }
}

// ---------------------------------------------------------------------------
// Mock data — replace with real aggregator subscription in production
// ---------------------------------------------------------------------------

const MOCK_NOTIFICATIONS: UINotification[] = [
  {
    id: 1, app: "quantchat", type: "message",
    title: "New message from Aria",
    body: "Hey, did you catch the new signal drop from the broadcast? It's moving fast.",
    occurredAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    senderName: "Aria Vesper", read: false, priorityScore: 10,
  },
  {
    id: 2, app: "quantsink", type: "broadcast",
    title: "Your broadcast hit 1,000 views",
    body: "Adaptive Alpha Decay reached the Rising Voice milestone.",
    occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    read: false, priorityScore: 5,
  },
  {
    id: 3, app: "quantchill", type: "match",
    title: "New match — Marcus Thorne",
    body: "You both have Kalman Filter in your interest graph.",
    occurredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    senderName: "Marcus Thorne", read: false, priorityScore: 8,
  },
  {
    id: 4, app: "quanttube", type: "video_engagement",
    title: "157 new interactions on your video",
    body: "FPGA-Accelerated Multicast Feed Normalisation is trending.",
    occurredAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    read: false, priorityScore: 5,
  },
  {
    id: 5, app: "quantmail", type: "email",
    title: "Institutional access request",
    body: "Goldman Quant Desk has requested access to your signal stream.",
    occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    senderName: "GS Quant Desk", read: true, priorityScore: 4,
  },
  {
    id: 6, app: "quantchat", type: "message",
    title: "Message from Leo Park",
    body: "Can you share the Heston calibration config from the last broadcast?",
    occurredAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    senderName: "Leo Park", read: true, priorityScore: 10,
  },
  {
    id: 7, app: "quantneon", type: "metaverse_event",
    title: "Live event in 10 minutes",
    body: "Quant Symposium: Rough Volatility Panel — Metaverse Room 3.",
    occurredAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    read: false, priorityScore: 7,
  },
  {
    id: 8, app: "quantads", type: "ad_performance",
    title: "Ad campaign report available",
    body: "Signal Precision campaign reached 98% target audience overlap.",
    occurredAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    receivedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    read: true, priorityScore: 2,
  },
  {
    id: 9, app: "quantedits", type: "edit_share",
    title: "Priya shared an edit with you",
    body: "Vol Surface Arbitrage explainer — draft 2 ready for review.",
    occurredAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    receivedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    senderName: "Priya Anand", read: false, priorityScore: 4,
  },
  {
    id: 10, app: "quantbrowse", type: "web_clip",
    title: "Web clip saved",
    body: "JP Morgan: 2026 Derivatives Outlook — clipped while browsing.",
    occurredAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    receivedAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    read: true, priorityScore: 3,
  },
];

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function groupByApp(
  notifications: UINotification[],
): Map<QuantApp, UINotification[]> {
  const map = new Map<QuantApp, UINotification[]>();
  for (const n of notifications) {
    const arr = map.get(n.app) ?? [];
    arr.push(n);
    map.set(n.app, arr);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PriorityDot({ score }: { score: number }) {
  const color =
    score >= 8 ? "#C97A9E"
    : score >= 5 ? "#C9A96E"
    : "#5A5A5A";
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1"
      style={{ backgroundColor: color }}
      title={`Priority ${score}`}
    />
  );
}

function MediaPreview({ url }: { url: string }) {
  const isVideo = url.includes("video") || /\.(mp4|webm|mov)$/i.test(url);
  return (
    <div
      className="relative mt-2 rounded-sm overflow-hidden flex-shrink-0"
      style={{ width: 72, height: 48, backgroundColor: "#1A1A1A", border: "1px solid #2A2A2A" }}
    >
      {isVideo ? (
        <>
          <div className="absolute inset-0 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#C9A96E" opacity={0.8}>
              <path d="M8 5v14l11-7L8 5z" />
            </svg>
          </div>
          <img src={url} alt="video thumbnail" className="w-full h-full object-cover opacity-50" />
        </>
      ) : (
        <img src={url} alt="preview" className="w-full h-full object-cover" />
      )}
    </div>
  );
}

function NotificationCard({
  notification,
  onMarkRead,
  onAction,
}: {
  notification: UINotification;
  onMarkRead: (id: number) => void;
  onAction: (notificationId: number, actionId: string) => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const meta = APP_META[notification.app];
  const actions = getQuickActions(notification.type);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }
      }
      className="rounded-sm border transition-colors duration-200"
      style={{
        backgroundColor: notification.read ? "#0D0D0D" : "#111111",
        borderColor: notification.read ? "#1A1A1A" : "#222222",
      }}
      onHoverStart={() => setActionsOpen(true)}
      onHoverEnd={() => setActionsOpen(false)}
    >
      <div className="p-4 flex gap-3">
        {/* Priority dot + read indicator */}
        <div className="flex flex-col items-center gap-1 pt-0.5">
          {!notification.read && (
            <div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: meta.accentColor }}
            />
          )}
          {notification.read && <div className="w-1.5 h-1.5" />}
          <PriorityDot score={notification.priorityScore} />
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-0.5">
            <span
              className="text-[11px] font-semibold leading-snug"
              style={{ color: notification.read ? "#5A5A5A" : "#D4D4D4" }}
            >
              {notification.title}
            </span>
            <span className="text-[10px] font-mono flex-shrink-0" style={{ color: "#4A4A4A" }}>
              {relativeTime(notification.occurredAt)}
            </span>
          </div>

          {notification.senderName && (
            <span
              className="text-[10px] font-medium block mb-1"
              style={{ color: meta.accentColor }}
            >
              {notification.senderName}
            </span>
          )}

          {notification.body && (
            <p className="text-[11px] leading-relaxed line-clamp-2" style={{ color: "#5A5A5A" }}>
              {notification.body}
            </p>
          )}

          {notification.mediaUrl && <MediaPreview url={notification.mediaUrl} />}
        </div>
      </div>

      {/* Quick actions — revealed on hover */}
      <AnimatePresence>
        {actionsOpen && (
          <motion.div
            key="actions"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div
              className="px-4 py-2 flex items-center gap-1 border-t"
              style={{ borderColor: "#1A1A1A" }}
            >
              {actions.map((action) => (
                <button
                  key={action.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction(notification.id, action.id);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[10px] tracking-wide font-medium transition-colors duration-150 uppercase"
                  style={{ color: "#5A5A5A" }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = meta.accentColor;
                    (e.currentTarget as HTMLElement).style.backgroundColor = `${meta.accentColor}12`;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "#5A5A5A";
                    (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                  }}
                >
                  {action.icon}
                  {action.label}
                </button>
              ))}

              {!notification.read && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkRead(notification.id);
                  }}
                  className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[10px] tracking-wide font-medium transition-colors duration-150 uppercase"
                  style={{ color: "#3A3A3A" }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "#7A7A7A";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "#3A3A3A";
                  }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                  </svg>
                  Mark read
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function AppSection({
  app,
  notifications,
  onMarkRead,
  onMarkAllRead,
  onAction,
}: {
  app: QuantApp;
  notifications: UINotification[];
  onMarkRead: (id: number) => void;
  onMarkAllRead: (app: QuantApp) => void;
  onAction: (notificationId: number, actionId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const meta = APP_META[app];
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="mb-4">
      {/* Section header */}
      <div
        className="flex items-center gap-2 mb-2 cursor-pointer select-none"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        aria-expanded={!collapsed}
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setCollapsed((c) => !c)}
      >
        <span className="text-base leading-none">{meta.emoji}</span>
        <span
          className="text-[11px] font-semibold tracking-[0.12em] uppercase"
          style={{ color: meta.accentColor }}
        >
          {meta.label}
        </span>

        {unreadCount > 0 && (
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded-sm tabular-nums"
            style={{
              backgroundColor: `${meta.accentColor}20`,
              color: meta.accentColor,
              border: `1px solid ${meta.accentColor}40`,
            }}
          >
            {unreadCount}
          </span>
        )}

        <div className="flex-1" />

        {unreadCount > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMarkAllRead(app);
            }}
            className="text-[9px] tracking-widest uppercase font-medium transition-colors duration-150"
            style={{ color: "#3A3A3A" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "#7A7A7A";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "#3A3A3A";
            }}
          >
            Mark all read
          </button>
        )}

        <motion.div
          animate={{ rotate: collapsed ? -90 : 0 }}
          transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.2 }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="#3A3A3A">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </motion.div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="content"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-1.5">
              {notifications.map((n) => (
                <NotificationCard
                  key={n.id}
                  notification={n}
                  onMarkRead={onMarkRead}
                  onAction={onAction}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  activeFilter,
  badgeCounts,
  onFilterChange,
}: {
  activeFilter: QuantApp | "all";
  badgeCounts: Record<QuantApp, number>;
  onFilterChange: (filter: QuantApp | "all") => void;
}) {
  const totalUnread = Object.values(badgeCounts).reduce((s, n) => s + n, 0);

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {/* "All" chip */}
      <button
        onClick={() => onFilterChange("all")}
        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[10px] font-semibold tracking-wide uppercase transition-all duration-150"
        style={{
          backgroundColor: activeFilter === "all" ? "rgba(201,169,110,0.12)" : "transparent",
          color: activeFilter === "all" ? "#C9A96E" : "#4A4A4A",
          border: `1px solid ${activeFilter === "all" ? "rgba(201,169,110,0.3)" : "#1E1E1E"}`,
        }}
      >
        All
        {totalUnread > 0 && (
          <span
            className="text-[9px] font-bold px-1 py-0 rounded-sm tabular-nums"
            style={{ backgroundColor: "#C9A96E", color: "#0A0A0A" }}
          >
            {totalUnread}
          </span>
        )}
      </button>

      {ALL_APPS.filter((app) => badgeCounts[app] > 0 || activeFilter === app).map((app) => {
        const meta = APP_META[app];
        const count = badgeCounts[app];
        const active = activeFilter === app;
        return (
          <button
            key={app}
            onClick={() => onFilterChange(active ? "all" : app)}
            className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[10px] font-semibold tracking-wide uppercase transition-all duration-150"
            style={{
              backgroundColor: active ? `${meta.accentColor}15` : "transparent",
              color: active ? meta.accentColor : "#4A4A4A",
              border: `1px solid ${active ? `${meta.accentColor}35` : "#1E1E1E"}`,
            }}
          >
            <span>{meta.emoji}</span>
            {meta.label}
            {count > 0 && (
              <span
                className="text-[9px] font-bold px-1 py-0 rounded-sm tabular-nums"
                style={{ backgroundColor: meta.accentColor, color: "#0A0A0A" }}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main UnifiedNotificationUI
// ---------------------------------------------------------------------------

export interface UnifiedNotificationUIProps {
  /**
   * External notifications to display. If not provided, the component
   * uses mock data so it is usable as a standalone preview.
   */
  notifications?: UINotification[];
  /** Called when the user triggers a quick action. */
  onAction?: (notificationId: number, actionId: string) => void;
  /** Whether the panel should be visible. */
  open?: boolean;
  /** Called when the panel requests to be closed. */
  onClose?: () => void;
  /** Inline vs. full panel rendering mode. Default 'panel'. */
  mode?: "panel" | "inline";
}

export default function UnifiedNotificationUI({
  notifications: externalNotifications,
  onAction,
  open = true,
  onClose,
  mode = "panel",
}: UnifiedNotificationUIProps) {
  const shouldReduceMotion = useReducedMotion();
  const [notifications, setNotifications] = useState<UINotification[]>(
    externalNotifications ?? MOCK_NOTIFICATIONS,
  );
  const [filter, setFilter] = useState<QuantApp | "all">("all");
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync external prop changes.
  useEffect(() => {
    if (externalNotifications) {
      setNotifications(externalNotifications);
    }
  }, [externalNotifications]);

  // Close panel on outside click (panel mode only).
  useEffect(() => {
    if (mode !== "panel" || !open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose?.();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [mode, open, onClose]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleMarkRead = useCallback((id: number) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const handleMarkAllRead = useCallback((app?: QuantApp) => {
    setNotifications((prev) =>
      prev.map((n) => (!app || n.app === app ? { ...n, read: true } : n)),
    );
  }, []);

  const handleAction = useCallback(
    (notificationId: number, actionId: string) => {
      if (actionId === "like" || actionId === "accept") {
        handleMarkRead(notificationId);
      }
      onAction?.(notificationId, actionId);
    },
    [handleMarkRead, onAction],
  );

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const filtered = filter === "all"
    ? notifications
    : notifications.filter((n) => n.app === filter);

  const sorted = [...filtered].sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    return b.priorityScore - a.priorityScore;
  });

  const grouped = groupByApp(sorted);

  const badgeCounts = ALL_APPS.reduce((acc, app) => {
    acc[app] = notifications.filter((n) => n.app === app && !n.read).length;
    return acc;
  }, {} as Record<QuantApp, number>);

  const totalUnread = Object.values(badgeCounts).reduce((s, n) => s + n, 0);
  const appsWithNotifications =
    filter === "all"
      ? ALL_APPS.filter((app) => grouped.has(app))
      : ALL_APPS.filter((app) => app === filter && grouped.has(app));

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const content = (
    <div
      ref={panelRef}
      className="flex flex-col"
      style={{
        backgroundColor: "#0A0A0A",
        color: "#D4D4D4",
        fontFamily: "var(--font-body, Inter, sans-serif)",
        height: mode === "panel" ? "100%" : "auto",
        maxHeight: mode === "panel" ? "100vh" : "none",
      }}
    >
      {/* Header */}
      <div
        className="flex-shrink-0 px-5 py-4 border-b flex items-center justify-between gap-3"
        style={{ borderColor: "#1A1A1A" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] tracking-[0.2em] font-semibold uppercase"
            style={{ fontFamily: "var(--font-display, serif)", color: "#D4D4D4" }}
          >
            Notifications
          </span>
          {totalUnread > 0 && (
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded-sm tabular-nums"
              style={{ backgroundColor: "#C9A96E", color: "#0A0A0A" }}
            >
              {totalUnread}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {totalUnread > 0 && (
            <button
              onClick={() => handleMarkAllRead()}
              className="text-[9px] tracking-widest uppercase font-medium transition-colors duration-150"
              style={{ color: "#3A3A3A" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#7A7A7A";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#3A3A3A";
              }}
            >
              Mark all read
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded-sm transition-colors duration-150"
              style={{ color: "#3A3A3A" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#7A7A7A";
                (e.currentTarget as HTMLElement).style.backgroundColor = "#1A1A1A";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#3A3A3A";
                (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
              }}
              aria-label="Close notifications"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div
        className="flex-shrink-0 px-5 py-3 border-b"
        style={{ borderColor: "#1A1A1A" }}
      >
        <FilterBar
          activeFilter={filter}
          badgeCounts={badgeCounts}
          onFilterChange={setFilter}
        />
      </div>

      {/* Notification list */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {appsWithNotifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#2A2A2A"
              strokeWidth="1.5"
            >
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-[11px] tracking-wide" style={{ color: "#2A2A2A" }}>
              No notifications
            </span>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {appsWithNotifications.map((app) => {
              const appNotifications = grouped.get(app);
              if (!appNotifications || appNotifications.length === 0) return null;
              return (
                <AppSection
                  key={app}
                  app={app}
                  notifications={appNotifications}
                  onMarkRead={handleMarkRead}
                  onMarkAllRead={handleMarkAllRead}
                  onAction={handleAction}
                />
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Footer */}
      <div
        className="flex-shrink-0 px-5 py-3 border-t flex items-center justify-between"
        style={{ borderColor: "#1A1A1A" }}
      >
        <span className="text-[9px] tracking-[0.2em] uppercase" style={{ color: "#2A2A2A" }}>
          9 Apps · Unified Inbox
        </span>
        <span className="text-[9px] font-mono tabular-nums" style={{ color: "#2A2A2A" }}>
          {notifications.length} total
        </span>
      </div>
    </div>
  );

  if (mode === "inline") {
    return (
      <div
        className="rounded-sm border overflow-hidden"
        style={{ borderColor: "#1A1A1A", minHeight: 400 }}
      >
        {content}
      </div>
    );
  }

  // Panel mode — slides in from the right.
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.2 }}
            className="fixed inset-0 z-40"
            style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="panel"
            initial={{ x: "100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0 }}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 380, damping: 40 }
            }
            className="fixed top-0 right-0 bottom-0 z-50 w-full sm:w-96 shadow-2xl"
            style={{ borderLeft: "1px solid #1A1A1A" }}
          >
            {content}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
