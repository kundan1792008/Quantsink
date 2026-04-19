"use client";

/**
 * UnifiedNotificationUI — Quant cross-app inbox surface
 *
 * Issue #23 (sub-task 3). Renders the user-facing notification center that
 * the `NotificationAggregator` feeds. The component is intentionally
 * presentational + pluggable: every side-effecting capability (subscribe to
 * the aggregator, toggle DND, invoke an action…) is exposed through a
 * controller object so the same UI can run with a real aggregator in
 * production and an in-memory stub in Storybook / tests.
 *
 * Features (all from the issue spec):
 *
 *   • Grouped by app with collapsible sections + per-app badge counts.
 *   • Per-app + global "Mark all read".
 *   • App filter chip-row.
 *   • Quick actions surfaced inline (reply, like, accept…) without
 *     leaving the notification center.
 *   • Rich previews — image, video poster, message snippet, audio.
 *   • Search box across title/body/sender.
 *   • Sort by priority or recency.
 *   • Snooze, dismiss and "Do Not Disturb" controls.
 *   • Empty/loading/error states.
 *
 * Styling matches the Quantsink "muted-luxury" tokens already defined in
 * `tailwind.config.js` (#0A0A0A bg, gold #C9A96E accent, Inter / Geist).
 */

import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "framer-motion";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  NotificationAggregator,
  NotificationListFilter,
  QuantApp,
  UnifiedNotification,
} from "../services/NotificationAggregator";
import { QUANT_APPS } from "../services/NotificationAggregator";

// ---------------------------------------------------------------------------
// Public types — keep the surface small so the component stays portable
// ---------------------------------------------------------------------------

export interface UnifiedNotificationUIProps {
  /** The bound aggregator. The component subscribes on mount, unsubscribes on unmount. */
  aggregator: NotificationAggregator;
  /** When true the panel renders. Parent owns visibility (e.g. drawer). */
  open: boolean;
  /** Callback when user requests to close the panel. */
  onClose?: () => void;
  /** Callback when user clicks a notification body (deep-link routing). */
  onOpenNotification?: (n: UnifiedNotification) => void;
  /** Optional toggle handler for the global DND switch. */
  onToggleDnd?: (enabled: boolean) => void;
  /** Whether DND is currently on. Owned by the parent. */
  dndEnabled?: boolean;
  /** Initial filter applied on mount. */
  initialFilter?: NotificationListFilter;
  /** Tailwind class name for the outer container. */
  className?: string;
  /** Page size for paginated lists. Default 50. */
  pageSize?: number;
  /** When true the panel pins itself instead of collapsing apps. */
  pinned?: boolean;
}

// ---------------------------------------------------------------------------
// App display metadata (used for chips, badges, headers)
// ---------------------------------------------------------------------------

interface AppMeta {
  readonly id: QuantApp;
  readonly label: string;
  readonly initial: string;
  readonly accentClass: string;
  readonly description: string;
}

const APP_META: Readonly<Record<QuantApp, AppMeta>> = {
  quantsink: {
    id: "quantsink",
    label: "Quantsink",
    initial: "S",
    accentClass: "text-brand-accent",
    description: "Broadcasts & feed",
  },
  quantchat: {
    id: "quantchat",
    label: "Quantchat",
    initial: "C",
    accentClass: "text-emerald-300",
    description: "Direct messages",
  },
  quantchill: {
    id: "quantchill",
    label: "Quantchill",
    initial: "H",
    accentClass: "text-pink-300",
    description: "Matches & dating",
  },
  quantads: {
    id: "quantads",
    label: "Quantads",
    initial: "A",
    accentClass: "text-amber-300",
    description: "Ads platform",
  },
  quantedits: {
    id: "quantedits",
    label: "Quantedits",
    initial: "E",
    accentClass: "text-purple-300",
    description: "Collab edits",
  },
  quanttube: {
    id: "quanttube",
    label: "Quanttube",
    initial: "T",
    accentClass: "text-red-300",
    description: "Long-form video",
  },
  quantmail: {
    id: "quantmail",
    label: "Quantmail",
    initial: "M",
    accentClass: "text-sky-300",
    description: "Email",
  },
  quantneon: {
    id: "quantneon",
    label: "Quantneon",
    initial: "N",
    accentClass: "text-fuchsia-300",
    description: "Metaverse",
  },
  quantbrowse: {
    id: "quantbrowse",
    label: "Quantbrowse",
    initial: "B",
    accentClass: "text-orange-300",
    description: "Web clips",
  },
};

