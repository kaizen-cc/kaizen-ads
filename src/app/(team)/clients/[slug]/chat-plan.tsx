"use client";

import { AdImg } from "@/components/ad-img";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { HoverCard } from "@/components/hover-card";
import type { PlannedOp } from "@/lib/ad-changes";
import { kpiText, lineOf, verifyLink, type Metrics, type ObjRef, type OpEdit } from "@/lib/chat-change-core";
import { confirmChatChange, discardChatChange, loadChatChange, saveChatChecklist, type ChatChangeView } from "./chat-change-actions";

// The plan under a chat answer that asked for a change in the ad account: every object it will touch, by name, with
// its creative and numbers a hover (or tap) away, before → after, ticked to go ahead. The buyer can untick, edit an
// amount, name or link, then confirm. Once it's done, each object links straight to where it is in Ads Manager or
// Google Ads to check it landed.

const PLATFORM = {
  meta: { name: "Meta", dot: "bg-[#0866ff]", ring: "border-[#0866ff]/35", tint: "bg-[#0866ff]/[0.06]", where: "Ads Manager" },
  google: { name: "Google Ads", dot: "bg-[#4285f4]", ring: "border-[#4285f4]/35", tint: "bg-[#4285f4]/[0.06]", where: "Google Ads" },
  team: { name: "Team", dot: "bg-brand", ring: "border-brand/35", tint: "bg-brand/[0.05]", where: "" },
} as const;

const LEVEL: Record<ObjRef["level"], string> = { campaign: "Campaign", adset: "Ad set", ad: "Ad", ad_group: "Ad group", keyword: "Keyword", person: "Person" };

