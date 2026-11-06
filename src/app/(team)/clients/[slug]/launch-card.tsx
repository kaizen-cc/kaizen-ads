"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { WriteOff } from "@/components/write-gate";
import type { BudgetSpec, CheckItem, LaunchItem, LaunchPlan, LaunchQuestion, PlanAd, PlanAdset, PlanCampaign } from "@/lib/launch-sheet/types";
import { Clamp, LaunchMore } from "./launch-more";
import { buildLaunchPlan, confirmLaunch, continueLaunch, loadLaunch, replyToLaunch, setAsideLaunch, takeLaunchProposals, type LaunchView } from "./launch-sheet-actions";

// The launch card under a chat answer: a launch sheet as the Media Buyer reads it, checks it and asks about it, then
// the plan as line items (campaign → ad sets → ads, each with Meta's dry run), confirmed here and followed line by
// line as it's created, then read back with a link to each object in Ads Manager. The conversation is in the chat.

const WORKING = new Set(["reading", "resolving", "planning", "checking", "applying"]);
const STATUS: Record<string, string> = {
  reading: "Reading the sheet…",
  resolving: "Checking the account…",
  asking: "Waiting on your answers",
  planning: "Laying out the plan…",
  checking: "Checking with Meta…",
  ready: "Plan ready to confirm",
  applying: "Creating in Meta…",
  applied: "Created",
  partial: "Partly created",
  failed: "Stopped",
  set_aside: "Set aside",
  discarded: "Dropped",
};

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
function budgetText(b: BudgetSpec | null) {
  if (!b) return null;
  if (b.type === "lifetime") return `${money(b.amount)} lifetime`;
  return `${money(b.amount)}/day${b.schedules?.length ? ` · raised in ${b.schedules.length} period${b.schedules.length === 1 ? "" : "s"}` : ""}`;
}
const dates = (s: string | null, e: string | null) => (s || e ? `${s ?? "on turn-on"} → ${e ?? "no end"}` : "Starts when turned on");

export function Mark({ level }: { level: CheckItem["level"] | "valid" | "invalid" | "unchecked" | "created" | "failed" | "planned" | "creating" | "skipped" | "existing" }) {
  const m: Record<string, [string, string]> = {
    ok: ["✓", "text-ok"],
    valid: ["✓", "text-ok"],
    created: ["✓", "text-ok"],
    existing: ["✓", "text-ink/50"],
    fail: ["✗", "text-bad"],
    invalid: ["✗", "text-bad"],
    failed: ["✗", "text-bad"],
    warn: ["!", "text-warn"],
    skipped: ["–", "text-ink/40"],
    info: ["i", "text-ink/55"],
    unchecked: ["○", "text-ink/40"],
    planned: ["○", "text-ink/40"],
    creating: ["•", "text-brand animate-pulse"],
  };
  const [ch, cls] = m[level] ?? ["○", "text-ink/40"];
  return <span aria-hidden className={`mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink/[0.06] text-[11px] font-semibold ${cls}`}>{ch}</span>;
}

