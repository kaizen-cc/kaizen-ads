"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { WriteOff } from "@/components/write-gate";
import { chars, G, kwText, type AdLine, type GAdGroup, type GCampaign, type GooglePlan, type Match, type PlanEdit, type Rsa } from "@/lib/google-launch/core";
import type { LaunchItem } from "@/lib/launch-sheet/types";
import { Checklist, Mark, Question } from "./launch-card";
import { Clamp, LaunchMore } from "./launch-more";
import {
  buildGoogleLaunchPlan,
  deployGoogleLaunch,
  editGoogleLaunch,
  fixGoogleLaunch,
  loadGoogleLaunch,
  recheckGoogleLaunch,
  setAsideGoogleLaunch,
  takeGoogleProposals,
  type GoogleLaunchView,
} from "./google-launch-actions";

// The Google launch card under a chat answer: what was read (the buyer's words or their sheet), the questions only
// they can answer (only about this launch), then the plan as every object it creates
// (campaign, ad groups, keywords by match type, negatives, each RSA headline and description with its character count,
// assets, budget), each with Google's dry run. Lines are edited or removed right here; Deploy creates it all paused; once it's read back, the card offers to suggest more for the rest of the account.

const WORKING = new Set(["reading", "resolving", "planning", "checking", "applying"]);
const STATUS: Record<string, string> = {
  reading: "Reading…",
  resolving: "Checking the account…",
  asking: "Waiting on your answers",
  planning: "Laying out the plan…",
  checking: "Checking with Google…",
  ready: "Plan ready",
  applying: "Creating in Google Ads…",
  applied: "Created, paused",
  partial: "Created, some by hand",
  failed: "Stopped",
  set_aside: "Set aside",
  discarded: "Dropped",
};
const MATCH_LABEL: Record<Match, string> = { EXACT: "Exact", PHRASE: "Phrase", BROAD: "Broad" };
const BID: Record<string, string> = { MAXIMIZE_CONVERSIONS: "Maximize conversions", MAXIMIZE_CONVERSION_VALUE: "Maximize conversion value", MAXIMIZE_CLICKS: "Maximize clicks", MANUAL_CPC: "Manual CPC" };

type Act = (key: string, fn: () => Promise<{ ok: true; view: GoogleLaunchView } | { ok: false; error: string } | GoogleLaunchView | null>) => Promise<void>;

const levelOf = (i: LaunchItem | undefined) => (i?.status ?? "planned") as Parameters<typeof Mark>[0]["level"];

function LineNote({ item, link }: { item: LaunchItem | undefined; link?: string | null }) {
  if (!item) return null;
  return (
    <>
      {(item.status === "invalid" || item.status === "failed") && item.error && (
        <p className="text-[11.5px] leading-snug text-bad [overflow-wrap:anywhere]">
          {item.error}
          {item.help && <span className="block text-ink/70">Fix: {item.help}</span>}
        </p>
      )}
      {(item.status === "unchecked" || item.status === "skipped" || item.status === "valid") && item.help && <p className="text-[11px] leading-snug text-ink/50">{item.help}</p>}
      {link && (
        <a href={link} target="_blank" rel="noreferrer" className="w-fit text-[11.5px] text-brand-text underline max-md:inline-flex max-md:min-h-9 max-md:items-center">
          Open in Google Ads ↗
        </a>
      )}
    </>
  );
}

function Remove({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" aria-label={`Remove ${label}`} title="Remove from the plan" disabled={disabled} onClick={onClick} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink/40 hover:bg-ink/[0.06] hover:text-bad disabled:opacity-30 md:h-7 md:w-7">
      ×
    </button>
  );
}

