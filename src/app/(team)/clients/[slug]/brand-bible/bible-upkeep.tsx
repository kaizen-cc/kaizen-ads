"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { WebsiteIssue } from "@/lib/website-issues";
import { closeWebsiteIssue, exportAccount, pointOnboardingSheet, recheckLinks, sendWebsiteSuggestions } from "../brand-bible-actions";

// Keeping the Bible true: what it found wrong on the client's site and in our numbers (each on its page, sorted for
// the client or for us), the pages it sends people to and whether they're still live, and the account packaged to
// download (made on its own at offboarding).

export type BibleLink = { url: string; label: string | null; source: string; ok: boolean | null; status: number | null; title: string | null; checkedAt: string | null; change: string | null; changedAt: string | null };

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
const short = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

export function IssuesPanel({ issues, clientId, slug, canEdit }: { issues: WebsiteIssue[]; clientId: string; slug: string; canEdit: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const forClient = issues.filter((i) => i.audience === "client");
  const forUs = issues.filter((i) => i.audience === "team");
  const unsent = forClient.filter((i) => i.status === "open");
  const close = (id: string, status: "fixed" | "dismissed") =>
    start(async () => {
      await closeWebsiteIssue(clientId, slug, id, status);
      router.refresh();
    });
  const Row = ({ i }: { i: WebsiteIssue }) => (
    <li className="grid gap-1.5 border-t border-line py-3 first:border-t-0">
      <p className="text-[14px] leading-relaxed">{i.issue}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
        {i.pageUrl ? (
          <a href={i.pageUrl} target="_blank" rel="noreferrer" className="max-w-full truncate text-brand-text hover:underline">
            {short(i.pageUrl)} ↗
          </a>
        ) : (
          <span>Site-wide</span>
        )}
        {i.status === "sent" && i.sentAt && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-ok">Sent to the client {fmt(i.sentAt)}</span>}
        <span className="ml-auto flex gap-1">
          <button type="button" disabled={busy} onClick={() => close(i.id, "fixed")} className="min-h-9 max-md:h-11 rounded-full px-2.5 hover:text-fg md:min-h-7">
            Fixed
          </button>
          <button type="button" disabled={busy} onClick={() => close(i.id, "dismissed")} className="min-h-9 max-md:h-11 rounded-full px-2.5 hover:text-fg md:min-h-7">
            Not an issue
          </button>
        </span>
      </div>
    </li>
  );
  if (!issues.length) return <p className="text-[13.5px] text-muted">Nothing found wrong on their site or in our numbers.</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-[18px] border border-line bg-bg/60 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="font-heading text-[16px]">For the client</p>
          <span className="text-[12px] text-faint">Suggestions for their site (their website isn&apos;t ours)</span>
        </div>
        {forClient.length ? <ul className="mt-2">{forClient.map((i) => <Row key={i.id} i={i} />)}</ul> : <p className="mt-2 text-[13px] text-muted">Nothing for them.</p>}
        {canEdit && unsent.length > 0 && (
          <div className="mt-3 grid gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  if (!confirm(`Email ${unsent.length} suggestion${unsent.length === 1 ? "" : "s"} to the client's contacts now?`)) return;
                  const r = await sendWebsiteSuggestions(clientId, slug);
                  setNote(r.ok ? `Sent to ${r.sent.join(", ")}` : r.error);
                  router.refresh();
                })
              }
              className="h-11 justify-self-start rounded-full bg-fg px-4 text-[13px] text-bg disabled:opacity-50 md:h-9"
            >
              Send {unsent.length} to the client
            </button>
            {note && <p className="text-[12px] text-faint">{note}</p>}
          </div>
        )}
      </div>
      <div className="rounded-[18px] border border-line bg-bg/60 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="font-heading text-[16px]">For us</p>
          <span className="text-[12px] text-faint">To fix or watch. Audits and briefs read these too</span>
        </div>
        {forUs.length ? <ul className="mt-2">{forUs.map((i) => <Row key={i.id} i={i} />)}</ul> : <p className="mt-2 text-[13px] text-muted">Nothing for us.</p>}
      </div>
    </div>
  );
}

