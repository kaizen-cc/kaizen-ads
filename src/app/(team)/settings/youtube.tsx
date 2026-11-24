"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { pushParams, useParam } from "@/lib/url-state";
import { field } from "@/components/ui";
import { roleLabel, type TeamRole } from "@/lib/roles";
import type { SourceView, TakeawayView, VideoView, YouTubePage } from "@/lib/youtube";
import { agentsForTakeaway, BLOCKED_LABEL, YT_LINE_LABEL, YT_LINES, type YtLine } from "@/lib/youtube-core";
import {
  acceptYouTubeTakeaway,
  addYouTubeSource,
  callInYouTubeAgent,
  checkYouTubeNow,
  dismissYouTubeTakeaway,
  pasteYouTubeTranscript,
  removeYouTubeSource,
  setYouTubeActive,
  setYouTubeLines,
  suggestYouTubeLines,
  summarizeYouTube,
  type Summary,
} from "./youtube-actions";

// Settings › AI agents › YouTube: the channels and videos the agents keep studying, in one place. Execs and line heads
// subscribe and tag the lines each teaches; new videos become takeaways shared with everyone on those lines; a line head
// or an exec accepts each into the agents' learning, calls in an agent to work it into the playbook, or dismisses it.
// The view (?yt=) lives in the address, so back returns to it.

export type YtView = "decide" | "mine" | "all" | "sources";

const AGENT_LABEL: Record<string, string> = {
  media_buyer: "Media Buyer",
  google_buyer: "Google Ads Buyer",
  creative_director: "Creative Director",
  copywriter: "Copywriter",
  email_strategist: "Email Strategist",
  email_creative: "Email Creative",
  email_builder: "Email Builder",
  social_strategist: "Social Strategist",
  tracking_engineer: "Tracking Engineer",
};

const LINE_TINT: Record<YtLine, string> = { meta: "#5b8def", google: "#34a853", creative: "#e0752d", email: "#a259ff", social: "#e4405f", tracking: "#9b6bd6" };

const when = (iso: string | null) => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
};

function LineChip({ line, on = true, onClick }: { line: YtLine; on?: boolean; onClick?: () => void }) {
  const tint = LINE_TINT[line];
  const cls = `inline-flex items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors ${onClick ? "min-h-11 md:min-h-8" : "py-1"} ${on ? "border-transparent text-fg" : "border-line text-faint hover:text-muted"}`;
  const style = on ? { background: `${tint}22` } : undefined;
  const dot = <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: on ? tint : "var(--fg-faint)" }} />;
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={on} className={cls} style={style}>
      {dot}
      {YT_LINE_LABEL[line]}
    </button>
  ) : (
    <span className={cls} style={style}>
      {dot}
      {YT_LINE_LABEL[line]}
    </span>
  );
}

function useRun() {
  const [busy, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? (r.message ? { ok: true, text: r.message } : null) : { ok: false, text: r.error });
      router.refresh();
    });
  return { busy, note, run };
}

const Note = ({ note }: { note: { ok: boolean; text: string } | null }) => (note ? <p className={`text-[12.5px] ${note.ok ? "text-muted" : "text-bad"}`}>{note.text}</p> : null);

// ─── Add a source ───────────────────────────────────────────────────────────

