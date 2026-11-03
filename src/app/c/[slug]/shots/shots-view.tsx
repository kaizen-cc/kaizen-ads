"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Shot, ShotList } from "@/lib/shot-list";
import { createClient } from "@/lib/supabase/client";
import { assetSlots, assetsShared } from "../start/actions";
import { shotSent } from "./actions";

// The shot list as the client sees it: what we need from them for next cycle's ads, one card per shot with what it's
// for and a look from what's working in their market, and an upload right on the card. Sent shots are ticked off.

export function ShotsView({ slug, brand, listId, list }: { slug: string; brand: string; listId: string; list: ShotList }) {
  const sent = list.shots.filter((s) => s.delivered).length;
  const total = list.shots.length;
  return (
    <div className="grid gap-5">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-7 pt-8 md:px-10 md:pb-10 md:pt-12">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-96 w-96 rounded-full bg-brand/30 blur-[120px]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Kaizen Marketing · {brand}</p>
        <h1 className="mt-2 font-heading text-[28px] leading-[1.08] tracking-tight md:text-[42px]">{sent === total ? "Everything's in, thank you" : `What we need for ${list.month}`}</h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">{list.intro}</p>
        <div className="mt-5 flex items-center gap-3">
          <span className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${(sent / Math.max(1, total)) * 100}%` }} />
          </span>
          <span className="tabular shrink-0 text-[13px] text-muted">
            {sent} of {total} sent
          </span>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        {list.shots.map((s, i) => (
          <ShotCard key={s.id} slug={slug} listId={listId} shot={s} n={i + 1} />
        ))}
      </div>

      {list.have.length > 0 && <p className="text-[13px] text-faint">Already have, no need to send: {list.have.join(", ")}.</p>}
      <p className="text-[14px] text-muted">{list.closing}</p>
      <Link href={`/c/${slug}`} className="justify-self-start text-[13.5px] text-brand-text hover:underline">
        ← Back to your portal
      </Link>
    </div>
  );
}

function ShotCard({ slug, listId, shot, n }: { slug: string; listId: string; shot: Shot; n: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = Boolean(shot.delivered);
  const send = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    try {
      const slots = await assetSlots(slug, files.map((f) => ({ name: f.name, bytes: f.size })));
      if (!slots.ok) throw new Error(slots.error);
      const supabase = createClient();
      const uploaded: { path: string; name: string; mime: string; bytes: number }[] = [];
      for (let i = 0; i < files.length; i++) {
        setBusy(`Uploading ${i + 1} of ${files.length}…`);
        const { error: e } = await supabase.storage.from("client-docs").uploadToSignedUrl(slots.slots[i].path, slots.slots[i].token, files[i], { contentType: files[i].type || "application/octet-stream" });
        if (e) throw new Error(`${files[i].name} didn't upload. Try again.`);
        uploaded.push({ path: slots.slots[i].path, name: files[i].name, mime: files[i].type, bytes: files[i].size });
      }
      setBusy("Sending it to the team…");
      const r = await assetsShared(slug, uploaded, []);
      if (!r.ok) throw new Error(r.error);
      const m = await shotSent(slug, listId, shot.id, uploaded.map((u) => u.name));
      if (!m.ok) throw new Error(m.error);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <article className={`grid content-start gap-3 rounded-[22px] border p-4 md:p-5 ${done ? "border-ok/40 bg-ok-soft/20" : "border-line bg-surface"}`}>
      <div className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold ${done ? "bg-ok text-white" : "bg-surface-2 text-muted"}`}>{done ? "✓" : n}</span>
        <div className="min-w-0">
          <p className="font-heading text-[16px] leading-snug [overflow-wrap:anywhere]">{shot.what}</p>
          <p className="mt-1 text-[12.5px] text-faint">
            {shot.format === "video" ? "Video" : "Photo"} · {shot.specs}
          </p>
        </div>
      </div>
      <p className="text-[13.5px] text-muted">{shot.why}</p>
      {shot.again && <p className="rounded-[12px] bg-surface-2 px-3 py-2 text-[12.5px] text-muted">A fresh take: {shot.again}</p>}
      {(shot.refs ?? []).length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">The look we&rsquo;re going for</p>
          <div className="flex gap-2">
            {(shot.refs ?? []).map((r) => (
              <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="relative block h-28 w-24 shrink-0 overflow-hidden rounded-[12px] border border-line bg-surface-2">
                {r.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span className="grid h-full place-items-center text-[11px] text-faint">Open ↗</span>
                )}
                {r.video && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 px-1.5 text-[10px] text-white">▶</span>}
              </a>
            ))}
          </div>
        </div>
      )}
      {done ? (
        <p className="text-[13px] text-ok">Got it{shot.delivered!.files.length ? `: ${shot.delivered!.files.slice(0, 3).join(", ")}${shot.delivered!.files.length > 3 ? "…" : ""}` : ""}</p>
      ) : (
        <label className={`grid h-12 cursor-pointer place-items-center rounded-full text-[14.5px] font-medium ${busy ? "bg-surface-2 text-muted" : "bg-brand text-white hover:bg-brand-hover"}`}>
          {busy ?? `Upload the ${shot.format === "video" ? "clip" : "photo"}`}
          <input type="file" multiple accept={shot.format === "video" ? "video/*,image/*" : "image/*,video/*"} disabled={Boolean(busy)} className="sr-only" onChange={(e) => void send([...(e.target.files ?? [])])} />
        </label>
      )}
      {error && <p className="text-[13px] text-bad">{error}</p>}
    </article>
  );
}
