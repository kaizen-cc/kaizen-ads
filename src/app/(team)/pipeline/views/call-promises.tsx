"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CallPromise, OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "./suggested-briefs";

// What we promised clients on calls and haven't started: two business days after the call, with nothing in
// production, the strategist writes the brief from the call. One click to review it and send it to the makers.

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

export function CallPromises({ promises }: { promises: CallPromise[] }) {
  const router = useRouter();
  const [sheet, setSheet] = useState<OpenSuggestion | null>(null);
  if (!promises.length) return null;
  return (
    <section className="grid gap-4 rounded-[20px] border border-warn/40 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(224,166,58,0.16),transparent_60%)] p-5 md:p-6">
      <div className="grid gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warn">Promised on calls</span>
        <h2 className="font-display text-2xl tracking-tight">
          {promises.length} {promises.length === 1 ? "thing we said we'd do hasn't" : "things we said we'd do haven't"} started
        </h2>
        <p className="text-sm text-muted">Pulled from the call notes. Each one has a brief written from the call, ready to send to production.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {promises.map((p) => (
          <article key={p.commitmentId} className="grid content-start gap-3 rounded-[16px] border border-line bg-bg/70 p-4">
            <div className="grid gap-1">
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Link href={`/clients/${p.clientSlug}`} className="font-medium text-fg hover:underline">
                  {p.client}
                </Link>
                · &ldquo;{p.callTitle}&rdquo; · {day(p.callAt)}
              </span>
              <p className="text-[15px] leading-snug">&ldquo;{p.what}&rdquo;</p>
              <p className="text-xs text-warn">Nothing in production since. It was due {day(p.dueAt)}.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setSheet(p.suggestion)} className="h-9 rounded-brand bg-fg px-4 text-sm font-medium text-bg">
                Review the brief
              </button>
            </div>
          </article>
        ))}
      </div>
      {sheet && (
        <SuggestionSheet
          s={sheet}
          onClose={() => {
            setSheet(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}