function AddSource() {
  const [link, setLink] = useState("");
  const [lines, setLines] = useState<YtLine[]>([]);
  const { busy, note, run } = useRun();
  const toggle = (l: YtLine) => setLines((x) => (x.includes(l) ? x.filter((y) => y !== l) : [...x, l]));
  return (
    <form
      className="grid gap-3 rounded-[22px] border border-line bg-surface p-4 md:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!link.trim()) return;
        run(async () => {
          const r = await addYouTubeSource(link, lines);
          if (r.ok) {
            setLink("");
            setLines([]);
          }
          return r;
        });
      }}
    >
      <div>
        <h3 className="font-heading text-[18px] leading-tight">Subscribe to a channel or add a video</h3>
        <p className="mt-1 text-[12.5px] text-muted">A channel link (youtube.com/@name), an @handle or one video&apos;s link. Leave the lines empty and the AI suggests them from the channel&apos;s videos.</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className={`${field} h-11 md:h-10`} value={link} onChange={(e) => setLink(e.target.value)} placeholder="youtube.com/@channel, @handle or a video link" inputMode="url" autoCapitalize="none" aria-label="YouTube channel or video" />
        <button type="submit" disabled={busy || !link.trim()} className="inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-fg px-5 text-sm text-bg transition-opacity disabled:opacity-50 md:h-10">
          {busy ? "Reading YouTube…" : "Add"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11.5px] text-faint">Teaches</span>
        {YT_LINES.map((l) => (
          <LineChip key={l} line={l} on={lines.includes(l)} onClick={() => toggle(l)} />
        ))}
        {!lines.length && <span className="text-[11.5px] text-faint">· AI suggests</span>}
      </div>
      <Note note={note} />
    </form>
  );
}

// ─── Sources ────────────────────────────────────────────────────────────────