export function Checklist({ checks }: { checks: CheckItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const order = { fail: 0, warn: 1, info: 2, ok: 3 } as const;
  return (
    <ul className="grid gap-1">
      {[...checks]
        .sort((a, b) => order[a.level] - order[b.level])
        .map((c) => (
          <li key={c.key} className="grid gap-1 rounded-[10px] px-2 py-1.5 hover:bg-ink/[0.03]">
            <button type="button" onClick={() => setOpen(open === c.key ? null : c.key)} className="flex min-h-9 items-start gap-2 text-left max-md:min-h-11">
              <Mark level={c.level} />
              <span className="grid min-w-0 gap-0.5">
                <span className="text-[12.5px] font-medium [overflow-wrap:anywhere]">{c.label}</span>
                <span className={`text-[11.5px] leading-snug text-ink/60 [overflow-wrap:anywhere] ${open === c.key ? "" : "line-clamp-2"}`}>{c.detail}</span>
              </span>
            </button>
            {open === c.key && c.fix && <p className="ml-7 rounded-[8px] border border-ink/[0.08] bg-ink/[0.03] px-2.5 py-1.5 text-[11.5px] leading-snug text-ink/75 [overflow-wrap:anywhere]">How to fix: {c.fix}</p>}
          </li>
        ))}
    </ul>
  );
}

export function Question({ q, busy, onUse }: { q: LaunchQuestion; busy: boolean; onUse: (answer: string | null) => void }) {
  return (
    <li className={`grid gap-1.5 rounded-[12px] border px-3 py-2.5 ${q.answer ? "border-ok/25 bg-ok-soft/10" : "border-ink/[0.08] bg-ink/[0.02]"}`}>
      <p className="text-[12.5px] font-medium leading-snug">
        {q.question}
        {q.required && !q.answer && <span className="ml-1 text-brand-text">*</span>}
      </p>
      {q.why && (
        <p className="line-clamp-2 text-[11px] leading-snug text-ink/50" title={q.why}>
          {q.why}
        </p>
      )}
      {q.answer ? (
        <p className="flex items-start gap-1.5 text-[12px] text-ink/85">
          <span className="text-ok">✓</span>
          <span className="[overflow-wrap:anywhere]">{q.answer}</span>
        </p>
      ) : (
        <>
          <p className="text-[12px] leading-snug text-ink/75 [overflow-wrap:anywhere]">
            <span className="text-ink/45">Proposal: </span>
            {q.proposal}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={busy} onClick={() => onUse(null)} className="h-10 rounded-full bg-fg px-3.5 text-[12px] text-bg disabled:opacity-40 md:h-8">
              Use this
            </button>
            {q.options
              .filter((o) => o.trim() && o.trim() !== q.proposal.trim())
              .slice(0, 4)
              .map((o) => (
                <button key={o} type="button" title={o} disabled={busy} onClick={() => onUse(o)} className="h-10 max-w-full truncate rounded-full border border-ink/10 px-3.5 text-[12px] text-ink/70 hover:text-fg disabled:opacity-40 md:h-8">
                  {o}
                </button>
              ))}
          </div>
        </>
      )}
    </li>
  );
}

const itemOf = (items: LaunchItem[], key: string) => items.find((i) => i.key === key);
const levelOf = (i: LaunchItem | undefined) => (i?.status ?? "planned") as Parameters<typeof Mark>[0]["level"];

function LineState({ item, link }: { item: LaunchItem | undefined; link?: string | null }) {
  if (!item) return null;
  return (
    <>
      {item.status === "unchecked" && item.help && <p className="text-[11px] text-ink/45">{item.help}</p>}
      {(item.status === "invalid" || item.status === "failed" || (item.status === "skipped" && item.error)) && (
        <p className="text-[11.5px] leading-snug text-bad [overflow-wrap:anywhere]">
          {item.status === "skipped" ? "Left out: " : ""}
          {item.error}
          {item.help && <span className="block text-ink/70">Fix: {item.help}</span>}
        </p>
      )}
      {item.status === "created" && item.help && <p className="text-[11px] text-warn">{item.help}</p>}
      {link && (
        <a href={link} target="_blank" rel="noreferrer" className="text-[11.5px] text-brand-text underline">
          Open in Ads Manager ↗
        </a>
      )}
    </>
  );
}

function Thumb({ src, label, video }: { src: string | null; label: string; video?: boolean }) {
  return (
    <span className="relative grid shrink-0 gap-0.5 text-center">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" referrerPolicy="no-referrer" className={`rounded-[7px] bg-ink/10 object-cover ${label === "9:16" ? "h-16 w-9" : "h-14 w-11"}`} />
      ) : (
        <span className={`rounded-[7px] bg-ink/10 ${label === "9:16" ? "h-16 w-9" : "h-14 w-11"}`} />
      )}
      {video && <span className="absolute left-1 top-1 text-[8px] text-white drop-shadow">▶</span>}
      <span className="text-[9.5px] text-ink/45">{label}</span>
    </span>
  );
}

