"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Section } from "@/components/ui";
import type { ShotList } from "@/lib/shot-list";
import { markShotListSent, writeClientShotList } from "./actions";

// What the client has on Drive to make creative from, and next month's shot list: the photos and clips to ask them
// for, written from what's planned and winning, minus what's already there. Copy it into an email or Slack.

export type AssetGlance = { images: number; videos: number; designs: number; newest: string | null; stale: boolean };
export type SavedShotList = { id: string; list: ShotList; createdAt: string; sentAt: string | null };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const textOf = (l: ShotList) => [l.intro, "", ...l.shots.map((s, i) => `${i + 1}. ${s.what} (${s.format}, ${s.specs}) · ${s.why}`), "", l.closing].join("\n");

export function ShotListPanel({ clientId, slug, assets, latest, live }: { clientId: string; slug: string; assets: AssetGlance; latest: SavedShotList | null; live: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stale = assets.stale;
  const write = () =>
    start(async () => {
      setError(null);
      const r = await writeClientShotList(clientId, slug);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  return (
    <Section
      title="Assets and shot list"
      description="What's on their Drive to make creative from, and what to ask them for next month. The strategist checks the same assets before it suggests a brief."
    >
      <div id="shot-list" className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">
            <span className="tabular text-fg">{assets.images}</span> photos
          </span>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">
            <span className="tabular text-fg">{assets.videos}</span> videos
          </span>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">
            <span className="tabular text-fg">{assets.designs}</span> design files
          </span>
          <span className={`rounded-full px-2.5 py-1 ${stale ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>
            {assets.newest ? `Newest on Drive ${day(assets.newest)}` : "Nothing on Drive yet"}
            {stale && " · time to ask for fresh footage"}
          </span>
        </div>

        {latest ? (
          <div className="grid gap-3 rounded-[14px] border border-line bg-bg/40 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-heading text-[15px]">Shot list for {latest.list.month}</p>
              <span className="text-[11px] text-faint">
                Written {day(latest.createdAt)}
                {latest.sentAt ? ` · sent ${day(latest.sentAt)}` : ""}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted">{latest.list.intro}</p>
            <ol className="grid gap-2">
              {latest.list.shots.map((s, i) => (
                <li key={i} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2 text-sm">
                  <span className="tabular text-faint">{i + 1}</span>
                  <span className="grid gap-0.5">
                    <span>{s.what}</span>
                    <span className="text-[11px] text-faint">
                      {s.format === "video" ? "Video" : "Photo"} · {s.specs} · {s.why}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            {latest.list.have.length > 0 && <p className="text-[11px] text-faint">Already on Drive, not asked for: {latest.list.have.join(", ")}</p>}
            <p className="text-sm text-muted">{latest.list.closing}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(textOf(latest.list));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="h-9 rounded-full bg-fg px-4 text-sm text-bg"
              >
                {copied ? "Copied" : "Copy to send"}
              </button>
              {!latest.sentAt && (
                <button type="button" disabled={pending} onClick={() => start(async () => markShotListSent(latest.id, slug))} className="h-9 rounded-full border border-line px-4 text-sm text-muted hover:text-fg">
                  Mark as sent
                </button>
              )}
              {live && (
                <button type="button" disabled={pending} onClick={write} className="h-9 px-2 text-sm text-faint hover:text-fg disabled:opacity-60">
                  {pending ? "Writing…" : "Write it again"}
                </button>
              )}
            </div>
          </div>
        ) : (
          live && (
            <button type="button" disabled={pending} onClick={write} className="justify-self-start rounded-full bg-fg px-4 py-2 text-sm text-bg disabled:opacity-60">
              {pending ? "Writing next month's shot list…" : "Write next month's shot list"}
            </button>
          )
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    </Section>
  );
}
