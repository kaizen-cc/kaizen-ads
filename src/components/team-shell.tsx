"use client";

import { isIdeasPath, noIdeas } from "@/lib/maker-day-core";
import { useUnreadHeadsUps } from "@/lib/assistant/heads-up-store";
import Image from "next/image";
import { ThemeSwitch } from "./theme-switch";
import type { Theme } from "@/app/(team)/theme-actions";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { NotificationBell } from "./notification-bell";
import { BriefJobsIndicator, BriefJobsRoot } from "./brief-jobs";
import { MediaJobsIndicator, MediaJobsRoot } from "./media-jobs";
import { PersonAvatar } from "@/components/person-avatar";
import { ViewAsBar, ViewAsControl } from "@/components/view-as";
import { channelNavOk, isSupportRole, SUPPORT_HIDDEN } from "@/lib/roles";
import { useAgentCall } from "./agent-call-provider";
import { UndoToast } from "./undo-toast";

type Tier = "exec" | "lead" | "member";
// buyer: media-buying tools the creative team doesn't use (hidden for them); reports: only executives and media buyers;
// creativeLead: only the Head of Creative
type Item = { href: string; label: string; icon: string; tiers?: Tier[]; buyer?: boolean; reports?: boolean; creativeLead?: boolean };
/** The creative team's place in the menu: the Head of Creative, a designer or editor, or not creative */
export type CreativeSide = "lead" | "maker" | null;

const I = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  // A briefcase (accounts), so it never reads as a second house beside Overview
  clients: "M4 8h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18",
  kpis: "M4 19h16M6 15l4-5 3 3 5-7",
  reports: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4",
  ideas: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2h5c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z",
  ai: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  lab: "M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10",
  // A target (prospects to win)
  sales: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  routines: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
};