/** Text that turns into a box on tap; Enter saves, Escape cancels, an empty line removes it */
function Editable({ value, max, onSave, disabled, placeholder }: { value: string; max?: number; onSave: (v: string) => void; disabled: boolean; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const n = chars(editing ? v : value);
  const over = max != null && n > max;
  if (editing && !disabled)
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          if (v.trim() !== value) onSave(v.trim());
        }}
      >
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setV(value))}
          className="h-11 min-w-0 flex-1 rounded-[8px] border border-brand/40 bg-bg px-2.5 text-[16px] outline-none md:h-8 md:text-[12.5px]"
        />
        {max != null && <span className={`tabular w-11 shrink-0 text-right text-[10.5px] ${over ? "text-bad" : "text-ink/45"}`}>{n}/{max}</span>}
        <button type="submit" className="h-11 shrink-0 rounded-full bg-fg px-3 text-[12px] text-bg md:h-8">
          Save
        </button>
      </form>
    );
  return (
    <button type="button" disabled={disabled} onClick={() => (setV(value), setEditing(true))} className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-[8px] px-1.5 text-left hover:bg-ink/[0.04] disabled:hover:bg-transparent md:min-h-7">
      <span className={`min-w-0 text-[12.5px] leading-snug [overflow-wrap:anywhere] ${value ? "" : "text-ink/35"}`}>{value || placeholder}</span>
      {max != null && <span className={`tabular shrink-0 text-[10.5px] ${over ? "font-medium text-bad" : "text-ink/40"}`}>{n}/{max}</span>}
    </button>
  );
}

function CopyLines({ lines, field, max, rsaKey, edit, busy }: { lines: AdLine[]; field: "headline" | "description"; max: number; rsaKey: string; edit: (e: PlanEdit) => void; busy: boolean }) {
  return (
    <ol className="grid gap-0.5">
      {lines.map((l, i) => (
        <li key={`${i}-${l.text}`} className="flex items-center gap-1.5">
          <span className="tabular w-5 shrink-0 text-right text-[10px] text-ink/35">{i + 1}</span>
          {l.pin ? <span className="shrink-0 rounded-full bg-ink/[0.07] px-1.5 text-[9.5px] text-ink/60">{field === "headline" ? "H" : "D"}{l.pin}</span> : null}
          <Editable value={l.text} max={max} disabled={busy} onSave={(text) => edit({ type: "line", key: rsaKey, field, index: i, text })} />
        </li>
      ))}
    </ol>
  );
}

function RsaLine({ r, g, items, edit, busy, link }: { r: Rsa; g: GAdGroup; items: LaunchItem[]; edit: (e: PlanEdit) => void; busy: boolean; link: string | null }) {
  const key = `rsa:${g.key}:${r.key}`;
  const item = items.find((i) => i.key === key);
  const [open, setOpen] = useState(item?.status === "invalid");
  const over = r.headlines.filter((h) => chars(h.text) > G.headline).length + r.descriptions.filter((d) => chars(d.text) > G.description).length;
  return (
    <li className="grid gap-1.5 rounded-[12px] border border-ink/[0.07] bg-bg/40 p-2.5">
      <div className="flex items-start gap-2">
        <Mark level={levelOf(item)} />
        <button type="button" onClick={() => setOpen((o) => !o)} className="grid min-h-11 min-w-0 flex-1 gap-0.5 text-left md:min-h-0">
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink/45">Responsive search ad</span>
          <span className="text-[12.5px] font-medium leading-snug [overflow-wrap:anywhere]">{r.headlines.slice(0, 3).map((h) => h.text).join(" | ") || "No headlines"}</span>
          <span className="text-[11px] text-ink/55">
            {r.headlines.length}/15 headlines · {r.descriptions.length}/4 descriptions{over ? ` · ${over} over the limit` : ""} {open ? "▴" : "▾"}
          </span>
        </button>
        <Remove label="this ad" disabled={busy} onClick={() => edit({ type: "remove", key })} />
      </div>
      {open && (
        <div className="grid gap-2 rounded-[10px] bg-ink/[0.03] p-2">
          <p className="text-[10px] uppercase tracking-[0.12em] text-ink/45">Headlines · 30 characters</p>
          <CopyLines lines={r.headlines} field="headline" max={G.headline} rsaKey={key} edit={edit} busy={busy} />
          {r.headlines.length < G.headlinesMax && (
            <Editable value="" placeholder="+ Add a headline" max={G.headline} disabled={busy} onSave={(text) => text && edit({ type: "line", key, field: "headline", index: r.headlines.length, text })} />
          )}
          <p className="pt-1 text-[10px] uppercase tracking-[0.12em] text-ink/45">Descriptions · 90 characters</p>
          <CopyLines lines={r.descriptions} field="description" max={G.description} rsaKey={key} edit={edit} busy={busy} />
          {r.descriptions.length < G.descriptionsMax && (
            <Editable value="" placeholder="+ Add a description" max={G.description} disabled={busy} onSave={(text) => text && edit({ type: "line", key, field: "description", index: r.descriptions.length, text })} />
          )}
          <div className="grid gap-1 pt-1 sm:grid-cols-2">
            <span className="flex items-center gap-1 text-[11px] text-ink/45">
              /<Editable value={r.path1} placeholder="path 1" max={G.path} disabled={busy} onSave={(text) => edit({ type: "rsa", key, field: "path1", text })} />
            </span>
            <span className="flex items-center gap-1 text-[11px] text-ink/45">
              /<Editable value={r.path2} placeholder="path 2" max={G.path} disabled={busy} onSave={(text) => edit({ type: "rsa", key, field: "path2", text })} />
            </span>
          </div>
          <span className="flex items-center gap-1 text-[11px] text-ink/45">
            Final URL <Editable value={r.finalUrl} placeholder="https://…" disabled={busy} onSave={(text) => edit({ type: "rsa", key, field: "finalUrl", text })} />
          </span>
        </div>
      )}
      <LineNote item={item} link={link} />
    </li>
  );
}