function SourceCard({ s, canManage }: { s: SourceView; canManage: boolean }) {
  const { busy, note, run } = useRun();
  const [lines, setLines] = useState<YtLine[]>(s.lines);
  const toggle = (l: YtLine) => {
    const next = lines.includes(l) ? lines.filter((x) => x !== l) : [...lines, l];
    setLines(next);
    run(() => setYouTubeLines(s.id, next));
  };
  return (
    <li className={`grid gap-3 rounded-[22px] border border-line bg-surface p-4 md:p-5 ${s.active ? "" : "opacity-70"}`}>
      <div className="flex items-start gap-3">
        {s.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.thumbnail} alt="" className={`h-12 w-12 shrink-0 object-cover ${s.kind === "channel" ? "rounded-full" : "rounded-[10px]"}`} />
        ) : (
          <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-surface-2 text-faint">▶</span>
        )}
        <div className="min-w-0 flex-1">
          <a href={s.url} target="_blank" rel="noreferrer" className="block truncate font-heading text-[16px] leading-tight hover:underline">
            {s.title ?? s.url}
          </a>
          <p className="mt-0.5 truncate text-[12px] text-faint">
            {s.kind === "channel" ? (s.handle ? `@${s.handle}` : "Channel") : "Single video"}
            {s.addedBy ? ` · added by ${s.addedBy}` : ""}
            {!s.active ? " · paused" : ""}
          </p>
        </div>
      </div>
      {s.about && <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted">{s.about}</p>}
      <div className="flex flex-wrap gap-1.5">
        {canManage ? YT_LINES.map((l) => <LineChip key={l} line={l} on={lines.includes(l)} onClick={() => toggle(l)} />) : lines.map((l) => <LineChip key={l} line={l} />)}
      </div>
      {canManage && s.suggested.length > 0 && s.suggested.join() !== lines.join() && (
        <p className="text-[11.5px] text-faint">
          AI suggests: {s.suggested.map((l) => YT_LINE_LABEL[l]).join(", ")}.{" "}
          <button type="button" className="min-h-11 text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0" onClick={() => (setLines(s.suggested), run(() => setYouTubeLines(s.id, s.suggested)))}>
            Use these
          </button>
        </p>
      )}
      <dl className="grid grid-cols-3 gap-3 border-t border-line/70 pt-3">
        {[
          ["Last checked", s.kind === "channel" ? (when(s.lastChecked) ?? "Not yet") : "—"],
          ["New this week", String(s.newVideos)],
          ["Takeaways", String(s.takeaways)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-[10.5px] text-faint">{k}</dt>
            <dd className="tabular mt-0.5 text-[15px]">{v}</dd>
          </div>
        ))}
      </dl>
      {(s.blocked.key > 0 || s.blocked.unavailable > 0 || s.blocked.long > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {s.blocked.key > 0 && <span className="rounded-full border border-dashed border-warn/60 bg-warn-soft px-2.5 py-1 text-[11.5px] text-warn">{BLOCKED_LABEL.key} · {s.blocked.key}</span>}
          {s.blocked.unavailable > 0 && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted">{BLOCKED_LABEL.unavailable} · {s.blocked.unavailable}</span>}
          {s.blocked.long > 0 && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted" title="Add one by its link to read it anyway">{BLOCKED_LABEL.long} · {s.blocked.long}</span>}
        </div>
      )}
      {s.error && <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[12px] text-warn">{s.error}</p>}
      {canManage && (
        <div className="flex flex-wrap gap-1.5">
          {s.kind === "channel" && (
            <button type="button" disabled={busy} onClick={() => run(() => checkYouTubeNow(s.id))} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8">
              Check now
            </button>
          )}
          {s.kind === "channel" && (
            <button type="button" disabled={busy} onClick={() => run(() => suggestYouTubeLines(s.id))} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8">
              Suggest lines
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => run(() => setYouTubeActive(s.id, !s.active))} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8">
            {s.active ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => confirm(`Stop studying ${s.title ?? "this"}? Its videos and takeaways stay.`) && run(() => removeYouTubeSource(s.id))}
            className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[12.5px] text-faint hover:text-bad disabled:opacity-50 md:min-h-8"
          >
            Remove
          </button>
        </div>
      )}
      <Note note={note} />
    </li>
  );
}

// ─── Takeaways ──────────────────────────────────────────────────────────────

function TakeawayRow({ t }: { t: TakeawayView }) {
  const { busy, note, run } = useRun();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(t.takeaway);
  const agents = agentsForTakeaway({ lines: t.lines, roles: t.roles });
  const status =
    t.status === "accepted" ? `Accepted${t.decidedBy ? ` by ${t.decidedBy}` : ""}: the agents use it` : t.status === "called" ? `${AGENT_LABEL[t.calledRole ?? ""] ?? "An agent"} called in${t.decidedBy ? ` by ${t.decidedBy}` : ""}` : t.status === "dismissed" ? `Dismissed${t.decidedBy ? ` by ${t.decidedBy}` : ""}` : null;
  return (
    <li className="grid gap-2 border-t border-line/70 pt-3 first:border-t-0 first:pt-0">
      {editing ? (
        <textarea className={`${field} h-auto min-h-24 py-2 leading-relaxed`} value={text} onChange={(e) => setText(e.target.value)} aria-label="Takeaway" />
      ) : (
        <p className={`text-[14px] leading-relaxed ${t.status === "dismissed" ? "text-faint line-through" : ""}`}>{t.takeaway}</p>
      )}
      {t.why && <p className="text-[12.5px] text-muted">Why: {t.why}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {t.lines.map((l) => (
          <LineChip key={l} line={l} />
        ))}
        {t.roles
          .filter((r) => !r.startsWith("head_of"))
          .slice(0, 4)
          .map((r) => (
            <span key={r} className="rounded-full bg-surface-2 px-2 py-1 text-[11px] text-muted">
              {roleLabel(r as TeamRole)}
            </span>
          ))}
        <a href={t.link} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-[11.5px] text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0">
          Watch the moment ↗
        </a>
      </div>
      {status && <p className="text-[11.5px] text-faint">{status}</p>}
      {t.canDecide && t.status === "pending" && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => run(async () => (editing ? acceptYouTubeTakeaway(t.id, text) : acceptYouTubeTakeaway(t.id)))}
            className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[12.5px] text-bg disabled:opacity-50 md:min-h-8"
          >
            {editing ? "Accept as edited" : "Accept into learning"}
          </button>
          {!editing && (
            <button type="button" onClick={() => setEditing(true)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg md:min-h-8">
              Reword
            </button>
          )}
          {agents.slice(0, 2).map((a) => (
            <button
              key={a}
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await callInYouTubeAgent(t.id, a);
                  if (r.ok) router.push(r.href);
                  return r.ok ? { ok: true, message: `The ${AGENT_LABEL[a]} is reading it…` } : r;
                })
              }
              className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8"
            >
              {busy ? "Briefing…" : `Call in the ${AGENT_LABEL[a] ?? "agent"}`}
            </button>
          ))}
          <button type="button" disabled={busy} onClick={() => run(() => dismissYouTubeTakeaway(t.id))} className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[12.5px] text-faint hover:text-fg disabled:opacity-50 md:min-h-8">
            Dismiss
          </button>
        </div>
      )}
      <Note note={note} />
    </li>
  );
}