// Two groups: the day-to-day work, and where ideas come from. Settings sits at the bottom, by your name.
const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "Work",
    items: [
      // Everyone's home: the daily recap, then what's next for them
      { href: "/pipeline", label: "Overview", icon: I.home },
      { href: "/board", label: "Boards", icon: I.board },
      // The creative team's own KPIs (the Creative KPI tab on the Board), one tap away for the Head of Creative
      { href: "/board?view=kpis", label: "Team KPIs", icon: I.kpis, creativeLead: true },
      { href: "/clients", label: "Clients", icon: I.clients },
      // The executives' weekly full-account review, run step by step
      { href: "/kpis", label: "KPIs", icon: I.kpis, buyer: true },
      { href: "/reports", label: "Reports", icon: I.reports, reports: true },
      { href: "/ai", label: "Kaizen AI", icon: I.ai },
      // New business (internal for now): the prospects the Sales agent researches, for the executives and the leads
      { href: "/sales", label: "Sales", icon: I.sales, tiers: ["exec", "lead"] },
      // Your routines: recaps, sweeps and the nightly agent at your own times (execs and leads)
      { href: "/routines", label: "Routines", icon: I.routines, tiers: ["exec", "lead"] },
    ],
  },
  {
    title: "Ideas",
    items: [
      { href: "/ideas", label: "Ideas", icon: I.ideas },
      { href: "/lab", label: "Ads Lab", icon: I.lab, tiers: ["exec", "lead"], buyer: true },
    ],
  },
];
// Execs and leads: AI agents, the team, sync health, errors and the data under the hood
const SETTINGS: Item = { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z", tiers: ["exec", "lead"] };

// Everyone: what they've sent from the feedback bubble; execs also see everyone's, grouped and prioritized
const FEEDBACK: Item = { href: "/feedback", label: "Feedback", icon: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12zM9 11h.01M12 11h.01M15 11h.01" };

/** The last way they contacted their assistant on this device (the chooser starts there) */
const CONTACT_KEY = "kz:assistant-contact";
const readContact = (): "call" | "chat" => {
  try {
    return localStorage.getItem(CONTACT_KEY) === "chat" ? "chat" : "call";
  } catch {
    return "call";
  }
};
const saveContact = (v: "call" | "chat") => {
  try {
    localStorage.setItem(CONTACT_KEY, v);
  } catch {
    /* private window: not remembered */
  }
};

const CALL_PATH = "M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z";
const CHAT_PATH = "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z";

const subscribeNone = () => () => undefined;

/**
 * My assistant: everyone's personal assistant, a call or a chat away from any page (both live above every page and are
 * one conversation). Tapping it opens a small centered chooser (Call or Chat), starting on the last one used on this
 * device. The label is short ("My Assistant", or the name they gave it) so it always fits, and wraps rather than cuts.
 */
function AssistantButton({ size = "side", onPress }: { size?: "side" | "menu"; onPress?: () => void }) {
  const { startAssistant, startAssistantChat, activeRole, live, talk, assistantTint: tint, assistantName } = useAgentCall();
  const on = live && activeRole === "assistant";
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<"call" | "chat">("call");
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const mounted = useSyncExternalStore(
    subscribeNone,
    () => true,
    () => false,
  );
  const who = assistantName || "My Assistant";
  // Urgent heads-ups waiting unread in the chat (a missed ring, or while they were away)
  const unread = useUnreadHeadsUps();
  const pick = (v: "call" | "chat") => {
    saveContact(v);
    setOpen(false);
    onPress?.();
    if (v === "chat") startAssistantChat();
    else startAssistant();
  };
  const toggle = () => {
    // On already: back to it, no question
    if (on) {
      onPress?.();
      return talk === "text" ? startAssistantChat() : startAssistant();
    }
    const l = readContact();
    setLast(l);
    setOpen((o) => !o);
    requestAnimationFrame(() => options.current[l === "chat" ? 1 : 0]?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
  const choices: { key: "call" | "chat"; label: string; sub: string; d: string }[] = [
    { key: "call", label: "Call", sub: "Talk it through", d: CALL_PATH },
    { key: "chat", label: "Chat", sub: "Type, or dictate", d: CHAT_PATH },
  ];
  return (
    <div className="relative w-full min-w-0">
      <div className="group relative flex w-full min-w-0 items-stretch overflow-hidden rounded-[12px] border border-line bg-surface-2/40 transition-colors hover:border-faint">
        <span aria-hidden className="pointer-events-none absolute -left-6 -top-8 h-16 w-24 rounded-full opacity-25 blur-2xl transition-opacity group-hover:opacity-40" style={{ background: tint }} />
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`relative flex min-w-0 flex-1 items-center gap-2.5 text-left active:scale-[0.99] ${size === "menu" ? "min-h-12 pl-3" : "py-2 pl-3"}`}
        >
          <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-[10px]" style={{ background: `${tint}22`, color: tint, boxShadow: `inset 0 0 0 1px ${tint}33` }}>
            {on && <span aria-hidden className="absolute inset-0 animate-ping rounded-[10px] opacity-30" style={{ background: tint }} />}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={on && talk === "text" ? CHAT_PATH : CALL_PATH} />
            </svg>
          </span>
          <span className="relative grid min-w-0 flex-1 gap-0.5 leading-tight">
            <span className={`font-medium text-fg [overflow-wrap:break-word] [text-wrap:balance] ${size === "menu" ? "text-[15px]" : "text-[13.5px]"}`}>{who}</span>
            <span className={`text-[11px] ${unread && !on ? "font-medium text-brand-text" : "text-faint"}`}>{on ? (talk === "text" ? "In a chat" : "On a call") : unread ? `${unread} urgent in your chat` : "Call or chat"}</span>
          </span>
          {on && <span aria-hidden className="relative h-2 w-2 shrink-0 rounded-full bg-ok shadow-[0_0_0_3px_var(--ok-soft)]" />}
          {!on && unread > 0 && (
            <span aria-label={`${unread} unread`} className="relative grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-white">
              {unread}
            </span>
          )}
        </button>
        {/* Its settings: the name, voice, color and what it knows, on the Assistant page */}
        <Link
          href="/assistant#make-it-yours"
          onClick={() => onPress?.()}
          aria-label="Your assistant's settings"
          title="Your assistant's settings"
          className={`relative grid shrink-0 place-items-center text-faint transition-colors hover:text-fg ${size === "menu" ? "w-12" : "w-10"}`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </Link>
      </div>
      {open &&
        mounted &&
        createPortal(
          // A centered chooser over a dimmed page (a portal, so the sidebar's or the drawer's own box never moves it)
          <div className="fixed inset-0 z-[70] grid place-items-center p-5" role="dialog" aria-modal="true" aria-label={`Contact ${who}`}>
            <button type="button" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm animate-[sheet-fade_.15s_ease-out]" />
            <div
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const i = options.current.findIndex((b) => b === document.activeElement);
                  options.current[i === 0 ? 1 : 0]?.focus();
                }
              }}
              className="relative w-full max-w-[360px] overflow-hidden rounded-[24px] border border-line bg-surface p-5 shadow-[0_30px_80px_-24px_rgba(0,0,0,0.6)] animate-[sheet-fade_.18s_ease-out]"
            >
              <span aria-hidden className="pointer-events-none absolute -top-16 left-1/2 h-32 w-56 -translate-x-1/2 rounded-full opacity-25 blur-3xl" style={{ background: tint }} />
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-full text-faint transition-colors hover:text-fg active:bg-surface-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
              <div className="relative grid justify-items-center gap-1 pb-4 pt-1 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-[16px]" style={{ background: `${tint}22`, color: tint, boxShadow: `inset 0 0 0 1px ${tint}33` }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
                  </svg>
                </span>
                <p className="mt-1 font-heading text-[19px] leading-tight [overflow-wrap:break-word]">{assistantName ? `Reach ${assistantName}` : "Reach your assistant"}</p>
                <p className="text-[13px] text-muted">How do you want to talk?</p>
              </div>
              <div role="group" aria-label="Contact" className="relative grid grid-cols-2 gap-2.5">
                {choices.map((c, i) => (
                  <button
                    key={c.key}
                    ref={(el) => {
                      options.current[i] = el;
                    }}
                    type="button"
                    onClick={() => pick(c.key)}
                    className="relative grid min-h-[104px] content-center justify-items-center gap-1.5 rounded-[16px] border border-line bg-surface-2/50 px-3 py-4 text-center transition hover:border-faint hover:bg-surface-2 focus-visible:border-faint focus-visible:bg-surface-2 focus-visible:outline-none active:scale-[0.98]"
                    style={last === c.key ? { borderColor: `${tint}88` } : undefined}
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-[12px]" style={{ background: `${tint}22`, color: tint }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d={c.d} />
                      </svg>
                    </span>
                    <span className="text-[15px] font-medium text-fg">{c.label}</span>
                    <span className="text-[12px] leading-tight text-faint">{last === c.key ? "Last used" : c.sub}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function TeamShell({ name, fullName, meId, roles, tier, creative = null, reports = false, channel = false, role = null, theme = null, viewAs = null, canViewAs = false, children }: { name: string; fullName: string; meId: string; roles: string; tier: Tier; creative?: CreativeSide; reports?: boolean; channel?: boolean; role?: string | null; theme?: Theme | null; viewAs?: { label: string; name: string } | null; canViewAs?: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const view = useSearchParams().get("view");
  // The creative team doesn't get the media-buying tools; the Head of Creative gets their team's KPIs instead. Reports
  // are only for executives and media buyers
  const can = (i: Item) => (!i.tiers || i.tiers.includes(tier)) && !(i.buyer && creative) && (!i.reports || reports) && (!i.creativeLead || creative === "lead");
  // The email and social teams get only Overview, Clients, KPIs, Reports and Kaizen AI (Feedback and Settings sit apart);
  // the email team also gets Boards (their Email Board)
  // The makers and customer success have no Ideas (their Overview is their plate): gone from the sidebar and the tab bar
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => can(i) && (!channel || channelNavOk(i.href, role) || i.href === "/sales" || i.href === "/routines") && !(noIdeas(role) && isIdeasPath(i.href)) && !(isSupportRole(role) && SUPPORT_HIDDEN.includes(i.href))) })).filter((g) => g.items.length);
  const settings = can(SETTINGS) ? SETTINGS : null;
  // The tab bar on phones: home (the Overview), the board, clients and KPIs (the creative team: their own
  // KPIs, or Ideas); everything else is in the menu
  const all = groups.flatMap((g) => g.items);
  const fourth = (creative ? ["/board?view=kpis", "/ideas"] : ["/kpis"]).map((h) => all.find((i) => i.href === h)).find(Boolean);
  const tabs = [all.find((i) => i.href === "/pipeline"), all.find((i) => i.href === "/board"), all.find((i) => i.href === "/clients"), fourth].filter((i): i is Item => Boolean(i)).slice(0, 4);
  const [menu, setMenu] = useState(false);
  // The menu closes on its own when the page changes, and the page behind doesn't scroll while it's open
  const [seenPath, setSeenPath] = useState(path);
  // The place just pressed lights up at once, before its page arrives, so a click never looks ignored
  const [going, setGoing] = useState<string | null>(null);
  const [seenView, setSeenView] = useState(view);
  if (seenPath !== path || seenView !== view) {
    setSeenPath(path);
    setSeenView(view);
    setMenu(false);
    setGoing(null);
  }
  const press = (href: string) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    setGoing(href);
  };
  useEffect(() => {
    if (!menu) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const home = "/pipeline";
  // Winners and Market live under Ideas; Team under Settings
  // A place with a view in its address (Team KPIs) is on only with that view, and the Board then isn't
  const teamKpis = all.some((i) => i.href === "/board?view=kpis");
  const activeNow = (href: string) => {
    const [base, query] = href.split("?");
    if (query) return path === base && view === new URLSearchParams(query).get("view");
    if (href === "/board" && teamKpis && view === "kpis" && path === "/board") return false;
    return path === href || path.startsWith(`${href}/`) || (href === "/ideas" && (path.startsWith("/winners") || path.startsWith("/market"))) || (href === "/settings" && path.startsWith("/team"));
  };
  const active = (href: string) => (going ? going === href : activeNow(href));
  const link = (item: Item) => {
    const on = active(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={press(item.href)}
        aria-current={on ? "page" : undefined}
        className={`relative flex items-center gap-3 rounded-brand px-3 py-2.5 text-sm transition-colors ${on ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg"}`}
      >
        {on && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" />}
        <Icon d={item.icon} />
        {item.label}
      </Link>
    );
  };

  return (
    <div className="relative min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <BriefJobsRoot />
      <MediaJobsRoot />
      {/* Undo for anything cleared off the Overview (src/lib/undo.ts) */}
      <UndoToast />
      <ViewAsBar label={viewAs?.label ?? null} name={viewAs?.name ?? null} />
      {/* A faint brand glow behind the top of every page (first, so everything after it paints above) */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_15%_0%,rgba(178,30,44,0.16),transparent_70%)] md:left-[240px]" />
      <aside className="pt-safe hidden border-r border-line bg-surface md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <div className="flex items-center justify-between gap-2 pb-6 pl-5 pr-3 pt-6">
          <Link href={home} className="flex items-center gap-2">
            <Image src="/kaizen-logo.png" alt="Kaizen" width={110} height={26} priority />
            <span className="mt-1 font-display text-sm tracking-wide text-muted">OS</span>
          </Link>
          <span className="flex items-center gap-1.5">
            <BriefJobsIndicator compact />
            <MediaJobsIndicator compact />
            <NotificationBell placement="side" />
          </span>
        </div>
        <nav className="grid gap-5 px-3" aria-label="Main">
          {groups.map((g) => (
            <div key={g.title} className="grid gap-0.5">
              <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{g.title}</p>
              {g.items.map(link)}
            </div>
          ))}
        </nav>
        <div className="mt-auto grid min-w-0 gap-0.5 px-3 pb-2">
          {/* min-w-0: the button shrinks to the sidebar instead of the live label pushing it past the edges */}
          <div className="min-w-0 pb-2">
            <AssistantButton />
          </div>
          {link(FEEDBACK)}
          {settings && link(settings)}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-4">
          {/* Their profile: the picture and name open it */}
          <Link href={`/profile/${meId}`} aria-label="Your profile" className="group/me flex min-w-0 flex-1 items-center gap-3 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
            <PersonAvatar name={fullName} size={34} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium group-hover/me:text-brand-text">{name}</span>
              <span className="block truncate text-xs text-faint">{roles}</span>
            </span>
          </Link>
          <form action="/auth/signout" method="post">
            <button className="rounded-brand px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">Sign out</button>
          </form>
        </div>
        {/* The owner alone: see the app as a teammate or a role (lib/view-as-core.ts) */}
        {canViewAs && (
          <div className="px-3 pb-1">
            <ViewAsControl />
          </div>
        )}
        <div className="px-4 pb-4">
          <ThemeSwitch saved={theme} />
        </div>
      </aside>

      {/* Phones: an app's top bar (menu, logo, notifications) */}
      <header className="pt-safe sticky top-0 z-30 border-b border-line/70 bg-bg/85 backdrop-blur-xl md:hidden">
        <div className="flex h-14 items-center justify-between gap-2 px-2">
          <button type="button" onClick={() => setMenu(true)} aria-label="Open the menu" aria-expanded={menu} className="grid h-11 w-11 place-items-center rounded-full text-fg active:bg-surface-2">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h10" />
            </svg>
          </button>
          <Link href={home} className="flex items-center gap-1.5">
            <Image src="/kaizen-logo.png" alt="Kaizen" width={92} height={21} priority />
            <span className="mt-1 font-display text-xs tracking-wide text-muted">OS</span>
          </Link>
          <span className="flex h-11 items-center justify-end gap-1">
            <BriefJobsIndicator compact />
            <MediaJobsIndicator compact />
            <span className="flex h-11 w-11 items-center justify-center">
              <NotificationBell placement="top" />
            </span>
          </span>
        </div>
      </header>

      {/* Phones: the menu, sliding in from the left like an app's */}
      {menu && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close the menu" onClick={() => setMenu(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-[sheet-fade_.2s_ease-out]" />
          <aside className="pt-safe pb-safe absolute inset-y-0 left-0 flex w-[84%] max-w-[320px] flex-col border-r border-line bg-surface shadow-2xl animate-[drawer-left_.25s_cubic-bezier(.2,.8,.2,1)]">
            <div className="flex items-center justify-between gap-2 px-5 pb-5 pt-5">
              <Link href={home} className="flex items-center gap-2" onClick={() => setMenu(false)}>
                <Image src="/kaizen-logo.png" alt="Kaizen" width={104} height={24} />
                <span className="mt-1 font-display text-sm tracking-wide text-muted">OS</span>
              </Link>
              <button type="button" onClick={() => setMenu(false)} aria-label="Close the menu" className="grid h-10 w-10 place-items-center rounded-full text-muted active:bg-surface-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="min-w-0 px-3 pb-4">
              <AssistantButton size="menu" onPress={() => setMenu(false)} />
            </div>
            <nav className="grid flex-1 content-start gap-6 overflow-y-auto px-3" aria-label="Main">
              {groups.map((g) => (
                <div key={g.title} className="grid gap-1">
                  <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{g.title}</p>
                  {g.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={(e) => {
                        press(item.href)(e);
                        setMenu(false);
                      }}
                      aria-current={active(item.href) ? "page" : undefined}
                      className={`flex min-h-12 items-center gap-3.5 rounded-[12px] px-3 text-[15px] transition-colors ${active(item.href) ? "bg-surface-2 text-fg" : "text-muted active:bg-surface-2/60"}`}
                    >
                      <span className={active(item.href) ? "text-brand-text" : ""}>
                        <Icon d={item.icon} />
                      </span>
                      {item.label}
                    </Link>
                  ))}
                </div>
              ))}
              <Link
                href={FEEDBACK.href}
                onClick={(e) => {
                  press(FEEDBACK.href)(e);
                  setMenu(false);
                }}
                className={`flex min-h-12 items-center gap-3.5 rounded-[12px] px-3 text-[15px] ${active(FEEDBACK.href) ? "bg-surface-2 text-fg" : "text-muted active:bg-surface-2/60"}`}
              >
                <Icon d={FEEDBACK.icon} />
                {FEEDBACK.label}
              </Link>
              {settings && (
                <Link
                  href={settings.href}
                  onClick={(e) => {
                    press(settings.href)(e);
                    setMenu(false);
                  }}
                  className={`flex min-h-12 items-center gap-3.5 rounded-[12px] px-3 text-[15px] ${active(settings.href) ? "bg-surface-2 text-fg" : "text-muted active:bg-surface-2/60"}`}
                >
                  <Icon d={settings.icon} />
                  {settings.label}
                </Link>
              )}
            </nav>
            <div className="flex items-center gap-3 border-t border-line px-5 py-4">
              <Link href={`/profile/${meId}`} onClick={() => setMenu(false)} aria-label="Your profile" className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-[10px] outline-none">
                <PersonAvatar name={fullName} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{name}</span>
                  <span className="block truncate text-xs text-faint">{roles}</span>
                </span>
              </Link>
              <form action="/auth/signout" method="post">
                <button className="min-h-10 rounded-full border border-line px-3 text-xs text-muted active:bg-surface-2">Sign out</button>
              </form>
            </div>
            {canViewAs && (
              <div className="px-5 pb-3">
                <ViewAsControl size="menu" onPicked={() => setMenu(false)} />
              </div>
            )}
            <div className="px-5 pb-[calc(env(safe-area-inset-bottom)+16px)]">
              <p className="pb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Appearance</p>
              <ThemeSwitch saved={theme} size="lg" />
            </div>
          </aside>
        </div>
      )}

      {/* Phones: the tab bar, the places used most, always under the thumb */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-bg/90 backdrop-blur-xl md:hidden" aria-label="Tabs">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((item) => {
            const on = active(item.href);
            return (
              <Link key={item.href} href={item.href} onClick={press(item.href)} aria-current={on ? "page" : undefined} className={`flex h-[58px] flex-col items-center justify-center gap-1 text-[10.5px] ${on ? "text-fg" : "text-faint active:text-muted"}`}>
                <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors ${on ? "bg-brand/15 text-brand-text" : ""}`}>
                  <Icon d={item.icon} />
                </span>
                {item.label}
              </Link>
            );
          })}
          <button type="button" onClick={() => setMenu(true)} className="flex h-[58px] flex-col items-center justify-center gap-1 text-[10.5px] text-faint active:text-muted">
            <span className="grid h-7 w-12 place-items-center rounded-full">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                <path d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
            </span>
            More
          </button>
        </div>
      </nav>

      {/* No stacking context of its own (no isolate, no z-index): a page's drawers and sheets (z-50) then rise above the
          top bar and tab bar instead of being trapped under them */}
      <main className="relative min-w-0 overflow-x-clip px-4 pb-[calc(70px+env(safe-area-inset-bottom))] pt-6 md:px-10 md:py-8">{children}</main>
    </div>
  );
}