function KeywordChips({ g, kind, items, edit, busy }: { g: GAdGroup; kind: "kw" | "aneg"; items: LaunchItem[]; edit: (e: PlanEdit) => void; busy: boolean }) {
  const list = kind === "kw" ? g.keywords : g.negatives;
  if (!list.length) return null;
  const groups = (["EXACT", "PHRASE", "BROAD"] as Match[]).map((m) => ({ m, ks: list.map((k, i) => ({ k, i })).filter((x) => x.k.match === m) })).filter((x) => x.ks.length);
  const bad = list.map((_, i) => items.find((x) => x.key === `${kind}:${g.key}:${i}`)).filter((x) => x?.status === "invalid" || x?.status === "failed");
  return (
    <div className="grid gap-1.5">
      {groups.map(({ m, ks }) => (
        <div key={m} className="grid gap-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink/45">
            {kind === "aneg" ? "Negatives · " : ""}
            {MATCH_LABEL[m]} · {ks.length}
          </span>
          <span className="flex flex-wrap gap-1">
            {ks.map(({ k, i }) => {
              const it = items.find((x) => x.key === `${kind}:${g.key}:${i}`);
              const wrong = it?.status === "invalid" || it?.status === "failed";
              return (
                <span key={`${k.match}-${k.text}-${i}`} title={it?.error ?? it?.help ?? undefined} className={`inline-flex max-w-full items-center gap-0.5 rounded-full border py-0.5 pl-2.5 text-[11.5px] ${wrong ? "border-bad/40 bg-bad-soft/20 text-bad" : it?.status === "created" ? "border-ok/30 text-ink/80" : "border-ink/10 text-ink/75"}`}>
                  <span className="truncate">{kwText(k)}</span>
                  <button type="button" aria-label={`Remove ${kwText(k)}`} disabled={busy} onClick={() => edit({ type: "remove", key: `${kind}:${g.key}:${i}` })} className="grid h-9 w-9 place-items-center rounded-full text-ink/40 hover:text-bad disabled:opacity-30 md:h-5 md:w-6">
                    ×
                  </button>
                </span>
              );
            })}
          </span>
        </div>
      ))}
      {bad.length > 0 && <p className="text-[11px] text-bad">{bad.map((b) => b?.error).filter(Boolean).slice(0, 3).join(" ")}</p>}
    </div>
  );
}

