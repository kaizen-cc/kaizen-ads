"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { Check, EngagementPlan, Post } from "@/lib/engagement-launch";
import { confirmForClient, findPostsAgain, setLaunchBudget, turnOnLaunch } from "./actions";

type L = { status: string; account: string | null; posts: Post[]; chosen: string[]; plan: EngagementPlan | null; checklist: Check[]; campaignId: string | null; ads: number; note: string | null; error: string | null; confirmedBy: string | null; liveAt: string | null };

const STATUS: Record<string, { text: string; tone: string }> = {
  finding: { text: "Finding their best posts…", tone: "bg-warn-soft text-warn" },
  proposed: { text: "Waiting on the client to confirm the posts", tone: "bg-warn-soft text-warn" },
  confirmed: { text: "Confirmed: building it…", tone: "bg-warn-soft text-warn" },
  building: { text: "Building it in Meta…", tone: "bg-warn-soft text-warn" },
  built: { text: "Built, paused: check it and turn it on", tone: "bg-brand/15 text-brand-text" },
  live: { text: "Live", tone: "bg-ok-soft text-ok" },
  none: { text: "No posts to run", tone: "bg-surface-2 text-muted" },
  failed: { text: "Something went wrong", tone: "bg-bad-soft text-bad" },
};

export function LaunchView({ client, l }: { client: { id: string; name: string; slug: string }; l: L | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set(l?.chosen ?? []));
  const [budget, setBudget] = useState(String(l?.plan?.dailyBudget ?? ""));
  const busy = l && ["finding", "confirmed", "building"].includes(l.status);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [busy, router]);
  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: done } : { ok: false, text: r.error });
      router.refresh();
    });
  const s = l ? (STATUS[l.status] ?? STATUS.failed) : null;
  const editable = l && ["proposed", "failed"].includes(l.status);
  const toLook = l?.checklist.filter((c) => c.status !== "ok").length ?? 0;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 pb-24">
      <div className="-mx-4 -mt-6 flex flex-wrap items-center gap-2 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur-xl md:sticky md:top-0 md:z-30 md:-mx-10 md:-mt-8 md:px-10">
        <Link href={`/clients/${client.slug}`} className="inline-flex h-11 min-w-0 items-center gap-1.5 rounded-full pr-2 text-[13px] text-muted hover:text-fg md:h-9">
          <span aria-hidden>←</span> <span className="truncate">{client.name}</span>
        </Link>
        <span className="hidden text-faint md:inline">/</span>
        <span className="hidden font-heading text-[14px] md:inline">First ads in 48 hours</span>
        {l?.campaignId && l.account && (
          <a href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${l.account}&selected_campaign_ids=${l.campaignId}`} target="_blank" rel="noreferrer" className="ml-auto inline-flex h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-muted hover:text-fg md:h-9">
            Open in Ads Manager ↗
          </a>
        )}
      </div>

      {!l ? (
        <p className="rounded-[20px] border border-dashed border-line p-8 text-center text-[14px] text-muted">
          Nothing yet. When a new client approves their presentation and picks the 48-hour launch, their best posts show up here.
          <button type="button" onClick={() => act(() => findPostsAgain(client.id), "Looking through their posts…")} className="mt-3 block w-full text-[13px] text-brand-text hover:underline">
            Find their posts now
          </button>
        </p>
      ) : (
        <>
          <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-6">
            <div className="flex flex-wrap items-center gap-2">
              {s && <span className={`rounded-full px-3 py-1 text-[12.5px] ${s.tone}`}>{s.text}</span>}
              {l.confirmedBy && <span className="text-[12.5px] text-faint">Confirmed by {l.confirmedBy}</span>}
            </div>
            {(l.note || l.error) && <p className={`text-[13.5px] ${l.error ? "text-bad" : "text-muted"}`}>{l.error ?? l.note}</p>}
            {l.plan && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13.5px]">
                <span>
                  <span className="text-faint">Who: </span>
                  {l.plan.geo.label}, {l.plan.ageMin}+
                </span>
                <span>
                  <span className="text-faint">Page: </span>
                  {l.plan.pageName ?? "–"}
                  {l.plan.igName ? ` · @${l.plan.igName}` : ""}
                </span>
                {editable ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      act(() => setLaunchBudget(client.id, Number(budget)), "Budget saved.");
                    }}
                    className="flex items-center gap-1.5"
                  >
                    <span className="text-faint">$/day</span>
                    <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" className="h-10 w-20 rounded-[10px] border border-line bg-bg px-2.5 text-[14px] outline-none focus:border-brand-text/60" />
                    {Number(budget) !== l.plan.dailyBudget && <button className="h-10 rounded-full bg-fg px-3 text-[12.5px] text-bg">Save</button>}
                  </form>
                ) : (
                  <span>
                    <span className="text-faint">Budget: </span>${l.plan.dailyBudget}/day
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {editable && l.posts.length > 0 && (
                <button type="button" disabled={pending || !keep.size} onClick={() => act(() => confirmForClient(client.id, [...keep]), "Building it, paused…")} className="h-11 rounded-full bg-fg px-5 text-[14px] text-bg disabled:opacity-40">
                  Confirm for the client and build it
                </button>
              )}
              {l.status === "built" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (confirm(`Turn on ${client.name}'s engagement campaign (${l.ads} ads, $${l.plan?.dailyBudget}/day)? The client gets their "you're live" email and Slack message.`)) act(() => turnOnLaunch(client.id), "It's live, and the client has been told.");
                  }}
                  className="h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                >
                  {pending ? "One moment…" : toLook ? `Turn it on (${toLook} to check first)` : "Turn it on"}
                </button>
              )}
              {["proposed", "none", "failed"].includes(l.status) && (
                <button type="button" disabled={pending} onClick={() => act(() => findPostsAgain(client.id), "Looking through their posts again…")} className="h-11 rounded-full border border-line px-4 text-[14px] text-muted hover:text-fg">
                  Find their posts again
                </button>
              )}
            </div>
            {msg && <p className={`text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
          </section>

          {l.checklist.length > 0 && (
            <section className="grid gap-2 rounded-[20px] border border-line bg-surface p-4 md:p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Launch checklist</p>
              {l.checklist.map((c) => (
                <div key={c.item} className="flex items-start gap-3 border-t border-line py-2.5 first:border-t-0">
                  <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] ${c.status === "ok" ? "bg-ok-soft text-ok" : c.status === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>{c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "?"}</span>
                  <div className="grid min-w-0 gap-0.5">
                    <p className="text-[14px]">{c.item}</p>
                    <p className="text-[12.5px] text-muted">
                      {c.status === "manual" ? "Check by hand: " : ""}
                      {c.note}
                    </p>
                  </div>
                </div>
              ))}
            </section>
          )}

          {l.posts.length > 0 && (
            <section className="grid gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{l.status === "none" ? "Their recent posts (none picked)" : "The posts"}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {l.posts.map((p) => {
                  const on = keep.has(p.id);
                  return (
                    <div key={p.id} className={`grid content-start gap-2 overflow-hidden rounded-[18px] border bg-surface ${on || !editable ? "border-line" : "border-line opacity-50"}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {p.image && <img src={p.image} alt="" className="aspect-[4/5] w-full object-cover" loading="lazy" />}
                      <div className="grid gap-1.5 px-3.5 pb-3.5">
                        <p className="flex items-center justify-between text-[11px] text-faint">
                          <span>
                            {p.platform === "facebook" ? "Facebook" : "Instagram"} · {p.format} · {p.at.slice(0, 10)} · {p.score}× typical
                          </span>
                          {p.permalink && (
                            <a href={p.permalink} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                              Open ↗
                            </a>
                          )}
                        </p>
                        {p.caption && <p className="line-clamp-3 text-[13px] leading-snug">{p.caption}</p>}
                        {p.why && <p className="text-[12px] leading-snug text-muted">{p.why}</p>}
                        {editable && (
                          <button
                            type="button"
                            onClick={() => {
                              const next = new Set(keep);
                              if (on) next.delete(p.id);
                              else next.add(p.id);
                              setKeep(next);
                            }}
                            className={`mt-1 h-10 rounded-full text-[13px] ${on ? "bg-surface-2 text-fg" : "border border-line text-muted"}`}
                          >
                            {on ? "✓ Keep" : "Left out"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
