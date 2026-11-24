"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { OPEN_STATUSES, PROSPECT_STATUSES, STATUS_LABEL, fitBand, type ProspectStatus } from "@/lib/sales-core";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { addAction, findAction, researchAction, updateAction } from "./actions";

// Sales › Prospects: the pipeline as cards (no tables, so it reads the same on a phone), filtered by stage and by
// whose they are, both in the address. The three ways in (research a business, find a list, add one by hand) open as
// a panel that lives in the address too (?new=), so back closes it.

export type ProspectRow = {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  location: string | null;
  status: ProspectStatus;
  fit: number | null;
  fitReason: string | null;
  summary: string | null;
  ownerId: string | null;
  owner: string | null;
  researched: boolean;
  updated: string;
};

const ago = (iso: string) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function FitBadge({ fit, large = false }: { fit: number | null; large?: boolean }) {
  const band = fitBand(fit);
  const tone = band === "strong" ? "bg-ok-soft text-ok" : band === "possible" ? "bg-warn-soft text-warn" : band === "weak" ? "bg-bad-soft text-bad" : "bg-surface-2 text-faint";
  return (
    <span className={`inline-flex shrink-0 items-baseline gap-1 rounded-full px-2.5 font-medium tabular-nums ${large ? "py-1 text-[15px]" : "py-0.5 text-[12px]"} ${tone}`} title={fit == null ? "Not scored yet" : `Fit ${fit}/100`}>
      {fit == null ? "No score" : fit}
      {fit != null && <span className="text-[10px] opacity-70">fit</span>}
    </span>
  );
}

export function StageSelect({ id, status, onDone }: { id: string; status: ProspectStatus; onDone?: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState(status);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <label className="grid gap-1">
      <span className="sr-only">Stage</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as ProspectStatus;
          const was = value;
          setValue(next);
          setError(null);
          start(async () => {
            const r = await updateAction(id, { status: next });
            if (!r.ok) {
              setValue(was);
              setError(r.error);
            } else {
              onDone?.();
              router.refresh();
            }
          });
        }}
        className="h-11 min-w-0 rounded-full border border-line bg-surface px-3.5 text-[16px] text-fg md:h-9 md:text-[13px]"
      >
        {PROSPECT_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      {error && <span className="text-[12px] text-bad">{error}</span>}
    </label>
  );
}

