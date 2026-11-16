"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toasts";
import { draftChannelAction, setChannelWeekly } from "./channel-actions";

// One client on the Clients tab: connected ones can draft a report now and choose whether they also get a Monday weekly
// (the monthly is always drafted); the others say what to connect, and take you to the client's page to do it.

type Props = { clientId: string; name: string; slug: string; line: "email" | "social"; state: "connected" | "missing" | "pending" | "failing"; what: string | null; weekly: boolean; latest: { id: string; label: string; status: string } | null };

const Dot = ({ ok }: { ok: boolean }) => <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-ok" : "bg-warn"}`} />;

export function ChannelClientRow({ clientId, name, slug, line, state, what, weekly, latest }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [on, setOn] = useState(weekly);
  const connected = state === "connected";

  const draft = (kind: "monthly" | "weekly") =>
    start(async () => {
      const r = await draftChannelAction(clientId, line, kind);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't draft it", body: r.error });
      toast({ tone: "ok", title: r.existing ? "It's already there" : "Drafting it now", body: r.existing ? "Opening it." : "It opens when it's written." });
      router.push(`/reports/${r.id}`);
    });

  const flip = () =>
    start(async () => {
      const next = !on;
      setOn(next);
      const r = await setChannelWeekly(clientId, line, next);
      if (!r.ok) {
        setOn(!next);
        toast({ tone: "bad", title: "Couldn't change it", body: r.error });
      } else router.refresh();
    });

  return (
    <li className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="grid min-w-0 gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <Dot ok={connected} />
          <span className="truncate font-heading text-[16px]">{name}</span>
        </span>
        {connected ? (
          <span className="text-xs text-muted">{latest ? `Latest: ${latest.label}` : "Connected. Its first report is drafted on the first business days of the month."}</span>
        ) : (
          <span className="text-xs leading-relaxed text-warn">{what}</span>
        )}
      </div>
      {connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" role="switch" aria-checked={on} disabled={pending} onClick={flip} className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-3.5 text-sm text-muted hover:border-faint hover:text-fg disabled:opacity-60 md:h-9">
            <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-ok" : "bg-surface-2"}`}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
            </span>
            Weekly too
          </button>
          <button type="button" disabled={pending} onClick={() => draft("monthly")} className="inline-flex h-11 items-center rounded-full bg-fg px-4 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-60 md:h-9">
            Draft last month
          </button>
          <button type="button" disabled={pending} onClick={() => draft("weekly")} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-fg hover:border-faint disabled:opacity-60 md:h-9">
            Draft last week
          </button>
        </div>
      ) : (
        <Link href={`/clients/${slug}`} className="inline-flex h-11 items-center justify-center rounded-full border border-line px-4 text-sm text-fg hover:border-faint md:h-9">
          Open the client
        </Link>
      )}
    </li>
  );
}