function AdLine({ ad, items, link }: { ad: PlanAd; items: LaunchItem[]; link: string | null }) {
  const [open, setOpen] = useState(false);
  const creative = itemOf(items, `creative:${ad.key}`);
  const item = itemOf(items, `ad:${ad.key}`);
  const shown = item?.status === "planned" || item?.status === "unchecked" ? (creative ?? item) : item;
  return (
    <li className="grid gap-1.5 rounded-[12px] border border-ink/[0.07] bg-bg/40 p-2.5">
      <div className="flex items-start gap-2.5">
        <Mark level={levelOf(shown)} />
        <div className="flex shrink-0 gap-1">
          {ad.source.kind === "files" ? (
            <>
              {ad.source.feed && <Thumb src={ad.source.feed.thumb} label="4:5" video={ad.source.feed.kind === "video"} />}
              {ad.source.vertical && <Thumb src={ad.source.vertical.thumb} label="9:16" video={ad.source.vertical.kind === "video"} />}
            </>
          ) : (
            <span className="grid h-14 w-11 place-items-center rounded-[7px] bg-ink/10 text-center text-[9px] leading-tight text-ink/60">Existing post</span>
          )}
        </div>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[12.5px] font-medium leading-snug [overflow-wrap:anywhere]">{ad.name}</span>
          <span className="text-[11px] text-ink/55 [overflow-wrap:anywhere]">
            {ad.identity.mode === "partnership" ? `Partnership: ${ad.identity.pageName} × ${ad.identity.partnerName}` : `${ad.identity.pageName}${ad.identity.igId ? " + Instagram" : " (Facebook only)"}`}
            {" · "}
            {ad.cta.replace(/_/g, " ").toLowerCase()}
          </span>
          {ad.source.kind === "files" ? (
            <button type="button" onClick={() => setOpen((o) => !o)} className="w-fit text-left text-[11px] text-ink/55 underline decoration-ink/20 hover:text-fg max-md:min-h-9">
              {ad.copy.bodies.length} primary text{ad.copy.bodies.length === 1 ? "" : "s"} · {ad.copy.titles.length} headline{ad.copy.titles.length === 1 ? "" : "s"}, stacked {open ? "▴" : "▾"}
            </button>
          ) : (
            <a href={ad.source.url} target="_blank" rel="noreferrer" className="truncate text-[11px] text-brand-text underline">
              {ad.source.url.replace(/^https?:\/\/(www\.)?/, "")}
            </a>
          )}
        </div>
      </div>
      {open && ad.source.kind === "files" && (
        <div className="grid gap-1.5 rounded-[10px] bg-ink/[0.03] p-2 text-[11.5px] leading-snug">
          {ad.copy.titles.map((t, i) => (
            <p key={`t${i}`}>
              <span className="text-ink/45">Headline {i + 1}: </span>
              {t}
            </p>
          ))}
          {ad.copy.bodies.map((t, i) => (
            <p key={`b${i}`} className="whitespace-pre-wrap">
              <span className="text-ink/45">Primary {i + 1}: </span>
              {t}
            </p>
          ))}
        </div>
      )}
      <p className="truncate text-[10.5px] text-ink/40" title={`${ad.link}${ad.urlTags ? `?${ad.urlTags}` : ""}`}>
        {ad.link.replace(/^https?:\/\/(www\.)?/, "")}
        {ad.urlTags ? " · Kaizen UTMs" : ""}
      </p>
      <LineState item={creative?.status === "invalid" || creative?.status === "failed" ? creative : item} link={link} />
    </li>
  );
}

function AdsetLine({ s, plan, items, qa, cbo }: { s: PlanAdset; plan: LaunchPlan; items: LaunchItem[]; qa: Map<string, string | null>; cbo: boolean }) {
  const item = itemOf(items, `adset:${s.key}`);
  const t = s.targeting;
  const where = [...t.cities.map((c) => `${c.name} +${c.radius}mi`), ...t.regions.map((r) => r.name), ...t.countries, ...t.zips].join(", ") || "No location";
  const ads = plan.ads.filter((a) => a.adsetKey === s.key);
  return (
    <li className="grid gap-2 rounded-[12px] border border-ink/[0.08] bg-ink/[0.02] p-2.5">
      <div className="flex items-start gap-2">
        <Mark level={levelOf(item)} />
        <div className="grid min-w-0 gap-0.5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink/45">Ad set{s.mode === "existing" ? " · existing" : ""}</span>
          <span className="text-[12.5px] font-medium leading-snug [overflow-wrap:anywhere]">{s.name}</span>
          <span className="text-[11px] leading-snug text-ink/55">
            {dates(s.start, s.end)} · {cbo ? "campaign budget" : (budgetText(s.budget) ?? "no budget")} · {s.cloned ? `targeting, pixel and optimization copied from "${s.cloned.name || "the ad set"}"` : `${where} · ages ${t.ageMin}–${t.ageMax === 65 ? "65+" : t.ageMax}`} · {s.event?.toLowerCase() ?? "purchase"}
          </span>
          <LineState item={item} link={qa.get(`adset:${s.key}`)} />
        </div>
      </div>
      {ads.length > 0 && (
        <ul className="grid gap-1.5 md:pl-7">
          {ads.map((a) => (
            <AdLine key={a.key} ad={a} items={items} link={qa.get(`ad:${a.key}`) ?? null} />
          ))}
        </ul>
      )}
    </li>
  );
}

