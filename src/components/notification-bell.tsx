"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { markRead, myNotifications } from "@/app/(team)/notification-actions";
import type { Notice } from "@/lib/notifications";
import { toast } from "./toasts";

// The bell: what's new for you, newest first. It checks every minute and when you come back to the tab; something
// critical that arrives while you're here also pops up bottom-right. Opening one marks it read and takes you there.

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

const KIND_ICON: Record<string, string> = {
  assigned: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  ticket: "M4 6h16M4 12h16M4 18h10",
  client: "M3 21V8l9-5 9 5v13M9 21v-6h6v6",
  promise: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  kpi: "M3 17l6-6 4 4 8-8M14 7h7v7",
  fatigue: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  recap: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  onboarding: "M5 13l4 4L19 7",
  handoff: "M7 17 17 7M7 7h10v10",
  sprint: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
};

export function NotificationBell({ placement = "side" }: { placement?: "side" | "top" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await myNotifications();
      // Critical ones that arrived since the last look pop up (not on the first load)
      // Only one bell pops them up (the sidebar one; the phone header shows the same list)
      if (seen.current && placement === "side" && r.popups) for (const n of r.items) if (!n.read && n.priority === "critical" && !seen.current.has(n.id)) toast({ tone: "bad", title: n.title, body: n.body ?? undefined, actions: n.href ? [{ label: "Open", href: n.href, primary: true }] : undefined, ms: 9000 });
      seen.current = new Set(r.items.map((n) => n.id));
      setItems(r.items);
      setUnread(r.unread);
    } catch {
      /* signed out or offline: try again next time */
    }
  }, [placement]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 60_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const go = async (n: Notice) => {
    setOpen(false);
    if (!n.read) {
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      void markRead(n.id);
    }
    if (n.href) {
      if (n.href.startsWith("http")) window.open(n.href, "_blank", "noreferrer");
      else router.push(n.href);
    }
  };
  const readAll = async () => {
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
    setUnread(0);
    await markRead();
  };

  const today = items.filter((n) => isToday(n.createdAt));
  const earlier = items.filter((n) => !isToday(n.createdAt));
  const panel =
    placement === "side"
      ? "fixed left-[248px] top-4 bottom-4 w-[400px]"
      : "fixed inset-x-3 top-16 max-h-[75vh]";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={unread ? `${unread} new notifications` : "Notifications"}
        className="relative grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`${panel} z-50 grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[18px] border border-line bg-surface shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)]`} style={{ animation: "drawer-in .18s ease-out" }}>
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <p className="font-heading text-[16px]">Notifications</p>
                <p className="text-[11px] text-faint">What&apos;s on you, and what&apos;s new with your clients</p>
              </div>
              <span className="flex items-center gap-3">
                {unread > 0 && (
                  <button type="button" onClick={readAll} className="text-xs text-muted hover:text-fg">
                    Mark all read
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    router.push("/notifications");
                  }}
                  aria-label="Notification settings"
                  className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              </span>
            </div>
            <div className="overflow-y-auto">
              {!items.length && (
                <div className="grid place-items-center gap-2 px-6 py-16 text-center">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-ok-soft text-ok">✓</span>
                  <p className="text-sm text-muted">Nothing new. Work assigned to you and news on your clients show up here.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      router.push("/notifications");
                    }}
                    className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline"
                  >
                    Choose what you get
                  </button>
                </div>
              )}
              {[
                ["Today", today],
                ["Earlier", earlier],
              ].map(([label, list]) =>
                (list as Notice[]).length ? (
                  <div key={label as string}>
                    <p className="px-4 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{label as string}</p>
                    <ul>
                      {(list as Notice[]).map((n) => (
                        <li key={n.id}>
                          <button type="button" onClick={() => void go(n)} className={`flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 ${n.read ? "opacity-60" : ""}`}>
                            <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${n.priority === "critical" && !n.read ? "bg-brand/20 text-brand-text" : "bg-surface-2 text-muted"}`}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d={KIND_ICON[n.kind] ?? KIND_ICON.ticket} />
                              </svg>
                            </span>
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="flex items-start justify-between gap-2">
                                <span className={`text-[13.5px] leading-snug ${n.read ? "" : "font-medium"}`}>{n.title}</span>
                                <span className="shrink-0 pt-0.5 text-[10.5px] text-faint">{ago(n.createdAt)}</span>
                              </span>
                              {n.body && <span className="line-clamp-2 text-xs text-muted">{n.body}</span>}
                              {n.actor && <span className="text-[10.5px] text-faint">by {n.actor}</span>}
                            </span>
                            {!n.read && <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.priority === "critical" ? "bg-brand" : "bg-fg/40"}`} />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
