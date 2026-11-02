"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
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
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function PresentationAdmin({ client, hasBible, p }: { client: { id: string; name: string; slug: string; kaizenId: number | null }; hasBible: boolean; p: P | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [change, setChange] = useState("");
  const writing = p?.status === "writing";
  const editable = !p || ["draft", "held", "failed"].includes(p.status);

  useEffect(() => {
    if (!writing) return;
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [writing, router]);

  const act = (fn: () => Promise<{ ok: true; note?: string } | { ok: false; error: string }>, done?: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: r.note ?? done ?? "Done." } : { ok: false, text: r.error });
      if (r.ok) setChange("");
      router.refresh();
    });

  const status = !p
    ? { tone: "muted", text: hasBible ? "Not written yet" : "Waiting on the Brand Bible" }
    : p.status === "writing"
      ? { tone: "warn", text: "Writing it from the Brand Bible…" }
      : p.status === "draft"
        ? { tone: "warn", text: `Ready for you · goes out on its own ${p.sendAfter ? when(p.sendAfter) : "in 24 hours"}` }
        : p.status === "held"
          ? { tone: "muted", text: p.error ? `Held · ${p.error}` : "Held · it won't go out until someone sends it" }
          : p.status === "failed"
            ? { tone: "bad", text: `Couldn't write it · ${p.error ?? "try again"}` }
            : p.status === "sent"
              ? { tone: "ok", text: `Sent ${p.sentAt ? when(p.sentAt) : ""} to ${p.sentTo.join(", ")} · ${p.viewedAt ? `opened ${when(p.viewedAt)}` : "not opened yet"}` }
              : { tone: "ok", text: `Approved by the client ${p.approvedAt ? when(p.approvedAt) : ""}` };
  const tone = { ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", muted: "bg-surface-2 text-muted" }[status.tone];

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
          {p?.withoutIntake && <p className="rounded-full bg-surface-2 px-3 py-1 text-[12.5px] text-muted">Written without their intake form (none 4 business days in): it says so</p>}
        </div>
        {editable && hasBible && (
          <div className="grid gap-3">
            {p?.deck && (
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={pending} onClick={() => act(() => sendPresentationNow(client.id))} className="h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-50">
                  {pending ? "One moment…" : "Approve and send to the client"}
                </button>
                {p.status === "draft" && (
                  <button type="button" disabled={pending} onClick={() => act(() => holdPresentation(client.id, true), "Held: it won't go out on its own.")} className="h-11 rounded-full border border-line px-4 text-[14px] text-muted hover:text-fg disabled:opacity-50">
                    Hold it
                  </button>
                )}
                {p.status === "held" && (
                  <button type="button" disabled={pending} onClick={() => act(() => holdPresentation(client.id, false), "Back on: it goes out on its own in 24 hours.")} className="h-11 rounded-full border border-line px-4 text-[14px] text-muted hover:text-fg disabled:opacity-50">
                    Send on its own in 24h
                  </button>
                )}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act(() => rewritePresentation(client.id, change), "Rewriting it: this takes a minute or two.");
              }}
              className="grid gap-2 rounded-[14px] border border-line bg-bg p-2 focus-within:border-brand-text/60"
            >
              <textarea
                value={change}
                onChange={(e) => setChange(e.target.value)}
                rows={2}
                placeholder={p?.deck ? "Anything to change before it goes? e.g. lead with the subscription, drop the second idea" : "Anything it should focus on? (optional)"}
                className="w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-relaxed outline-none [field-sizing:content]"
              />
              <button type="submit" disabled={pending || writing || (Boolean(p?.deck) && !change.trim())} className="h-10 justify-self-end rounded-full bg-fg px-4 text-[13.5px] text-bg disabled:opacity-40">
                {p?.deck ? "Change it" : "Write it now"}
              </button>
            </form>
          </div>
        )}
        {msg && <p className={`text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
      </section>

      {p?.deck ? (
        <PresentationDeck brand={client.name} deck={p.deck} reactions={p.reactions} approved={p.status === "approved"} readOnly intake={p.withoutIntake ? { clientId: client.kaizenId } : undefined} />
      ) : (
        <p className="rounded-[20px] border border-dashed border-line p-8 text-center text-[14px] text-muted">
          {writing ? "Writing it…" : hasBible ? "Write it from the Brand Bible to see exactly what the client will get." : "It's written once the Brand Bible is in."}
        </p>
      )}
    </div>
  );
}