// ---------------------------------------------------------------------------
// Utility hooks
// ---------------------------------------------------------------------------

/** Live snapshot of the aggregator store, refreshed on aggregator events. */
function useNotifications(
  aggregator: NotificationAggregator,
  filter: NotificationListFilter | undefined,
): { items: UnifiedNotification[]; refresh: () => void; loading: boolean } {
  const [items, setItems] = useState<UnifiedNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const refresh = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    aggregator
      .list(filterRef.current)
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aggregator]);

  useEffect(() => {
    const cleanup = refresh();
    const offNotif = aggregator.on("notification", () => refresh());
    const offUpdate = aggregator.on("update", () => refresh());
    const offRead = aggregator.on("read", () => refresh());
    const offDismiss = aggregator.on("dismiss", () => refresh());
    return () => {
      cleanup?.();
      offNotif();
      offUpdate();
      offRead();
      offDismiss();
    };
  }, [aggregator, refresh]);

  return { items, refresh, loading };
}

/** Returns true when any of the listed apps has unread notifications. */
function useBadgeCounts(aggregator: NotificationAggregator): Record<QuantApp, number> {
  const [counts, setCounts] = useState<Record<QuantApp, number>>(emptyCounts());

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      aggregator.badgeCounts().then((next) => {
        if (!cancelled) setCounts(next);
      });
    };
    refresh();
    const offN = aggregator.on("notification", refresh);
    const offU = aggregator.on("update", refresh);
    const offR = aggregator.on("read", refresh);
    const offD = aggregator.on("dismiss", refresh);
    return () => {
      cancelled = true;
      offN();
      offU();
      offR();
      offD();
    };
  }, [aggregator]);

  return counts;
}

