"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "./toasts";

type Feed = {
  max: number;
  running: { id: string; client: string; progress: number }[];
  queued: { id: string; targetId: string; client: string; at: string }[];
  finished: { id: string; client: string; status: "ready" | "failed"; at: string; headline: string | null }[];
};
type Start = { status?: "running" | "queued"; id?: string; client?: string; full?: boolean; error?: string };

/** Ask for an audit (of a KPI's account, or a queued one), and say so if it had to wait for a slot. */
export async function requestAudit(ask: { targetId?: string; auditId?: string }, client?: string): Promise<Start> {
  const res = await fetch("/api/audits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ask) });
  const out = (await res.json().catch(() => ({ error: "Couldn't start the audit" }))) as Start;
  if (out.error) toast({ tone: "bad", title: "The audit didn't start", body: out.error });
  else if (out.status === "queued" && out.full)
    toast({
      tone: "warn",
      title: "You can run 3 audits at once",
      body: `${out.client || client || "This account"} is queued. When one finishes, you'll get a note here to start it, or pick another from your queue first.`,
      ms: 7000,
    });
  window.dispatchEvent(new Event("kz-audits"));
  return out;
}

/**
 * Follows my audits from any page: says when one finishes (with a way to open it), and when a slot frees up while
 * others are queued, offers them in the order they were asked for so I can start whichever matters most.
 */
export function AuditWatcher() {
  const router = useRouter();
  const seen = useRef<Set<string> | null>(null);
  const lastRunning = useRef<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const poll = async () => {
      let feed: Feed | null = null;
      try {
        const res = await fetch("/api/audits/feed", { cache: "no-store" });
        if (res.ok) feed = (await res.json()) as Feed;
      } catch {
        feed = null;
      }
      if (!alive) return;
      if (feed) {
        // The first look only learns what already finished; it doesn't announce it
        const first = seen.current === null;
        if (first) seen.current = new Set(feed.finished.map((f) => f.id));
        const fresh = feed.finished.filter((f) => !seen.current!.has(f.id));
        for (const f of fresh) {
          seen.current!.add(f.id);
          toast({
            id: `done-${f.id}`,
            tone: f.status === "ready" ? "ok" : "bad",
            title: f.status === "ready" ? `Audit finished: ${f.client}` : `The audit for ${f.client} didn't finish`,
            body: f.status === "ready" ? (f.headline ?? undefined) : "Open its KPI card to try again.",
            actions: f.status === "ready" ? [{ label: "Open the audit", href: `/kpis/audit/${f.id}`, primary: true }] : [{ label: "Open KPIs", href: "/kpis" }],
            ms: 6000,
          });
        }
        const slots = feed.max - feed.running.length;
        const freed = lastRunning.current !== null && feed.running.length < lastRunning.current;
        if (feed.queued.length && slots > 0 && (freed || fresh.length)) {
          toast({
            id: "queue",
            tone: "info",
            title: slots === 1 ? "A slot is free: start your next audit" : `${slots} slots are free: start your next audits`,
            body: "In the order you asked for them. Pick whichever matters most.",
            actions: feed.queued.slice(0, 4).map((q, i) => ({
              label: `Start ${q.client}`,
              primary: i === 0,
              run: async () => {
                await requestAudit({ auditId: q.id }, q.client);
                router.refresh();
              },
            })),
            ms: 8000,
          });
        }
        if (fresh.length) router.refresh();
        lastRunning.current = feed.running.length;
      }
      // Quick while something's running or waiting; slow otherwise
      const busy = feed && (feed.running.length || feed.queued.length);
      timer = setTimeout(poll, busy ? 6000 : 45000);
    };
    const nudge = () => {
      clearTimeout(timer);
      timer = setTimeout(poll, 800);
    };
    void poll();
    window.addEventListener("kz-audits", nudge);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("kz-audits", nudge);
    };
  }, [router]);
  return null;
}
