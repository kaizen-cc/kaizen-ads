"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { JobProgress } from "@/components/job-progress";
import { PresentationDeck } from "@/components/presentation-deck";
import type { Deck, Reactions } from "@/lib/presentation-types";
import { holdPresentation, rewritePresentation, sendPresentationNow } from "./actions";

type P = {
  status: "writing" | "draft" | "held" | "sent" | "approved" | "failed";
  deck: Deck | null;
  reactions: Reactions;
  sendAfter: string | null;
  sentAt: string | null;
  sentTo: string[];
  viewedAt: string | null;
  approvedAt: string | null;
  error: string | null;
  withoutIntake: boolean;
  startedAt: string | null;
  draftedAt: string | null;
  bibleVersion: string | null;
};

/** A presentation kept beside the current one: a new version (writing, draft, failed) or an older draft (superseded) */
export type Version = {
  id: string;
  status: "writing" | "draft" | "failed" | "superseded";
  deck: Deck | null;
  withoutIntake: boolean;
  bibleVersion: string | null;
  error: string | null;
  startedAt: string;
  draftedAt: string | null;
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function PresentationAdmin({
  client,
  hasBible,
  bibleVersion,
  autoSend,
  expectedMs,
  versions,
  showing,
  p,
}: {
  client: { id: string; name: string; slug: string; kaizenId: number | null };
  hasBible: boolean;
  bibleVersion: string | null;
  autoSend: boolean;
  expectedMs: number;
  versions: Version[];
  showing: Version | null;
  p: P | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [change, setChange] = useState("");
  const withClient = p?.status === "sent" || p?.status === "approved";
  // The newest version written beside the one with the client (never the history of replaced drafts)
  const latest = versions.find((v) => v.status !== "superseded") ?? null;
  const fresh = withClient && latest && (!p?.sentAt || Date.parse(latest.startedAt) > Date.parse(p.sentAt)) ? latest : null;
  const history = versions.filter((v) => v.status === "superseded" && v.deck);
  const writing = p?.status === "writing" || fresh?.status === "writing";
  const editable = !p || ["draft", "held", "failed", "writing"].includes(p.status);

  useEffect(() => {
    if (!writing) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [writing, router]);

  const act = (fn: () => Promise<{ ok: true; note?: string } | { ok: false; error: string }>, done?: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: r.note ?? done ?? "Done." } : { ok: false, text: r.error });
      if (r.ok) setChange("");
      router.refresh();
    });
  const write = () => act(() => rewritePresentation(client.id, change), "Writing it in the background.");

  const status = !p
    ? { tone: "muted", text: hasBible ? "Not written yet" : "Waiting on the Brand Bible" }
    : p.status === "writing"
      ? { tone: "warn", text: "Writing it from the Brand Bible…" }
      : p.status === "draft"
        ? { tone: "warn", text: autoSend ? `Ready for you · goes out on its own ${p.sendAfter ? when(p.sendAfter) : "in one business day"}` : "Ready for you · it goes out when someone sends it" }
        : p.status === "held"
          ? { tone: "muted", text: p.error ? `Held · ${p.error}` : "Held · it won't go out until someone sends it" }
          : p.status === "failed"
            ? { tone: "bad", text: `Couldn't write it · ${p.error ?? "try again"}` }
            : p.status === "sent"
              ? { tone: "ok", text: `Sent ${p.sentAt ? when(p.sentAt) : ""} to ${p.sentTo.join(", ")} · ${p.viewedAt ? `opened ${when(p.viewedAt)}` : "not opened yet"}` }
              : { tone: "ok", text: `Approved by the client ${p.approvedAt ? when(p.approvedAt) : ""}` };
  const tone = { ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", muted: "bg-surface-2 text-muted" }[status.tone];
  const behind = Boolean(p?.deck && bibleVersion && p.bibleVersion && p.bibleVersion !== bibleVersion && !fresh);

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 pb-24">
      <div className="-mx-4 -mt-6 flex flex-wrap items-center gap-2 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur-xl md:sticky md:top-0 md:z-30 md:-mx-10 md:-mt-8 md:px-10">
        <Link href={`/clients/${client.slug}/brand-bible`} className="inline-flex h-11 min-w-0 items-center gap-1.5 rounded-full pr-2 text-[13px] text-muted hover:text-fg md:h-9">
          <span aria-hidden>←</span> <span className="truncate">{client.name} · Brand Bible</span>
        </Link>
        <span className="hidden text-faint md:inline">/</span>
        <span className="hidden font-heading text-[14px] md:inline">Client presentation</span>
        {p?.status === "approved" && (
          <Link href={`/clients/${client.slug}/launch`} className="ml-auto inline-flex h-11 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-muted hover:border-faint hover:text-fg md:h-9">
            First ads in 48 hours →
          </Link>
        )}
        {p?.deck && (
          <Link href={`/c/${client.slug}/plan`} className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-muted hover:border-faint hover:text-fg md:h-9">
            Open as the client ↗
          </Link>
        )}
      </div>

      {/* Where it stands, and what to do */}
      <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-4 md:p-6">
        <div className="flex flex-wrap gap-2">
          <p className={`rounded-full px-3 py-1 text-[12.5px] ${tone}`}>{status.text}</p>
          {p?.bibleVersion && <p className="rounded-full bg-surface-2 px-3 py-1 text-[12.5px] text-muted">From Bible {p.bibleVersion}</p>}
          {p?.withoutIntake && <p className="rounded-full bg-surface-2 px-3 py-1 text-[12.5px] text-muted">Written without their intake form (none 4 business days in): it says so</p>}
        </div>
        {p?.status === "writing" && <JobProgress startedAt={p.startedAt} expectedMs={expectedMs} label="Writing it from the Brand Bible" onRetry={write} />}
        {behind && <p className="text-[13px] text-muted">The Brand Bible is now {bibleVersion}: a new version of this is written on its own; you can also write it now.</p>}
        {editable && hasBible && (
          <div className="grid gap-3">
            {p?.deck && p.status !== "writing" && (
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={pending} onClick={() => act(() => sendPresentationNow(client.id))} className="h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-50">
                  {pending ? "One moment…" : "Approve and send to the client"}
                </button>
                {p.status === "draft" && autoSend && (
                  <button type="button" disabled={pending} onClick={() => act(() => holdPresentation(client.id, true), "Held: it won't go out on its own.")} className="h-11 rounded-full border border-line px-4 text-[14px] text-muted hover:text-fg disabled:opacity-50">
                    Hold it
                  </button>
                )}
                {p.status === "held" && autoSend && (
                  <button type="button" disabled={pending} onClick={() => act(() => holdPresentation(client.id, false), "Back on: it goes out on its own in one business day.")} className="h-11 rounded-full border border-line px-4 text-[14px] text-muted hover:text-fg disabled:opacity-50">
                    Send on its own in a business day
                  </button>
                )}
              </div>
            )}
            <ChangeForm
              value={change}
              onChange={setChange}
              disabled={pending || writing}
              needsText={Boolean(p?.deck) && !behind}
              placeholder={p?.deck ? "Anything to change before it goes? e.g. lead with the subscription, drop the second idea" : "Anything it should focus on? (optional)"}
              label={p?.deck ? (behind && !change.trim() ? "Write it from the new Bible" : "Change it") : "Write it now"}
              onSubmit={write}
            />
          </div>
        )}
        {/* With the client already: theirs stays as it is, and a new version is written beside it */}
        {withClient && hasBible && (
          <div className="grid gap-3 rounded-[16px] border border-line bg-bg p-3 md:p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[13.5px] font-medium">New version</p>
              <p className="text-[12px] text-muted">The one the client has stays exactly as it is.</p>
            </div>
            {fresh?.status === "writing" ? (
              <JobProgress startedAt={fresh.startedAt} expectedMs={expectedMs} label={`Writing a new version${fresh.bibleVersion ? ` from Bible ${fresh.bibleVersion}` : ""}`} onRetry={write} />
            ) : fresh?.status === "draft" ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[13px] text-muted">
                  Drafted {fresh.draftedAt ? when(fresh.draftedAt) : ""}
                  {fresh.bibleVersion ? ` from Bible ${fresh.bibleVersion}` : ""}. It isn&apos;t sent: someone sends it when it&apos;s right.
                </p>
                <Link
                  href={showing?.id === fresh.id ? `/clients/${client.slug}/brand-bible/presentation` : `?version=${fresh.id}`}
                  className="inline-flex h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg md:h-9"
                >
                  {showing?.id === fresh.id ? "Show theirs" : "See the new version"}
                </Link>
              </div>
            ) : fresh?.status === "failed" ? (
              <p className="text-[13px] text-bad">Couldn&apos;t write the new version · {fresh.error ?? "try again"}</p>
            ) : null}
            {fresh?.status !== "writing" && (
              <ChangeForm
                value={change}
                onChange={setChange}
                disabled={pending || writing}
                needsText={false}
                placeholder="What should the new version change? (optional) e.g. the new offer, the holiday push"
                label="Write a new version"
                onSubmit={write}
              />
            )}
          </div>
        )}
        {msg && <p className={`text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
      </section>

      {history.length > 0 && (
        <details className="rounded-[16px] border border-line bg-surface px-4 py-3 text-[13px]">
          <summary className="flex min-h-11 cursor-pointer items-center text-muted md:min-h-0">Earlier drafts ({history.length})</summary>
          <ul className="mt-2 grid gap-1">
            {history.map((v) => (
              <li key={v.id}>
                <Link href={showing?.id === v.id ? `/clients/${client.slug}/brand-bible/presentation` : `?version=${v.id}`} className="flex min-h-11 items-center justify-between gap-3 rounded-[10px] px-2 hover:bg-surface-2 md:min-h-9">
                  <span>
                    Drafted {v.draftedAt ? day(v.draftedAt) : day(v.startedAt)}
                    {v.bibleVersion ? ` · Bible ${v.bibleVersion}` : ""}
                  </span>
                  <span className="text-faint">{showing?.id === v.id ? "Showing · back to current" : "See it"}</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      {showing?.deck ? (
        <div className="grid gap-3">
          <p className="rounded-full bg-warn-soft px-3 py-1.5 text-center text-[12.5px] text-warn">
            {showing.status === "superseded" ? "An earlier draft, kept as history" : "The new version: not sent"} ·{" "}
            <Link href={`/clients/${client.slug}/brand-bible/presentation`} className="underline">
              back to the current one
            </Link>
          </p>
          <PresentationDeck brand={client.name} deck={showing.deck} reactions={{}} approved={false} readOnly intake={showing.withoutIntake ? { clientId: client.kaizenId } : undefined} />
        </div>
      ) : p?.deck ? (
        <PresentationDeck brand={client.name} deck={p.deck} reactions={p.reactions} approved={p.status === "approved"} readOnly intake={p.withoutIntake ? { clientId: client.kaizenId } : undefined} />
      ) : (
        <p className="rounded-[20px] border border-dashed border-line p-8 text-center text-[14px] text-muted">
          {p?.status === "writing" ? "Writing it…" : hasBible ? "Write it from the Brand Bible to see exactly what the client will get." : "It's written once the Brand Bible is in."}
        </p>
      )}
    </div>
  );
}

function ChangeForm({ value, onChange, disabled, needsText, placeholder, label, onSubmit }: { value: string; onChange: (v: string) => void; disabled: boolean; needsText: boolean; placeholder: string; label: string; onSubmit: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="grid gap-2 rounded-[14px] border border-line bg-bg p-2 focus-within:border-brand-text/60"
    >
      <textarea
        data-chat
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-relaxed outline-none [field-sizing:content]"
      />
      <button type="submit" disabled={disabled || (needsText && !value.trim())} className="h-11 justify-self-end rounded-full bg-fg px-4 text-[13.5px] text-bg disabled:opacity-40 md:h-10">
        {label}
      </button>
    </form>
  );
}