export function LinksPanel({ links, clientId, slug }: { links: BibleLink[]; clientId: string; slug: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const last = links.map((l) => l.checkedAt).filter((x): x is string => Boolean(x)).sort().pop();
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-faint">
        <span>{last ? `Last read ${fmt(last)}. Read again every 90 days, and before every new creative request.` : "Not read yet. They're read within the hour, and before every new creative request."}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await recheckLinks(clientId, slug);
              setNote(r.ok ? (r.flagged.length ? `${r.flagged.length} changed or broken: the team was told.` : `${r.checked} read, nothing changed.`) : r.error);
              router.refresh();
            })
          }
          className="ml-auto h-11 rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:h-8"
        >
          {busy ? "Reading…" : "Check now"}
        </button>
      </div>
      {note && <p className="text-[12.5px] text-muted">{note}</p>}
      {links.length > 0 && (
        <ul className="grid gap-0 overflow-hidden rounded-[14px] border border-line">
          {links.map((l) => (
            <li key={l.url} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[13px] first:border-t-0">
              <span className={`h-2 w-2 shrink-0 rounded-full ${l.ok === false ? "bg-bad" : l.change ? "bg-warn" : l.ok ? "bg-ok" : "bg-faint"}`} />
              <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-brand-text">
                {l.label || l.title || short(l.url)} <span className="text-faint">{short(l.url)}</span>
              </a>
              {l.source === "request" && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">From a request</span>}
              {l.ok === false && <span className="text-[12px] text-bad">Broken{l.status ? ` (${l.status})` : ""}</span>}
              {l.change && l.ok !== false && <span className="w-full pl-5 text-[12px] text-warn">{l.change}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ExportButton({ clientId, slug, last }: { clientId: string; slug: string; last: { at: string; reason: string } | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1.5">
      {last && (
        <a href={`/api/clients/${clientId}/export`} title={`Made ${fmt(last.at)}${last.reason === "offboarding" ? " at offboarding" : ""}`} className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-muted hover:border-faint hover:text-fg md:h-9">
          <span aria-hidden>⇣</span> <span className="max-md:hidden">Account</span> package
        </a>
      )}
      <button
        type="button"
        disabled={busy}
        title={error ?? "Package the whole account now: the Bible, its change log, where we left off and everything they ran"}
        onClick={() =>
          start(async () => {
            const r = await exportAccount(clientId, slug);
            if (!r.ok) return setError(r.error);
            setError(null);
            router.refresh();
            window.open(`/api/clients/${clientId}/export`, "_blank");
          })
        }
        className="inline-flex h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-muted hover:border-faint hover:text-fg disabled:opacity-50 md:h-9"
      >
        {busy ? "Packaging…" : last ? "↻" : "Package the account"}
      </button>
    </span>
  );
}

export type OnboardingSheetInfo = { url: string; name: string; editedAt: string | null; readAt: string | null; error: string | null; parts: ("bible" | "meta" | "google")[] };

const PART_NAMES = { bible: "Brand facts → the Bible", meta: "Meta planning → Meta strategy", google: "Google planning → Google strategy" } as const;

/** Where the client's onboarding sheet stands, and pointing to it by link when it wasn't found by name */
export function SheetPanel({ sheet, clientId, slug, canEdit }: { sheet: OnboardingSheetInfo | null; clientId: string; slug: string; canEdit: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      {sheet ? (
        <div className="grid gap-2 rounded-[14px] border border-line px-4 py-3 text-[13px]">
          <a href={sheet.url} target="_blank" rel="noreferrer" className="truncate font-medium hover:text-brand-text">
            {sheet.name} ↗
          </a>
          <p className="text-[12px] text-faint">
            {sheet.editedAt ? `Edited ${fmt(sheet.editedAt)}` : ""}
            {sheet.readAt ? ` · read ${fmt(sheet.readAt)}` : " · not read yet"}
          </p>
          {sheet.error ? (
            <p className="text-[12.5px] text-bad">Couldn&apos;t read it: {sheet.error}</p>
          ) : sheet.readAt ? (
            sheet.parts.length ? (
              <div className="flex flex-wrap gap-1.5">
                {sheet.parts.map((p) => (
                  <span key={p} className="rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted">
                    {PART_NAMES[p]}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted">Only the template so far: nothing filled in for this client.</p>
            )
          ) : null}
        </div>
      ) : (
        <p className="text-[13px] text-muted">None found in Drive by name (&ldquo;{"<Client>"} - Client Onboarding Sheet&rdquo;). It&apos;s looked for every hour.</p>
      )}
      {canEdit && (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim()) return;
            start(async () => {
              const r = await pointOnboardingSheet(clientId, slug, url.trim());
              setNote(r.ok ? (r.result === "read" ? "Read: it goes into the next Bible and strategy builds." : "Read, but it's only the template.") : r.error);
              if (r.ok) setUrl("");
              router.refresh();
            })
          }}
        >
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={sheet ? "A different sheet? Paste its link" : "Paste the sheet's link"} className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13.5px] outline-none focus:border-brand-text/60" />
          <button type="submit" disabled={busy || !url.trim()} className="h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50">
            {busy ? "Reading…" : "Use this sheet"}
          </button>
        </form>
      )}
      {note && <p className="text-[12.5px] text-muted">{note}</p>}
    </div>
  );
}