function CampaignLine({ c, plan, items, qa }: { c: PlanCampaign; plan: LaunchPlan; items: LaunchItem[]; qa: Map<string, string | null> }) {
  const item = itemOf(items, `campaign:${c.key}`);
  return (
    <li className="grid gap-2">
      <div className="flex items-start gap-2">
        <Mark level={levelOf(item)} />
        <div className="grid min-w-0 gap-0.5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink/45">Campaign · {c.mode === "existing" ? "existing" : "new"}</span>
          <span className="text-[13px] font-medium leading-snug [overflow-wrap:anywhere]">{c.name}</span>
          <span className="text-[11px] text-ink/55">
            {c.objective.replace("OUTCOME_", "").toLowerCase()}
            {c.budget ? ` · ${budgetText(c.budget)}` : " · budgets on the ad sets"}
          </span>
          {c.budget?.schedules?.length ? <span className="text-[10.5px] text-ink/45">{c.budget.schedules.map((x) => `+${money(x.amount)}/day ${x.start}→${x.end}`).join(" · ")}</span> : null}
          <LineState item={item} link={qa.get(`campaign:${c.key}`)} />
        </div>
      </div>
      <ul className="grid gap-2 md:pl-4">
        {plan.adsets
          .filter((s) => s.campaignKey === c.key)
          .map((s) => (
            <AdsetLine key={s.key} s={s} plan={plan} items={items} qa={qa} cbo={Boolean(c.budget)} />
          ))}
      </ul>
    </li>
  );
}