function PasteTranscript({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { busy, note, run } = useRun();
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg md:min-h-8">
        Paste the transcript
      </button>
    );
  return (
    <div className="grid gap-2">
      <textarea className={`${field} h-auto min-h-32 py-2`} value={text} onChange={(e) => setText(e.target.value)} placeholder="On YouTube: … under the video › Show transcript, select it all and paste here" aria-label="Transcript" />
      <div className="flex gap-1.5">
        <button type="button" disabled={busy || text.trim().length < 400} onClick={() => run(() => pasteYouTubeTranscript(id, text))} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[12.5px] text-bg disabled:opacity-50 md:min-h-8">
          Read it
        </button>
        <button type="button" onClick={() => setOpen(false)} className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[12.5px] text-faint md:min-h-8">
          Cancel
        </button>
      </div>
      <Note note={note} />
    </div>
  );
}

const STATUS: Record<string, string> = { queued: "Queued", reading: "Reading now", no_transcript: "No transcript", skipped: "Nothing to learn", failed: "Couldn't read" };

function VideoCard({ v, show }: { v: VideoView; show: TakeawayView[] }) {
  return (
    <li className="grid gap-4 overflow-hidden rounded-[22px] border border-line bg-surface p-4 md:grid-cols-[200px_1fr] md:p-5">
      <a href={v.url} target="_blank" rel="noreferrer" className="relative block aspect-video overflow-hidden rounded-[14px] bg-surface-2">
        {v.thumbnail && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
        )}
        {(v.blocked || STATUS[v.status]) && <span className="absolute left-2 top-2 rounded-full bg-deep/85 px-2 py-0.5 text-[10.5px] text-fg backdrop-blur">{v.blocked ? BLOCKED_LABEL[v.blocked] : STATUS[v.status]}</span>}
      </a>
      <div className="grid min-w-0 content-start gap-3">
        <div>
          <a href={v.url} target="_blank" rel="noreferrer" className="font-heading text-[16px] leading-snug [overflow-wrap:anywhere] hover:underline">
            {v.title ?? "A YouTube video"}
          </a>
          <p className="mt-0.5 text-[12px] text-faint">
            {[v.channel, when(v.publishedAt), v.onDemand ? "asked for on demand" : null, v.via === "gemini" ? "transcribed by Gemini" : v.via === "paste" ? "transcript pasted" : null].filter(Boolean).join(" · ")}
          </p>
          {v.sharedNote && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              {v.priority >= 3 && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-text">Must watch</span>}
              <span className="[overflow-wrap:anywhere]">{v.sharedNote}</span>
              {v.shares > 1 && <span className="text-faint">· shared {v.shares} times</span>}
            </p>
          )}
        </div>
        {v.summary && <p className="text-[13px] leading-relaxed text-muted">{v.summary}</p>}
        {v.status === "no_transcript" && (
          <div className="grid gap-2 rounded-[14px] bg-surface-2 p-3">
            <p className="text-[12.5px] text-muted">{v.error}</p>
            <PasteTranscript id={v.id} />
          </div>
        )}
        {(v.status === "failed" || v.blocked === "long") && v.error && <p className={`text-[12.5px] ${v.blocked ? "text-muted" : "text-bad"}`}>{v.error}</p>}
        {show.length > 0 && (
          <ul className="grid gap-3">
            {show.map((t) => (
              <TakeawayRow key={t.id} t={t} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

// ─── Summarize on demand ────────────────────────────────────────────────────

function SummarizeBox() {
  const [link, setLink] = useState("");
  const [busy, start] = useTransition();
  const [out, setOut] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="grid gap-3 rounded-[22px] border border-line bg-surface p-4 md:p-5">
      <div>
        <h3 className="font-heading text-[18px] leading-tight">Summarize a video</h3>
        <p className="mt-1 text-[12.5px] text-muted">Paste any YouTube link: its summary and takeaways in about a minute. Just for you; nothing is shared or learned.</p>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!link.trim()) return;
          start(async () => {
            setError(null);
            const r = await summarizeYouTube(link);
            if (r.ok) setOut(r.summary);
            else setError(r.error);
          });
        }}
      >
        <input className={`${field} h-11 md:h-10`} value={link} onChange={(e) => setLink(e.target.value)} placeholder="youtube.com/watch?v=…" inputMode="url" autoCapitalize="none" aria-label="YouTube video link" />
        <button type="submit" disabled={busy || !link.trim()} className="inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-line px-5 text-sm hover:border-faint/60 disabled:opacity-50 md:h-10">
          {busy ? "Watching it…" : "Summarize"}
        </button>
      </form>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      {out && (
        <div className="grid gap-2 rounded-[14px] bg-surface-2 p-4">
          <a href={out.url} target="_blank" rel="noreferrer" className="font-heading text-[15px] hover:underline">
            {out.title ?? "The video"}
            {out.channel ? <span className="text-faint"> · {out.channel}</span> : null}
          </a>
          {out.summary && <p className="text-[13px] leading-relaxed text-muted">{out.summary}</p>}
          <ul className="grid gap-2">
            {out.takeaways.map((t, i) => (
              <li key={i} className="text-[13px] leading-relaxed">
                {t.takeaway}{" "}
                <a href={t.link} target="_blank" rel="noreferrer" className="text-faint underline-offset-4 hover:underline">
                  ↗
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ─── Setup ───────────────────────────────────────────────────────────────────

/** Where transcripts come from: Gemini connected, or the one step to connect it */
function Setup({ gemini, waiting }: { gemini: boolean; waiting: number }) {
  return (
    <section className={`flex flex-col gap-2 rounded-[18px] border px-4 py-3 sm:flex-row sm:items-center sm:gap-4 ${gemini ? "border-line bg-surface" : "border-dashed border-warn/60 bg-warn-soft"}`}>
      <span className="inline-flex items-center gap-2 text-[13px] font-medium">
        <span aria-hidden className={`h-2 w-2 rounded-full ${gemini ? "bg-ok" : "bg-warn"}`} />
        {gemini ? "Gemini connected" : "Gemini not connected"}
      </span>
      <p className="text-[12.5px] text-muted">
        {gemini
          ? "Videos with no captions YouTube will share are transcribed by Gemini: a few each run, none past an hour unless added by link. Its cost shows under Expenses."
          : `Create a key in Google AI Studio (aistudio.google.com › Get API key) and add it to Vercel as GEMINI_API_KEY.${waiting ? ` ${waiting} video${waiting === 1 ? " waits" : "s wait"} for it and are read as soon as it's set.` : ""}`}
      </p>
    </section>
  );
}

// ─── The section ────────────────────────────────────────────────────────────

const VIEWS: { key: YtView; label: string }[] = [
  { key: "decide", label: "Your call" },
  { key: "mine", label: "For you" },
  { key: "all", label: "Every video" },
  { key: "sources", label: "Channels" },
];

export function YouTubeLearning({ data, view: asked, deciding }: { data: YouTubePage; view: YtView | null; /** Can decide on any line (an exec or a line head) */ deciding: boolean }) {
  const views = VIEWS.filter((v) => v.key !== "decide" || deciding);
  const seeAll = useParam("ytall") === "1";
  const view: YtView = asked && views.some((v) => v.key === asked) ? asked : deciding && data.waiting ? "decide" : "mine";
  const channels = data.sources.filter((s) => s.kind === "channel");
  const read = data.videos.filter((v) => v.status === "done").length;
  // Your call opens on your own lines; "See all" (?ytall=1) shows every takeaway you may decide (owner, Nov 23 2026)
  const pick = (v: VideoView): TakeawayView[] => (view === "decide" ? v.takeaways.filter((t) => t.canDecide && t.status === "pending" && (seeAll || t.scoped)) : view === "mine" ? v.takeaways.filter((t) => t.mine && t.status !== "dismissed") : v.takeaways);
  const outside = data.videos.reduce((n, v) => n + v.takeaways.filter((t) => t.canDecide && t.status === "pending" && !t.scoped).length, 0);
  const list = data.videos.map((v) => ({ v, show: pick(v) })).filter(({ v, show }) => show.length || (view === "all" && v.status !== "skipped"));
  return (
    <div className="grid gap-6">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 py-6 md:px-8 md:py-7">
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-28 -z-10 h-80 w-80 rounded-full bg-[#ff3d3d]/15 blur-[110px]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">YouTube learning</p>
        <h2 className="mt-2 font-heading text-[28px] leading-tight md:text-[34px]">
          {channels.length ? `Studying ${channels.length} channel${channels.length === 1 ? "" : "s"}` : "What should the agents study?"}
        </h2>
        <p className="mt-2 max-w-2xl text-[13px] text-muted">
          New videos are read every few hours. Each becomes concrete, attributed takeaways, shared with everyone on the lines they involve. A line head or an exec accepts each into the agents&apos; learning, calls in an agent to work it into the playbook, or dismisses it. Agents use only what&apos;s accepted.
        </p>
        <dl className="mt-5 grid grid-cols-3 gap-6 md:max-w-xl md:gap-10">
          {[
            ["Videos read", String(read), "so far"],
            ["Your call", deciding ? String(data.waiting) : "—", deciding ? "takeaways waiting" : "line heads and execs"],
            ["For you", String(data.forMe), "takeaways on your lines"],
          ].map(([k, v, n]) => (
            <div key={k} className="grid gap-0.5">
              <dt className="text-[11px] text-faint">{k}</dt>
              <dd className="tabular font-display text-[26px] leading-none md:text-[32px]">{v}</dd>
              <dd className="text-[11px] text-faint">{n}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Setup gemini={data.gemini} waiting={data.sources.reduce((n, s) => n + s.blocked.key, 0)} />

      {data.canManage && <AddSource />}

      <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:w-fit md:rounded-full md:border md:border-line md:bg-surface md:p-1 md:px-1" aria-label="YouTube views">
        {views.map((v) => (
          <Link
            key={v.key}
            href={`/settings?tab=agents&section=youtube&yt=${v.key}`}
            aria-current={view === v.key ? "page" : undefined}
            className={`inline-flex h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-[13px] transition-colors md:h-9 ${view === v.key ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg md:border-0"}`}
          >
            {v.label}
            {v.key === "decide" && data.waiting > 0 && <span className="tabular ml-1.5 rounded-full bg-brand-soft px-1.5 text-[11px] text-brand-text">{data.waiting}</span>}
          </Link>
        ))}
      </nav>

      {view === "decide" && outside > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <span>{seeAll ? "Every takeaway you may decide" : "Only your lines"}</span>
          <button type="button" onClick={() => pushParams({ ytall: seeAll ? null : "1" })} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-fg hover:border-ink/30 md:h-8 md:px-3">
            {seeAll ? "Only my lines" : `See all (${outside} more)`}
          </button>
        </div>
      )}
      {view === "sources" ? (
        data.sources.length ? (
          <ul className="grid gap-4 md:grid-cols-2">
            {data.sources.map((s) => (
              <SourceCard key={s.id} s={s} canManage={data.canManage} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[22px] border border-dashed border-line p-6 text-center text-[13px] text-muted">No channels yet.{data.canManage ? " Add one above." : " An exec or a line head adds them."}</p>
        )
      ) : list.length ? (
        <ul className="grid gap-4">
          {list.map(({ v, show }) => (
            <VideoCard key={v.id} v={v} show={show} />
          ))}
        </ul>
      ) : (
        <p className="rounded-[22px] border border-dashed border-line p-6 text-center text-[13px] text-muted">
          {view === "decide" ? "Nothing waiting for your call." : view === "mine" ? "No takeaways for your lines yet. They show up here as new videos are read." : "No videos read yet."}
        </p>
      )}

      <SummarizeBox />
    </div>
  );
}