function AdGroupLine({ g, items, edit, busy, links }: { g: GAdGroup; items: LaunchItem[]; edit: (e: PlanEdit) => void; busy: boolean; links: Map<string, string | null> }) {
  const item = items.find((i) => i.key === `adgroup:${g.key}`);
  return (
    <li className="grid gap-2 rounded-[12px] border border-ink/[0.08] bg-ink/[0.02] p-2.5">
      <div className="flex items-start gap-2">
        <Mark level={levelOf(item)} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink/45">Ad group · {g.mode === "existing" ? "existing, adding into it" : "new, paused"}</span>
          {g.mode === "new" ? <Editable value={g.name} disabled={busy} onSave={(text) => edit({ type: "name", key: `adgroup:${g.key}`, text })} /> : <span className="text-[12.5px] font-medium">{g.name}</span>}
          <span className="text-[11px] text-ink/55">
            {g.keywords.length} keyword{g.keywords.length === 1 ? "" : "s"} · {g.rsas.length} ad{g.rsas.length === 1 ? "" : "s"}
            {g.negatives.length ? ` · ${g.negatives.length} negatives` : ""}
          </span>
          <LineNote item={item} link={links.get(`adgroup:${g.key}`)} />
        </div>
        {g.mode === "new" && <Remove label={g.name} disabled={busy} onClick={() => edit({ type: "remove", key: `adgroup:${g.key}` })} />}
      </div>
      <div className="grid gap-2 md:pl-7">
        <KeywordChips g={g} kind="kw" items={items} edit={edit} busy={busy} />
        <KeywordChips g={g} kind="aneg" items={items} edit={edit} busy={busy} />
        {g.rsas.length > 0 && (
          <ul className="grid gap-1.5">
            {g.rsas.map((r) => (
              <RsaLine key={r.key} r={r} g={g} items={items} edit={edit} busy={busy} link={links.get(`rsa:${g.key}:${r.key}`) ?? null} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function CampaignLine({ c, plan, items, edit, busy, links }: { c: GCampaign; plan: GooglePlan; items: LaunchItem[]; edit: (e: PlanEdit) => void; busy: boolean; links: Map<string, string | null> }) {
  const item = items.find((i) => i.key === `campaign:${c.key}`);
  const budget = items.find((i) => i.key === `budget:${c.key}`);
  const ext = items.filter((i) => i.parentKey === `campaign:${c.key}` && (i.kind === "extension" || i.kind === "negative"));
  return (
    <li className="grid gap-2">
      <div className="flex items-start gap-2">
        <Mark level={levelOf(budget?.status === "invalid" ? budget : item)} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink/45">
            {c.type === "PERFORMANCE_MAX" ? "Performance Max" : "Search"} campaign · {c.mode === "existing" ? "existing" : "new, paused"}
          </span>
          {c.mode === "new" ? <Editable value={c.name} disabled={busy} onSave={(text) => edit({ type: "name", key: `campaign:${c.key}`, text })} /> : <span className="text-[13px] font-medium leading-snug">{c.name}</span>}
          {c.mode === "new" && c.type === "SEARCH" && (
            <span className="flex flex-wrap items-center gap-x-1 text-[11px] text-ink/55">
              <span className="inline-flex items-center">
                $<Editable value={String(c.budget ?? "")} placeholder="budget" disabled={busy} onSave={(t) => Number(t) > 0 && edit({ type: "budget", campaignKey: c.key, amount: Number(t) })} />/day
              </span>
              · {BID[c.bidding]}
              {c.targetCpa ? ` · target CPA $${c.targetCpa}` : ""}
              {c.targetRoas ? ` · target ROAS ${Math.round(c.targetRoas * 100)}%` : ""} · {c.locations.map((l) => l.name.split(",")[0]).join(", ") || "no locations"} · English
            </span>
          )}
          <LineNote item={budget?.status === "invalid" ? budget : item} link={links.get(`campaign:${c.key}`)} />
        </div>
        {c.mode === "new" && <Remove label={c.name} disabled={busy} onClick={() => edit({ type: "remove", key: `campaign:${c.key}` })} />}
      </div>
      {ext.length > 0 && (
        <ul className="flex flex-wrap gap-1 md:pl-7">
          {ext.map((e) => (
            <li key={e.key} title={e.error ?? undefined} className={`inline-flex max-w-full items-center gap-0.5 rounded-full border py-0.5 pl-2.5 text-[11.5px] ${e.status === "invalid" ? "border-bad/40 text-bad" : "border-ink/10 text-ink/70"}`}>
              <span className="truncate">{e.kind === "negative" ? `Negative ${e.label}` : e.label}</span>
              <button type="button" aria-label={`Remove ${e.label}`} disabled={busy} onClick={() => edit({ type: "remove", key: e.key })} className="grid h-9 w-9 place-items-center rounded-full text-ink/40 hover:text-bad disabled:opacity-30 md:h-5 md:w-6">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="grid gap-2 md:pl-4">
        {plan.adGroups
          .filter((g) => g.campaignKey === c.key)
          .map((g) => (
            <AdGroupLine key={g.key} g={g} items={items} edit={edit} busy={busy} links={links} />
          ))}
        {plan.assetGroups
          .filter((a) => a.campaignKey === c.key)
          .map((a) => {
            const it = items.find((i) => i.key === `assetgroup:${a.key}`);
            return (
              <li key={a.key} className="grid gap-1 rounded-[12px] border border-ink/[0.08] bg-ink/[0.02] p-2.5">
                <div className="flex items-start gap-2">
                  <Mark level={levelOf(it)} />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-ink/45">Asset group · {a.mode === "existing" ? "existing" : "new, by hand"}</span>
                    <span className="text-[12.5px] font-medium">{a.name}</span>
                    <span className="text-[11px] text-ink/55">{it?.label.split(": ").slice(1).join(": ")}</span>
                    {[...a.headlines, ...a.longHeadlines, ...a.descriptions].slice(0, 12).map((t, i) => (
                      <span key={i} className="text-[11.5px] text-ink/75">
                        {t} <span className={`tabular text-[10px] ${chars(t) > (i < a.headlines.length ? G.headline : G.description) ? "text-bad" : "text-ink/35"}`}>{chars(t)}</span>
                      </span>
                    ))}
                    <LineNote item={it} />
                  </div>
                  <Remove label={a.name} disabled={busy} onClick={() => edit({ type: "remove", key: `assetgroup:${a.key}` })} />
                </div>
              </li>
            );
          })}
      </ul>
    </li>
  );
}

export function GoogleLaunchCard({ id, compact = false }: { id: string; compact?: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<GoogleLaunchView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Polls while the questions are being tailored (status asking with progress), at most about two minutes
  const tailoring = useRef(0);

  // Follow it while it's being read, planned, checked or created, and while the questions are being tailored
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await loadGoogleLaunch(id).catch(() => null);
      if (!live) return;
      setV(next);
      const refining = next?.status === "asking" && Boolean(next.progress) && tailoring.current++ < 50;
      if (next && (WORKING.has(next.status) || refining || (next.status === "applied" && !next.qa))) timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, busy]);

  const act: Act = async (key, fn) => {
    setBusy(key);
    setError(null);
    const r = await fn().catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "Something went wrong." }));
    setBusy(null);
    if (r && "ok" in r) {
      if (r.ok) setV(r.view);
      else setError(r.error);
    } else if (r) setV(r);
    router.refresh();
  };

  if (!v) return <div className="w-full max-w-[96%] animate-pulse rounded-[14px] border border-ink/[0.08] p-3 text-[12px] text-ink/50">Opening the launch…</div>;
  if (compact)
    return (
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#1a73e8]/30 bg-[#1a73e8]/[0.06] px-3 py-1 text-[11px] text-ink/65">
        <span className="h-1.5 w-1.5 rounded-full bg-[#1a73e8]" />
        Google launch · {STATUS[v.status] ?? v.status} · latest card below
      </span>
    );

  const plan = v.plan;
  const open = v.questions.filter((q) => !q.answer);
  const requiredOpen = open.filter((q) => q.required);
  const links = new Map((v.qa?.lines ?? []).map((l) => [l.key, l.link]));
  const toMake = v.items.filter((i) => i.status !== "existing").length;
  const invalid = v.items.filter((i) => i.status === "invalid").length;
  const created = v.items.filter((i) => i.status === "created").length;
  const editing = ["ready", "failed"].includes(v.status) && !busy;
  const edit = (e: PlanEdit) => void act(`edit:${"key" in e ? e.key : e.type}`, () => editGoogleLaunch(v.id, e));
  const kws = plan?.adGroups.reduce((s, g) => s + g.keywords.length, 0) ?? 0;
  const ads = plan?.adGroups.reduce((s, g) => s + g.rsas.length, 0) ?? 0;
  const qaBad = (v.qa?.lines ?? []).filter((l) => !l.ok);

  return (
    // Never wider than the chat panel: every descendant may shrink (min-w-0) and long tokens (campaign names with pipes,
    // URLs, keyword lists) wrap anywhere
    <section className="grid w-full min-w-0 max-w-[96%] grid-cols-[minmax(0,1fr)] gap-3 rounded-[16px] border border-[#1a73e8]/30 bg-[#1a73e8]/[0.04] p-3 [overflow-wrap:anywhere] md:p-3.5 [&_*]:min-w-0">
      <header className="flex items-center justify-between gap-2">
        <span className="flex shrink-0 items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-ink/60">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#1a73e8]" />
          Launch · Google Ads
        </span>
        <span className="flex items-center gap-1.5 truncate text-[10.5px] text-ink/50" title={STATUS[v.status] ?? v.status}>
          {(WORKING.has(v.status) || (v.status === "asking" && v.progress)) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" />}
          <span className="truncate">{STATUS[v.status] ?? v.status}</span>
        </span>
      </header>
      <p className="truncate text-[11.5px] text-ink/55" title={`${v.source}${v.account ? ` · account ${v.account}` : ""}`}>
        {v.source}
        {v.account ? ` · account ${v.account.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}` : ""}
      </p>

      {v.progress && (WORKING.has(v.status) || v.status === "asking") && (
        <p className="flex items-center gap-2 text-[12px] text-ink/65">
          {v.status === "asking" && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" />}
          {v.progress}
          {v.status === "asking" ? "… you can answer already" : ""}
        </p>
      )}
      {v.error && <p className="rounded-[10px] border border-bad/25 bg-bad-soft/20 px-3 py-2 text-[12px] text-ink/85">{v.error}</p>}

      {v.summary && (
        <div className="grid gap-1.5 text-[12.5px] leading-relaxed text-ink/85">
          {v.summary.split(/\n{2,}/).map((p, i) => (
            <Clamp key={i} text={p} className={p.startsWith("Note:") ? "text-[11.5px] text-ink/60" : ""} />
          ))}
        </div>
      )}

      {v.checks.length > 0 && !plan && (
        <div className="grid gap-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink/45">What I checked</p>
          <Checklist checks={v.checks} />
        </div>
      )}

      {v.questions.length > 0 && (v.status === "asking" || !plan) && (
        <div className="grid gap-2">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink/45">Only you can decide{requiredOpen.length ? ` · ${requiredOpen.length} to go` : ""}</p>
          <ul className="grid gap-2">
            {v.questions.map((q) => (
              <Question key={q.key} q={q} busy={Boolean(busy) || v.status !== "asking"} onUse={(answer) => void act(`use:${q.key}`, () => (answer ? takeGoogleProposals(v.id, [q.key], { [q.key]: answer }) : takeGoogleProposals(v.id, [q.key])))} />
            ))}
          </ul>
        </div>
      )}
      {["asking", "ready"].includes(v.status) && (
        <div className="flex flex-wrap items-center gap-2">
          {v.status === "asking" && open.length > 1 && (
            <button type="button" disabled={Boolean(busy)} onClick={() => void act("all", () => takeGoogleProposals(v.id, open.map((q) => q.key)))} className="h-11 rounded-full border border-ink/15 px-4 text-[12.5px] text-ink/75 hover:text-fg disabled:opacity-40 md:h-9">
              Use all proposals
            </button>
          )}
          <button type="button" disabled={Boolean(busy) || requiredOpen.length > 0} onClick={() => void act("build", () => buildGoogleLaunchPlan(v.id))} className={`h-11 rounded-full px-5 text-[13px] font-medium disabled:opacity-40 md:h-9 ${v.status === "asking" ? "bg-fg text-bg" : "border border-ink/15 text-ink/75"}`}>
            {busy === "build" ? "Starting…" : v.status === "asking" ? "Build the plan" : "Rebuild the plan"}
          </button>
          {v.status === "asking" && <span className="text-[11px] text-ink/45">Or answer in the chat, in your own words.</span>}
        </div>
      )}

      {plan && (
        <div className="grid gap-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink/45">The plan · everything created paused</p>
            <span className="text-[10.5px] text-ink/45">{created ? `${created} of ${toMake} created` : `${toMake} lines · ${kws} keywords · ${ads} ads`}</span>
          </div>
          {plan.note && <Clamp text={plan.note} className="text-[12px] leading-relaxed text-ink/75" />}
          {v.warnings.length > 0 && (
            <ul className="grid gap-1 rounded-[10px] border border-warn/25 bg-warn-soft/20 px-3 py-2">
              {v.warnings.slice(0, 8).map((w) => (
                <li key={w} className="text-[11.5px] leading-snug text-ink/80">
                  ! {w}
                </li>
              ))}
            </ul>
          )}
          <ul className="grid gap-3">
            {plan.campaigns.map((c) => (
              <CampaignLine key={c.key} c={c} plan={plan} items={v.items} edit={edit} busy={!editing} links={links} />
            ))}
          </ul>
          {editing && <p className="text-[11px] text-ink/45">Tap any line to fix it, × to leave it out. Every change is checked with Google again.</p>}
        </div>
      )}

      {v.qa && (
        <p className={`rounded-[10px] px-3 py-2 text-[12px] ${qaBad.length ? "border border-warn/30 bg-warn-soft/20" : "border border-ok/25 bg-ok-soft/15"}`}>
          {qaBad.length ? `Read back from Google: ${qaBad.length} line${qaBad.length === 1 ? "" : "s"} differ from the plan. ${qaBad.slice(0, 3).map((l) => `${l.key.split(":")[0]} ${l.diffs.join(", ")}`).join("; ")}` : `Read back from Google: all ${v.qa.lines.length} created lines are there, paused. Turn them on in Google Ads when you're ready.`}
        </p>
      )}

      {/* Once it's deployed and read back: suggest more for the rest of the account (sprint or the buyer's tasks) */}
      {v.status === "applied" && v.qa && <LaunchMore runId={v.id} />}

      {v.status === "ready" && !v.write.live && <WriteOff status={v.write} canSwitch={v.canSwitch} account={v.account} compact onLive={() => void loadGoogleLaunch(v.id).then((next) => next && setV(next))} />}
      {v.status === "ready" && v.write.live && !v.canConfirm && <p className="text-[11.5px] text-ink/50">The client&apos;s Google buyer, the head of Google, a lead or an exec deploys a launch.</p>}
      {error && <p className="text-[12px] text-bad">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {v.status === "ready" && v.write.live && v.canConfirm && (
          <button type="button" disabled={Boolean(busy) || Boolean(v.blocked)} title={v.blocked ?? undefined} onClick={() => void act("deploy", () => deployGoogleLaunch(v.id))} className="h-11 rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-40 md:h-9">
            {busy === "deploy" ? "Starting…" : `Deploy ${toMake} line${toMake === 1 ? "" : "s"}, paused`}
          </button>
        )}
        {["ready", "failed"].includes(v.status) && invalid > 0 && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act("fix", () => fixGoogleLaunch(v.id))} className="h-11 rounded-full border border-ink/15 px-4 text-[12.5px] text-ink/80 hover:text-fg disabled:opacity-40 md:h-9">
            {busy === "fix" ? "Fixing…" : "Fix what I can"}
          </button>
        )}
        {v.status === "failed" && plan && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act("recheck", () => recheckGoogleLaunch(v.id))} className="h-11 rounded-full border border-ink/15 px-4 text-[12.5px] text-ink/80 hover:text-fg disabled:opacity-40 md:h-9">
            Check again
          </button>
        )}
        {["asking", "ready", "failed"].includes(v.status) && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act("aside", () => setAsideGoogleLaunch(v.id))} className="h-11 rounded-full border border-ink/10 px-4 text-[12.5px] text-ink/60 hover:text-fg md:h-9">
            Set aside
          </button>
        )}
      </div>
      {v.status === "ready" && v.blocked && v.write.live && v.canConfirm && <p className="text-[11.5px] text-ink/50">{v.blocked}</p>}
    </section>
  );
}