export function LaunchCard({ id, compact = false, reply = false }: { id: string; compact?: boolean; reply?: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<LaunchView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  // How many lines were created when the launch was last continued from here (so each stop is continued once)
  const continued = useRef(-1);
  // Polls while the questions are being tailored (status asking with progress), at most about two minutes
  const tailoring = useRef(0);

  // Follow the launch while it's being read, planned or created, and while the questions are being tailored
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await loadLaunch(id).catch(() => null);
      if (!live) return;
      setV(next);
      const refining = next?.status === "asking" && Boolean(next.progress) && tailoring.current++ < 50;
      if (next && (WORKING.has(next.status) || next.resumable || refining || (next.status === "applied" && !next.qa))) timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, busy]);

  // A long launch stops before the server's time runs out: pick it up once, from here
  const made = v?.items.filter((i) => i.status === "created").length ?? 0;
  useEffect(() => {
    if (!v?.resumable || !v.canConfirm || continued.current >= made) return;
    continued.current = made;
    void continueLaunch(id).then((r) => r.ok && setV(r.view));
  }, [v?.resumable, v?.canConfirm, made, id]);

  const act = async (key: string, fn: () => Promise<{ ok: true; view: LaunchView } | { ok: false; error: string } | LaunchView | null>) => {
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
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#0866ff]/30 bg-[#0866ff]/[0.06] px-3 py-1 text-[11px] text-ink/65">
        <span className="h-1.5 w-1.5 rounded-full bg-[#0866ff]" />
        Launch · {STATUS[v.status] ?? v.status} · latest card below
      </span>
    );

  const plan = v.plan;
  const open = v.questions.filter((q) => !q.answer);
  const requiredOpen = open.filter((q) => q.required);
  const qa = new Map((v.qa?.lines ?? []).map((l) => [l.key, l.link]));
  const created = v.items.filter((i) => i.status === "created").length;
  const toMake = v.items.filter((i) => i.status !== "existing").length;
  const refused = v.items.filter((i) => i.status === "invalid").length;
  const failed = v.items.filter((i) => i.status === "failed" || i.status === "skipped").length;
  const media = v.items.filter((i) => i.kind === "media");
  const pages = [...new Set(v.rows.map((r) => r.page).filter(Boolean))];
  const qaBad = (v.qa?.lines ?? []).filter((l) => !l.ok);

  return (
    // Never wider than the chat panel: every descendant may shrink (min-w-0) and long tokens (names, links) wrap anywhere
    <section className="grid w-full min-w-0 max-w-[96%] grid-cols-[minmax(0,1fr)] gap-3 rounded-[16px] border border-[#0866ff]/30 bg-[#0866ff]/[0.04] p-3 [overflow-wrap:anywhere] md:p-3.5 [&_*]:min-w-0">
      <header className="flex items-center justify-between gap-2">
        <span className="flex shrink-0 items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-ink/60">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#0866ff]" />
          Launch · Meta
        </span>
        <span className="flex items-center gap-1.5 truncate text-[10.5px] text-ink/50" title={STATUS[v.status] ?? v.status}>
          {(WORKING.has(v.status) || (v.status === "asking" && v.progress)) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" />}
          <span className="truncate">{STATUS[v.status] ?? v.status}</span>
        </span>
      </header>

      <div className="grid gap-0.5">
        <h3 className="font-display text-[17px] leading-tight tracking-tight [overflow-wrap:anywhere]">{v.event.name || v.source}</h3>
        <p className="text-[11.5px] text-ink/55">
          {v.rows.length ? `${v.rows.length} row${v.rows.length === 1 ? "" : "s"}` : v.source}
          {pages.length ? ` · ${pages.length} Page${pages.length === 1 ? "" : "s"}: ${pages.slice(0, 3).join(", ")}${pages.length > 3 ? "…" : ""}` : ""}
          {v.event.date ? ` · event ${v.event.date}` : ""}
        </p>
      </div>

      {v.progress && (WORKING.has(v.status) || v.status === "asking") && (
        <p className="flex items-center gap-2 text-[12px] text-ink/65">
          {v.status === "asking" && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" />}
          {v.progress}
          {v.status === "asking" ? "… you can answer already" : ""}
        </p>
      )}
      {v.error && <p className="rounded-[10px] border border-bad/25 bg-bad-soft/20 px-3 py-2 text-[12px] text-ink/85">{v.error}</p>}

      {v.summary && (
        <div className="grid gap-1.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink/45">What I read</p>
          <div className="grid gap-1.5 text-[12.5px] leading-relaxed text-ink/85">
            {v.summary.split(/\n{2,}/).map((p, i) => (
              <Clamp key={i} text={p} className={p.startsWith("Note:") ? "text-[11.5px] text-ink/60" : ""} />
            ))}
          </div>
        </div>
      )}

      {v.checks.length > 0 && (
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
              <Question key={q.key} q={q} busy={Boolean(busy) || v.status !== "asking"} onUse={(answer) => void act(`use:${q.key}`, () => (answer ? takeLaunchProposals(v.id, [q.key], { [q.key]: answer }) : takeLaunchProposals(v.id, [q.key])))} />
            ))}
          </ul>
          {v.status === "asking" && (
            <div className="flex flex-wrap items-center gap-2">
              {open.length > 1 && (
                <button type="button" disabled={Boolean(busy)} onClick={() => void act("all", () => takeLaunchProposals(v.id, open.map((q) => q.key)))} className="h-11 rounded-full border border-ink/15 px-4 text-[12.5px] text-ink/75 hover:text-fg disabled:opacity-40 md:h-9">
                  Use all proposals
                </button>
              )}
              <button type="button" disabled={Boolean(busy) || requiredOpen.length > 0} onClick={() => void act("build", () => buildLaunchPlan(v.id))} className="h-11 rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-40 md:h-9">
                {busy === "build" ? "Starting…" : "Build the plan"}
              </button>
              <span className="text-[11px] text-ink/45">Or answer in the chat, in your own words.</span>
            </div>
          )}
        </div>
      )}

      {plan && (
        <div className="grid gap-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink/45">The plan · {plan.goLive === "scheduled" ? "scheduled start" : "created paused"}</p>
            {toMake > 0 && <span className="text-[10.5px] text-ink/45">{created ? `${created} of ${toMake} created` : `${toMake} lines`}</span>}
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
              <CampaignLine key={c.key} c={c} plan={plan} items={v.items} qa={qa} />
            ))}
          </ul>
          {media.length > 0 && (
            <p className="text-[11px] text-ink/50">
              {media.length} file{media.length === 1 ? "" : "s"} from Drive to the ad account&apos;s library: {media.filter((m) => m.status === "created").length} uploaded
              {media.some((m) => m.status === "invalid" || m.status === "failed") ? `, ${media.filter((m) => m.status === "invalid" || m.status === "failed").length} can't be opened (${media.find((m) => m.error)?.error ?? ""})` : ""}
            </p>
          )}
        </div>
      )}

      {v.qa && (
        <p className={`rounded-[10px] px-3 py-2 text-[12px] ${qaBad.length ? "border border-warn/30 bg-warn-soft/20" : "border border-ok/25 bg-ok-soft/15"}`}>
          {qaBad.length ? `Read back from Meta: ${qaBad.length} line${qaBad.length === 1 ? "" : "s"} differ from the plan. ${qaBad.slice(0, 3).map((l) => `${l.key.split(":")[0]} ${l.diffs.join(", ")}`).join("; ")}` : `Read back from Meta: all ${v.qa.lines.length} created lines match the plan.`}
        </p>
      )}

      {/* Once it's created and read back: suggest more for the rest of the account (sprint or the buyer's tasks) */}
      {v.status === "applied" && v.qa && <LaunchMore runId={v.id} />}

      {v.status === "ready" && !v.live && (v.write && !v.write.live ? (
        <WriteOff status={v.write} canSwitch={v.canSwitch} account={v.plan?.account ?? null} compact onLive={() => void loadLaunch(v.id).then((next) => next && setV(next))} />
      ) : (
        <p className="rounded-[10px] border border-warn/30 bg-warn-soft/30 px-3 py-2 text-[12px] text-ink/80">{v.liveNote ?? "Live changes are off for this client."} The plan stays here to create once they&apos;re on.</p>
      ))}
      {v.status === "ready" && v.live && !v.canConfirm && <p className="text-[11.5px] text-ink/50">The client&apos;s Meta buyer, the head of Meta, a lead or an exec confirms a launch.</p>}
      {error && <p className="text-[12px] text-bad">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {v.status === "ready" && v.live && v.canConfirm && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act("confirm", () => confirmLaunch(v.id))} className="h-11 rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-40 md:h-9">
            {busy === "confirm" ? "Starting…" : `Create ${toMake - refused} line${toMake - refused === 1 ? "" : "s"} ${plan?.goLive === "scheduled" ? "scheduled" : "paused"}`}
            {refused ? ` · ${refused} left out` : ""}
          </button>
        )}
        {(v.status === "partial" || v.status === "failed") && failed > 0 && v.canConfirm && plan && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act("retry", () => continueLaunch(v.id, true))} className="h-11 rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-40 md:h-9">
            {busy === "retry" ? "Retrying…" : `Retry ${failed} line${failed === 1 ? "" : "s"}`}
          </button>
        )}
        {["asking", "ready"].includes(v.status) && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act("aside", () => setAsideLaunch(v.id))} className="h-11 rounded-full border border-ink/10 px-4 text-[12.5px] text-ink/60 hover:text-fg md:h-9">
            Set aside
          </button>
        )}
      </div>

      {reply && ["asking", "ready"].includes(v.status) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            setText("");
            void act("reply", async () => {
              const r = await replyToLaunch(v.id, t);
              if (r.ok) setSaid(r.answer);
              return r;
            });
          }}
          className="grid gap-2"
        >
          {said && <p className="rounded-[10px] bg-ink/[0.04] px-3 py-2 text-[12.5px] leading-relaxed text-ink/85">{said}</p>}
          <div className="flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer the Media Buyer…" className="h-11 min-w-0 flex-1 rounded-full border border-ink/10 bg-ink/[0.03] px-4 text-[16px] outline-none focus:border-brand/50 md:h-9 md:text-[13px]" />
            <button type="submit" disabled={!text.trim() || Boolean(busy)} className="h-11 shrink-0 rounded-full bg-fg px-4 text-[13px] text-bg disabled:opacity-40 md:h-9">
              Send
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
