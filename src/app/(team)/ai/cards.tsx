"use client";

import { useState } from "react";
import { Markdown } from "@/components/markdown";
import { ChatPlan } from "@/app/(team)/clients/[slug]/chat-plan";
import { LaunchCard } from "@/app/(team)/clients/[slug]/launch-card";
import { BriefPreviewButton } from "@/components/quick-brief-sheet";
import { ConfirmCardView, ConnectCardView, ConnectorSteps } from "./connectors-ui";
import type { BriefCard, Card, CopyCard, CopyField, LinkCard, ListCard, MetricsCard, ToolRun } from "@/lib/kaizen-ai/types";

// What Kaizen AI's tools put on screen: metrics tables, copy sets with character counts, briefs ready to send, report
// and Google file links, ad change plans (confirmed on the card, never in the chat), and short lists.

const money = (x: number | null | undefined) => (x == null ? "—" : `$${x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(2).replace(/\.00$/, "")}`);
const n = (x: number | null | undefined, d = 0) => (x == null ? "—" : x.toLocaleString(undefined, { maximumFractionDigits: d }));

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-faint transition hover:bg-ink/[0.05] hover:text-fg ${className}`}
      aria-label={label}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {done ? <path d="M5 12l5 5L20 7" /> : <path d="M9 9h10v10H9zM5 15V5h10" />}
      </svg>
      {done ? "Copied" : label}
    </button>
  );
}

/** A chat answer: markdown, with fenced code blocks shown as copyable blocks */
export function ChatMarkdown({ text }: { text: string }) {
  const parts = text.split(/(```[\w-]*\n[\s\S]*?(?:```|$))/g);
  return (
    <div className="grid gap-3 [&_p]:text-[15px] [&_p]:leading-[1.7] [&_li]:text-[15px] [&_p]:text-fg/90 [&_li]:text-fg/90">
      {parts.map((p, i) => {
        const code = p.match(/^```([\w-]*)\n([\s\S]*?)(?:```)?$/);
        if (code)
          return (
            <div key={i} className="overflow-hidden rounded-[14px] border border-line bg-surface-2/60">
              <div className="flex items-center justify-between border-b border-line/70 px-3 py-1">
                <span className="text-[11px] uppercase tracking-[0.12em] text-faint">{code[1] || "text"}</span>
                <CopyButton text={code[2].replace(/\n$/, "")} />
              </div>
              <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-relaxed text-fg">
                <code>{code[2].replace(/\n$/, "")}</code>
              </pre>
            </div>
          );
        return p.trim() ? <Markdown key={i} text={p.replace(/`([^`\n]+)`/g, "$1")} /> : null;
      })}
    </div>
  );
}