export function SalesView({ prospects, meId }: { prospects: ProspectRow[]; meId: string }) {
  const stage = useParam("stage");
  const all = useParam("all") === "1";
  const panel = useParam("new");
  const q = (useParam("q") ?? "").trim().toLowerCase();
  const scope = all ? prospects : prospects.filter((p) => p.ownerId === meId);
  const shown = scope
    .filter((p) => (stage === "open" ? OPEN_STATUSES.includes(p.status) : stage && (PROSPECT_STATUSES as readonly string[]).includes(stage) ? p.status === stage : true))
    .filter((p) => !q || `${p.name} ${p.website ?? ""} ${p.industry ?? ""} ${p.location ?? ""}`.toLowerCase().includes(q));
  const count = (s: ProspectStatus) => scope.filter((p) => p.status === s).length;
  const open = scope.filter((p) => OPEN_STATUSES.includes(p.status)).length;

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[1040px] gap-7 pb-12">
      <header className="grid gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Sales</p>
        <h1 className="font-heading text-[28px] leading-tight md:text-[34px]">Prospects</h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-muted">
          Businesses Kaizen could grow. The Sales agent researches each one from its site and the open web, scores the fit, and drafts the first outreach for you to send. Ask your assistant too: &ldquo;Find med spas in Tampa running no ads.&rdquo;
        </p>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        {(
          [
            ["research", "Research a business"],
            ["list", "Find prospects"],
            ["add", "Add by hand"],
          ] as const
        ).map(([k, label], i) => (
          <button
            key={k}
            type="button"
            onClick={() => (panel === k ? closeParams("new") : panel ? replaceParams({ new: k }) : pushParams({ new: k }))}
            aria-expanded={panel === k}
            className={`inline-flex h-11 items-center justify-center rounded-full px-5 text-[14px] font-medium transition-colors ${panel === k ? "bg-fg text-bg" : i === 0 ? "bg-brand text-white hover:bg-brand-hover" : "border border-line bg-surface text-fg hover:bg-surface-2"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {panel === "research" && <ResearchPanel />}
      {panel === "list" && <FindPanel />}
      {panel === "add" && <AddPanel />}

      <section className="grid min-w-0 gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-full border border-line bg-surface p-1" role="tablist" aria-label="Whose prospects">
            {(
              [
                [false, "Mine"],
                [true, "Everyone's"],
              ] as const
            ).map(([v, label]) => (
              <button key={label} type="button" role="tab" aria-selected={all === v} onClick={() => pushParams({ all: v ? "1" : null })} className={`h-11 rounded-full px-4 text-[14px] transition-colors md:h-9 md:text-[13px] ${all === v ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {label}
              </button>
            ))}
          </div>
          <label className="min-w-0 flex-1 basis-48">
            <span className="sr-only">Search prospects</span>
            <input defaultValue={q} onChange={(e) => replaceParams({ q: e.target.value || null })} placeholder="Search by name, site, industry or city" className="h-11 w-full rounded-full border border-line bg-surface px-4 text-[16px] text-fg placeholder:text-faint md:h-10 md:text-[14px]" />
          </label>
        </div>

        <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
          <StageChip label="All" n={scope.length} on={!stage} onClick={() => pushParams({ stage: null })} />
          <StageChip label="Open" n={open} on={stage === "open"} onClick={() => pushParams({ stage: "open" })} />
          {PROSPECT_STATUSES.map((s) => (
            <StageChip key={s} label={STATUS_LABEL[s]} n={count(s)} on={stage === s} onClick={() => pushParams({ stage: s })} />
          ))}
        </div>

        {shown.length === 0 ? (
          <div className="grid place-items-center gap-2 rounded-[22px] border border-dashed border-line px-6 py-14 text-center">
            <p className="font-heading text-[18px]">{scope.length ? "Nothing here" : all ? "No prospects yet" : "No prospects of yours yet"}</p>
            <p className="max-w-sm text-[13.5px] leading-relaxed text-muted">{scope.length ? "Try another stage or search." : "Research a business or find a list to start the pipeline."}</p>
          </div>
        ) : (
          <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
            {shown.map((p) => (
              <li key={p.id} className="grid min-w-0 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <Link href={`/sales/${p.id}`} className="inline-flex min-h-11 items-center break-words font-heading text-[18px] leading-snug text-fg hover:underline md:min-h-0">
                      {p.name}
                    </Link>
                    <p className="break-words text-[12.5px] text-muted">{[p.industry, p.location].filter(Boolean).join(" · ") || "Not researched yet"}</p>
                  </div>
                  <FitBadge fit={p.fit} />
                </div>
                {(p.summary || p.fitReason) && <p className="break-words text-[13.5px] leading-relaxed text-muted">{p.summary || p.fitReason}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-faint">
                  {p.website && (
                    <a href={p.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center break-all text-brand-text hover:underline md:min-h-0">
                      {host(p.website)} ↗
                    </a>
                  )}
                  <span>{p.owner ? (p.ownerId === meId ? "Yours" : p.owner) : "No owner"}</span>
                  <span>Updated {ago(p.updated)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StageSelect id={p.id} status={p.status} />
                  <Link href={`/sales/${p.id}`} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-[14px] text-fg hover:bg-surface-2 md:h-9 md:text-[13px]">
                    {p.researched ? "Open" : "Open and research"}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StageChip({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`inline-flex h-11 shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[13px] transition-colors md:h-9 ${on ? "bg-fg text-bg" : "bg-surface text-muted hover:text-fg"}`}>
      {label}
      <span className={`tabular-nums ${on ? "opacity-70" : "text-faint"}`}>{n}</span>
    </button>
  );
}

const field = "h-11 w-full min-w-0 rounded-[14px] border border-line bg-bg px-3.5 text-[16px] text-fg placeholder:text-faint md:text-[14px]";

function Panel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 gap-4 rounded-[22px] border border-line bg-surface p-4 md:p-6">
      <div className="grid gap-1">
        <h2 className="font-heading text-[20px]">{title}</h2>
        <p className="text-[13.5px] leading-relaxed text-muted">{sub}</p>
      </div>
      {children}
    </section>
  );
}

function Submit({ pending, label, busy }: { pending: boolean; label: string; busy: string }) {
  return (
    <button type="submit" disabled={pending} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brand px-6 text-[14px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60 sm:w-auto">
      {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />}
      {pending ? busy : label}
    </button>
  );
}

function ResearchPanel() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title="Research a business" sub="Its site, reviews, social, and whether it runs Meta or Google ads, turned into a brief and a Kaizen strategy: the services that fit, the angle, proof from similar clients, and talking points. Takes a minute or two.">
      <form
        className="grid gap-3 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(null);
          start(async () => {
            const r = await researchAction({ name: String(f.get("name") ?? ""), website: String(f.get("website") ?? ""), location: String(f.get("location") ?? ""), question: String(f.get("question") ?? "") });
            if (!r.ok) setError(r.error);
            else router.push(`/sales/${r.id}`);
          });
        }}
      >
        <input name="name" placeholder="Business name" className={field} autoComplete="off" />
        <input name="website" placeholder="Website" inputMode="url" className={field} autoComplete="off" />
        <input name="location" placeholder="City (if the name is common)" className={field} autoComplete="off" />
        <input name="question" placeholder="Anything to look into? (optional)" className={`${field} md:col-span-3`} autoComplete="off" />
        <div className="grid gap-2 md:col-span-3 md:flex md:items-center">
          <Submit pending={pending} label="Research" busy="Researching… (a minute or two)" />
          {error && <p className="text-[13px] text-bad">{error}</p>}
        </div>
      </form>
    </Panel>
  );
}

function FindPanel() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Panel title="Find prospects" sub="Describe who to look for: the industry, the area, and any signal (no ads running, one location, high-ticket). The agent finds them on the public web, scores each by fit and adds them here as New.">
      <form
        className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px]"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setMsg(null);
          start(async () => {
            const r = await findAction({ profile: String(f.get("profile") ?? ""), count: Number(f.get("count") ?? 8) });
            if (!r.ok) setMsg({ ok: false, text: r.error });
            else {
              setMsg({ ok: true, text: r.found ? `Found ${r.found}; ${r.added} new added to the pipeline.` : "None found that match. Try a wider area or fewer conditions." });
              router.refresh();
            }
          });
        }}
      >
        <input name="profile" required placeholder="e.g. med spas in Tampa running no ads" className={field} autoComplete="off" />
        <label className="grid">
          <span className="sr-only">How many</span>
          <select name="count" defaultValue="8" className={field}>
            {[5, 8, 10, 15].map((n) => (
              <option key={n} value={n}>
                {n} businesses
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-2 md:col-span-2 md:flex md:items-center">
          <Submit pending={pending} label="Find them" busy="Searching… (a minute or two)" />
          {msg && <p className={`text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
        </div>
      </form>
      <p className="text-[12.5px] leading-relaxed text-faint">Public sources only. Nothing here browses or messages anyone on LinkedIn: the agent drafts, you send.</p>
    </Panel>
  );
}

function AddPanel() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title="Add by hand" sub="A business you already know about. Research it from its page when you're ready.">
      <form
        className="grid gap-3 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(null);
          start(async () => {
            const r = await addAction({ name: String(f.get("name") ?? ""), website: String(f.get("website") ?? ""), location: String(f.get("location") ?? "") });
            if (!r.ok) setError(r.error);
            else router.push(`/sales/${r.id}`);
          });
        }}
      >
        <input name="name" required placeholder="Business name" className={field} autoComplete="off" />
        <input name="website" placeholder="Website" inputMode="url" className={field} autoComplete="off" />
        <input name="location" placeholder="City" className={field} autoComplete="off" />
        <div className="grid gap-2 md:col-span-3 md:flex md:items-center">
          <Submit pending={pending} label="Add" busy="Adding…" />
          {error && <p className="text-[13px] text-bad">{error}</p>}
        </div>
      </form>
    </Panel>
  );
}