function emptyCounts(): Record<QuantApp, number> {
  const out = {} as Record<QuantApp, number>;
  for (const a of QUANT_APPS) out[a] = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function UnifiedNotificationUI(props: UnifiedNotificationUIProps): JSX.Element | null {
  const {
    aggregator,
    open,
    onClose,
    onOpenNotification,
    onToggleDnd,
    dndEnabled = false,
    initialFilter,
    className,
    pageSize = 50,
    pinned = false,
  } = props;

  const reduceMotion = useReducedMotion();

  const [appFilter, setAppFilter] = useState<QuantApp | "all">("all");
  const [showRead, setShowRead] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"priority" | "receivedAt">("priority");
  const [collapsed, setCollapsed] = useState<Record<QuantApp, boolean>>(() => {
    const out = {} as Record<QuantApp, boolean>;
    for (const a of QUANT_APPS) out[a] = false;
    return out;
  });
  const [snoozePickerFor, setSnoozePickerFor] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const filter = useMemo<NotificationListFilter>(() => {
    return {
      ...(initialFilter ?? {}),
      app: appFilter === "all" ? undefined : appFilter,
      orderBy: sortKey,
      order: "desc",
      limit: pageSize,
    };
  }, [appFilter, initialFilter, pageSize, sortKey]);

  const { items, loading, refresh } = useNotifications(aggregator, filter);
  const badgeCounts = useBadgeCounts(aggregator);

  // ---- Derived view model -------------------------------------------------
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((n) => {
      if (!showRead && n.read) return false;
      if (n.dismissed) return false;
      if (q) {
        const hay = `${n.title} ${n.body} ${n.senderName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, search, showRead]);

  const grouped = useMemo(() => {
    const out = new Map<QuantApp, UnifiedNotification[]>();
    for (const a of QUANT_APPS) out.set(a, []);
    for (const n of filteredItems) {
      const arr = out.get(n.app);
      if (arr) arr.push(n);
    }
    for (const arr of Array.from(out.values())) {
      arr.sort((a: UnifiedNotification, b: UnifiedNotification) => {
        if (sortKey === "priority") return b.priority - a.priority;
        return Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
      });
    }
    return out;
  }, [filteredItems, sortKey]);

  // ---- Action handlers ----------------------------------------------------
  const handleMarkAllGlobally = useCallback(async () => {
    setBusyAction("mark-all-global");
    try {
      await aggregator.markAllReadGlobally();
      refresh();
    } finally {
      setBusyAction(null);
    }
  }, [aggregator, refresh]);

  const handleMarkAllForApp = useCallback(
    async (app: QuantApp) => {
      setBusyAction(`mark-all-${app}`);
      try {
        await aggregator.markAllReadForApp(app);
        refresh();
      } finally {
        setBusyAction(null);
      }
    },
    [aggregator, refresh],
  );

  const handleAction = useCallback(
    async (n: UnifiedNotification, actionId: string) => {
      setBusyAction(`${n.id}:${actionId}`);
      try {
        await aggregator.invokeAction(n.id, actionId);
      } catch (err) {
        // Errors are surfaced via aggregator's `error` event; UI stays calm.
        console.warn("Notification action failed", err);
      } finally {
        setBusyAction(null);
      }
    },
    [aggregator],
  );

  const handleDismiss = useCallback(
    async (n: UnifiedNotification) => {
      setBusyAction(`${n.id}:dismiss`);
      try {
        await aggregator.dismiss(n.id);
      } finally {
        setBusyAction(null);
      }
    },
    [aggregator],
  );

  const handleSnooze = useCallback(
    async (n: UnifiedNotification, ms: number) => {
      setSnoozePickerFor(null);
      setBusyAction(`${n.id}:snooze`);
      try {
        await aggregator.snooze(n.id, ms);
      } finally {
        setBusyAction(null);
      }
    },
    [aggregator],
  );

  const handleOpen = useCallback(
    async (n: UnifiedNotification) => {
      await aggregator.markRead(n.id);
      onOpenNotification?.(n);
    },
    [aggregator, onOpenNotification],
  );

  const totalUnread = useMemo(
    () => Object.values(badgeCounts).reduce((s, x) => s + x, 0),
    [badgeCounts],
  );

  // ---- Animations ---------------------------------------------------------
  const panelTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.35, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] };

  if (!open) return null;

  return (
    <motion.aside
      role="dialog"
      aria-modal="false"
      aria-label="Unified notification center"
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={panelTransition}
      className={[
        "fixed top-0 right-0 z-40 h-full w-full max-w-[420px]",
        "bg-[#0A0A0A] border-l border-brand-border",
        "flex flex-col text-brand-text font-body",
        className ?? "",
      ].join(" ")}
    >
      <PanelHeader
        totalUnread={totalUnread}
        onMarkAll={handleMarkAllGlobally}
        markAllBusy={busyAction === "mark-all-global"}
        onClose={onClose}
        onToggleDnd={onToggleDnd}
        dndEnabled={dndEnabled}
      />

      <PanelControls
        appFilter={appFilter}
        onAppFilter={setAppFilter}
        showRead={showRead}
        onShowRead={setShowRead}
        search={search}
        onSearch={setSearch}
        sortKey={sortKey}
        onSortKey={setSortKey}
        badgeCounts={badgeCounts}
      />

      <div className="flex-1 overflow-y-auto" data-testid="unified-notifications-list">
        {loading && items.length === 0 ? (
          <SkeletonList />
        ) : filteredItems.length === 0 ? (
          <EmptyState pinned={pinned} />
        ) : (
          <LayoutGroup>
            {QUANT_APPS.map((app) => {
              const list = grouped.get(app) ?? [];
              if (list.length === 0) return null;
              const isCollapsed = !pinned && collapsed[app];
              return (
                <AppGroup
                  key={app}
                  app={app}
                  items={list}
                  collapsed={isCollapsed}
                  onToggleCollapse={() =>
                    setCollapsed((prev) => ({ ...prev, [app]: !prev[app] }))
                  }
                  onMarkAll={() => handleMarkAllForApp(app)}
                  markAllBusy={busyAction === `mark-all-${app}`}
                  onAction={handleAction}
                  onDismiss={handleDismiss}
                  onOpen={handleOpen}
                  onRequestSnooze={(id) => setSnoozePickerFor(id)}
                  snoozePickerFor={snoozePickerFor}
                  onSnooze={handleSnooze}
                  onCancelSnoozePicker={() => setSnoozePickerFor(null)}
                  busyAction={busyAction}
                  unread={badgeCounts[app] ?? 0}
                />
              );
            })}
          </LayoutGroup>
        )}
      </div>

      <PanelFooter aggregator={aggregator} />
    </motion.aside>
  );
}

// ---------------------------------------------------------------------------
// Header / controls / footer
// ---------------------------------------------------------------------------

interface PanelHeaderProps {
  totalUnread: number;
  onMarkAll: () => void;
  markAllBusy: boolean;
  onClose?: () => void;
  onToggleDnd?: (enabled: boolean) => void;
  dndEnabled: boolean;
}

function PanelHeader(props: PanelHeaderProps): JSX.Element {
  const { totalUnread, onMarkAll, markAllBusy, onClose, onToggleDnd, dndEnabled } = props;
  return (
    <header className="flex-shrink-0 px-5 py-4 border-b border-brand-border flex items-center gap-3">
      <div className="flex-1 flex flex-col">
        <h2
          className="text-lg font-display tracking-[0.18em] text-brand-text"
          style={{ fontFamily: "var(--font-display)" }}
        >
          INBOX
        </h2>
        <span className="text-[10px] tracking-[0.22em] text-brand-subtext uppercase">
          {totalUnread === 0 ? "Zero unread" : `${totalUnread} unread`}
        </span>
      </div>
      <button
        type="button"
        onClick={onMarkAll}
        disabled={markAllBusy || totalUnread === 0}
        className={[
          "text-[10px] tracking-[0.22em] uppercase px-3 py-2 rounded-sm border",
          "border-brand-border text-brand-subtext hover:text-brand-text hover:border-brand-accent",
          "disabled:opacity-40 disabled:cursor-not-allowed transition-colors",
        ].join(" ")}
      >
        {markAllBusy ? "Working…" : "Mark all"}
      </button>
      {onToggleDnd ? (
        <button
          type="button"
          onClick={() => onToggleDnd(!dndEnabled)}
          aria-pressed={dndEnabled}
          className={[
            "text-[10px] tracking-[0.22em] uppercase px-3 py-2 rounded-sm border transition-colors",
            dndEnabled
              ? "border-brand-accent text-brand-accent"
              : "border-brand-border text-brand-subtext hover:text-brand-text hover:border-brand-accent",
          ].join(" ")}
        >
          DND
        </button>
      ) : null}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notification center"
          className="text-brand-subtext hover:text-brand-text text-lg leading-none w-8 h-8 flex items-center justify-center"
        >
          ×
        </button>
      ) : null}
    </header>
  );
}

interface PanelControlsProps {
  appFilter: QuantApp | "all";
  onAppFilter: (app: QuantApp | "all") => void;
  showRead: boolean;
  onShowRead: (v: boolean) => void;
  search: string;
  onSearch: (v: string) => void;
  sortKey: "priority" | "receivedAt";
  onSortKey: (v: "priority" | "receivedAt") => void;
  badgeCounts: Record<QuantApp, number>;
}

function PanelControls(props: PanelControlsProps): JSX.Element {
  const {
    appFilter,
    onAppFilter,
    showRead,
    onShowRead,
    search,
    onSearch,
    sortKey,
    onSortKey,
    badgeCounts,
  } = props;
  return (
    <div className="flex-shrink-0 px-5 pt-3 pb-4 border-b border-brand-border flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          type="search"
          placeholder="Search inbox…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="flex-1 bg-transparent border border-brand-border rounded-sm px-3 py-2 text-sm placeholder:text-brand-subtext focus:border-brand-accent focus:outline-none"
        />
        <select
          aria-label="Sort by"
          value={sortKey}
          onChange={(e) => onSortKey(e.target.value as "priority" | "receivedAt")}
          className="bg-transparent border border-brand-border rounded-sm px-2 text-xs text-brand-subtext focus:border-brand-accent focus:outline-none"
        >
          <option value="priority">Priority</option>
          <option value="receivedAt">Recent</option>
        </select>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto -mx-1 px-1 pb-1">
        <FilterChip
          label="All"
          active={appFilter === "all"}
          onClick={() => onAppFilter("all")}
        />
        {QUANT_APPS.map((app) => (
          <FilterChip
            key={app}
            label={APP_META[app].label}
            initial={APP_META[app].initial}
            badge={badgeCounts[app] ?? 0}
            accentClass={APP_META[app].accentClass}
            active={appFilter === app}
            onClick={() => onAppFilter(app)}
          />
        ))}
      </div>

      <label className="flex items-center gap-2 text-[10px] tracking-[0.22em] text-brand-subtext uppercase cursor-pointer">
        <input
          type="checkbox"
          checked={showRead}
          onChange={(e) => onShowRead(e.target.checked)}
          className="w-3 h-3 accent-brand-accent"
        />
        Show read
      </label>
    </div>
  );
}

interface FilterChipProps {
  label: string;
  initial?: string;
  badge?: number;
  accentClass?: string;
  active: boolean;
  onClick: () => void;
}

function FilterChip(props: FilterChipProps): JSX.Element {
  const { label, initial, badge, accentClass, active, onClick } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] tracking-[0.18em] uppercase whitespace-nowrap transition-colors",
        active
          ? "border-brand-accent text-brand-text bg-brand-surface"
          : "border-brand-border text-brand-subtext hover:text-brand-text hover:border-brand-accent",
      ].join(" ")}
    >
      {initial ? (
        <span
          className={["text-xs font-display", accentClass ?? "text-brand-accent"].join(" ")}
          style={{ fontFamily: "var(--font-display)" }}
          aria-hidden
        >
          {initial}
        </span>
      ) : null}
      <span>{label}</span>
      {badge && badge > 0 ? (
        <span className="text-[10px] bg-brand-accent text-black rounded-full min-w-[18px] text-center px-1.5">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

function PanelFooter({ aggregator }: { aggregator: NotificationAggregator }): JSX.Element {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const tick = () => setPending(aggregator.pendingCount());
    tick();
    const off = aggregator.on("rateLimited", tick);
    const id = setInterval(tick, 5_000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [aggregator]);
  return (
    <footer className="flex-shrink-0 px-5 py-3 border-t border-brand-border text-[10px] tracking-[0.22em] uppercase text-brand-subtext flex items-center justify-between">
      <span>{aggregator.isConnected() ? "● Live bus" : "○ Reconnecting"}</span>
      {pending > 0 ? <span>{pending} queued</span> : <span>Quiet inbox</span>}
    </footer>
  );
}

// ---------------------------------------------------------------------------
// App group section
// ---------------------------------------------------------------------------

interface AppGroupProps {
  app: QuantApp;
  items: UnifiedNotification[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMarkAll: () => void;
  markAllBusy: boolean;
  onAction: (n: UnifiedNotification, actionId: string) => void;
  onDismiss: (n: UnifiedNotification) => void;
  onOpen: (n: UnifiedNotification) => void;
  onRequestSnooze: (id: string) => void;
  snoozePickerFor: string | null;
  onSnooze: (n: UnifiedNotification, ms: number) => void;
  onCancelSnoozePicker: () => void;
  busyAction: string | null;
  unread: number;
}

function AppGroup(props: AppGroupProps): JSX.Element {
  const {
    app,
    items,
    collapsed,
    onToggleCollapse,
    onMarkAll,
    markAllBusy,
    onAction,
    onDismiss,
    onOpen,
    onRequestSnooze,
    snoozePickerFor,
    onSnooze,
    onCancelSnoozePicker,
    busyAction,
    unread,
  } = props;

  const meta = APP_META[app];
  return (
    <section className="border-b border-brand-border" aria-label={`${meta.label} notifications`}>
      <header className="flex items-center gap-3 px-5 py-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-controls={`app-${app}`}
          className="flex items-center gap-3 flex-1 text-left group"
        >
          <span
            className={[
              "w-7 h-7 rounded-sm flex items-center justify-center border border-brand-border text-sm font-display",
              meta.accentClass,
            ].join(" ")}
            style={{ fontFamily: "var(--font-display)" }}
            aria-hidden
          >
            {meta.initial}
          </span>
          <div className="flex flex-col">
            <span className="text-sm tracking-[0.12em] uppercase text-brand-text group-hover:text-brand-accent transition-colors">
              {meta.label}
            </span>
            <span className="text-[10px] tracking-[0.22em] uppercase text-brand-subtext">
              {meta.description}
            </span>
          </div>
          <span className="ml-auto text-xs text-brand-subtext">
            {unread > 0 ? `${unread} unread` : `${items.length}`}
          </span>
          <span
            className={[
              "ml-2 text-brand-subtext transition-transform",
              collapsed ? "rotate-0" : "rotate-90",
            ].join(" ")}
            aria-hidden
          >
            ▸
          </span>
        </button>
        <button
          type="button"
          onClick={onMarkAll}
          disabled={markAllBusy || unread === 0}
          className="text-[10px] tracking-[0.22em] uppercase text-brand-subtext hover:text-brand-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {markAllBusy ? "…" : "Mark"}
        </button>
      </header>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.ul
            id={`app-${app}`}
            key="open"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {items.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onAction={onAction}
                onDismiss={onDismiss}
                onOpen={onOpen}
                onRequestSnooze={onRequestSnooze}
                showSnoozePicker={snoozePickerFor === n.id}
                onSnooze={onSnooze}
                onCancelSnoozePicker={onCancelSnoozePicker}
                busyAction={busyAction}
              />
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Notification row
// ---------------------------------------------------------------------------

interface NotificationRowProps {
  notification: UnifiedNotification;
  onAction: (n: UnifiedNotification, actionId: string) => void;
  onDismiss: (n: UnifiedNotification) => void;
  onOpen: (n: UnifiedNotification) => void;
  onRequestSnooze: (id: string) => void;
  showSnoozePicker: boolean;
  onSnooze: (n: UnifiedNotification, ms: number) => void;
  onCancelSnoozePicker: () => void;
  busyAction: string | null;
}

function NotificationRow(props: NotificationRowProps): JSX.Element {
  const {
    notification,
    onAction,
    onDismiss,
    onOpen,
    onRequestSnooze,
    showSnoozePicker,
    onSnooze,
    onCancelSnoozePicker,
    busyAction,
  } = props;

  const reduceMotion = useReducedMotion();
  const isBusy = busyAction?.startsWith(`${notification.id}:`) ?? false;
  const isSnoozed =
    typeof notification.snoozedUntil === "number" && notification.snoozedUntil > Date.now();

  return (
    <motion.li
      layout
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, x: 24 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={[
        "px-5 py-4 border-t border-brand-border/60",
        notification.read ? "bg-transparent" : "bg-[#101010]",
        isSnoozed ? "opacity-60" : "",
      ].join(" ")}
      data-testid={`notification-${notification.id}`}
    >
      <div className="flex items-start gap-3">
        <PriorityPip priority={notification.priority} />
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => onOpen(notification)}
            className="text-left w-full group"
          >
            <div className="flex items-center gap-2">
              <h3
                className={[
                  "text-sm font-display tracking-[0.05em] text-brand-text truncate",
                  notification.read ? "" : "font-bold",
                ].join(" ")}
                style={{ fontFamily: "var(--font-display)" }}
              >
                {notification.title}
              </h3>
              {notification.senderName ? (
                <span className="text-[10px] tracking-[0.18em] uppercase text-brand-subtext">
                  · {notification.senderName}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-brand-subtext mt-1 line-clamp-2">
              {notification.body}
            </p>
          </button>

          <NotificationPreviews previews={notification.previews} />

          <div className="flex items-center gap-3 mt-3 flex-wrap">
            <time
              dateTime={notification.occurredAt}
              className="text-[10px] tracking-[0.22em] uppercase text-brand-subtext"
            >
              {formatRelativeTime(notification.occurredAt)}
            </time>
            {notification.actions.slice(0, 3).map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => onAction(notification, action.id)}
                disabled={isBusy}
                className="text-[10px] tracking-[0.22em] uppercase text-brand-text hover:text-brand-accent border border-brand-border hover:border-brand-accent rounded-sm px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() =>
                showSnoozePicker ? onCancelSnoozePicker() : onRequestSnooze(notification.id)
              }
              className="text-[10px] tracking-[0.22em] uppercase text-brand-subtext hover:text-brand-accent ml-auto"
            >
              Snooze
            </button>
            <button
              type="button"
              onClick={() => onDismiss(notification)}
              disabled={isBusy}
              className="text-[10px] tracking-[0.22em] uppercase text-brand-subtext hover:text-brand-accent disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Dismiss
            </button>
          </div>

          <AnimatePresence>
            {showSnoozePicker ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3 flex items-center gap-2 overflow-hidden"
              >
                <SnoozeOption label="15m" onClick={() => onSnooze(notification, 15 * 60_000)} />
                <SnoozeOption label="1h" onClick={() => onSnooze(notification, 60 * 60_000)} />
                <SnoozeOption label="4h" onClick={() => onSnooze(notification, 4 * 60 * 60_000)} />
                <SnoozeOption label="24h" onClick={() => onSnooze(notification, 24 * 60 * 60_000)} />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </motion.li>
  );
}

function SnoozeOption({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] tracking-[0.22em] uppercase text-brand-text hover:text-brand-accent border border-brand-border hover:border-brand-accent rounded-sm px-2 py-1 transition-colors"
    >
      {label}
    </button>
  );
}

function PriorityPip({ priority }: { priority: number }): JSX.Element {
  let color = "bg-brand-muted";
  if (priority >= 9) color = "bg-brand-accent";
  else if (priority >= 7) color = "bg-emerald-400";
  else if (priority >= 5) color = "bg-sky-400";
  else if (priority >= 3) color = "bg-amber-400";
  return (
    <span
      aria-label={`Priority ${priority}`}
      className={["mt-1.5 inline-block w-1.5 h-1.5 rounded-full flex-shrink-0", color].join(" ")}
    />
  );
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

function NotificationPreviews({
  previews,
}: {
  previews: UnifiedNotification["previews"];
}): JSX.Element | null {
  if (!previews || previews.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-3 gap-2">
      {previews.slice(0, 3).map((p, idx) => {
        if (p.type === "image") {
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${idx}-${p.value}`}
              src={p.value}
              alt={p.caption ?? ""}
              className="w-full h-20 object-cover rounded-sm border border-brand-border"
            />
          );
        }
        if (p.type === "video") {
          return (
            <div
              key={`${idx}-${p.value}`}
              className="relative w-full h-20 rounded-sm border border-brand-border bg-black flex items-center justify-center"
            >
              <span className="text-brand-accent text-xs">▶ {p.durationSec ?? "?"}s</span>
            </div>
          );
        }
        if (p.type === "audio") {
          return (
            <div
              key={`${idx}-${p.value}`}
              className="w-full h-20 rounded-sm border border-brand-border bg-brand-surface flex items-center justify-center text-[10px] tracking-[0.22em] text-brand-subtext"
            >
              ♪ AUDIO
            </div>
          );
        }
        if (p.type === "link") {
          return (
            <a
              key={`${idx}-${p.value}`}
              href={p.value}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full h-20 rounded-sm border border-brand-border bg-brand-surface flex items-center justify-center px-2 text-center text-[10px] tracking-[0.18em] text-brand-text hover:text-brand-accent break-words"
            >
              {p.caption ?? p.value}
            </a>
          );
        }
        return (
          <div
            key={`${idx}-${p.value}`}
            className="w-full h-20 rounded-sm border border-brand-border bg-brand-surface flex items-center justify-center px-2 text-center text-[10px] tracking-[0.18em] text-brand-subtext"
          >
            {p.caption ?? p.value}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty / loading states
// ---------------------------------------------------------------------------

function EmptyState({ pinned }: { pinned: boolean }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center text-center px-8 py-20 gap-3">
      <div className="w-10 h-10 rounded-full border border-brand-border flex items-center justify-center text-brand-accent text-lg">
        ◯
      </div>
      <p
        className="text-sm font-display tracking-[0.18em] text-brand-text"
        style={{ fontFamily: "var(--font-display)" }}
      >
        ZERO INBOX
      </p>
      <p className="text-xs text-brand-subtext max-w-[260px]">
        {pinned
          ? "All quiet across every Quant app. Nothing is competing for your attention."
          : "All caught up. We will surface anything important from any of the nine Quant apps the moment it arrives."}
      </p>
    </div>
  );
}

function SkeletonList(): JSX.Element {
  return (
    <ul className="px-5 py-6 flex flex-col gap-4">
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="border border-brand-border rounded-sm p-4 flex flex-col gap-2 animate-pulse"
          aria-hidden
        >
          <div className="h-3 w-1/3 bg-brand-border rounded-sm" />
          <div className="h-3 w-2/3 bg-brand-border rounded-sm" />
          <div className="h-3 w-1/2 bg-brand-border rounded-sm" />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 4) return `${w}w ago`;
  return new Date(t).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Re-exports for downstream stories / tests
// ---------------------------------------------------------------------------

export { APP_META, formatRelativeTime };