export function ToolChips({ runs: all }: { runs: ToolRun[] }) {
  // A connector's tools (Shopify, Drive, ...) show as expandable steps with their input and result
  const steps = all.filter((r) => r.connector);
  const runs = all.filter((r) => !r.connector);
  if (!all.length) return null;
  if (!runs.length) return <ConnectorSteps runs={steps} />;
  return (
    <div className="grid gap-1.5">
    <div className="flex flex-wrap gap-1.5">
      {runs.map((r) => (
        <span key={r.id} title={r.summary ?? undefined} className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-[12.5px] ${r.ok === false ? "border-bad/30 bg-bad-soft/40 text-bad" : "border-line bg-surface text-muted"}`}>
          {r.ok === null ? (
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-brand border-t-transparent" aria-hidden />
          ) : r.ok ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-ok" aria-hidden>
              <path d="M5 12l5 5L20 7" />
            </svg>
          ) : (
            <span aria-hidden>!</span>
          )}
          {r.ok === null ? r.label : r.label.replace(/…$/, "")}
          {r.ok === false && r.summary ? <span className="max-w-[260px] truncate text-bad/80">· {r.summary}</span> : null}
        </span>
      ))}
    </div>
    <ConnectorSteps runs={steps} />
    </div>
  );
}

function Shell({ title, sub, children, action }: { title: string; sub?: string | null; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[18px] border border-line bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-fg">{title}</p>
          {sub ? <p className="text-[12px] text-faint">{sub}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Metrics({ c }: { c: MetricsCard }) {
  const [all, setAll] = useState(false);
  const rows = all ? c.rows : c.rows.slice(0, 12);
  const roas = c.kpi?.roas ?? false;
  const tsv = [["Name", "Spend", "Results", roas ? "ROAS" : "Cost/result", "CTR %", "CPM", "Freq"].join("\t"), ...c.rows.map((r) => [r.name, r.spend, r.results ?? "", roas ? (r.roas ?? "") : (r.cpr ?? ""), r.ctr ?? "", r.cpm ?? "", r.freq ?? ""].join("\t"))].join("\n");
  return (
    <Shell title={c.title} sub={c.range} action={<CopyButton text={tsv} label="Copy table" />}>
      <div className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-start">
        <div className="flex flex-wrap gap-2">
          {c.windows.map((w) => (
            <div key={w.label} className="rounded-[12px] bg-ink/[0.035] px-3 py-2">
              <p className="text-[10.5px] uppercase tracking-[0.12em] text-faint">{w.label}</p>
              <p className="text-[15px] font-semibold tabular-nums text-fg">{w.value == null ? "—" : roas ? `${w.value.toFixed(2)}x` : money(w.value)}</p>
              <p className="text-[11.5px] tabular-nums text-faint">
                {money(w.spend)} · {n(w.results, 1)}
              </p>
            </div>
          ))}
        </div>
        <div className="grid gap-1 text-[12.5px] text-muted sm:text-right">
          {c.kpi ? (
            <p>
              {c.kpi.label} target <span className="font-semibold text-fg">{c.kpi.target == null ? "not set" : roas ? `${c.kpi.target}x` : money(c.kpi.target)}</span>
            </p>
          ) : null}
          {c.budget ? (
            <div className="grid gap-1">
              <p>
                Budget {money(c.budget.spent)} of {money(c.budget.budget)} · pace <span className={c.budget.status === "on" ? "text-ok" : "text-warn"}>{Math.round(c.budget.pace * 100)}%</span>
              </p>
              <div className="h-1.5 w-full min-w-[160px] overflow-hidden rounded-full bg-ink/[0.06]">
                <div className={`h-full rounded-full ${c.budget.status === "on" ? "bg-ok" : "bg-warn"}`} style={{ width: `${Math.min(100, (c.budget.spent / Math.max(1, c.budget.budget)) * 100)}%` }} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="overflow-x-auto border-t border-line/70">
        <table className="w-full min-w-[640px] text-left text-[12.5px]">
          <thead className="bg-surface-2/60 text-[10.5px] uppercase tracking-[0.1em] text-faint">
            <tr>
              <th className="px-4 py-2 font-semibold">{c.level.replace("_", " ")}</th>
              <th className="px-3 py-2 text-right font-semibold">Spend</th>
              <th className="px-3 py-2 text-right font-semibold">Results</th>
              <th className="px-3 py-2 text-right font-semibold">{roas ? "ROAS" : "Cost/result"}</th>
              <th className="px-3 py-2 text-right font-semibold">CTR</th>
              <th className="px-3 py-2 text-right font-semibold">CPM</th>
              {c.platform === "meta" ? <th className="px-3 py-2 text-right font-semibold">Freq</th> : null}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r, i) => {
              const off = c.kpi?.target != null && (roas ? r.roas != null && r.roas < c.kpi.target : r.cpr != null && r.cpr > c.kpi.target * 1.15);
              return (
                <tr key={i} className="border-t border-line/60">
                  <td className="max-w-[320px] truncate px-4 py-2 text-fg" title={r.name}>
                    {r.name}
                  </td>
                  <td className="px-3 py-2 text-right text-muted">{money(r.spend)}</td>
                  <td className="px-3 py-2 text-right text-muted">{n(r.results, 1)}</td>
                  <td className={`px-3 py-2 text-right ${off ? "text-bad" : "text-fg"}`}>{roas ? (r.roas == null ? "—" : `${r.roas.toFixed(2)}x`) : money(r.cpr)}</td>
                  <td className="px-3 py-2 text-right text-muted">{r.ctr == null ? "—" : `${r.ctr}%`}</td>
                  <td className="px-3 py-2 text-right text-muted">{money(r.cpm)}</td>
                  {c.platform === "meta" ? <td className={`px-3 py-2 text-right ${(r.freq ?? 0) > 3 ? "text-warn" : "text-muted"}`}>{n(r.freq, 2)}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {c.rows.length > 12 ? (
        <button type="button" onClick={() => setAll(!all)} className="min-h-11 w-full border-t border-line/70 text-[12.5px] text-muted hover:text-fg">
          {all ? "Show fewer" : `Show all ${c.rows.length}`}
        </button>
      ) : null}
    </Shell>
  );
}

function Count({ f }: { f: CopyField }) {
  if (f.limit == null) return null;
  const len = [...f.text].length;
  return <span className={`shrink-0 text-[11px] tabular-nums ${len > f.limit ? "font-semibold text-bad" : "text-faint"}`}>{`${len}/${f.limit}`}</span>;
}

function Line({ f, label }: { f: CopyField; label?: string }) {
  if (!f.text) return null;
  return (
    <div className="group flex items-start justify-between gap-3 rounded-[10px] px-2 py-1.5 hover:bg-ink/[0.03]">
      <p className="min-w-0 text-[13.5px] text-fg">
        {label ? <span className="mr-2 text-[11px] uppercase tracking-[0.1em] text-faint">{label}</span> : null}
        {f.text}
      </p>
      <div className="flex items-center gap-1">
        <Count f={f} />
        <span className="opacity-0 transition group-hover:opacity-100 max-md:opacity-100">
          <CopyButton text={f.text} label="" />
        </span>
      </div>
    </div>
  );
}

function Copy({ c }: { c: CopyCard }) {
  const all =
    c.platform === "meta"
      ? (c.meta ?? []).map((a, i) => `Ad ${i + 1}${a.angle ? ` (${a.angle})` : ""}\nPrimary text: ${a.primaryText}\nHeadline: ${a.headline.text}\nDescription: ${a.description.text}\nCTA: ${a.cta}`).join("\n\n")
      : [`Headlines:\n${(c.google?.headlines ?? []).map((h) => h.text).join("\n")}`, `Descriptions:\n${(c.google?.descriptions ?? []).map((d) => d.text).join("\n")}`, `Sitelinks:\n${(c.google?.sitelinks ?? []).map((s) => [s.text.text, s.line1.text, s.line2.text].filter(Boolean).join(" | ")).join("\n")}`, `Callouts:\n${(c.google?.callouts ?? []).map((x) => x.text).join("\n")}`].join("\n\n");
  return (
    <Shell title={`${c.platform === "meta" ? "Meta" : "Google"} copy${c.client ? ` · ${c.client}` : ""}`} sub={c.flags.length ? `${c.flags.length} to fix` : "Within every limit"} action={<CopyButton text={all} label="Copy all" />}>
      {c.flags.length ? (
        <ul className="grid gap-1 border-b border-line/70 bg-warn-soft/30 px-4 py-2.5 text-[12.5px] text-fg">
          {c.flags.map((f, i) => (
            <li key={i}>· {f}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 px-2 py-3">
        {c.meta?.map((a, i) => (
          <div key={i} className="grid gap-1 rounded-[14px] border border-line/70 p-2">
            <div className="flex items-center justify-between px-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
                Ad {i + 1}
                {a.angle ? ` · ${a.angle}` : ""}
              </p>
              <CopyButton text={`${a.primaryText}\n\n${a.headline.text}\n${a.description.text}`} label="" />
            </div>
            <p className="whitespace-pre-wrap px-2 text-[13.5px] leading-relaxed text-fg">{a.primaryText}</p>
            <Line f={a.headline} label="Headline" />
            <Line f={a.description} label="Description" />
            {a.cta ? <p className="px-2 text-[12px] text-faint">Button: {a.cta}</p> : null}
          </div>
        ))}
        {c.google ? (
          <>
            <Group title="Headlines">{c.google.headlines.map((h, i) => <Line key={i} f={h} />)}</Group>
            <Group title="Descriptions">{c.google.descriptions.map((h, i) => <Line key={i} f={h} />)}</Group>
            {c.google.sitelinks.length ? (
              <Group title="Sitelinks">
                {c.google.sitelinks.map((s, i) => (
                  <div key={i} className="rounded-[10px] border border-line/60 py-1">
                    <Line f={s.text} />
                    <Line f={s.line1} />
                    <Line f={s.line2} />
                  </div>
                ))}
              </Group>
            ) : null}
            {c.google.callouts.length ? <Group title="Callouts">{c.google.callouts.map((h, i) => <Line key={i} f={h} />)}</Group> : null}
          </>
        ) : null}
      </div>
    </Shell>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{title}</p>
      {children}
    </div>
  );
}

function Brief({ c }: { c: BriefCard }) {
  const [open, setOpen] = useState(false);
  const making = c.formats.map((f) => `${f.new ? `${f.new} new` : ""}${f.new && f.variations ? " + " : ""}${f.variations ? `${f.variations} var.` : ""} ${f.format}`).join(", ");
  // Its quick preview right here (in the address, so back closes it): the full brief is written only if they choose it
  const q = new URLSearchParams(c.href.split("?")[1] ?? "");
  const previewKey = `ai-${(q.get("ai") ?? c.client.id).slice(0, 8)}-${q.get("card") ?? "0"}`;
  const action = (
    <BriefPreviewButton
      previewKey={previewKey}
      clientId={c.client.id}
      source={{ kind: "idea", label: `Briefed in Kaizen AI: ${c.title}`.slice(0, 200), text: [[`Title: ${c.title}`, c.angle && `Angle: ${c.angle}`, c.audience && `Audience: ${c.audience}`, `Making: ${making}`, c.landing && `Landing page: ${c.landing}`].filter(Boolean).join("\n"), c.brief].join("\n\n").slice(0, 4000) }}
      from={{ kicker: "From Kaizen AI", label: c.title || c.client.name }}
      className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand-hover md:min-h-10"
    >
      Brief it
    </BriefPreviewButton>
  );
  return (
    <Shell title={c.title || "Creative brief"} sub={`${c.client.name} · ${making}`} action={action}>
      <div className="grid gap-2 px-4 py-3 text-[13px]">
        {c.angle ? (
          <p>
            <span className="text-faint">Angle · </span>
            <span className="text-fg">{c.angle}</span>
          </p>
        ) : null}
        {c.audience ? (
          <p>
            <span className="text-faint">Audience · </span>
            <span className="text-fg">{c.audience}</span>
          </p>
        ) : null}
        <div className={open ? "" : "max-h-[160px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"}>
          <Markdown text={c.brief} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setOpen(!open)} className="min-h-9 rounded-full px-3 text-[12.5px] text-muted hover:bg-ink/[0.04] hover:text-fg">
            {open ? "Show less" : "Read the whole brief"}
          </button>
          <CopyButton text={c.brief} label="Copy brief" />
          <p className="text-[12px] text-faint">Brief it for a quick preview; the full brief is written only if you choose it, and opens in Ready to send.</p>
        </div>
      </div>
    </Shell>
  );
}

function LinkView({ c }: { c: LinkCard }) {
  return (
    <a
      href={c.href}
      target={c.external ? "_blank" : undefined}
      rel={c.external ? "noopener noreferrer" : undefined}
      className="flex min-h-14 items-center justify-between gap-3 rounded-[16px] border border-line bg-surface px-4 py-3 transition hover:border-brand/40 hover:bg-brand-soft/20"
    >
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold text-fg">{c.title}</span>
        <span className="block text-[12.5px] text-muted">{c.detail}</span>
      </span>
      <span className="shrink-0 text-[13px] font-medium text-brand-text">{c.cta} →</span>
    </a>
  );
}

function List({ c }: { c: ListCard }) {
  return (
    <Shell title={c.title}>
      <ul className="divide-y divide-line/60">
        {c.items.map((it, i) => {
          const body = (
            <div className="flex items-start gap-3 px-4 py-2.5">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${it.tone === "bad" ? "bg-bad" : it.tone === "warn" ? "bg-warn" : it.tone === "ok" ? "bg-ok" : "bg-faint"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] text-fg">{it.title}</p>
                {it.detail ? <p className="text-[12.5px] text-muted">{it.detail}</p> : null}
              </div>
              {it.when ? <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{it.when}</span> : null}
            </div>
          );
          return <li key={i}>{it.href ? <a href={it.href} target={/^https?:/.test(it.href) ? "_blank" : undefined} rel="noopener noreferrer" className="block hover:bg-ink/[0.03]">{body}</a> : body}</li>;
        })}
      </ul>
    </Shell>
  );
}

export function CardView({ card }: { card: Card }) {
  switch (card.type) {
    case "metrics":
      return <Metrics c={card} />;
    case "copy":
      return <Copy c={card} />;
    case "brief":
      return <Brief c={card} />;
    case "link":
      return <LinkView c={card} />;
    case "list":
      return <List c={card} />;
    case "plan":
      return (
        <div className="grid gap-1">
          <p className="px-1 text-[12px] text-faint">
            Planned change for {card.client}: nothing is written until it&rsquo;s confirmed below.
          </p>
          <ChatPlan id={card.id} />
        </div>
      );
    case "connect":
      return <ConnectCardView c={card} />;
    case "connector_confirm":
      return <ConfirmCardView c={card} />;
    case "launch":
      return (
        <div className="grid gap-1">
          <p className="px-1 text-[12px] text-faint">Launch sheet for {card.client}: nothing goes to Meta until the plan is confirmed below.</p>
          <LaunchCard id={card.id} reply />
        </div>
      );
    default:
      return null;
  }
}