function MetricsTable({ ref7, ref30, r }: { ref7: Metrics | null | undefined; ref30: Metrics | null | undefined; r: ObjRef }) {
  if (!ref7 && !ref30) return <p className="text-[11.5px] text-ink/45">No spend in the last 30 days.</p>;
  const tone = (m: Metrics | null | undefined) => {
    if (m?.cpr == null || r.target == null) return "";
    const good = r.roas ? m.cpr >= r.target : m.cpr <= r.target;
    return good ? "text-ok" : "text-bad";
  };
  const rows: [string, (m: Metrics) => string, boolean?][] = [
    ["Spend", (m) => `$${m.spend.toLocaleString("en-US", { maximumFractionDigits: 0 })}`],
    [r.result ? `${r.result}` : "Results", (m) => String(m.results)],
    [r.roas ? "ROAS" : "Cost / result", (m) => kpiText(m.cpr, r.roas), true],
    ["CTR", (m) => (m.ctr == null ? "–" : `${m.ctr}%`)],
    ...(r.platform === "meta" ? ([["Frequency", (m: Metrics) => (m.freq == null ? "–" : String(m.freq))]] as [string, (m: Metrics) => string][]) : []),
  ];
  return (
    <table className="w-full text-[11.5px]">
      <thead>
        <tr className="text-ink/45">
          <th className="py-0.5 text-left font-normal" />
          <th className="py-0.5 text-right font-normal">7 days</th>
          <th className="py-0.5 text-right font-normal">30 days</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, f, kpi]) => (
          <tr key={label} className="border-t border-ink/[0.06]">
            <td className="py-1 text-ink/60">{label}</td>
            <td className={`tabular py-1 text-right ${kpi ? tone(ref7) : ""}`}>{ref7 ? f(ref7) : "–"}</td>
            <td className={`tabular py-1 text-right ${kpi ? tone(ref30) : ""}`}>{ref30 ? f(ref30) : "–"}</td>
          </tr>
        ))}
        {r.target != null && (
          <tr className="border-t border-ink/[0.06]">
            <td className="py-1 text-ink/60">Target</td>
            <td colSpan={2} className="tabular py-1 text-right text-ink/70">
              {kpiText(r.target, r.roas)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** What the buyer sees on hover (or tap): the object's creative, copy, numbers and where it lives. */
function Preview({ r, newId }: { r: ObjRef; newId?: string | null }) {
  const c = r.creative;
  // A Meta ad's picture is kept for good (Meta's own links expire), so an old plan still shows it
  const metaAd = r.platform === "meta" && r.level === "ad" ? r.id : null;
  const link = verifyLink(r);
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-0.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink/45">
          {LEVEL[r.level]}
          {r.status ? ` · ${r.status === "ACTIVE" || r.status === "ENABLED" ? "on" : r.status.toLowerCase().replace(/_/g, " ")}` : ""}
        </span>
        <span className="text-[13.5px] font-medium leading-snug [overflow-wrap:anywhere]">{r.name}</span>
        {r.path.length > 0 && <span className="text-[11.5px] text-ink/50 [overflow-wrap:anywhere]">{r.path.join(" › ")}</span>}
      </div>
      {c && (
        <div className="grid gap-2 rounded-[12px] border border-ink/[0.08] bg-ink/[0.03] p-2.5">
          {c.cards?.length ? (
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
              {c.cards.map((k, i) => (
                <span key={i} className="grid w-24 shrink-0 gap-1">
                  {k.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={k.thumb} alt="" className="aspect-square w-24 rounded-[8px] object-cover" />
                  ) : (
                    <span className="aspect-square w-24 rounded-[8px] bg-ink/10" />
                  )}
                  {k.headline && <span className="truncate text-[10.5px] text-ink/60">{k.headline}</span>}
                </span>
              ))}
            </div>
          ) : c.thumb || metaAd ? (
            <span className="relative block">
              <AdImg src={c.thumb} adId={metaAd} className="max-h-56 w-full rounded-[8px] object-cover" />
              {c.video && <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">▶ Video</span>}
            </span>
          ) : null}
          {c.headline && <p className="text-[12.5px] font-medium leading-snug">{c.headline}</p>}
          {c.body && <p className="line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-ink/70">{c.body}</p>}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {c.cta && <span className="rounded-full bg-ink/10 px-2 py-0.5 text-ink/75">{c.cta.replace(/_/g, " ").toLowerCase()}</span>}
            {c.url && (
              <a href={c.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-brand-text underline">
                {c.url.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            )}
          </div>
        </div>
      )}
      {r.platform !== "team" && <MetricsTable ref7={r.m7} ref30={r.m30} r={r} />}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
        {link && (
          <a href={newId ? verifyLink(r, newId)! : link} target="_blank" rel="noreferrer" className="text-brand-text underline">
            Open in {PLATFORM[r.platform].where} ↗
          </a>
        )}
        {c?.preview && (
          <a href={c.preview} target="_blank" rel="noreferrer" className="text-ink/60 underline hover:text-fg">
            Ad preview ↗
          </a>
        )}
      </div>
    </div>
  );
}

/** An object by name, with its preview on hover (a sheet on a phone). Never just a bare title. */
function Obj({ r, newId }: { r: ObjRef; newId?: string | null }) {
  const thumb = r.creative?.thumb ?? r.creative?.cards?.[0]?.thumb ?? null;
  const metaAd = r.platform === "meta" && r.level === "ad" ? r.id : null;
  return (
    <HoverCard width={340} content={<Preview r={r} newId={newId} />}>
      <button type="button" className="inline-flex max-w-full items-center gap-2 rounded-[10px] border border-ink/10 bg-ink/[0.04] py-1 pl-1 pr-2.5 text-left text-[12.5px] transition-colors hover:border-ink/25 max-md:min-h-11">
        {thumb || metaAd ? (
          <AdImg src={thumb} adId={metaAd} className="h-8 w-8 shrink-0 rounded-[7px] object-cover" />
        ) : (
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] bg-ink/10 text-[10px] text-ink/60">{LEVEL[r.level].slice(0, 2)}</span>
        )}
        <span className="grid min-w-0">
          <span className="truncate font-medium">{r.name}</span>
          {r.path.length > 0 && <span className="truncate text-[10.5px] text-ink/45">{r.path.join(" › ")}</span>}
        </span>
      </button>
    </HoverCard>
  );
}

const EDITABLE = { meta_budget: "to", campaign_budget: "to", target_cpa: "to", target_roas: "to", meta_rename: "name", meta_link: "url", google_ad_url: "url" } as const;

function Line({ op, i, on, toggle, locked, edit, setEdit }: { op: PlannedOp; i: number; on: boolean; toggle: () => void; locked: boolean; edit: OpEdit | undefined; setEdit: (e: OpEdit | undefined) => void }) {
  const [what, from, to] = lineOf(op);
  const field = EDITABLE[op.kind as keyof typeof EDITABLE];
  const [editing, setEditing] = useState(false);
  const failed = op.check?.ok === false;
  const done = op.result;
  const ref = op.ref ?? null;
  return (
    <li className={`grid gap-2 rounded-[12px] border px-3 py-2.5 ${done?.ok ? "border-ok/30 bg-ok-soft/20" : done && !done.ok ? "border-bad/30 bg-bad-soft/20" : "border-ink/[0.08] bg-ink/[0.02]"}`}>
      <div className="flex items-start gap-2.5">
        {!done && (
          <input
            type="checkbox"
            checked={on && !failed}
            disabled={locked || failed}
            onChange={toggle}
            aria-label={`Include: ${what}`}
            className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-brand,#b21e2c)] max-md:h-6 max-md:w-6"
          />
        )}
        <div className="grid min-w-0 flex-1 gap-1.5">
          {ref ? <Obj r={ref} newId={done?.newId} /> : <span className="text-[12.5px] font-medium">{what}</span>}
          {op.kind === "meta_copy_ad" && op.dest && (
            <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink/55">
              into <Obj r={op.dest} />
            </span>
          )}
          <p className="text-[12px] leading-snug text-ink/75 [overflow-wrap:anywhere]">
            <span className="text-ink/55">{ref ? what.replace(/ ".*$/, "") : ""}</span>
            {ref ? " " : ""}
            {from != null && <span className="text-ink/45 line-through decoration-ink/30">{from}</span>}
            {from != null && " → "}
            <span className="font-medium text-fg">{field && edit ? (field === "to" ? `$${edit.to}` : field === "name" ? edit.name : edit.url) : to}</span>
          </p>
          {editing && field && !locked && (
            <span className="flex gap-1.5">
              <input
                autoFocus
                defaultValue={field === "to" ? String(edit?.to ?? (op as { to?: number }).to ?? "") : field === "name" ? (edit?.name ?? String((op as { to?: string }).to ?? "")) : (edit?.url ?? String((op as { to?: string }).to ?? ""))}
                inputMode={field === "to" ? "decimal" : field === "url" ? "url" : "text"}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  setEdit(!v ? undefined : field === "to" ? { to: Number(v.replace(/[$,]/g, "")) } : field === "name" ? { name: v } : { url: v });
                  setEditing(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="h-10 min-w-0 flex-1 rounded-[10px] border border-ink/15 bg-transparent px-3 text-[16px] outline-none focus:border-brand/50 md:h-8 md:text-[13px]"
              />
            </span>
          )}
          {op.why && <p className="text-[11px] text-ink/50">{op.why}</p>}
          {op.warning && !done && <p className="text-[11px] text-warn">{op.warning}</p>}
          {failed && !done && <p className="text-[11px] text-bad">Won&apos;t go through: {op.check?.error}</p>}
          {done && (
            <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] ${done.ok ? "text-ok" : "text-bad"}`}>
              {done.ok ? "✓ Done" : `× ${done.error}`}
              {done.ok && ref && verifyLink(ref, done.newId) && (
                <a href={verifyLink(ref, done.newId)!} target="_blank" rel="noreferrer" className="text-brand-text underline">
                  Check it in {PLATFORM[ref.platform].where} ↗
                </a>
              )}
            </p>
          )}
        </div>
        {field && !locked && !done && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-ink/55 hover:bg-ink/10 hover:text-fg max-md:min-h-11">
            Edit
          </button>
        )}
      </div>
      <span className="sr-only">Change {i + 1}</span>
    </li>
  );
}

export function ChatPlan({ id }: { id: string }) {
  const router = useRouter();
  const [v, setV] = useState<ChatChangeView | null>(null);
  const [picks, setPicks] = useState<Set<number> | null>(null);
  const [edits, setEdits] = useState<Record<number, OpEdit>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow the plan while the buyer agent writes it
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await loadChatChange(id).catch(() => null);
      if (!live) return;
      setV(next);
      if (next?.status === "planning" || next?.status === "applying") timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  const ops = v?.ops ?? [];
  const chosen = picks ?? new Set(ops.map((o, i) => (o.selected !== false && o.check?.ok !== false && !o.result?.ok ? i : -1)).filter((i) => i >= 0));
  const p = PLATFORM[v?.platform ?? "meta"];
  const open = v && ["ready", "partial", "failed"].includes(v.status) && ops.some((o) => !o.result?.ok);
  const locked = !v || !open || !v.canConfirm || Boolean(busy);

  const confirm = async () => {
    if (!v) return;
    setBusy("confirm");
    setError(null);
    const r = await confirmChatChange(v.id, [...chosen], edits);
    setBusy(null);
    if (r.ok) {
      setV(r.view);
      setPicks(null);
      setEdits({});
      router.refresh();
    } else setError(r.error);
  };

  if (!v)
    return (
      <div className="w-full max-w-[96%] animate-pulse rounded-[14px] border border-ink/[0.08] p-3 text-[12px] text-ink/50">Opening the plan…</div>
    );

  return (
    <section className={`grid w-full max-w-[96%] gap-2.5 rounded-[14px] border p-3 ${p.ring} ${p.tint}`}>
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-ink/60">
          <span className={`h-2 w-2 rounded-full ${p.dot}`} />
          {v.platform === "team" ? "Team change" : `Plan · ${p.name}`}
        </span>
        <span className="text-[10.5px] text-ink/45">
          {v.status === "planning" ? "Reading the live account…" : v.status === "applying" ? "Making the changes…" : v.status === "applied" ? `Done${v.appliedBy ? ` · ${v.appliedBy}` : ""}` : v.status === "partial" ? "Partly done" : v.status === "discarded" ? "Dropped" : v.status === "nothing" ? "Nothing to change" : v.savedAt ? "Saved as a checklist" : `${chosen.size} of ${ops.length} ticked`}
        </span>
      </header>

      {v.status === "planning" && (
        <p className="flex items-center gap-2 text-[12px] text-ink/60">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
          Pulling the exact {v.platform === "google" ? "campaigns, ads and keywords" : v.platform === "team" ? "people" : "campaigns, ad sets and ads"} and their numbers. Nothing changes until you confirm.
        </p>
      )}
      {v.note && v.status !== "planning" && <p className="text-[12.5px] leading-relaxed text-ink/80">{v.note}</p>}
      {v.error && <p className="text-[12px] text-bad">{v.error}</p>}

      {ops.length > 0 && (
        <ul className="grid gap-2">
          {ops.map((op, i) => (
            <Line
              key={i}
              op={op}
              i={i}
              on={chosen.has(i)}
              locked={locked}
              toggle={() => {
                const next = new Set(chosen);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                setPicks(next);
              }}
              edit={edits[i]}
              setEdit={(e) => setEdits((cur) => ({ ...cur, [i]: e as OpEdit }))}
            />
          ))}
        </ul>
      )}

      {open && !v.live && v.platform !== "team" && (
        <p className="rounded-[10px] border border-warn/30 bg-warn-soft/30 px-3 py-2 text-[12px] text-ink/80">{v.liveNote ?? "Live changes are off for this client."} Save it as a checklist to apply by hand, or confirm it here once they&apos;re on.</p>
      )}
      {open && !v.canConfirm && <p className="text-[11.5px] text-ink/50">{v.platform === "team" ? "An exec or a lead confirms a buyer change." : `The client's buyer, the head of ${p.name}, a lead or an exec confirms this.`}</p>}
      {error && <p className="text-[12px] text-bad">{error}</p>}

      {open && v.canConfirm && (
        <div className="flex flex-wrap gap-2">
          {v.live ? (
            <button type="button" disabled={Boolean(busy) || !chosen.size} onClick={() => void confirm()} className="h-11 rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-40 md:h-9">
              {busy === "confirm" ? "Making the changes…" : `Confirm ${chosen.size} change${chosen.size === 1 ? "" : "s"}`}
            </button>
          ) : (
            !v.savedAt && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={async () => {
                  setBusy("save");
                  setV((await saveChatChecklist(v.id)) ?? v);
                  setBusy(null);
                }}
                className="h-11 rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-40 md:h-9"
              >
                Save as a checklist
              </button>
            )
          )}
          {v.status !== "partial" && (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={async () => {
                setBusy("drop");
                setV((await discardChatChange(v.id)) ?? v);
                setBusy(null);
              }}
              className="h-11 rounded-full border border-ink/10 px-4 text-[13px] text-ink/60 hover:text-fg md:h-9"
            >
              Drop it
            </button>
          )}
        </div>
      )}
    </section>
  );
}
