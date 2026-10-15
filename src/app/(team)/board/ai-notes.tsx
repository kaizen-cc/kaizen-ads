"use client";

import { useEffect, useState } from "react";
import type { CreativeNote, CreativeNotes } from "@/lib/ai";
import { creativeNotes, type AiNotes } from "./review-actions";

const SECTIONS: { key: CreativeNote["severity"]; label: string; dot: string; text: string }[] = [
  { key: "fix", label: "Fix before it goes to the client", dot: "bg-bad", text: "text-bad" },
  { key: "watch", label: "Keep an eye on", dot: "bg-warn", text: "text-warn" },
  { key: "good", label: "Working well", dot: "bg-ok", text: "text-ok" },
];

const VERDICT: Record<CreativeNotes["verdict"], { label: string; cls: string }> = {
  fix: { label: "Needs fixes", cls: "bg-bad-soft text-bad" },
  minor: { label: "A few things to check", cls: "bg-warn-soft text-warn" },
  ready: { label: "Looks ready", cls: "bg-ok/15 text-ok" },
};

export const DEMO_NOTES: CreativeNotes = {
  verdict: "fix",
  headline: "The 9:16 has the price inside the Reels caption area, and the offer on D2 says 20% off where the brief says 25%.",
  notes: [
    { severity: "fix", design: "D2", size: "", area: "Offer", note: "Badge reads \"20% OFF\" but the brief's offer is 25% off this week only." },
    { severity: "fix", design: "D1", size: "9:16", area: "Placement", note: "The \"$8 Calzone Mondays\" price sits in the bottom third, where the Reels caption and buttons cover it. Move it above the middle." },
    { severity: "watch", design: "D1", size: "4:5", area: "Text", note: "The subhead is thin white on a light crust; at phone size it's hard to read. A shadow or darker panel would help." },
    { severity: "watch", design: "", size: "", area: "Brief", note: "The brief asks to show the calzone cut open; D2 shows it whole." },
    { severity: "good", design: "D1", size: "", area: "Craft", note: "The cheese pull is sharp and warm, exactly the first look the brief asked for." },
  ],
};

/** The AI's look at the creative, for whoever reviews it. Starts by itself in creative review and refreshes while it runs. */
export function AiNotesCard({ requestId, demo = false }: { requestId: string; demo?: boolean }) {
  const [state, setState] = useState<AiNotes | null>(demo ? { status: "done", notes: DEMO_NOTES, at: "", stale: false } : null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (demo) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      creativeNotes(requestId).then((s) => {
        if (!live) return;
        setState(s);
        if (s.status === "running") timer = setTimeout(load, 5000);
      });
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [requestId, demo]);

  const rerun = async () => {
    if (demo) return;
    setState({ status: "running", since: new Date().toISOString() });
    const s = await creativeNotes(requestId, { rerun: true });
    setState(s);
    // Keep checking until it lands
    const poll = async () => {
      const next = await creativeNotes(requestId);
      setState(next);
      if (next.status === "running") setTimeout(poll, 5000);
    };
    if (s.status === "running") setTimeout(poll, 5000);
  };

  if (!state || state.status === "none") return null;

  return (
    <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-[#6c7ee1]" aria-hidden>
            <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" />
          </svg>
          <span className="text-sm font-medium">AI review notes</span>
          {state.status === "done" && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT[state.notes.verdict].cls}`}>{VERDICT[state.notes.verdict].label}</span>}
        </button>
        {state.status === "running" ? (
          <span className="flex items-center gap-1.5 text-xs text-faint">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6c7ee1]" />
            Looking over every file…
          </span>
        ) : (
          <button onClick={rerun} className="text-xs text-faint hover:text-fg">
            {state.status === "done" && state.stale ? "Files changed · look again" : "Look again"}
          </button>
        )}
      </div>

      {state.status === "running" && <p className="text-xs text-muted">Reading the text, checking the offer against the brief, brand rules and Meta placements. Usually under a minute.</p>}
      {state.status === "failed" && <p className="text-xs text-muted">{state.error}</p>}

      {state.status === "done" && open && (
        <>
          <p className="text-sm leading-relaxed">{state.notes.headline}</p>
          {SECTIONS.map((sec) => {
            const list = state.notes.notes.filter((n) => n.severity === sec.key);
            if (!list.length) return null;
            return (
              <div key={sec.key} className="grid gap-1.5">
                <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${sec.text}`}>{sec.label}</p>
                <ul className="grid gap-1.5">
                  {list.map((n, i) => (
                    <li key={i} className="flex gap-2.5 rounded-[8px] bg-bg/60 px-3 py-2 text-sm">
                      <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${sec.dot}`} />
                      <span className="min-w-0 flex-1 leading-relaxed">
                        {(n.design || n.size || n.area) && (
                          <span className="mr-1.5 text-xs text-faint">{[n.design, n.size, n.area].filter(Boolean).join(" · ")}</span>
                        )}
                        {n.note}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="text-[11px] text-faint">The AI can miss things and get things wrong. It sees one frame of a video.</p>
        </>
      )}
    </div>
  );
}
