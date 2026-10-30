"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clearNotices, markRead, myNotifications, restoreNotices } from "@/app/(team)/notification-actions";
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
  reply: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5",
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
  // Escape closes it
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const readAll = async () => {
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
    setUnread(0);
    await markRead();
  };

  // Clearing takes them off the bell at once; Undo puts them back
  const clear = async (ids?: string[]) => {
    const gone = new Set(ids ?? items.map((x) => x.id));
    setUnread((u) => Math.max(0, u - items.filter((x) => gone.has(x.id) && !x.read).length));
    setItems((xs) => xs.filter((x) => !gone.has(x.id)));
    const cleared = await clearNotices(ids);
    toast({
      tone: "ok",
      title: cleared.length === 1 ? "Notification cleared" : `${cleared.length} notifications cleared`,
      ms: 5000,
      actions: [
        {
          label: "Undo",
          run: async () => {
            await restoreNotices(cleared);
            await load();
          },
        },
      ],
    });
  };

  const today = items.filter((n) => isToday(n.createdAt));
  const earlier = items.filter((n) => !isToday(n.createdAt));
  const panel =
    placement === "side"
      ? "fixed left-[252px] top-4 bottom-4 w-[min(400px,calc(100vw-268px))]"
      : // Phones (the top bar's bell): a full-screen sheet, clear of the notch and home indicator
        "fixed inset-0 pt-safe pb-safe";
  const sheet = placement === "top";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={unread ? `${unread} new notifications` : "Notifications"}
        className={`relative grid place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg ${placement === "top" ? "h-11 w-11" : "h-9 w-9"}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {/* Rendered at the top of the page (not inside the sidebar), so no page's own layers can cover it or take its clicks */}
      {open &&
        createPortal(
        <>
          <div className="fixed inset-0 z-[90] bg-black/30" onClick={() => setOpen(false)} aria-hidden />
          <div role="dialog" aria-label="Notifications" className={`${panel} z-[91] grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-line bg-surface ${sheet ? "" : "rounded-[18px] border shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)]"}`} style={{ animation: "drawer-in .18s ease-out" }}>
            <div className={`flex items-center justify-between gap-3 border-b border-line px-4 ${sheet ? "py-2" : "py-3"}`}>
              <div className="min-w-0">
                <p className="font-heading text-[16px]">Notifications</p>
                <p className="text-[11px] text-faint">Only whatWhat&apos;s on you, and what&apos;s new with your clientsapos;s on you: replies you owe, yeses you havenWhat&apos;s on you, and what&apos;s new with your clientsapos;t done, work handed to you. Updates are in your day.</p>
              </div>
              <span className={`flex shrink-0 items-center ${sheet ? "gap-1" : "gap-3"}`}>
                {unread > 0 && (
                  <button type="button" onClick={readAll} className={`text-xs text-muted hover:text-fg ${sheet ? "min-h-11 px-2" : ""}`}>
                    Mark all read
                  </button>
                )}
                {items.length > 0 && (
                  <button type="button" onClick={() => void clear()} className={`text-xs text-muted hover:text-fg ${sheet ? "min-h-11 px-2" : ""}`}>
                    Clear all
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    router.push("/notifications");
                  }}
                  aria-label="Notification settings"
                  className={`grid place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg ${sheet ? "h-11 w-11" : "h-7 w-7"}`}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
                {sheet && (
                  <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </span>
            </div>
            <div className="overflow-y-auto overscroll-contain">
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
                    className={`text-xs text-muted underline-offset-4 hover:text-fg hover:underline ${sheet ? "min-h-11 px-3" : ""}`}
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
                    <div className="flex items-center justify-between px-4 pb-1 pt-3">
                      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{label as string}</p>
                      {label === "Earlier" && (
                        <button type="button" onClick={() => void clear((list as Notice[]).map((n) => n.id))} className={`text-[11px] text-faint hover:text-fg ${sheet ? "-my-3 min-h-11 px-2" : ""}`}>
                          Clear earlier
                        </button>
                      )}
                    </div>
                    <ul>
                      {(list as Notice[]).map((n) => (
                        <li key={n.id} className="group relative">
                          <button type="button" onClick={() => void go(n)} className={`flex w-full gap-3 pl-4 text-left ${sheet ? "pr-14" : "pr-4"} transition-colors hover:bg-surface-2 ${sheet ? "py-3.5 active:bg-surface-2" : "py-3"} ${n.read ? "opacity-60" : ""}`}>
                            <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${n.priority === "critical" && !n.read ? "bg-brand/20 text-brand-text" : "bg-surface-2 text-muted"}`}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d={KIND_ICON[n.kind] ?? KIND_ICON.ticket} />
                              </svg>
                            </span>
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="flex items-start justify-between gap-2">
                                <span className={`min-w-0 break-words leading-snug ${sheet ? "text-[15px]" : "text-[13.5px]"} ${n.read ? "" : "font-medium"}`}>{n.title}</span>
                                <span className={`shrink-0 pt-0.5 text-[10.5px] text-faint ${sheet ? "" : "group-hover:opacity-0"}`}>{ago(n.createdAt)}</span>
                              </span>
                              {n.body && <span className={`line-clamp-2 text-muted ${sheet ? "text-[13px]" : "text-xs"}`}>{n.body}</span>}
                              {n.actor && <span className="text-[10.5px] text-faint">by {n.actor}</span>}
                            </span>
                            {!n.read && <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.priority === "critical" ? "bg-brand" : "bg-fg/40"} ${sheet ? "" : "group-hover:opacity-0"}`} />}
                          </button>
                          {/* Clear: always there on phones, on hover on a computer */}
                          <button
                            type="button"
                            onClick={() => void clear([n.id])}
                            aria-label="Clear this notification"
                            className={`absolute right-1.5 grid place-items-center rounded-full text-faint transition hover:bg-surface-3 hover:text-fg ${sheet ? "top-1.5 h-11 w-11" : "top-2 h-8 w-8 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"}`}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                              <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>
          </div>
        </>,
          document.body,
        )}
    </>
  );
}
