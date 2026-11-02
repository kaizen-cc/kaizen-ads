"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { confirmPosts } from "./actions";

// After they approve and choose the 48-hour launch: the posts we'd put money behind first, each with why, to keep or
// drop, then "Go with these". While we look, and while it's being set up, it says so.

export type FirstAdsPost = { id: string; platform: "facebook" | "instagram"; caption: string; image: string | null; permalink: string | null; at: string; format: string; why?: string };
export type FirstAds = { status: string; posts: FirstAdsPost[]; chosen: string[]; note: string | null; geo: string | null };

export function FirstAdsCard({ slug, data, canAct }: { slug: string; data: FirstAds; canAct: boolean }) {
  const router = useRouter();
  const [keep, setKeep] = useState<Set<string>>(new Set(data.chosen));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = ["finding", "confirmed", "building"].includes(data.status);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [waiting, router]);

  const head = (title: string, body: string) => (
    <div className="grid gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Your first ads</p>
      <p className="font-heading text-[20px] leading-snug">{title}</p>
      <p className="text-[14px] leading-relaxed text-muted">{body}</p>
    </div>
  );

  return (
    <section className="grid gap-4 rounded-[24px] border border-brand/40 bg-surface p-5 md:p-8">
      {data.status === "finding" && (
        <>
          {head("Picking your best posts…", "We're going through your recent Facebook and Instagram posts for the ones worth putting money behind first.")}
          <span className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full w-1/2 animate-[ai-sweep_1.4s_ease-in-out_infinite] rounded-full bg-brand" />
          </span>
        </>
      )}
      {data.status === "none" && head("We'll start with fresh creative", data.note ?? "None of your recent posts is quite right to run yet, so your first ads will come from the new creative we're making.")}
      {data.status === "failed" && head("Your team is on it", "We hit a snag picking your posts; your media buyer has it and will be in touch.")}
      {data.status === "proposed" && (
        <>
          {head("These are the posts we'd run first", `Your own posts, run as ads${data.geo ? ` to people in ${data.geo}` : ""}, live within 48 hours. Keep the ones you're happy with.`)}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.posts.map((p) => {
              const on = keep.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!canAct}
                  onClick={() => {
                    const next = new Set(keep);
                    if (on) next.delete(p.id);
                    else next.add(p.id);
                    setKeep(next);
                  }}
                  className={`grid content-start gap-2 overflow-hidden rounded-[18px] border text-left transition-colors ${on ? "border-brand bg-brand/[0.06]" : "border-line bg-bg opacity-60"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.image && <img src={p.image} alt="" className="aspect-[4/5] w-full object-cover" loading="lazy" />}
                  <span className="grid gap-1.5 px-3.5 pb-3.5">
                    <span className="flex items-center justify-between text-[11px] text-faint">
                      <span>
                        {p.platform === "facebook" ? "Facebook" : "Instagram"} · {p.format} · {new Date(p.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                      <span className={on ? "text-brand-text" : ""}>{on ? "✓ Keep" : "Left out"}</span>
                    </span>
                    {p.caption && <span className="line-clamp-3 text-[13px] leading-snug">{p.caption}</span>}
                    {p.why && <span className="text-[12px] leading-snug text-muted">{p.why}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {canAct && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy || !keep.size}
                onClick={async () => {
                  setBusy(true);
                  const r = await confirmPosts(slug, [...keep]);
                  setBusy(false);
                  if (!r.ok) return setError(r.error);
                  router.refresh();
                }}
                className="h-12 rounded-full bg-brand px-6 text-[15px] font-medium text-white hover:bg-brand-hover disabled:opacity-50"
              >
                {busy ? "One moment…" : `Go with ${keep.size === data.posts.length ? "these" : `these ${keep.size}`}`}
              </button>
              {error && <p className="text-[13px] text-bad">{error}</p>}
            </div>
          )}
        </>
      )}
      {["confirmed", "building", "built"].includes(data.status) && head("Setting it up", "Your media buyer is setting up your first campaign with the posts you picked. You'll hear from us the moment it's live, within 48 hours.")}
      {data.status === "live" && head("You're live 🎉", "Your first campaign is running. It builds your audience and traffic now, and leads into the conversion campaigns as your new creative lands.")}
    </section>
  );
}
